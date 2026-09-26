# Module contracts

Frozen interfaces for the first version. Full rationale and the
measured evidence behind each decision live in [`../DESIGN.md`](../DESIGN.md).

Modules are being migrated to TypeScript one subtree at a time. The host half is
done (`src/types.ts`, `src/evaluator/**`, `src/runtime.ts`, `src/gate.ts`,
`src/notice.ts`, `src/status-route.ts`, `src/wire.ts`), and so is the client half
(`client/**/*.ts`, bundled to `lib/client.js`) and every test and harness module. All shared types
live in [`types.ts`](./types.ts) and the browser-facing wire format in
[`wire.ts`](./wire.ts), which is the executable half of this document: relative
imports carry an explicit `.ts` extension, and `tsc`'s
`rewriteRelativeImportExtensions` turns them into `.js` in the `lib/` build that
`exports["."]` publishes. `tsconfig.json` emits `lib/`, and the harness loads the
plugin through the package export, so a source edit needs `npx tsc -p tsconfig.json`
before `test/harness/run.sh` sees it.

## Shared vocabulary

```ts
/** direnv 的 env diff。`null` = 删掉这个变量（墓碑），string = 设置。 */
type Overlay = Record<string, string | null>

/** 可直接合并进 SubprocessSpawnSpec.env 的形态：`null` 已转成 `undefined`。 */
type EnvOverlay = Record<string, string | undefined>

interface Watch { path: string; modtime: number; exists: boolean }
```

`EnvOverlay` 的合并规则固定为 `{ ...envOverlay, ...spec.env }`：调用方/宿主显式
设置的值永远优先于 direnv，`DSH_*` 与 `NO_COLOR/TERM/PAGER/GIT_PAGER` 因此在
`spec.env` 里自动胜出，墓碑在 `spec.env` 没有同名键时原样保留。

## `src/evaluator/` — direnv 求值 + 分级 memo

实现拆成单一职责的若干模块，公开缝隙只有一个：`src/evaluator/index.ts` 的
`createEvaluator`。编排与 memo 查询在 `index.ts`；子进程在 `spawn.ts`；
分类策略在 `classify.ts`；memo 键在 `fingerprint.ts`；RC 探测在 `envrc.ts`；
watches 解码与 `.direnv` 降级在 `watches.ts`；侧边栏派生在 `derive.ts`；
记录表与 in-flight 去重在 `store.ts`；注入点归一化与 base 环境在 `deps.ts`；
`unknown` 错误值的收窄在 `errors.ts`。签名与不变量见
[`types.ts`](./types.ts)。

