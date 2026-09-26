# dsh-direnv 设计方案

> 一个 DSH（DeepSeek Harness）插件：让每个工作区的子进程都自动带上该工作区 `direnv` 的环境——仿佛 dsh 本身就是在那个目录下被启动的。
>
> 目标版本：DSH `0.1.7-rc.1` · 交付形态：npm 包 `dsh-direnv`（MIT，双语文档）

---

## 1. 目标与非目标

### 1.1 目标

1. **每个子进程的环境 = 由它自己的 cwd 决定的纯函数。** 模型跑的命令、后台任务、子代理、hooks 子进程、文件搜索工具内部起的 `rg`、用户自己点开的侧边栏终端——统统如此。
2. **会话创建/恢复时就开始异步加载**，模型第一次调工具时通常已经就绪。
3. **加载期间卡住工具调用**（不是卡住对话），UI 上表现为工具「自己卡住了」。
4. **用户可见的状态与操作面**：右侧栏一个 direnv 面板，加载中改 composer 占位符，失败弹 Toast。
5. 加载失败、`.envrc` 未 allow、`direnv` 不存在、缓存未命中——**一律不影响命令正常执行**。

### 1.2 非目标（v1 明确不做）

| 不做的事 | 原因 |
|---|---|
| MCP server 进程的环境 | 走 MCP SDK 自己的 `StdioClientTransport`，绕过 `ctx.subprocess` |
| 宿主 helper（打开 App、原生目录选择器、LibreOffice 转换） | 直接 `node:child_process`，且与工作区环境无关 |
| `direnv allow` / `direnv block` 操作 | 等于执行仓库里的任意代码，必须走 DSH 审批；留 v2 |
| Windows / pwsh 的实测 | 机制上覆盖（不改平台相关代码），但无测试环境 |
| 持久化「上一个工作区的环境」跨 session 复用 | 会话 cwd 不可变，缓存按目录共享即可 |

---

## 2. 已定决策

| # | 决策 | 内容 | 主要依据 |
|---|---|---|---|
| D1 | **语义与可见性** | 注入环境变量 + 首次在某目录加载/失败时给模型一条**一次性** sourced user 消息（含增量与移除）；**不**注入 `.envrc` 正文 | `.envrc` 是代码不是指令；注入位复用 `agent/pre-step`，与 `@deepseek-ai/dsh-agent-instructions` 同款 |
| D2 | **锚点目录** | 每次 spawn 用**它自己的 cwd**（工具层是模型传的 `workdir`，相对路径按 session cwd 解析）；目录上溯交给 `direnv` 自己 | 实测 direnv 2.37.1 只加载最近的 `.envrc`，且自己会向上找；AGENTS.md 那套 `.git` 停靠语义与 direnv 不一致 |
| D3 | **技术缝隙** | 替换 `ctx.subprocess`（覆写 `spawn` + `spawnTerminal`），子类化 `LocalSubprocessRuntime` | cordis 一个 context 只能有一个实现；`dsh-bash-sandbox extends LocalBashExecutor` 是同一套官方手法 |
| D4 | **触发时机** | `agent/created`（`source ∈ {startup, resume, clear, compact}`）**启动**（不 await）session cwd 的异步求值 | 不 await 的理由见 §3.4 |
| D5 | **门闸范围** | `tools/pre-execute` waterfall 里等待，**拦所有工具调用** | 规则最简单、语义自洽；加载在会话创建时就开跑，门闸通常是空的 |
| D6 | **放行策略** | 只要「有确定结果」就放行（成功/无 `.envrc`/被 block/报错/超时）；门闸预算 `loadTimeoutMs` 默认 300000，超时后**求值不中断**、后台继续跑并写缓存；求值子进程的 kill 期限是**独立**的 `evaluateTimeoutMs`（默认 0 = 不杀） | 一个坏 `.envrc` 不该让会话瘫痪。门闸的语义是「等工作做完」，不是「等成功」。两个预算必须分开：拿门闸超时当杀求值的理由，会让慢 `.envrc` 永远拿不到环境（§7.2 核查发现） |
| D7 | **求值与取用** | 预热点异步求值 + `spawn()` **纯查表**（冷则原样放行 + 触发异步补齐）；base env = `scrubbedParentEnv()` **再剔除全部 `DIRENV_*`**；**分级 memo**：只对昂贵的 nix/flake 结果缓存，键 = watches 逐项重扫 + **配置类输入**（`direnv.toml`、`lib/*.sh`、direnv 二进制、PATH 指纹），失败与 blocked 一律不缓存 | 剔除 `DIRENV_*` 是**安全红线**（否则复活被清洗的密钥）。direnv **没有**跨进程缓存（实测 5 次调用 = 5 次真执行）。核查证明**只按 `DIRENV_WATCHES` 缓存是错的**：`lib/*.sh`、`direnv.toml` 都不在 watches 里，那样会比「每次干净求值」更不正确 |
| D8 | **凭据类变量** | 全量注入（忠实 direnv），但**一次性把凭据名单告诉用户**（只进 sidebar，不进模型上下文）；`injectSensitive` 开关 | `.envrc` 已过 `direnv allow`，功能上就该等价于用户自己的 shell；但「悄悄扩大暴露面」不可接受 |
| D9 | **GUI 面** | 官方右列 tab（P2 内容）+ composer 占位符 + 失败 Toast + 「重新加载」。原计划的「本工作区禁用」按钮**已删除**：状态路由 GET-only、没有写接口，浏览器侧的「隐藏面板」既不真禁用又误导（见 §3.5） | 见 §3.5 |
| D10 | **交付** | npm 包 `dsh-direnv`（无 scope，未被占用）、`README.md` + `README.zh.md`、MIT、`dsh-plugin` 关键词 | 生态惯例（`dsh-status-rotator` / `dsh-context` / `dsh-better-sidebar` 均无 scope） |
| D11 | **安装方式** | 只做 subprocess 接管，**不**提供保守的 `./shell` 入口 | 双入口 = 两条维护路径；真有问题时再带着数据决定 |
| D12 | **两个语义细节** | ① `.envrc` 里的 `unset` 精确支持（`null` → `undefined` 墓碑）；② 调用方/宿主显式 env 优先于 direnv | 实测 `direnv export json` 对 unset 输出 `null`；`SubprocessSpawnSpec.env` 的 JSDoc 明确 `undefined` 是墓碑、字符串是「deliberate caller opt-in」 |
| D13 | **实现语言与构建** | 源码改为严格 TypeScript（`strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` + `erasableSyntaxOnly`），`tsc` 逐文件编译到 `lib/`，client 半边由 esbuild 打成单文件；相对导入写显式 `.ts` 后缀、由 `rewriteRelativeImportExtensions` 在编译期改写（同一份源码既能被 Node 直接跑、又能编译发布）。顺带把每个源文件拆到 ≤400 有效行（测试 ≤600） | 取代早先「零构建步骤」的选择：Node 的类型擦除不作用于 `node_modules`，而插件正是从那里被加载；client 的单文件约束又需要打包器。类型同时成为承重不变量的护栏（`peekEnv` 三态、`status: null` 不是错误、墓碑 `undefined`、`Outcome` 判别联合），迁移期间它们各自被变异测试证明是承重的 |

---

## 3. 架构

### 3.1 三条独立的数据流

```
                     ┌──────────────────────────────┐
   agent/created ───▶│                              │
                     │        求值器 Evaluator       │──▶ cwd → overlay 缓存
   tools/pre-execute │  （direnv export json + 超时） │    （含 in-flight 去重）
        │            └──────────────────────────────┘
        │                          │
        │ 门闸：等 session cwd 的    │ 注入：spawn 查表 / spawnTerminal await
        │ 求值「有确定结果」         ▼
        └────────────────▶ ctx.subprocess（我们的子类）
                                   │
                                   ▼
                        真正的 LocalSubprocessRuntime

   agent/pre-step ───▶ 一次性 sourced user 消息（状态摘要，含增量/移除）
   webServer 路由 ───▶ client 轮询 ──▶ 右列 tab / composer 占位符 / Toast
```

三条流共用一个 `cwd → 求值结果` 的事实源，互不阻塞：**门闸等的不是注入，注入也不依赖门闸**。

### 3.2 求值器

```js
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g
const strip = (s) => (s ?? '').replace(ANSI, '')

async function evaluate(dir, signal) {
  // 0) 前置：base = scrubbedParentEnv() 再删除所有 /^DIRENV_/ 的键（强制，见下）
  //    保留 HOME / XDG_CONFIG_HOME / XDG_DATA_HOME / DIRENV_CONFIG —— allow 库与 nix-direnv 都在这儿
  //    先自己 stat(dir)：Node 对「direnv 不存在」与「cwd 不存在」都报 ENOENT，且 err.path 都指向 direnv
  let r
  try {
    r = await runDirenv(['export', 'json'], { cwd: dir, env: base, stdin: 'ignore', signal })
  } catch (e) {                                  // cwd 是文件会【同步抛 ENOTDIR】
    if (['ENOENT', 'EACCES', 'ENOTDIR'].includes(e.code)) return { kind: 'direnv-unavailable', code: e.code }
    throw e
  }
  const err = strip(r.stderr)

  // 1) 非 0 退出：绝不解析 stdout（blocked 与 .envrc 里的 exit N 都会给出合法 JSON）
  if (r.exitCode !== 0) {
    // ⚠️ 不能用 includes('is blocked')：.envrc 自己 printf 一行就能伪造它（行锚定正则也会被骗）。
    //    稳健判据 = 「direnv: error 行恰好一条」且该行匹配模板。
    const errLines = err.match(/^direnv: error (.*)$/gm) ?? []
    if (errLines.length === 1 && /is blocked\. Run `direnv allow` to approve its content$/.test(errLines[0]))
      return { kind: 'blocked', stderr: err }
    // 同一套思路用在 exit status 上：`.envrc` 可以先 printf 一条伪造的 `direnv: error exit status 99`
    // 再 exit 3，于是该形态的行有两条。判据 = 整行锚定且**恰好一条**；>1 条 → 来源不可信，落到瞬时的
    // error/ambiguous-exit-status。（「取最后一条」把顺序当信任来源：RC 起的后台进程可以在真行之后补一条。）
    const statusLines = errLines.filter((l) => /^direnv: error exit status (\d+)$/.test(l))
    if (statusLines.length === 1) {
      const m = /^direnv: error exit status (\d+)$/.exec(statusLines[0])
      return { kind: 'envrc-failed', status: Number(m[1]), stderr: err }  // 注意：exit 会丢弃该 .envrc 此前的全部 export（与「语法错误前变量生效」相反）
    }
    // 这里是**子串**判据，看着可被伪造，但它排在 exit-status 分支之后，所以伪造不可达：
    // .envrc 打一条假 `direnv: error LoadConfig() ...` 再 exit 3 时，stderr 里会有两条
    // `direnv: error` 行，上面的分支已经按「恰好一条 exit status」把它判成 envrc-failed/3
    // （实测：kind=envrc-failed status=3，假串只出现在 stderr 摘要里）。
    if (err.includes('LoadConfig() failed to parse')) return { kind: 'config-error', stderr: err }
    return { kind: 'error', stderr: err, exitCode: r.exitCode, reason: statusLines.length > 1 ? 'ambiguous-exit-status' : undefined }
  }

  // 2) exit 0：空 stdout 有 4 类来源，必须靠我们自己的 stat 消歧（direnv 分不出来）
  if (r.stdout.trim() === '') {
    // ① 确实没有 RC ② .envrc 存在但不可读（chmod 000——此时 direnv 连墓碑都不发，永远无法卸载）
    // ③ 只有 .env 且 load_dotenv=false ④ base 里带着 FILE+WATCHES 的短路（我们全剔，不会发生）
    return { kind: 'absent-or-unreadable', probe: await statEnvrc(dir) }
  }

  const parsed = JSON.parse(r.stdout)            // 解析失败 → error/bad-json
  const overlay = {}
  for (const [k, v] of Object.entries(parsed)) {
    if (k.startsWith('DIRENV_')) continue        // DIRENV_DIFF / DIR / FILE / WATCHES
    overlay[k] = v                               // string → 设置；null → 墓碑
  }
  const noise = err.split('\n').filter((l) => l && !/^direnv: (loading|export|unloading)\b/.test(l))
  return { kind: 'ok', overlay, degraded: noise.length > 0, warnings: noise }
}
```

要点：

- **base 必须是 `scrubbedParentEnv()` 再剔除全部 `DIRENV_*`**（前者从 `@deepseek-ai/dsh-subprocess` 导入）。这一条是**强制**、不是优化——实测不剔除会同时踩四个坑：① 上一个目录的变量变成墓碑（`"FOO": null`）被我们当「删除继承变量」执行；② **被 harness 凭据清洗删掉的密钥原值复活**（`DIRENV_DIFF` 的 `p` 段存着旧值，卸载时还原成 `"MY_SECRET_TOKEN": "the-real-secret"`）；③ 宿主后来改过的变量被回滚成加载时刻的旧值（PATH 被改回去）；④ `DIRENV_DIR`+`DIRENV_FILE`+`DIRENV_WATCHES` 三者齐全且被 watch 的文件未变时 direnv **直接短路**（exit 0 + 空 stdout + 空 stderr），与「没有 `.envrc`」**完全同签名**。
- **`null` → `undefined`（墓碑）**：实测 `unset FOO` 且 `FOO` **在** base 里时 JSON 给 `"FOO": null`；`FOO` **不在** base 里时**键根本不出现**。子进程层 `env` 的 `undefined` 正是「从继承环境里删掉这个变量」，语义严格对应，不做近似。
- **memo 要分级，不能一刀切**（原设计的「靠 direnv 自己的 RC 缓存」是**错的**，而「只按 `DIRENV_WATCHES` 缓存」被核查证明**比不缓存更不正确**）：
  - 事实基础：direnv 在 `export json` 模式下**没有任何跨进程缓存**（默认 `XDG_CACHE_HOME` 下 strace 里含 "cache" 的路径 **0 个**、`~/.cache` 前后快照零变化、连续 5 次调用 `.envrc` 真执行 5 次）；而且**剔除 `DIRENV_*` 后短路永不触发**，`watch_file` 对插件完全无效。
  - **不要缓存**：无 `.envrc`（~5ms）、blocked（~7ms）、`denied`——比查表还便宜，缓存只会掩盖「blocked → allowed」这种状态变化。
  - **真正值得缓存**：真实 `use nix` / `use flake`（热 130–250ms，冷启动秒级）。
  - **键必须包含配置类输入**，因为 `DIRENV_WATCHES` **不覆盖**它们：`direnv.toml`（`load_dotenv` / `whitelist` / `bash_path`…）、`$DIRENV_CONFIG/lib/*.sh` 与 `$XDG_DATA_HOME/direnv/lib/*.sh`（**nix-direnv 就在这里**）、direnv 二进制自身的版本、`PATH` 指纹、cwd；再叠加 watches 里每一项的重扫。
  - **重扫分两种指纹**：`.envrc`、`.env`、`direnv.toml`、`lib/*.sh` 以及 `.direnv/**` / `$XDG_CACHE_HOME/direnv/**` 下的 watch 项取**内容 sha256**；其余 watch 项取 `mtime+size`（它们由用户显式 watch，direnv 自己也是按 mtime 判定的）。`.direnv` 这类路径必须内容寻址而不能只看 mtime，也不能只看存在性：nix-direnv 每次热跑都 `touch -h` 它们（看 mtime ⇒ 永不命中），而重建 profile 时这些 `.rc` 的正文**就是整个 dev-shell 的 PATH**（只看存在性 ⇒ 注入已 GC 掉的 store 路径）。
  - 唯一剩下的元数据指纹是普通 watch 项与目录项：目录用「排序后的条目名」，普通文件用 `mtime+size`（同尺寸同 mtime 的原地改内容不失效，这是刻意保留的性价比取舍）。
  - **失败/blocked 的结果绝不缓存成命中**（否则用户 `direnv allow` 之后仍被挡）；memo 只存可重放的增量，不存绝对值环境；提供 TTL 与 bypass 开关。
  - 代价：内容指纹每次预热点要多读若干配置文件（实测：一个 68 290 B 的 nix-direnv profile `.rc`、20 KB 的 `hm-nix-direnv.sh` 与几个小文件，合计约 **+88 KB / +1.2 ms** 每次预热点；单独看那个 `.rc`，`readFile+sha256` 是 0.93 ms vs `stat` 0.23 ms）。预热点只在「未知目录的 spawn」与工具门前发生，这个量级可接受；watched 集合本身仍只能靠真跑一次才能扩张。
- **分类规则就是上面那段代码**，几个反直觉处值得单独记住：`is blocked` 是唯一稳定的文本判据（stderr **恒带 ANSI**，`NO_COLOR`/`TERM=dumb`/非 TTY 都无效，剥掉再匹配）；`.envrc` 里 `source` 缺文件、甚至**语法错误**都返回 **exit 0** + 合法但可能不完整的 overlay（只有 stderr 有 bash 原文，且语法错误**之前**的变量已经生效）——所以即使 exit 0 也要把 stderr 噪声升级成 warning；`.envrc` 里 `exit 7` 的 exit code **仍然是 1**，真实状态只在文本 `direnv: error exit status N`；`.envrc` 被 chmod 000 与被 `direnv deny` 过这两种情况**无法与 absent / 无副作用区分**。
- **信任边界**：`direnv export json` 会在宿主进程里、以你的用户身份、**无沙箱**地执行该目录的 `.envrc`（实测可任意写文件；nix-direnv 会写项目内 `.direnv/` 与 `~/.cache/nix`）。direnv 自身零写入（strace 证明：带写标志的 `openat` 只有 `/dev/null`），但 `.envrc` 不是。所以「是否求值」等价于「是否信任这个目录」，并且必须**复用宿主已有的 allow 状态**，绝不代替用户 allow（详见 D4/v2 路线）。
- **要把 harness 的凭据清洗规则说准**：它是 **`DSH_` 前缀（大小写不敏感）+ 子串匹配 `/KEY|PASSWORD|SECRET|TOKEN/i`**。所以 `.envrc` 显式提供的变量能进子进程（我们的 overlay 正是「显式提供」），但**ambient 里名字撞上这四个子串的变量会被静默剔除**——`MONKEY_BUSINESS`、`TURKEY_MODE` 也不能幸免。这条要写进 README，否则用户会以为自己的变量凭空消失。
- **缓存的是结果**：`Map<canonicalCwd, { status, overlay, envrcPath, at, stderr }>`，配一个 in-flight Promise 表做去重（同一目录并发只求值一次）。
- **反递归**：插件自己起 direnv 时**不能**走 `ctx.subprocess.spawn`（那正是我们覆写的方法）。做法是保留原实现的引用再直接调用：
  ```js
  const rawSpawn = LocalSubprocessRuntime.prototype.spawn.bind(this)
  ```
  这样既绕开覆写，又保留下游的输出收集、spill、grace、kill 全套机制。

### 3.3 注入点

```js
class DirenvSubprocessRuntime extends LocalSubprocessRuntime {
  spawn(spec) {                        // 同步，因此只查表，绝不 IO
    const overlay = cache.peek(spec.cwd)
    if (overlay === undefined) {
      evaluator.prewarm(spec.cwd)      // 冷：放行 + 顺手补齐
      return super.spawn(spec)
    }
    return super.spawn({ ...spec, env: { ...overlay, ...spec.env } })
  }

  async spawnTerminal(spec) {          // 异步，可以直接等
    const overlay = await evaluator.ensure(spec.cwd)
    return super.spawnTerminal({ ...spec, env: { ...overlay, ...spec.env } })
  }
}
```

**合并顺序 `{ ...overlay, ...spec.env }` 一条规则解决所有优先级问题**：

- `spec.env` 在上层已经包含 `ENV_OVERRIDES`（`NO_COLOR=1 TERM=dumb PAGER=cat GIT_PAGER=cat`）、调用方显式 env、以及 `DSH_*` 快照——它们**全部自动优先于 direnv**，不需要额外「盖回去」。
- direnv 的值叠在 `scrubbedParentEnv()` 之上，所以 dev shell 的 `PATH` 正常生效。
- 墓碑（`undefined`）在 `spec.env` 没有同名键时原样保留。

覆盖到的路径（实测枚举，走 `ctx.subprocess` 的包）：`dsh-bash-local`（bash 工具 / 后台 / 子代理）、`dsh-pwsh-local`、`dsh-terminal-bash`（侧边栏终端、持久 bash）、`dsh-tool-fs-search`（glob/grep 的 rg）、`dsh-workspace-changes`（git）、`dsh-api-terminal-controller`、`dsh-ptc-runtime-node`、`dsh-experimental-speech-to-text-sensevoice`。

### 3.4 门闸

```js
ctx.on('tools/pre-execute', async (exec, next) => {
  if (exec.agent !== undefined) await gate.waitFor(exec.agent, exec.signal)
  return next()                       // 永不 deny、永不 throw
})
```

- `gate.waitFor` 在「该 session 的 cwd 求值有确定结果」时立即 resolve；超时或取消也 resolve。
- **超时只放行门闸，不中断求值**：门闸预算（`loadTimeoutMs`）与求值子进程的 kill 期限（`evaluateTimeoutMs`，默认 0 = 不杀）是两个独立的值。门闸超时后求值继续在后台跑完，写进缓存，下一次 spawn 就能注入（§4 超时行、§7.2 修复记录）。
- 与 `exec.signal` 赛跑：用户取消时立刻放行，由 harness 自己把这次调用判定为 cancelled。
- 被阻塞的 `pre-execute` 会**串行化同一步里其它并发工具调用**（`fillPool` 里 `await startCall(...)`），这正好是我们要的语义；实测**不会**触发工具超时（`dsh-tool-call-timeout-policy` 挂在更晚的 `tools/execute` 上）。

**关键实现约束：`agent/created` 里绝不 `await` 加载。**
`agent/created` 的监听器 **会被 await**，而且「抛错或 reject 会导致 agent 创建失败并跳过后续监听器」。在那里等待加载 = 卡住会话创建，与「对话不受影响」的决策直接冲突。所以：

```js
ctx.on('agent/created', ({ agent, source }) => {
  if (!['startup', 'resume', 'clear', 'compact'].includes(source)) return
  evaluator.prewarm(agent.session.header.cwd ?? process.cwd())   // fire-and-forget
  return undefined                                                // 立即返回，绝不抛
})
```

后台求值的生命周期挂在 `agent/disposed` 上（或插件自己的 `ctx.effect`），不挂在 `agent/created` 的 `signal` 上——那个 signal 是工厂初始化的取消信号，会误杀我们的加载。