```ts
export function createEvaluator(options: {
  direnvPath?: string          // 缺省从 PATH 解析 'direnv'
  evaluateTimeoutMs: number    // 求值子进程的 kill 期限；0 = 不设上限（默认）
  loadTimeoutMs?: number       // 已废弃：evaluateTimeoutMs 的别名，仅为兼容保留
  memo: boolean                // false = 每次真跑（调试用）
  log: (level: 'debug'|'info'|'warn'|'error', message: string, extra?: object) => void
  isDirDisabled?: (dir: string) => boolean
  deps?: EvaluatorDepsInput    // 测试注入点：{ baseEnv, spawnDirenv, stat, readFile, readdir, access, realpath, now, hash }
}): Evaluator

interface Evaluator {
  /**
   * 同步、零 IO。有记录就返回**可注入**的 env（`ok` 给 overlay，其余给空对象）；
   * **完全没有记录、或最近一次是瞬时失败**（超时/被杀/spawn 失败/crash/bad-json）
   * 时返回 `undefined`——那是"未知，值得再试"的信号，`spawn()` 会据此重新预热。
   * 三态在类型里叫 `PeekEnvResult`（`EnvOverlay | Record<string, never> | undefined`）：
   * 确定结论是**字面上的空对象**，与"未知"不是同一个值。
   */
  peekEnv(dir: string): PeekEnvResult

  /** 异步：命中 memo 直接返回；否则求值一次（同目录 in-flight 去重）。绝不抛。 */
  ensureEnv(dir: string, options?: { signal?: AbortSignal, force?: boolean }):
    Promise<EnvOverlay | undefined>

  /** 完整结果（含状态与诊断），给门闸与状态路由用。绝不抛。 */
  evaluate(dir: string, options?: { signal?: AbortSignal, force?: boolean }):
    Promise<Outcome>

  /** fire-and-forget 预热，返回的 promise 永不 reject。`{ force: true }` 绕过 memo。 */
  prewarm(dir: string, options?: { force?: boolean }): Promise<void>

  invalidate(dir?: string): void
  /** 纯查表，给侧边栏用 */
  status(dir: string): StatusRecord
  /** 纯查表 */
  inFlight(): readonly string[]
}

/**
 * 真正的判别联合（`src/types.ts` 的 `Outcome`）：`kind` 决定哪些字段存在，
 * `warnings` / `reason` 是**追加**的——只在有话要说时才出现。
 * `disabled` 没有 `ms`：这个 kind 从不跑任何东西。
 */
type Outcome =
  | { kind: 'ok';                 dir: string; envrcPath: string | null; overlay: Overlay
      env: EnvOverlay; degraded: boolean; warnings: string[]
      watches: Watch[] | null; ms: number; at: number; memoHit: boolean }
  | { kind: 'absent';             dir: string; ms: number; at: number }
  | { kind: 'unreadable';         dir: string; envrcPath: string; ms: number; at: number }
  | { kind: 'blocked';            dir: string; envrcPath: string | null; stderr: string; ms: number; at: number }
  | { kind: 'envrc-failed';       dir: string; status: number; stderr: string; ms: number; at: number }
  | { kind: 'config-error';       dir: string; stderr: string; ms: number; at: number }
  | { kind: 'error';              dir: string; stderr: string; exitCode: number | null; ms: number; at: number }
  | { kind: 'direnv-unavailable'; dir: string; code: string; ms: number; at: number }
  | { kind: 'disabled';           dir: string; at: number }

/**
 * PATH 的一条差分项。`value` 是原始分量（空串也是合法分量——POSIX 里它表示
 * 当前目录），渲染成什么样由 client 决定。`change` 是**三态**，缺一不可：
 * `unchanged` 不能拿来当「字段读不出来」时的默认值，那样等于谎报「没有变化」。
 */
interface PathEntry {
  value: string
  change: 'added' | 'removed' | 'unchanged'
}

interface StatusRecord {
  dir: string
  state: Outcome['kind'] | 'idle' | 'loading'
  at: number | null            // 上次求值完成时刻
  ms: number | null            // 上次求值耗时
  envrcPath: string | null
  memoHit: boolean
  variables: { name: string; sensitive: boolean; hasValue: boolean }[]  // 名字 + 是否凭据类
  pathEntries: PathEntry[]     // direnv 相对 base 的 PATH 差分，见下「顺序与多重集」
  credentials: string[]        // 命中 /KEY|PASSWORD|SECRET|TOKEN/i 的变量名
  errorSummary: string | null
  warnings: string[]
  watchCount: number           // 上次求值报告的被 watch 路径数（面板暂未使用，保留给诊断）
  env: EnvOverlay | null       // 值不进默认响应；只有路由收到 ?values=1 才填充（客户端展开某一行时才请求）
}
```

**两个预算不要混。** `evaluateTimeoutMs` 是**求值子进程**的 kill 期限（默认 `0` = 不设上限，代价是一个死循环的 `.envrc` 会一直挂着）；门闸的等待预算由 `src/gate.ts` 的 `timeoutMs`（配置里的 `loadTimeoutMs`，默认 300000）单独决定。两者曾经共用同一个数字，后果是慢 `.envrc`（冷 `use flake`）一超时就**既放行了工具、又杀掉了求值**，于是环境永远拿不到、而且非 ok 记录让后续 spawn 连重试都不做——这正是 `DESIGN.md` §7.2 记录的那个真 bug。