### 3.5 提示与 GUI

**模型侧（D1）**：在 `agent/pre-step` waterfall 里插入一条 sourced user 消息，做法照抄 `@deepseek-ai/dsh-agent-instructions`：

- 首次注入带 `baselineIdentity`（含 cwd 相对形状、配置指纹），resume 时身份不匹配就整条替换。
- 状态变化（blocked → ready、`.envrc` 内容变了、direnv 被移除）发 **delta**：`Additional` / `Updated` / `Removed` 三种措辞。
- 正文只有状态摘要（`.envrc` 路径 + 状态 + 一句话），**不含 `.envrc` 正文**。
- 自己实现 `</system-reminder>` 转义与字节预算（那套工具函数是私有实现，包没有导出，不可子路径导入）。

**用户侧（D9）**：官方右列 tab，两阶段注册：

```js
// 阶段一：注册 tab 类型
ctx.sidebarRightTabs.register({ id: 'dsh-direnv', kind: 'direnv', title: () => t('tab') })
// 阶段二：把 tab 体注册进 keyed seat —— 注意是 key，不是 id；且必须用 slots.inject 延迟注册
ctx.slots.inject('sidebar.right.pane.tab', () =>
  ctx.slots.register({ name: 'sidebar.right.pane.tab', key: 'dsh-direnv' }, DirenvPanel))
```

> **已验证的坑（Spike 4 + 独立核查）**：keyed 槽位漏 `key` 会**抛错**（`keyed slot "…" requires options.key`），未声明就 `register` 也抛（`slot "…" is not declared`）——都是响亮失败，不会出现"注册了但永远不显示"的幽灵 bug。但**声明当时还不存在**时，异常是经 `queueMicrotask` 抛出的**全局未捕获错误**，插件自己的 `try/catch` 兜不住，只能在 console 里看。
>
> **manifest 的两条静默陷阱（核查新发现）**：`dsh.client.platform` 必须是**精确的 `"web"`**——写成 `"Web"` / `"web "` / `"node"` 会被**静默丢弃**（boot 图里根本没有你这一行，零警告）；`dsh.client.inject` 里的名字必须是**精确包名**，写 `<pkg>/client` 形态**不会**被归一化，同样静默不加载。反过来，真正"响亮"的三种（缺 `exports["./client"]`、`platform` 不是字符串、`exports["./client"]` 指向的文件不存在）代价是**整个 web app 起不来**（无 URL、rc=1）。

面板内容（P2）：

1. **状态卡**：`.envrc` 路径、状态（加载中 / 已就绪 / 被 block / 出错 / 无 `.envrc`）、耗时、错误摘要；一个按钮——**重新加载**。（曾计划的「本工作区禁用」按钮已删除，理由见本节末。）
2. **环境明细**：本工作区由 direnv 提供的变量清单（值默认遮蔽、可逐个展开、可搜索）、`PATH` 的**有序三态差分**（绿 = 新增、红删除线 = 被移除、默认色 = 不变；靠前 = 优先级更高，列表逐行整条显示、不做 JS 截断）。
3. **凭据名单**（D8）：命中 `/KEY|PASSWORD|SECRET|TOKEN/i` 的变量名单，明确标注「这些会出现在子进程环境中」。**只给用户看。**

**不要依赖 `dsh-better-sidebar`**：DSH 0.1.7 自带这套官方右列 API，而 better-sidebar 自己（v0.19 起）就是走这套 API 的——我们的 tab 会与它的文件树/编辑器 tab 并列显示。`ctx.betterSidebar` 那个服务只管它的底部工作台，与本插件无关。

**瞬时提示**：

- 加载中：`ctx.conversation.blocks.set(sessionId, { reason: t('loading') })` → 输入框变灰 + 占位符显示文案；完成后 `set(sessionId, undefined)`。
- 失败：`ctx.conversation.input.for(actx).notify('error', text)` → composer 上方 3 秒自动消失的 Toast。
- 两者都不进会话日志（纯浏览器内存）。

**client 如何拿到 host 状态**：DSH 没有通用的 host→client 推送（转发事件是硬编码白名单，插件加不进去）。用 host 侧 `ctx.get('webServer').register({ kind: 'exact', path: '/plugins/dsh-direnv/status.json', handler })` + client 轮询（`webServer` 可能晚于插件激活，需要短轮询兜底——`dsh-status-rotator` 就是这么做的）。

> ⚠️ **这条路由必须自己上闸（核查实测的发现）**：DSH 的鉴权/信任围栏是**逐路由自愿调用**的，只加在首页与 `/api` 上；官方自带的 `/plugins/*` 分发路由**既不校验 token cookie、也不做 Host/Origin 检查、也不返回 CORS 头**（实测：无 cookie 也能 200；带外站 Host/Origin 也 200）。我们的面板要展示变量名甚至变量值，所以**必须显式复用同一套围栏**（`connection.admit` 那条路），并坚持最小暴露：默认只返回状态与变量**名**，值必须逐个按需取。

**「本工作区禁用」为什么没有实现（D9 修正）**：v1 的状态路由是 **GET-only**，没有写接口，所以「本工作区禁用 direnv」无法真正落地——任何客户端按钮都只能改自己浏览器里的一个偏好，改不了任何命令的环境。那种退化成「把面板藏起来」的做法会误导操作者（以为禁用了、其实命令照旧带环境），因此**整个删除**：`client/hidden.ts`、monitor 的 `hidden` 状态与「面板隐藏时跳过轮询/放行 composer」的分支、底部按钮与 `action.disable` / `action.enable` / `hint.hidden` / `hint.paused` 文案键，一并不再存在。保留的是**页面可见性**那条判断（`document.visibilityState === 'hidden'`：后台标签页暂停轮询），它与「隐藏面板」无关。真正的按工作区禁用需要 host 写接口，见 §9；在那之前，host 侧配置的 `disabledDirs` 是唯一语义为真的「禁用」（根本不注入）。

### 3.6 状态机

```
                 ┌──────────┐  agent/created   ┌─────────┐
   （无记录） ───▶│ loading  │─────────────────▶│ ready   │  有 overlay，spawn 注入
                 └────┬─────┘                  └─────────┘
                      │                        ┌─────────┐
                      ├───────────────────────▶│ blocked │  无 overlay，放行 + 提醒用户 allow
                      │                        └─────────┘
                      ├───────────────────────▶│ absent  │  无 .envrc/.env，静默（sidebar 显示）
                      │                        └─────────┘
                      └───────────────────────▶│ error   │  无 overlay，放行 + 摘要进 sidebar
                                               └─────────┘
   以上四个「确定结果」都会立刻放开工具门闸。
```

`ready` 之后，每次预热点（`agent/created` / `tools/pre-execute`）都会重新求值，所以 `.envrc` 改动在下一次工具调用时自动生效。

---

### 3.7 如何稳定拿到 DSH 核心包（经独立核查定稿）

DSH 在 boot 期给 Node 的解析器打了补丁（覆盖 `Module._resolveFilename` 与内部 ESM `resolveSync`），把裸名解析路由到「安装依赖闭包 ∪ 活动 profile 依赖」两张表。补丁**只对落在 `$DSH_HOME/profiles/` 前缀内（**词法前缀**，`..` 不规范化）或「活动 profile 的 `node_modules` 下指向树外的软链 realpath」的 importer/anchor 生效**。因此：

```js
// 首选：与安装形态无关，实测 12/12 场景成功（树外绝对路径插件、无 profileContext、无 node_modules、软链安装…）
const { LocalSubprocessRuntime } = await ctx.loader.import('@deepseek-ai/dsh-subprocess-local')

// 兜底（依赖 profileContext；锚点文件不需要存在）
const pc = ctx.get('profileContext')
if (pc) {
  const req = createRequire(pathToFileURL(join(pc.dir, 'cordis.yml')))
  mod = await import(pathToFileURL(req.resolve(spec)).href)
}

// 最深兜底（不依赖 profileContext；internal 可能不存在，需判空）
mod = await ctx.loader.internal?.import(spec, <树内 href>, {})
```

失败模式要记住：① `ctx.loader` 可能不存在，**必须判空**；② loader 的 baseUrl 不在 `$DSH_HOME/profiles/` 内时（非 profile 启动）首选路径会失败；③ **永远不要传 `./x` 这类相对说明符**——它会被重锚到 profile 目录；④ 目标既不在安装闭包也不在活动 profile 的 `node_modules` 时失败（这是正确行为）。

**`peerDependencies` 的正确用法（核查矩阵，直接决定发布包怎么写）**：

- **不要为了「能解析」而声明 peer**——`ctx.loader.import` 已经覆盖了所有形态。
- 对**非 `@deepseek-ai/dsh*`** 的包（例如 `@deepseek-ai/schemastery`），版本范围**永远不被校验**（只看键名，且键名要精确等于请求的包名、该包还要在安装闭包内）→ 写错无害。
- 对 **`@deepseek-ai/dsh*`**，范围**会被 `evaluatePluginCompatibility` 校验**；写错时 `preflight` 直接把该行 `disabled=true`，stderr 打一行 `dsh: disabling profile plugin row "…"`，**启动不被拒绝、插件静默不加载**（发布事故高风险）。所以：要么不声明，要么写一个**确定能匹配**的范围（本项目用 `~0.1.7-rc.1`，实测可匹配）。
- `dependencies` 声明**不参与**这条解析路径；`workspace:` 协议**不帮助解析**（且发布到 npm 后语义还会变）。

> 注：`profileContext.installAnchor` 是运行时真正的安装闭包锚点（实测指向 `.pnpm/@deepseek-ai+dsh@…/node_modules/@deepseek-ai/dsh/package.json`），能解析安装闭包、**不能**解析 profile 本地包。最深兜底里的 `loader.internal` 走的是 Node 内部 loader 句柄（`ModuleLoader.fromInternal()` 在无法识别的 Node 版本上会返回 `undefined`），**只作兜底、不作主路径**。
>
> ⚠️ **peer 范围不匹配其实有三道闸，症状各不相同（发布后最容易踩的坑）**：
> 1. **bundle 级**（范围不满足时）：`dsh: skipping profile bundle "…"` —— **整个 bundle 被跳过 ⇒ 我们的补丁从未应用 ⇒ 官方 subprocess 健在 ⇒ `--dump-config` 与安装前逐字节相同、启动零 pending、web 完全正常**。这是「看起来一切正常、插件静默不存在」，比报错危险得多。
> 2. **row 级 preflight**：单行被置 `disabled=true`，stderr 一行 `dsh: disabling profile plugin row "…"`；**`--dump-config` 不跑 preflight，所以 dump 里这一行看起来完全正常**。
> 3. **安装期**：`dsh plugin add` 会**硬拒**（exit 1，`installation rejected … nothing was installed`），并提示 `dsh plugin allow-version … --accept-risk`。
>
> 另外两条：**不声明任何 `@deepseek-ai/dsh*` peer = 完全不设版本闸**（`evaluatePluginCompatibility` 直接返回 undefined）；`*` 能通过纯粹是 `includePrerelease` 的功劳。所以范围写 `~0.1.7-rc.1`：当前 rc 通过、0.1.7 正式版与 0.1.8 也通过（函数级实测计算），0.2.0+ 才拦。**`^0.1.7` 与 `>=0.1.7` 都会被拦**（`^0.1.7` = `>=0.1.7 <0.2.0-0`，而 `0.1.7-rc.1 < 0.1.7`，下界就不满足）。
>
> **排错时必须两边都看**：patch 自身的警告（`patch: entry "…" not found`）**只出现在 `--dump-config` 的 stderr**；row 级 compat 拒绝**只出现在启动时**。

---

## 4. 失败矩阵

| 情形 | 子进程行为 | 模型 | 用户 | 门闸 |
|---|---|---|---|---|
| `direnv` 不在 PATH | 原样（无 overlay） | 一次性告知 | sidebar 显示「未安装 direnv」 | 立即放行 |
| 目录无 `.envrc` / `.env` | 原样 | 静默 | sidebar 显示「无 .envrc」 | 立即放行 |
| `.envrc` 未 allow | 原样 | 一次性告知（需在真实终端 `direnv allow`） | sidebar 显示 blocked + 提示 | 立即放行 |
| 求值报错（nix 失败等） | 原样 | 一次性告知 | sidebar 显示 stderr 摘要 | 立即放行；记录是**瞬时**的（`peekEnv` 返回 `undefined`），下一次 spawn 重新 prewarm |
| 门闸超时（`loadTimeoutMs` 内求值还没结论） | 原样（可能尚无 overlay） | 一次性告知 | sidebar 显示「仍在加载」→ 完成后转 ready | 立即放行；求值**不中断**，后台跑完后下一条命令自动带上 |
| 求值子进程被杀（`evaluateTimeoutMs` > 0 且超时）/ 中止（`signal`）/ spawn 失败 / crash | 原样 | 一次性告知 | sidebar 显示 error 摘要，下一次 spawn 会重试 | 立即放行；瞬时记录（`peekEnv` 返回 `undefined`），下一次 spawn 重新 prewarm。杀的是**整个进程组**（`detached` + `-pid` SIGKILL），所以 `.envrc` 的 bash 与孙进程不会变孤儿；但「放弃等待」不等于「没有副作用」——被杀前它可能已经写过文件 |
| `direnv: error exit status N` 在 stderr 里出现**多于一条**（`.envrc` 伪造了一条） | 原样 | — | sidebar 显示「ambiguous exit status」 | 立即放行；瞬时 `error`，不把伪造的 N 当作事实 |
| `.envrc` 里 `source` 缺文件 / **语法错误** | 原样，但 overlay 可能是**部分的**（错误之前的变量已生效，实测 exit 0） | 一次性告知「环境可能不完整」 | sidebar 显示 stderr 原文 | 立即放行 |
| `.envrc` 里 `exit N` | 原样 | 一次性告知 | sidebar 显示 `direnv: error exit status N` | 立即放行 |
| **`.envrc` 里 `exit N` 会丢弃该文件此前的全部 export**（注意与「语法错误前变量照样生效」相反）；`direnv.toml` 解析失败 → exit 1 + stdout 全空；`.env`-only 且 `load_dotenv=false` → exit 0 + 空 stdout，**与 absent 不可区分** | 原样 | 一次性告知 | sidebar 显示对应状态 | 立即放行 |
| `.envrc` 不可读（chmod 000） | 原样 | 静默 | sidebar 只能显示「无 .envrc」——**与 absent 不可区分**；且此后 direnv **不再发墓碑，永远无法卸载** | 立即放行 |
| 目录被 `direnv deny` 过 | 原样 | 静默 | 同上——**与「无副作用的 .envrc」同签名**，无法区分 | 立即放行 |
| 宿主环境里残留 `DIRENV_*`（dsh 从被 direnv 加载过的 shell 启动） | **求值前必须剔除**，否则会复活被 harness 清洗掉的密钥、注入上个目录的墓碑 | — | — | — |
| 宿主 shell 里由 direnv 注入的普通变量 | 仍随 base 被继承（「继承父环境」的固有语义；想更干净需在宿主启动时做一次「卸载」，v2 可选） | — | — | — |
| `spawn` 时缓存冷 | 原样 | 静默 | — | 不适用（不经门闸的路径） |
| 子进程 cwd 不存在 | 交给原实现报错 | 原样 | — | 不适用 |
| 插件内部任何异常 | 原样（`try/catch` 包住整条注入路径） | 静默 | sidebar 显示 | — |

**总原则**：本插件的任何失败都不得改变被 spawn 进程的行为——除了「多出/缺少环境变量」这一件事。

---

## 5. 配置 schema

与 `src/index.ts` 里的 `Config` 逐字段一致：

```js
export const Config = z.object({
  enabled: z.boolean().default(true),
  /** 显式指定 direnv 可执行文件；空串 = 从 PATH 解析。 */
  direnvPath: z.string().default(''),
  /** 门闸等待上限（毫秒）。超时即放行，求值不中断、后台继续。 */
  loadTimeoutMs: z.number().default(300000),
  /** 求值子进程的 kill 期限（毫秒）。0 = 永不杀（默认）：慢 dev shell 跑完为止；代价是死循环 `.envrc` 会留下一个长寿子进程，靠 in-flight 去重（每目录一个）与 4MB 输出上限兜底。有限值触发时按**进程组** SIGKILL（direnv + 它 source RC 的 bash + 孙进程），中止（`signal`）同理；被杀不等于没有副作用。 */
  evaluateTimeoutMs: z.number().default(0),
  /** 'all' 拦所有工具调用；'spawning' 只拦会起子进程的工具（**v1 尚未实现，等价于 'all' 并在启动时警告**）；'none' 不拦。 */
  gateTools: z.union([z.const('all'), z.const('spawning'), z.const('none')]).default('all'),
  /** 'filter' 时按 harness 的规则剔除凭据类变量（功能上会半残，仅供谨慎场景）。 */
  injectSensitive: z.union([z.const('all'), z.const('filter')]).default('all'),
  /** 是否向模型注入一次性状态消息。 */
  notifyModel: z.boolean().default(true),
  /** 是否注册右侧栏面板与 composer 提示。 */
  sidebar: z.boolean().default(true),
  /** 绝对路径白名单：这些目录完全不求值。 */
  disabledDirs: z.array(z.string()).default([]),
})
```

两点实现细节：schema 库（`@deepseek-ai/schemastery`）是**普通 dependency**，但 `src/index.ts` 用**顶层 await + catch** 导入它——拿不到 schema 时 `Config` 为 `undefined`，退化成"无校验但可用"。这是刻意的：插件若从 profile 之外加载（开发期绝对路径），裸名导入失败会让**整个 entry `failed to import` 且 stderr 不给原因**；丢校验可以接受，丢插件不行。另外 `apply` 内部还会再合并一份 `DEFAULT_SETTINGS`，所以即使 schema 缺席也不会出现 `loadTimeoutMs: undefined`（那会让门闸 `setTimeout(undefined)` = 0ms 直接超时），同样也不会出现 `evaluateTimeoutMs: undefined`（求值器把非正数一律当作默认 `0` = 不杀）。

---

## 6. 包结构与安装

### 6.1 文件布局

源码全部是 TypeScript，`lib/` 是构建产物（不入库，`npm install` 时由 `prepare` 生成）。

```
dsh-direnv/
├── package.json  tsconfig.json  tsconfig.client.json  tsconfig.test.json
├── cordis.patch.yml          # bundle 层：接管 subprocess
├── src/                      # host 半边（tsc 逐文件编译到 lib/）
│   ├── index.ts              # 插件入口：apply(ctx, config)
│   ├── types.ts              # 全仓共享类型：Outcome 判别联合 / StatusRecord / Evaluator
│   ├── wire.ts               # 状态路由线格式（host 与 client 共用；浏览器安全，无 node:*）
│   ├── runtime.ts            # DirenvSubprocessRuntime（子类）+ 三层兜底解析
│   ├── gate.ts               # 门闸状态机
│   ├── notice.ts             # 模型侧一次性消息（baseline/delta）
│   ├── status-route.ts       # webServer 状态路由
│   └── evaluator/            # 求值器拆成 10 个模块：编排 / 分类 / 指纹 / spawn / watch / 派生 / 存储 …
├── client/                   # client 半边：13 个模块，esbuild 打成单文件 lib/client.js
├── locale/{en,zh}.json
├── icon.svg
├── README.md  README.zh.md  LICENSE
└── test/                     # 单测（含真实 direnv fixture）+ helpers/ + harness/（假 LLM 测试台与 14 个端到端用例）
```

**为什么需要构建步骤。** TypeScript 是刻意的选择：强类型能把「承诺与实现不符」这类问题提前到编译期。而 Node 的原生类型擦除**不作用于 `node_modules`**——插件恰恰是从 profile 的 `node_modules` 里被 DSH 加载的，所以对外发布的必须是编译产物。client 半边另有独立约束：浏览器侧每个插件只能有**一个**文件（客户端模块表没有相对 `require`），因此 13 个 `client/**/*.ts` 模块由 esbuild 打成单文件 `lib/client.js`，且产物里 `react` 保持为**运行期**的宿主调用（有且仅有一次 `require(`，零 `import`/`export` 语句）。

**开发期不需要构建也能跑测试。** `node --test 'test/*.test.ts'` 与 `node test/client-boot.ts` 直接吃 TS 源码（Node ≥ 22.18 的原生类型擦除，无需 loader），只有契约测试要读打包产物，所以 `npm test` 仍先跑一次 build。

**规模纪律。** 每个 `.ts` 源文件的有效行（非空、且非纯注释行）≤ 400，测试与测试台 ≤ 600。当前实测 62 个 TS 文件、9,215 有效行；最大源文件 337 有效行（`src/evaluator/classify.ts`），最大测试文件 525（`test/evaluator-runtime.test.ts`）。

`package.json` 的关键字段（核查定稿）：

```json
{
  "name": "dsh-direnv",
  "version": "0.1.0",
  "type": "module",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./package.json": "./package.json",
    "./locale/*.json": "./locale/*.json"
  },
  "dsh": {
    "manifestVersion": 1,
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": [
        "@deepseek-ai/dsh-client-ui-sidebar-right",
        "@deepseek-ai/dsh-client-ui-conversation"
      ]
    }
  },
  "peerDependencies": {
    "@deepseek-ai/dsh-subprocess-local": "~0.1.7-rc.1"
  }
}
```

- `platform` 必须**精确**写 `"web"`；`inject` 必须是**精确包名**——两处写歪都是**静默失效**（见 §3.5）。
- `exports` 里 `"./client"` 与 `"./package.json"` 都必须有：前者缺失 = **整机起不来**，后者是元数据/工具链惯例。
- `peerDependencies` 只声明我们真正 import 的 dsh 包，且范围必须**确定能匹配**（见 §3.7 的矩阵与失败签名）。**不要为了「能解析」而声明 peer**——解析走 `ctx.loader.import`。代价要知情：范围不匹配时 DSH 会把整行静默 `disabled`，README 必须给出这个失败签名（`dsh: disabling profile plugin row "…"`）供排查。

### 6.2 `cordis.patch.yml`

```yaml
# 接管 subprocess seam：先关掉官方那一行，再插我们自己的
- id: subprocess
  disabled: true
- insert:
    - id: direnv-subprocess
      name: 'dsh-direnv'
```

顺序要求：bundle 按 `dsh.profile.bundles` 顺序叠加，`dsh plugin add` 把新 bundle 追加到最后，所以我们的 `disabled` 一定落在官方 `subprocess` 行之后。**必须写进 README**（手工装的人容易踩）。

三条实测出来的 patch 语义（都会踩）：