**`pathEntries` 的顺序与多重集语义（`src/evaluator/derive.ts` 是唯一实现）：**

- **顺序 = 新 PATH 的顺序**（靠前 = 优先级更高）。游标推进到某个 new 分量、并要占用 base 里
  更靠后的一个出现时，先把跳过的、不与任何 new 分量配对的 base 分量作为 `removed` 发出。
  因此只有在新 PATH 保持 base 原有顺序时，删除才恰好落在它原来的两个邻居之间；new 被整体
  重排时，删除只会出现在「游标走到下一个 new 分量之前」，未必挨着原邻居。走完 new 之后
  剩下的 `removed` 追加在末尾（PATH 变短时看得最清楚）。
- **多重集配对，不是集合**：同一个目录可以合法地在 `PATH` 里出现多次，每次出现都是独立的
  优先级槽位。第 k 次出现只有在 base 里也有第 k 次出现时才算 `unchanged`；超出 new 计数的
  那些 base 出现就是 `removed`，反之 new 里多出来的就是 `added`。用 `Set` 判成员会漏判重复项。
- base 里**没有 `PATH`** 时全部算 `added`（不是错误）；分量可以是**空串**（POSIX 里表示当前
  目录），差分不得抛错，渲染由 client 决定。
- 模型侧（`src/notice.ts`）**只报数量**（`N PATH entries added, M removed`），绝不报具体路径。

求值器必须实现 DESIGN.md §3.2 的分类规则，其中几条不可简化：

- 调 direnv 前把 base 里的 `DIRENV_*` **全部删掉**（安全红线：否则会复活被 harness
  清洗掉的密钥）。base 保留 `HOME`/`XDG_CONFIG_HOME`/`XDG_DATA_HOME`/`DIRENV_CONFIG`。
- 非 0 退出时**绝不解析 stdout**；`is blocked` 的判据是「`direnv: error` 行**恰好一条**
  且匹配 blocked 模板」（`.envrc` 能自己伪造这行）。
- 空 stdout 必须靠**自己 stat** 消歧（无 RC / 不可读 / `.env`-only / 短路）。
- exit 0 的 JSON 是 **diff**：`null` → 墓碑；键缺失 → 保持不变。
- memo 键必须包含 watches 逐项重扫 + `direnv.toml` + `lib/*.sh` + direnv 二进制 +
  `PATH` 指纹 + cwd（**只按 watches 会比不缓存更不正确**）。失败与 blocked 不缓存。

## `src/runtime.ts` — 替换 `ctx.subprocess` 的执行器

```ts
/** 解析基类（三层兜底），解析失败抛带尝试链的错误。 */
export async function resolveLocalSubprocessRuntime(ctx: PluginContext): Promise<RuntimeCtor>

/** 造出可 new 的子类；构造器里完成注册与启动期硬断言。 */
export function createRuntimeClass(
  Base: RuntimeCtor,
  deps: { evaluator: Evaluator; config: Partial<Settings>; log: LogFn },
): { Runtime: RuntimeClass; stats: RuntimeStats }
```

- 真实类型用在这里：`RuntimeCtor` 的实例类型是
  `@deepseek-ai/dsh-subprocess-local` 的 `LocalSubprocessRuntime`，
  `spawn` / `spawnTerminal` 的 spec 取自 `@deepseek-ai/dsh-subprocess`
  （`SubprocessSpawnSpec` / `SubprocessTerminalSpawnSpec`）——**该包不 re-export 这两个
  类型**，所以类型从 `dsh-subprocess` 取、类从 `dsh-subprocess-local` 取。
  类只能动态解析（拿到的是 `unknown`），因此 `RuntimeCtor` 的构造签名写的是本插件
  转发的那一小片 ctx（`PluginContext`）；真实构造器声明为 `(ctx: Context)`，运行期
  拿到的就是一个真 cordis `Context`。
- `spawn(spec)` 同步：`peekEnv(spec.cwd)` 命中就 `{ ...spec, env: { ...env, ...spec.env } }`，
  未命中则原样 `super.spawn(spec)` 并 `prewarm`。**绝不 IO、绝不抛。**