- **顺序依赖是真的**：如果手工重排 `dsh.profile.bundles` 把我们的层排到 `@deepseek-ai/dsh-base` **之前**，`disabled` 会因目标行还不存在而被跳过——`dsh: [<我们的层>] patch: entry "subprocess" not found`，于是**回到「重复注册」那个失败模式**（官方实现占位、我们的类从未挂上）。官方安装路径是追加，所以正常情况安全；但 bundles 顺序是用户可编辑的文档化配置。
- **id 定向 patch 里的 `name` 是「守卫」不是「覆盖」**：与目标当前 name 不符就整条 skip 并 warn。所以**不要**试图用 `- id: subprocess / name: 'dsh-direnv'` 就地换实现——必须走 `disabled: true` + `insert`。另外 patch 里的 `config` 是**整体替换、不是深合并**。
- **`insert[].name` 是一条 ESM 模块 specifier**，以 bundle 自己的目录为基准解析：推荐直接写**包名**；也可以写包名 + `exports` 里导出的子路径；绝对路径可用但不可移植；`./x` 相对的是 **bundle 目录**。写错的表现是条目 `failed to import` 且 **stderr 不给原因**（真因被 cordis logger 吞掉，DSH_HOME 下也没有落地日志），排查成本很高。

### 6.3 三个安装场景

| 场景 | 做法 |
|---|---|
| **本机开发** | `$DSH_HOME/cordis.patch.yml`（或 `dsh --patch <file>`）写 `insert` 指向**构建产物** `lib/index.js` 的绝对路径 + 覆盖 `hmr` 行的 `config.root` 指向仓库根。改 `src/**`/`client/**` 后**必须先 `npm run build`**（TS 迁移前是“改文件即时生效”，现在不是了），HMR 才会重跑 `apply()`。绝对路径入口只挂 host 半边：它不是包、没有 `package.json` 清单，所以**没有侧边栏 tab**。**必须是非空顶层 YAML 数组** |
| **自己的 web profile（长期）** | 改 nixos-config：`programs.dsh.profiles.web.rows.subprocess.disabled = true;` + `extraEntries = [{ id = "direnv-subprocess"; name = "dsh-direnv"; }]` + 包放进 `plugins` |
| **别人（npm / 本地路径）** | 已发布：`dsh plugin --profile <p> add dsh-direnv`；尚未发布时：`npm install && dsh plugin --profile <p> add "file:$PWD"`。⚠️ `file:` 安装走 pnpm 写 `node_modules`，**不要**对 nix 托管的 profile 这么做（见下方警告） |

> ⚠️ **绝对不要**对 nix 托管的 profile 跑 `dsh plugin ... add/remove`，也不要用 Web 侧栏「插件」页开关插件：plugin-manager 用 `writeFileAtomic` 写盘，会把 home-manager 的软链**替换成普通文件**（即使失败回滚也一样，已复现）。

---

## 7. 测试与 spike 清单

按「先证伪最贵假设」排序。1–3 是 go/no-go，做完再写业务代码。

| # | 问题 | 通过标准 |
|---|---|---|
| 1 | **dev 阶段能否裸名 import DSH 包**：`$DSH_HOME/cordis.patch.yml` 指向绝对路径 `.js` 时，`import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'` 能否解析？ | 能。兜底方案：`createRequire(profileDir + '/cordis.yml')`、或从 dsh 安装目录解析 |
| 2 | **替换 subprocess 后 DSH 能否正常启动**（bash 工具、沙箱、GUI、后台任务全绿） | ✅ **已通过**（见 §7.1） |
| 3 | **bundle patch 的 `disabled` 是否真能盖掉 base 的 `subprocess` 行**（在 scratch profile 里验证，别动 web） | 启动日志里 `ctx.subprocess` 是我们的实现 |
| 4 | 缓存命中路径的 overlay 真的到达子进程 | `env \| grep` 能看到 `.envrc` 里的变量与 `PATH` 新增项 |
| 5 | `unset` 墓碑真的删掉继承变量 | `FOO=inherited` + `.envrc` 里 `unset FOO` → 子进程 `env` 里没有 `FOO` |
| 6 | 门闸：`pre-execute` 阻塞期间对话/流式正常，且不触发工具超时 | 阻塞 10s，模型侧无报错，UI 是 running 卡片 |
| 7 | `agent/created` 里 fire-and-forget 不会拖慢/破坏会话创建 | 创建耗时无变化，且后台加载能跑完 |
| 8 | client 半边：composer 占位符生效；右列 tab 与 better-sidebar 共存 | GUI 目视 |
| 9 | `spawnTerminal` 路径（侧边栏终端）吃到 direnv | 终端里 `env \| grep` 命中 |
| 10 | 凭据注入与名单：`.envrc` 里放一个 `GITHUB_TOKEN`，确认子进程能看到、且 sidebar 名单列出它、模型上下文里**没有**它 | 三条同时成立 |

HMR 循环：`hmr` 行 `config.root = ["<仓库根>"]`，`npm run build` 写出 `lib/` 后 `apply()` 自动重跑（换包版本才需要重启进程；改了 `.ts` 却忘了构建，看到的就是“改了没生效”）。

### 7.1 Spike 结果（滚动更新）

**Spike 2 — 透明子类替换 `ctx.subprocess`：✅ 通过。** 在 scratch profile 里真启动验证：

- `ctx.subprocess.constructor.name === 'SpikeRuntime'`，`instanceof` 成立，覆写的 `spawn` / `spawnTerminal` 都被调到。
- 真实消费方链路穿过我们的类：`ctx.shell`（`SandboxBashExecutor`）→ 我们的 `spawn` → `landlock-run --ro / --rw … -- bash -c …` → 退出码 0、stdout 可读。
- **注入机制成立**：`spec.env` 的值到达子进程，同时 ambient 的 `DSH_*` 被 `scrubbedParentEnv()` 清掉。
- **反向对照**：删掉 `disabled: true` ⇒ `Error: service "subprocess" has been registered at <LocalSubprocessRuntime>`。**那两条 patch 是必需的。**

由此得到三条必须写进代码的修正：

1. **`SubprocessHandle` 没有 `readOutput()`。** 那是 `ctx.shell` 的 `ShellProcess` 才有的（消费式游标）。subprocess 层读收集输出是 `handle.collected.stdout.readFrom(offset)` → `{ text, nextOffset, lossy, spillPath? }`（非消费、按 offset）。求值器读 direnv 输出要走后者。
2. **类插件没有独立的 `apply(ctx)`**——`Fiber.execute` 对带 prototype 的插件执行 `new Plugin(ctx, config)`，**构造器就是 apply**；且 `unwrapExports = exports.default ?? exports`，同时导出默认类和具名 `apply` 时只有默认导出生效。所以主类把初始化写在构造器里，不要指望另挂一个 `apply`。
3. **静默降级是真风险**：`disabled: true` 生效、而我们的 entry 激活失败时，boot **不会崩**——只有一行 `warning: N entries did not activate`，然后 `bash-sandbox / terminal-controller / workspace-changes …: pending (waiting for service: subprocess)`，web 照常打印 URL。**用户会得到一个没有 bash 工具的 harness。**
   → 因此插件必须自带**启动期硬断言**：在构造器里校验锚点解析、原型链身份、`super(ctx, 'subprocess')` 注册成功，任何一步失败都打出**显眼到无法忽略**的日志（而不是依赖 cordis 的那行 warning）；README 里给出这个失败签名供排查。
   → 同理，锚点必须**动态发现**（遍历候选 bundle 目录），不能硬编码带 peer-hash 后缀的 store 路径。

**Spike 2 的独立核查（补充与更正）**

- **⚠️ 自检时不能用 `constructor.name` 或方法身份**：`ctx.subprocess` 是 cordis 的 **traceable Proxy**（连未覆写的官方实现都有 `ctx.subprocess.spawn !== Base.prototype.spawn`），而且**在构造器里 `ctx.subprocess === this` 是 `false`**（消费者拿到的是代理）。可靠的判据只有三个：`Object.getPrototypeOf(live) === YourClass.prototype`、`live instanceof YourClass`、以及**行为计数**（自己发一次 spawn，看覆写有没有被调到）。启动期硬断言必须按这三个来写。
- **降级时模型侧连工具都没有**：在 headless profile 里复现同一失败，清单是 `tool-bash: pending (waiting for service: shell)`、`tool-fs-search: pending (waiting for service: subprocess)`——不是"调用报错"，而是**工具根本没注册**。（注意：web 的全局工具目录在健康启动下同样为空，因为工具是按 agent scope 注册的，所以"目录为空"不能当证据。）
- **插件形态的准确规则是 `isConstructor`（函数有没有 `.prototype`）**：`export function apply`（仅具名）**会被 `new`**、`export default function(){}` 会被 `new`、`{ apply: function(){} }` 会被 `new`；只有**方法简写** `{ apply() {} }` 是普通调用。被 `new` 不会崩（`ctx` 照传），但 `this` 语义不同——**不要依赖 `this`**。
- **墓碑与凭据注入都可靠，可以依赖**：核查方在子进程里用 `[[ -v ]]` 与 `/proc/<pid>/environ` 做了 OS 级复核（含 PTY 路径）——`spec.env` 里的 `undefined` 确实把继承变量删掉（且是「在继承基线上删」而不是「空环境」），显式字符串也确实能复活被清洗的凭据类变量。
- **harness 的清洗规则比原先记的更宽**：`DSH_` 前缀（**大小写不敏感**）+ **子串**匹配 `/KEY|PASSWORD|SECRET|TOKEN/i`。后果：`MONKEY_BUSINESS`、`TURKEY_MODE`、`dsh_lower` 这类无辜名字也会被子进程环境剔除（若 `.envrc` 显式提供则能活下来）。这是 harness 的固有行为，写进 Known Limitations。
- **bundle patch 里 `insert` 与 `disabled` 的先后顺序无关**（`insert` 永远追加到组合树末尾），所以写法不脆弱。
- **正式 npm 安装根本不需要锚点**：把插件放进 `profiles/<p>/node_modules/` 之后，裸名 `import`、`createRequire(import.meta.url)`、`import.meta.resolve` **全部可用**；锚点方案只服务于「profile 之外的绝对路径」这种开发形态。
- 未验证：spill 恢复分支（该 profile 没配 spill，`spillPath` 一直是 `undefined`）；Windows/pwsh；**真实 pnpm 安装下是否会出现第二份 `@deepseek-ai/cordis` 导致 Service 基类身份分叉（最大残留风险）**。

**Spike 5 — 端到端测试台（假 LLM）：✅ 通过。** 用一个本地假 LLM（`node:http` + `openai-completions` 的 SSE 子集）+ `dsh headless --json`，在没有 API key、没有浏览器的情况下跑通了**真实 turn + 真实工具执行**（`tool_result.result === "STUB-LLM-OK\n"`）。由此：

- **门闸端到端证实**：`tools/pre-execute` 里 `await sleep(3000)` ⇒ `gate enter → 3001ms → gate exit → tools/result`；负对照（0ms）只隔 1ms。**设计里 Q5/Q6 的门闸行为成立。**
- **`agent/created` 必须 fire-and-forget（已实测）**：`return undefined` ⇒ listener 返回到首个 LLM 请求只隔 +232ms；`await` 一个 3000ms promise ⇒ +3199ms（差值 2967ms）。**在那里 await 就等于卡住会话创建。**
- **门闸必须永远 `return next()`**：`tools/pre-execute` 是**逐次调用**的 waterfall；监听器若不调 `next()` 而返回 `undefined`，上层会直接读 `gate.kind` 而抛 TypeError，被吞成工具错误结果（**此条为源码推断，核查中**）。所以门闸用「一个已经 resolve 的 promise」做幂等，绝不能裸 `return`。
- 测试台运行姿势（写进 README 的"如何验证"）：**不需要** `DSH_PERMISSION_MODE=danger-full-access`（核查已证伪——默认 `workspace-write` 下写 `/tmp` 直接成功，因为沙箱把整个 `/tmp` 加进了可写根；`read-only` 下被拒也是以工具结果返回；三种情形都不会悬挂。用默认模式反而顺便验证了沙箱路径）。另外：`DSH_TELEMETRY_DISABLED=1`、`env -u DSH_PROFILE_DIR`、`--json` 是**内层 app 参数**（必须在 `--patch` 之后）、`--from-default-profile` **仅首次可用**（重复会报 profile 已存在）、假 LLM 必须按「请求里有没有 `tools`」分流（session-title 会插一个无 tools 的请求）且**必须给一个非空 dummy key**。

**Spike 4 — client 半边：✅ 通过（服务端分发层面），独立核查后修正如下。** 核查方自建 7 个对照包、并在 Node 里直接跑 `SlotCore` 运行时复现，结论：

- **`key` vs `id` 是响亮失败**（四级证据：类型声明 / 运行时 `throw` / 官方 guide 自身 / 真实第三方 `dsh-better-sidebar`）。但报错时机分两种：槽位声明**已存在**→同步抛；**尚不存在**→`queueMicrotask` 的全局未捕获错误，插件自己的 `try/catch` 兜不住。
- **两个新的静默陷阱**：`dsh.client.platform` 是字符串但不等于 `"web"` ⇒ **静默丢弃**（boot 图里没有你这一行、零警告）；`dsh.client.inject` 里的名字不做 `stripClientSuffix` 归一化 ⇒ 写 `<pkg>/client` 形态也**静默失效**。真正的 loud 只有三种（缺 `exports["./client"]` / platform 非字符串 / `exports["./client"]` 指向的文件不存在），代价是**整个 web app 起不来**（rc=1、无 URL、`client-hmr` 连坐）。
- **`/plugins/*` 默认无围栏**（无 cookie 也 200、外站 Host/Origin 也 200、无 CORS 头）→ 我们的状态路由必须自己上闸。
- 分发确认字节级（核查方自己 curl 并复算 offset 4847775、58 个 `__ModuleLoader__.load`）。`rev` 的公式被离线复算命中：`framedHash("plugin-artifact", [mtimeMs, ctimeMs, size])`——**不是内容哈希**，所以 `touch` 一下就会换 rev。
- 开发循环注意：**改任何 client 文件都会让整条 5.5 MB 应用批 combo 换 rev**（缓存头是一年 immutable，等于整包重下）；而且**运行中改文件不会自动重组**（要靠 client-hmr 的 watch 或重启），"改了没生效"是预期行为。

**Spike 6 — direnv 求值器的语义与边界（direnv 2.37.1）：3 个设计级修正 + 1 个安全洞。** 这是本轮最有价值的一份，因为它**推翻了一个原本写进设计的前提**：

1. **【安全】base env 必须剔除全部 `DIRENV_*`。** 如果 dsh 本身是从一个被 direnv 加载过的 shell 里启动的，`DIRENV_*` 会经 `scrubbedParentEnv()`（它只按 `/KEY|PASSWORD|SECRET|TOKEN/i` 与 `DSH_*` 过滤，**不管 `DIRENV_*`**）漏进我们的求值调用，于是 `direnv export json` 走的是「从上一个目录卸载」的语义，实测三个后果：① 上个目录的变量变成墓碑 `"FOO": null`；② **`DIRENV_DIFF` 的 `p` 段里存着旧值，卸载时会把 harness 刚清洗掉的密钥原样写回**（实测 `"MY_SECRET_TOKEN": "the-real-secret"`）；③ 宿主后来改过的变量被回滚成加载时刻的旧值（PATH 被改回去）。④ 更隐蔽的：三者齐全且 watch 文件未变时 direnv **直接短路**（exit 0 + 空 stdout + 空 stderr），与「没有 `.envrc`」**完全同签名**。
2. **【前提推翻】direnv 没有任何跨进程缓存。** 原设计写的「不做插件层缓存，靠 direnv 自己的 RC 缓存 + `watch_file`」是**错的**：默认 `XDG_CACHE_HOME` 下实测 `~/.cache/direnv` **从未被创建**（strace 里含 "cache" 的路径 0 个、`~/.cache` 快照零变化），同一个 allowed `.envrc` 连跑 5 次全是 **40–48ms（热 = 冷）**，`.envrc` 真被执行 5 次；而**剔除 `DIRENV_*` 之后 `watch_file` 完全不起作用**。→ 改为**分级 memo**（只按 `DIRENV_WATCHES` 缓存是错的，见下条核查）。代价结构：进程启动 ~5–10ms + bash/stdlib ~35ms + `.envrc` 自身（真实 nix 工作区热 0.13–0.25s、**冷 4.3s**）。注意：没有 memo 时付费的是**每个预热点**（`agent/created` 与每次 `tools/pre-execute`），**不是每个子进程**——`spawn()` 只做纯查表。
3. **【分类规则】exit code 几乎没有用。** `is blocked` 是唯一稳定的文本判据（stderr **恒带 ANSI**，`NO_COLOR`/`TERM=dumb`/非 TTY 都无效）；`.envrc` 里 `source` 缺文件、甚至**语法错误**都返回 **exit 0** + 合法但可能不完整的 overlay；`.envrc` 里 `exit 7` 的 exit code **仍然是 1**；`.envrc` 被 chmod 000、被 `direnv deny` 过这两种情况**无法与 absent 区分**。另外：**absent 是空 stdout 而不是 `{}`**；非 0 退出时**绝不要解析 stdout**（blocked 也给合法 JSON）。
4. **direnv 自身零写入**（strace：带写标志的 `openat` 只有 `/dev/null` 与一次失败的 `/dev/tty`；工作区前后快照一致）——但**`.envrc` 本身是以宿主用户身份、无沙箱执行的任意 bash**，实测可任意写文件，nix-direnv 会写项目内 `.direnv/` 与 `~/.cache/nix`。所以「是否求值」等价于「是否信任这个目录」，v1 坚持复用宿主已有的 allow 状态。

**Spike 5 的独立核查**：用 **durable session log**（不依赖 stdout）重测，门闸 Δ=7176ms（gate 7000ms）、`agent/created` await Δ=2987ms，工具结果与 0ms 对照组**逐字节一致**。三条新增：

- **「不调 `next()`」从源码推断升级为实测**：结果 `isError=true`、文本 `Error: Cannot read properties of undefined (reading 'kind')`——**内部 TypeError 原文会暴露给模型**；工具 body 完全不执行，turn 不崩。→ 门闸必须永远 `return next()`（或返回 `{kind:'deny'|'cancel'}`）。
- **门闸会把同一步的并行工具调用串行化**：2 个并发安全的 `read` + gate 2000ms ⇒ 总 4012ms（gate 0ms 时 25ms）。对本设计可接受——门闸 promise 只解析一次、之后立即放行；但**加载期间**同一步的 N 个调用会退化成 N 倍等待，这点要在 README 里说明。
- 缺 `finish_reason` 时 `llm-retry` 会**重试 5 次（约 16s）**才报 TRANSPORT 错误——调试假服务时别误判成卡死。

**Spike 6 的独立核查（补充与更正）**：

- 密钥复活与墓碑**都独立复现**，机制定位到字节（`DIRENV_DIFF` 的 `p` 段在 `Revert()` 时被**无条件按名字写回**）。**短路其实只需 `DIRENV_FILE` + `DIRENV_WATCHES` 两个**（`DIRENV_DIR`/`DIRENV_DIFF` 无关）；只丢 `DIRENV_DIFF` 就能兼得安全与短路——但默认仍**全剔**（语义最干净）。
- **`includes('is blocked')` 有 false positive**：`.envrc` 自己 `printf` 一行就能伪造（连行锚定正则也被骗）→ 判据必须是「`direnv: error` 行**恰好一条**」且匹配模板（已写进 §3.2 代码）。
- **空 stdout 有 4 类来源**（无 RC / 不可读 / `.env`-only 且 `load_dotenv=false` / 短路）→ 消歧只能靠**我们自己的 `stat`**。
- **新失败形态**：`direnv.toml` 解析失败 → exit 1 + **stdout 全空**；`.env`-only 且 `load_dotenv=false` → exit 0 + 空 stdout（**与 absent 不可区分**）；`.envrc` 里 `exit N` 会**丢弃该 `.envrc` 此前的全部 export**（与「语法错误之前的变量照样生效」正好相反）；`chmod 000` 之后 direnv **连墓碑都不发**，**永远无法卸载**。
- **memo 有净负面风险**：`lib/*.sh`（**nix-direnv 就在这儿**）与 `direnv.toml` **都不在 watches 里**，只用 watches 做键会在这些输入变化时返回**陈旧值**——比干净求值更差。→ 分级 memo（见 D7 与 §3.2）。
- `use flake` **热跑也会重写 `.direnv/`**（mtime 每次都变），所以 `.direnv/` 不能作为 memo 的监视对象（会自我失效）。
- 语义澄清：`load_dotenv` **不是**「额外加载 `.env`」，只是把 `.env` 加入 RC 查找列表。

**Spike 3 的独立核查：结论成立，但「关键因果链」被证伪——真相比原来更危险。**

- ✅ bundle patch 的 `disabled` **能**盖掉 base 那一行（端到端：自写探针拿到 `VerifySubprocessRuntime`、spawn 成功）；去掉 `disabled` ⇒ 重复注册，而且探针拿到的仍是**官方实现**——「看起来装了但没生效」。
- ✅ **真实 pnpm 安装形态也测了**：`dsh plugin add file:<dir>`（`nodeLinker: hoisted`，最接近 npm 装）**有没有 peer 都能用**；只有 `link:` 形态才需要 peer。
- ❌ **原报告把「版本范围不符」和「一串 pending」绑在一起是错的**：范围不符时**整个 bundle 被跳过 ⇒ 补丁从未应用 ⇒ 官方 subprocess 健在 ⇒ `--dump-config` 与装前逐字节相同、启动零 pending、web 完全正常**。「一串 pending」属于另外两个场景：补丁打了但 entry import 失败（`link:` 无 peer），或用户在用户层把我们的 entry 关掉。
- 🆕 **三道闸门**（bundle 级跳过 / row 级 preflight / 安装期硬拒），且 **`--dump-config` 不跑 row 级 preflight**——它不能作为「启动时到底挂载了什么」的可信预言。
- 🆕 **诊断分家**：patch 自身的警告只在 `--dump-config` 的 stderr；row 级 compat 拒绝只在启动时。**排错必须两边都看。**
- 🆕 **patch 字段语义**：id 定向 patch 的 `name` 是**守卫**（不符即整条 skip），`config` 是**整体替换**——所以「就地改写实现」不可行。
- 🆕 **顺序依赖是真的**：手工重排 bundles 让我们的层排到 base 之前 ⇒ `patch: entry "subprocess" not found` + 重复注册那个失败模式。
- 🆕 **`insert[].name` 规则比原报告宽**：它是一条以 **bundle 目录**为基准的 ESM specifier（包名 / 包名 + `exports` 导出的子路径 / 绝对路径 / `./x` 相对 bundle 目录）；写错的表现是 `failed to import` 且 **stderr 不给原因**（真因被 cordis logger 吞掉）。