- `spawnTerminal(spec)` 异步：`await ensureEnv(spec.cwd)` 后再合并。两份 spec 对 `env`
  的**元素类型**声明不同（`NodeJS.ProcessEnv` vs `Record<string, string>`），而墓碑在
  两边都是 `undefined`、provider 会像 Node 自己的 `spawn` 那样丢掉它，所以合并函数
  对两者通用。
- **`config.injectSensitive === 'filter'` 在这里生效**（`spawn` 与 `spawnTerminal` 两条都走）：
  按 `/KEY|PASSWORD|SECRET|TOKEN/i` 的名字启发式（**刻意与 harness 自己的规则一致**，所以
  `MONKEY_BUSINESS` 这种无辜名字也会被扣下）从 overlay 里剔除命中的键；被剔除的条数计入
  `stats.filtered`，全被剔除时不改写 spec（`applySensitivity` 不筛时**返回同一个对象**，
  计数就靠这个引用相等）。
- 自检**不能**用 `constructor.name` 或方法身份（`ctx.subprocess` 是 cordis traceable
  Proxy）：只能用原型链身份、`instanceof`、行为计数。`ctx.get('subprocess')` 的取值在
  类型上就是 `unknown`，正是为了让这条纪律不可能被绕过。

## `src/gate.ts` — 门闸

```ts
export function createGate(deps: {
  evaluator: Evaluator
  log: LogFn
  timeoutMs?: number          // 配置里的 loadTimeoutMs（门闸预算，默认 300000）
}): Gate

type GateResult = 'ready' | 'timeout' | 'aborted' | 'skipped'
type GateState = 'idle' | 'pending' | 'ready' | 'skipped'

interface Gate {
  /** 幂等：为这个会话打开门闸（启动等待）。 */
  arm(key: string, dir: string): void
  /** 门闸等待；`ready` | `timeout` | `aborted` | `skipped` */
  waitFor(key: string, signal?: AbortSignal): Promise<GateResult>
  /** 用户放弃（/direnv skip）；键未知时 false。 */
  skip(key: string): boolean
  state(key: string): GateState
  /** 状态路由用的快照；键未知时 null。 */
  describe(key: string): GateDescriptor | null
  forget(key: string): void
}
```

`state()` 在等待结束后**仍报 `pending`**（`result` 才是结论，`skipped` 由 `result` 反推）：
`GateState` 里的 `ready` 目前没有生产者，`Describe` 也一样——面板据此只知道"门闸还开着"，
判断结论要读 `result`。这是现状契约，不是笔误。

## `src/notice.ts` — 模型侧一次性消息

```ts
export function createNoticeTracker(): NoticeTracker

interface NoticeTracker {
  /**
   * 传某会话当前 cwd 的 StatusRecord；返回要注入的消息，或 null 表示这次不必说话。
   * `state` 为 `loading` / `idle` 时**必须**返回 null——那不是结论，报出去就是假错误
   * （侧边栏 `force=1` 触发后台重算时，生产路径真的会经过这里）。
   */
  observe(sessionId: string, status: StatusRecord): { text: string; digest: string } | null
  forget(sessionId: string): void
  size(): number
}
```

字面规则：`.envrc` 正文与变量**值**永不出现；凭据类**名字**也不进模型文案（那是侧边栏给操作者看的），
只报数量。文案里出现的 `errorSummary` 必须原样使用，不要自己再加 `exit status` 前缀
（求值器给的摘要已经带上了）。

## `src/wire.ts` — 线格式的共享类型

host 与 browser 两半共用的唯一契约，**因此不得出现 `node:*` 与 `NodeJS.*`**（client 迁移
会直接 import 它）。`StatusRecord` / `EnvOverlay` / `StatusVariable` 从 `types.ts` 取。

```ts
interface StatusEnvelope {
  ok: true
  plugin: { name: string; version: string } | null
  sessionId: string | null
  dir: string | null
  status: StatusRecord | null          // null = 这个会话还没有可解析的工作区
  gate: WireGate | null                // HostRuntime 的 gate.describe() 原样序列化
  config?: WireConfig | null           // dir 为 null 的那个答案不带这个键
}

/** JSON.parse 之后的收窄边界；不是本路由的答案（比如 SPA 文档）返回 null。 */
export function parseEnvelope(body: unknown): StatusEnvelope | null
```

- **`status: null` 是正常状态**，不是传输失败；只有非 2xx、`content-type` 不是 JSON，
  或 `status.state` 不是非空字符串才算失败。
- **flat 形态也要接受**：body 本身就是一条 `StatusRecord`（没有 `ok`/`status` 信封）时，
  把 body 当记录读——`test/client-contract.test.ts` 的 "flat record body still renders"
  守着这条。
- `gate.result` / `gate.elapsedMs` 在求值还没结束时**是缺失的键**（`JSON.stringify` 丢掉
  `undefined`），不是 `null`，读侧必须按可选处理。
- 只有 `?values=1` 才让 host 往 `status.env` 里放变量**值**；不传时恒为 `null`。墓碑
  （`EnvOverlay` 里的 `undefined`）根本到不了线上，序列化时就被丢掉了。
- `status.pathEntries` 原样过线（顺序有意义，见上）。读侧对它的降级是**丢掉**而不是猜：
  `pathEntries` 不是数组 → `[]`；条目不是对象、`value` 不是字符串、或 `change` 不是
  `added`/`removed`/`unchanged` 之一 → 丢掉该条。**绝不把读不出的 `change` 默认成
  `unchanged`**——那等于对读者谎报「这里没有变化」。空串 `value` 要保留。

## `src/status-route.ts` — 面板数据源

```ts
export function registerStatusRoute(ctx: PluginContext, deps: StatusRouteDeps): unknown
```

路由：`GET /plugins/dsh-direnv/status.json?sessionId=…`。**必须自己上闸**：校验
`Host`/`Origin` 与 token cookie（复用 `connection.admit` 那条路；`/plugins/*` 在
DSH 里默认是零围栏的）。返回体上限最小化：默认不含变量**值**，只有名字与状态。
两个响应体都按 `StatusEnvelope` 标注，host 与 client 由同一个类型守住线格式。

**线格式（冻结——两侧必须逐字按这个来）**：

```jsonc
{
  "ok": true,
  "plugin": { "name": "dsh-direnv", "version": "0.1.0" },
  "sessionId": "…",          // 请求带的那个，没有则 null
  "dir": "…",                // 已解析的目录；解析不出则 null
  "status": { /* StatusRecord */ },   // 目录未知时为 null —— 这是正常状态，不是错误
  "gate": { "dir": "…", "state": "pending", "result": "ready", "elapsedMs": 12 },
  "config": { "disabledDirs": [], "loadTimeoutMs": 300000, "evaluateTimeoutMs": 0 }
}
```

客户端必须读 **`body.status`**，并把 `status === null` 当作「还没有工作区信息」而不是传输失败；
只有非 2xx、`content-type` 不是 JSON（web carrier 对未知路径会回 SPA 的 `index.html`），
或 `status.state` 不是非空字符串时才算失败。`status.env` 只在 `?values=1` 时有值。

查询参数：`sessionId`（可选）、`dir`（可选，绝对路径优先于 session 映射）、
`force=1`（请求 host 强制重跑一次求值）、`values=1`（**只有它**才在 `status.env` 里返回值；
不传时 `status.env` 恒为 `null`）。客户端只在操作者展开了变量时才带 `values=1`。

> 这条线格式是**冻结契约**：本项目出过一次 host 用信封、client 读顶层的错位，后果是面板
> 永远空白（连 composer 灰化与失败 toast 都失效，因为它们由 `state === 'loading'` 驱动）。
> 改动任何一侧都必须同时改另一侧，并由 `test/client-contract.test.ts` 守住。

## 跨模块规则