**Spike 1 的独立核查：头条建议被证伪，改用 `ctx.loader.import`。** 核查方跑了 12 个场景的矩阵：

- **原结论「唯一可靠机制是 `createRequire(<profile 锚点>)`」不成立**——`ctx.loader.import(spec)` 在**全部 12 个场景**成功（树外绝对路径插件、profile 无 `node_modules`、软链安装、无 `profileContext`），而且更简单。原报告自己的候选表里就写着 `loader.import` 裸名 OK，属于自相矛盾。**最终配方见 §3.7。**
- **前缀判据要精确化**：是**词法字符串前缀**（`..` **不**规范化，所以 `<home>/profiles/../x.yml` 命中而 `<home>/x.yml` 不命中）；`<home>/profiles`（无尾斜杠）不命中、`<home>/profiles/` 命中。另有**第二条独立机制**：活动 profile 的 `node_modules` 下指向树外的软链，其 realpath 也算「有拦截层」，但路由更严（只认安装闭包 + 该包自己声明的 peer 键名）。
- **peerDependencies 矩阵**（对发布包最关键）：非 `@deepseek-ai/dsh*` 的包**范围永不被校验**（`schemastery: ^99.0.0` 照样解析成功）；`dependencies` 不参与解析；`workspace:` 不帮助解析；软链形态**无法**解析 profile 本地包（`ctx.loader.import` 可以）。
- 原报告「返回另一个 Nix store 路径可作旁证」被判定**无效**：拦截路径与原生路径返回同一个 `.pnpm` 目标，store 路径区分不了两条路由。

---

## 7.2 实现期端到端证据（`direnv-smoke`）

设计阶段的所有结论最终要落到一次**真启动**上。这一节记录第一版实现的端到端结果，它是"这个插件真的能在 DSH 里工作"的判据。

**用例**（`test/harness/cases/direnv-smoke.ts`）：从官方 `headless` 模板初始化一个 scratch profile，仓库软链进该 profile 的 `node_modules/dsh-direnv`，overlay 里写入与 `cordis.patch.yml` 相同的两行（`- id: subprocess / disabled: true` + `insert: direnv-subprocess / name: 'dsh-direnv'`），工作区放一个 `.envrc`（`SOME_DIRENV_VAR=direnv-smoke-ok`），然后让假 LLM 命令模型用 `bash` 工具把它打印出来。

**放行 fixture 的方式**：不碰用户真实 allow 库（实测零写入）。在 scratch 里用 direnv 官方的 `[whitelist] prefix` 配置直接放行 fixture 目录，再让整个 `dsh` 子进程带上该配置目录的环境变量。裸 direnv 负对照：不带配置 → `exit 1` + `is blocked`；带配置 → `exit 0` 且 `SOME_DIRENV_VAR` 出现在输出里。

**决定性证据**（durable session log；下面是**独立核查员用 `--strict-audit` 复跑**的产物，不是首次尝试的产物——首次那次的运行目录已被后续运行覆盖，引用它会造成"声明与产物不符"）：

```
{"type":"tool/call",   "seq":17,"time":1790404150930,"data":{"callId":"call_fake_1","name":"bash",
   "arguments":"{\"command\":\"bash -c 'echo DIRENV_SMOKE=$SOME_DIRENV_VAR'\",…}"}}
{"type":"tool/result", "seq":18,"time":1790404151157,"data":{"message":{"role":"tool","toolCallId":"call_fake_1",
   "content":[{"type":"text","text":"DIRENV_SMOKE=direnv-smoke-ok\n"}],"isError":false}}}
```
`+294ms → +521ms`（Δ227ms），`=== RESULT: PASS (15/15 assertions) ===`，`audit={"changed":[],"added":[],"removed":[]}`，`processes={"fakeLlmAlive":false,"dshAlive":false}`。

一次真 DSH 启动里，`bash` 工具读到了**只存在于工作区 `.envrc` 里**的变量；`dsh.err`/`dsh.out` 无任何降级签名。注意审计项默认是 **WARN 级**（开发期仓库常有并发写入），要它成为断言必须加 `--strict-audit`。

**核查员的负对照（新增 8 个用例，未改既有文件）——这才是"原测试确实测的是插件"的证明**：

| 对照 | 做法 | 结果 |
|---|---|---|
| **拆掉插件** | 同样的工作区与白名单，只去掉那两行 patch | `PASS 15/15`；`bash` 工具**仍在**（`--dump-config` 显示官方 `@deepseek-ai/dsh-subprocess-local` 且未 disabled），输出**恰好是空值** `DIRENV_SMOKE=\n`，全程 0 次 `[dsh-direnv]` 痕迹 |
| **随机值** | 每次运行现生成 UUID 写进 `.envrc` | 输出与当场生成的值逐字节相等；该 UUID 在 `fake-llm.requests.jsonl` / `overlay.yml` / `dsh.err` 中出现 **0 次** → 排除"假 LLM 回显期望值" |
| **运行时生成值** | 值在 `.envrc` 内 `od /dev/urandom` 现生成 | 通过；该字面量**在任何输入文件里都不存在** |
| **门闸 vs 对话** | `.envrc` 含 `sleep 2`，探针 `gateMs:0` | `tool/call → tool/result` = **1996ms**（被卡住），而首个 `request/header` = **+164ms**（快 `.envrc` 基线 +163ms）、`agent/created → 首个带 tools 的请求` = 281ms（基线 268ms）→ **卡的是工具，不是对话** |
| **阻塞路径** | 无白名单，真 blocked | 工具照跑不挂死、输出空值、exit 0；模型在首个请求**之前**收到 blocked 通知，且文案明确"不要自己去 allow" |

> 测法提醒：探针自己的 `gate/enter→exit` 只有 0–1ms，因为探针的 waterfall 监听器注册在插件监听器**之前**，插件的 `await` 发生在探针的 `next()` 内部。照抄探针数字会得出"门闸没卡"的错误结论；要看 `tool/call → tool/result` 或 `gate/exit → dispatch/enter`。

**这一条同时验证了设计里最难串起来的几件事**：

1. bundle patch 的两行确实顶掉了官方 `subprocess`，并且我们的子类**赢了那个座位**（否则 bash 工具根本不会注册，或拿到的是官方实现 → 变量为空）。
2. `ctx.loader.import` 在「profile 内软链」这种安装形态下解析成功（§3.7 的首选路线）。
3. `spawn` 的纯查表 + 预热点求值这条链路，在真实工具调用里把 overlay 送到了子进程。
4. 求值前的 `DIRENV_*` 剔除没有破坏正常路径（否则 dirty 环境会污染结果）。
5. **模型通知也生效了**：`agent/inbox/spliced` 里出现了 `[dsh-direnv] direnv loaded …`，随后作为 `user/message` 进入上下文——即 §3.1 的一次性 sourced 消息在真 harness 里走通了（且这里走的正是"未被 claim 时用 inbox 排队"那条分支）。

**client 半边的交付级验证**（无浏览器环境，这是能做到的最强一级）：从官方 `web` 模板起一个 scratch profile，同样用软链把仓库挂进 profile 并打上我们的 patch，`dsh --profile client --patch overlay.yml --no-open --port 45999` 启动。**注意 app 由 profile 模板决定，不要写 `web` 子命令**——带上 `--profile` 再写 `web` 会得到 `error: too many arguments. Expected 0 arguments but got 1: web`。

结果：

- `web.err` **全空**——没有 `did not activate` / `pending` / `has been registered`，说明插件在 web profile 里同样正常接管了 `subprocess`。
- 启动载荷里确实有我们那一行，且 `inject` 与 `package.json` 完全一致：
  `{"id":"dsh-direnv","url":"plugins/??dsh-direnv/client.js&rev=7e2fc35499fb","rev":"7e2fc35499fb","inject":["@deepseek-ai/dsh-client-ui-sidebar-right","@deepseek-ai/dsh-client-ui-conversation"]}`
- 它还被排进了**应用批预载**（combo 的 `preload` 链接里包含 `plugins/??dsh-direnv/client.js`），说明 `platform: "web"` 被正确接受，不属于"字符串但不等于 web"那种静默丢弃。
- 取回模块本身：`http=200 bytes=57016`，与构建产物 `lib/client.js`（56949 B）**前 56949 字节逐字节相同**，多出的 67 字节正是官方分发层追加的 `;\n//# sourceMappingURL=??dsh-direnv/client.js.map&rev=…`。
- 官方 `dsh-client-ui-sidebar-right` 仍在载荷里（我们没有顶掉它）。

> 仍未验证（无浏览器）：tab 是否真的渲染出来、composer 是否真的变灰、Toast 是否真的 3 秒消失、真实 `SlotCore` 的抛错路径与 CSS 布局。这些只能在有浏览器的环境里过一遍。

**真实安装形态（`dsh plugin add`）的端到端验证**——风险表上那条「最大残留风险」的针对性实验：

```bash
dsh --profile installed --from-default-profile headless --dump-config   # 建 profile
dsh plugin --profile installed add file:/path/to/dsh-direnv            # 真 pnpm 安装（3.3s，+4 包）
dsh --profile installed --patch <llm-only overlay> --json "…"          # 真跑一轮
```

结果：

- 安装把 `dsh-direnv` **追加到 `dsh.profile.bundles` 末尾**（`["@deepseek-ai/dsh-base","@deepseek-ai/dsh-headless","dsh-direnv"]`）——顺序要求天然满足。
- **没有出现第二份 `@deepseek-ai/cordis`**（在 profile 的 `node_modules` 下枚举 `cordis/package.json` 为 0 条），插件也不直接依赖它；`Service` 基类身份分叉的担忧在真实安装路径上**实测不成立**。
- `--dump-config` 里出现 `# == dsh-direnv` 层与 `- id: direnv-subprocess`，且 dump 的 stderr 干净（patch 警告会只出现在那里）。
- **完整一轮跑通**（overlay 只有 LLM 行，插件行完全由已安装 bundle 的 patch 提供）：
  `{"type":"tool_result","callId":"call_fake_1","status":"completed","result":"INSTALLED_SMOKE=installed-smoke-ok\n"}`，`dsh exit=0`，无任何降级签名，最终文本只出现一次。

**尚未由端到端覆盖**：无（慢求值门闸、阻塞路径、真实安装形态都已在 2026-09-26 的核查里补上）。

> ⚠️ **核查发现的一个真 bug（已派修）**：`loadTimeoutMs` 当时被**同时**当成门闸预算与求值子进程的 kill 期限，于是超时不但放行工具，还会**杀掉求值**——慢 `.envrc`（冷 `use flake`）或调小该值的用户**永远拿不到环境**，而且非 ok 记录会让后续 spawn 不再重试。这与 §4 超时行、§8 风险表、`gate.js` 的 "continuing in the background" 日志以及 README 的承诺**互相矛盾**。正确语义是 D6 写的：门闸放行与求值完成是两件事，需要**各自独立的预算**（新增 `evaluateTimeoutMs`），且**瞬时失败**（超时/被杀/spawn 失败）必须让 `peekEnv` 返回 `undefined` 以便下次重试。
>
> ✅ **已修复**：上面那段历史保留，作为「承诺与实现不符」的案例。现在的实现是两个独立预算——`loadTimeoutMs`（默认 300000）只给门闸，求值器新增 `evaluateTimeoutMs`（默认 `0` = 永不杀，代价与兜底见 §8 风险表）；`peekEnv` 对 `error`（超时/被杀、spawn 失败、crash、bad-json、max-buffer）一律返回 `undefined`（瞬时，下一次 spawn 重新 prewarm），对 `absent` / `blocked` / `unreadable` / `envrc-failed` / `config-error` / `direnv-unavailable` 仍返回 `{}`（确定结论，不在每个子进程上重跑 direnv）。回归测试：`test/evaluator-runtime.test.ts` 的三个新用例（瞬时失败重试、确定结论不重跑、并发 prewarm 去重）加 `test/harness/cases/verify-timeout-continue.ts` 的端到端复现。

---

## 8. 已知限制与风险

**结构性限制（无法绕过，写进 README）**

1. MCP server 进程与宿主 helper 拿不到 direnv 环境（它们不走 `ctx.subprocess`）。
2. 安装 = 接管 `ctx.subprocess` 一行；若组合里换成别的 subprocess provider（例如远端 SSH 那种），本插件会把它盖住。
3. `spawn()` 是同步的，所以**非预热路径**（用户直接点开一个此前没访问过的目录的终端）在 `spawnTerminal` 覆盖范围之外不会有环境——实际上 PTY 走异步的 `spawnTerminal`，所以只影响「别的东西在冷目录里 spawn」这一小类。

**风险**

| 风险 | 缓解 |
|---|---|
| ~~**真实 pnpm 安装下出现第二份 `@deepseek-ai/cordis`** ⇒ `Service` 基类身份分叉~~ | **已实测证伪**（§7.2）：`dsh plugin add file:` 真装后 profile 下 0 份 `cordis/package.json`，完整一轮注入跑通、无降级签名 |
| 与 `LocalSubprocessRuntime` 内部契约耦合，DSH 升级可能破裂 | 用 `peerDependencies: ^0.1.7-rc.1` 让 DSH 在版本不匹配时**大声拒绝**加载，而不是静默出错 |
| 首次 `use flake` 构建 > 300s（门闸预算） | 门闸按时放行，求值**不中断**（`evaluateTimeoutMs` 默认 0 = 不杀），缓存写好后下一条命令自动带上 |
| 死循环 `.envrc` 永不结束（不杀默认的代价） | 每目录只有**一个** `direnv` 子进程（in-flight 去重，反复 prewarm 不会叠进程）、4MB 输出上限、`signal` 仍能杀；需要硬兜底就把 `evaluateTimeoutMs` 设成有限值 |
| **超时/中止只保证「不再等」，不保证被杀的 `.envrc` 没有副作用** | 进程组 SIGKILL 保证不留孤儿（direnv + bash + 孙进程一起死），但它在被杀之前可能已经写过文件、起过服务、改过 git 状态。要靠「根本不执行」来保证无副作用，只能靠 allow 库（不批准）与 `enabled: false`，而不是超时 |
| Windows 上杀掉子进程不等于杀掉它的子进程 | `detached` + `kill(-pid)` 是 POSIX 语义；Windows 不建进程组、退化成单 pid kill（且 `kill(-pid)` 抛错被吞掉，绝不让 evaluate 挂住）。v2 才做 pwsh 实测 |
| memo 内容指纹多读文件（68 KB 级 `.rc` 每次预热点 +1 ms 量级） | 只对「配置文件 + `.direnv` 缓存 watch」内容寻址，普通 watch 项仍是 `mtime+size`；预热点只在未知目录 spawn 与工具门前发生 |
| 凭据暴露面扩大 | D8：名单给用户看 + `injectSensitive` 开关；README 显著位置说明 |
| 模型把 `HOST`/`PORT` 之类的 dev 变量误当成生产值 | 一次性提示里写明「这些来自本工作区的 `.envrc`」 |
| **`diffPathEntries` 在 PATH 完全不相交且极长时是 O(n²)**：每个 new 分量都要从游标处线性扫描 base 找配对 | 两次独立测量：2000 条 47–52 ms、5000 条 192–217 ms、10000 条 300–506 ms、20000 条 1594–1793 ms。真实 PATH 是几十到几百条，只有病态 `.envrc` 才造得出几万条，`PATH` 还受 direnv 输出上限约束。**未优化**：真实量级无影响，而重写配对逻辑会多出一类「删除条目不丢不重」的出错面 |
| **纯重排的 PATH 不给模型任何 PATH 提示**：`.envrc` 只是把已有条目换顺序时，差分全是 `unchanged`，`src/notice.ts` 的 `pathCounts` 报 0 增 0 删，模型侧不会收到任何 PATH 相关文案 | 这是有意的：模型拿到的环境本身是对的，重排不需要它做任何事（`ms` 变了仍会有一条不带 PATH 计数的「re-evaluated」）。旧实现同样如此，属**非回归**；记在这里，避免以后被当成 bug 反复调查 |
| `writeFileAtomic` 毁软链 | 文档三令五申，安装路径只给 nix 模块与 bundle 两条 |

---

## 9. v2 候选

1. **`direnv allow` / `block`**：走 `ctx.approval` 的一次性审批，由插件在宿主进程执行（模型在沙箱里自己跑会 `permission denied`——`--ro-bind / /` 把 allow 库变成只读，已实测）。
2. **保守入口 `dsh-direnv/shell`**：只替换 `ctx.shell`，给不想让第三方插件站在所有子进程关键路径上的人。
3. **给上游提 issue**：把「任意 env 贡献者」做成正式缝隙（`ctx.shellEnv` 现在只收 `DSH_*`）。`mise` / `asdf` / dotenv 用户是同一类需求，本插件可以当参考实现。
4. Windows / pwsh 实测。
5. 导出「本工作区环境快照」，便于排查「为什么这条命令在终端里能跑、在模型手里不行」。
6. **真·按工作区禁用 + host 写接口**：D9 原本的「本工作区禁用」需要一条带写语义的 host 路由（例如 `POST /plugins/dsh-direnv/workspaces.json`，同样必须自己上闸），把「这个目录不注入环境」记在 host 侧而不是浏览器里；配套的 client 按钮才不再骗人。要一并想清楚写接口的鉴权/CSRF、记录存在哪、以及它与 `disabledDirs` 的关系（缓存失效粒度）。

---

## 附录 A：关键证据索引（DSH 0.1.7-rc.1）

| 事实 | 位置 |
|---|---|
| `ctx.shellEnv` 只收 `DSH_*`，键名校验会抛错 | `dsh-shell-env/lib/index.js:58-78`、`lib/types/index.d.ts`（`BashEnvContributor`） |
| 工具参数**不可改写** | `dsh-tools/lib/types/index.d.ts:437-447`（`PreToolDecision` 注释）；`hook-protocol/lib/types/types.d.ts`（`updatedInput` "PARSED but NOT honored"） |
| `ShellExecutor` 只有 `resolve`/`execute` 两个抽象方法 | `dsh-shell/lib/types/index.d.ts:61-69` |
| `SandboxBashExecutor extends LocalBashExecutor`（替换执行器的官方范本） | `dsh-bash-sandbox/lib/index.js:32` |
| env 合并顺序与 `ENV_OVERRIDES` | `dsh-bash-local/lib/index.js:22-27, 107-128` |
| 凭据清洗与 `scrubbedParentEnv` 导出 | `dsh-subprocess/lib/index.js:32, 50-56`；导出表末行 |
| `env` 的墓碑语义 + 「显式字符串是 caller opt-in」 | `dsh-subprocess/lib/types/types.d.ts:90-98` |
| `LocalSubprocessRuntime` 是公开导出、`spawn` 同步 | `dsh-subprocess-local/lib/types/index.d.ts:22-51`、`lib/index.js` 导出表 |
| bwrap 三个 profile 都**不**清环境 | `dsh-sandbox-local/lib/index.js:22-39, 301-340` |
| `agent/created` 监听器被 await、抛错会让创建失败 | `dsh-agent/lib/types/runtime-types.d.ts:227-234`；`dsh-agent/lib/index.js:572-588` |
| `tools/pre-execute` 先落盘 `tool/call`，再跑 waterfall | `dsh-agent-loop/lib/index.js:574-583`；`dsh-tools/lib/index.js:3225` |
| 工具超时挂在更晚的 `tools/execute`，门闸不会触发它 | `dsh-tool-call-timeout-policy/lib/index.js:115-141` |
| `agent/status` 只有 `idle`/`running`，插件无法设文案 | `dsh-agent/lib/types/runtime-types.d.ts:90, 252` |
| composer 占位符 / Toast 的官方 API | `dsh-client-ui-conversation/lib/types/client/contract/composer-blocks.d.ts`、`contract/input.d.ts:186, 227-232` |
| 官方右列 tab 两阶段注册 | `dsh-client-ui-sidebar-right/lib/types/client/index.d.ts:18-46`、`tab-registry.d.ts:71-133` |
| host→client 无通用推送（硬编码白名单） | `dsh-api-remotes/lib/types/remote-events.d.ts:12-81` |
| bundle patch 语义（`disabled` 按 id 断言；`insert` 追加） | `dsh-app-boot` 内嵌 schema 描述；`dsh-package-manifest/lib/types/types.d.ts` |
| 官方插件开发 skill（含 practices「用最弱的机制」） | `<dsh-agent-preset>/skills/cordis-plugin-development/` |

**本机实测**：`direnv 2.37.1` 只加载最近的 `.envrc`；`direnv export json` 对 unset 输出 `null`；DSH 沙箱下 `direnv allow` 写 allow 库被拒（`--ro-bind / /`）；沙箱只允许写工作区与 `/tmp`。

## 附录 B：被否决的路线

| 路线 | 否决原因 |
|---|---|
| 用 `ctx.shellEnv` 注入任意变量 | 键名强制 `DSH_*`，`PATH` 这类变量根本进不去 |
| Claude-Code 风格 hook 改写命令为 `direnv exec . ...` | 输入改写被明确排除（`updatedInput` 只解析不生效）；且 `direnv exec` 会跑进沙箱，缓存/allow 写入被拒 |
| fork `dsh-tool-bash` 换一个 `bash` 工具 | 工具插件挂在**每个 preset** 里（standard / ptc / cordis 各一份），还要复刻渲染、后台注册、审批集成 |
| 复用 `dsh-agent-instructions` 的目录上溯算法去找 `.envrc` | 那套在找不到 `.git` 时**一个祖先都不加载**（兜底返回 cwd），与 direnv「从 cwd 向上找最近的 `.envrc`」语义不同；且 `findProjectRoot` 未导出，装好的包里根本无法 import |
| 在 `tools/execute` 里临时改 `process.env` | 并行工具调用会互相污染；官方明说不支持 |
| 学 `dsh-status-rotator` 改 `[role="status"]` DOM 文案 | 官方 practices 明令「不要读别的插件的 DOM」；且插件无法覆盖 `chat` locale 命名空间（会抛错） |
| 只做 `DSH_*` 信息广播（`DSH_DIRENV_FILE` 之类让命令自己 source） | 不是透明注入，要求每条命令自己配合 |
| 在 `agent/created` 里 `await` 加载完成 | 会卡住**会话创建**（监听器被 await），与「对话不受影响」的决策冲突；抛错更会让创建直接失败 |