- 只用 `node:` 前缀导入 Node 内置模块。
- **运行时关键**的 dsh 包（要拿它的类来继承的那个）**必须**经 `ctx.loader.import` 动态解析，
  不能顶层静态 import——理由见 §3.7（安装形态差异 + `link:` 形态的解析放行）。
- 顶层静态 import 只允许用于 `dependencies` 里的**支持包**（当前只有
  `@deepseek-ai/schemastery`，取自 `Config` 的官方惯例）。这类包由 npm 装进我们自己的
  `node_modules`，解析不依赖 profile 树；解析失败时整个 entry 会 `failed to import`（响亮），
  所以不要往里加任何 dsh 包。
- host 侧不得 import 任何 `@deepseek-ai/dsh-client-*`。
- **浏览器半边可达的文件（`types.ts`、`wire.ts`）不得 import `node:*`，也不得出现
  `NodeJS.*`**：client 迁移会直接 import `wire.ts`，运行时的 `node:` import 会砸在浏览器里，
  类型里的 `NodeJS` 会让 `tsconfig.client.json`（`"types": []`）解析不到。
- host 与 DSH 的接触面（`ctx.loader`、三个事件 payload、`webServer` / `connection`）在
  `types.ts` 里是**结构化声明**：这些包不是本插件的依赖（`cordis-plugin-loader` 没装，
  `dsh-client-connection` 只是 `dsh-api-gateway` 的依赖），拿不到真实类型。装得上的**必须**
  用真的：`LocalSubprocessRuntime` 取自 `@deepseek-ai/dsh-subprocess-local`，
  `SubprocessSpawnSpec` / `SubprocessTerminalSpawnSpec` 取自 `@deepseek-ai/dsh-subprocess`
  （**`dsh-subprocess-local` 不 re-export 这两个类型**），两个包都是 `import type`，不产生
  运行期依赖。
- `src/index.ts` 的三个导出必须保持现在这种**声明式**形态（`export const name` /
  `export const Config` / `export async function apply`）。DSH 按 `isConstructor` 规则
  （有没有 `.prototype`）决定要不要 `new`：把 `apply` 写成箭头函数常量或对象方法简写会改变
  调用方式，插件会**静默**失效。
- client 侧（`client/**/*.ts`，打包成 `lib/client.js`）的运行期 `require` **只允许**平台种子里的那 9 个
  说明符：`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、
  `@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、
  `@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-dockkit`。清单外的一切
  （包括 `…-ui-sidebar-right` / `…-ui-conversation` 这些**引导图里的包工厂**）不保证解析：模块表查不到
  就**抛错**，代价是整个 web app 白屏。目前产物里只有两处 `require(`：`react` 与
  `@deepseek-ai/dsh-client-ui-primitives`（后者用来把面板画成官方组件，见 DESIGN.md §3.5），
  由 `test/client-contract.test.ts` 扫描产物守住。元素一律 `React.createElement`（**不用 JSX**）；
  种子包是平台提供的，**不得**写进 `dsh.client.inject`。
- 官方组件的 props 靠 `client/react.ts` 的 `h()` 在**编译期**逐个检查：组件调用走
  `h<P>(type: Component<P>, config: NoInfer<P> & { key? })`，`P` 只从元素类型推断（`primitives.ts`
  里的本地结构类型 = 官方 `.d.ts` 的逐字转写），于是多余、拼错、类型不符的 prop 都是编译错误；
  宿主元素（字符串 tag）与 `Fragment` 各走一个宽松重载。`NoInfer` 是承重的：去掉它，编译器会从
  对象字面量反推 `P`，拼错的 prop 会**静默通过**（反例：把某个 `state:` 写成 `status:`，typecheck
  依旧 exit 0）。测试侧的假件（`test/helpers/fake-primitives.ts`）按组件维护允许的 prop 名清单，
  清单外的 prop 直接抛错并报出组件名，`test/fake-primitives.test.ts` 守着这份清单。
- 每个模块头部一段 `/** … */` 说明它 owns 什么，以及**不做就会出错的那些不变量**；
  不写"我改了什么"式的注释，签名能说清的也不写注释。
