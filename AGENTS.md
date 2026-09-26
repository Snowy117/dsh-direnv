# AGENTS.md

面向在本仓库里干活的 AI 代理，也适用于人类贡献者。**先读这份，再读 `DESIGN.md`。**

DSH（DeepSeek Harness）插件：把每个工作区的 direnv 环境自动注入该工作区下运行的**所有**子进程，
让任何 `cwd` 落在工作区里的命令都像「在那边启动过 DSH 一样」。

官方文档：[开发指南](https://github.com/deepseek-ai/deepseek-harness/tree/master/docs/user/develop) ·
[参考手册](https://github.com/deepseek-ai/deepseek-harness/tree/master/docs/user/reference/)。

## 权威文档

| 文件 | 作用 |
|---|---|
| `DESIGN.md` | 设计与**实测证据**：每个决策及其依据、失败矩阵、风险表、附录 A 的证据索引。**改行为前先查这里**，改完把新证据写回去。 |
| `src/CONTRACTS.md` | 冻结的模块契约与状态路由**线格式**。跨模块改动必须同时改契约。 |
| `README.md` / `README.zh.md` | 用户文档，两版必须同步（见下）。 |
| `test/harness/README.md` | 假 LLM 测试台怎么用、它的硬守卫为什么存在。 |

## 命令

```bash
npm install                 # 会通过 prepare 自动构建出 lib/
npm run typecheck           # 三个 tsconfig：host / 浏览器半边 / 测试与测试台
npm run build               # tsc 逐文件编译 src/ → lib/，esbuild 打包 client/ → lib/client.js
npm test                    # 单测（真实 direnv fixture + 契约测试跑打包产物）
node test/client-boot.ts    # 交付级验收：起 scratch web profile，不需要浏览器
test/harness/run.sh --all   # 14 个端到端用例（真 DSH 启动 + 真工具执行），不需要 API key
```

单测可以单跑：`node --test test/evaluator-memo.test.ts`。测试与测试台是 `.ts`，靠 Node ≥ 22.18 的
**原生类型擦除**直接跑，不需要 loader；相对导入因此必须写显式 `.ts` 后缀。

## 不要破坏的不变量（每一条都是踩坑换来的）

1. **安全红线**：交给子进程的 base env 必须剔除**全部** `DIRENV_*`（只放行 `DIRENV_CONFIG`、
   `DIRENV_LOG_FORMAT`）。否则 `DIRENV_DIFF` 会**复活**已被 harness 清洗掉的密钥。
2. **`peekEnv` 是三态**：`ok` → overlay；确定结论（absent/blocked/unreadable/…）→ `{}`；瞬时失败
   （超时/被杀/spawn 失败/crash/bad-json）→ `undefined`，调用方据此重新预热。别把它压成两态。
3. **门闸超时 ≠ 杀求值**：`loadTimeoutMs` 管门闸（工具调用最多被拦多久），`evaluateTimeoutMs` 管
   `direnv` 子进程 kill 期限（默认 `0` = 永不杀）。两者曾经共用一个数字，导致慢 `.envrc` **永远**
   拿不到环境。
4. **`tools/pre-execute` 必须 `return next()`**：返回 `undefined` 会让工具调用直接变成 isError。
5. **模型文案的边界**：不出现变量**值**，不出现凭据**名字**（只报数量）；`.envrc` 正文永不进上下文。
6. **线格式是冻结契约**：`status: null` 是「还没有工作区信息」的正常状态而非错误；客户端只在操作者
   展开变量时才带 `values=1`；必须校验 `content-type`（SPA fallback 会拿 `index.html` 伪装成 200）。
7. **client 半边只能是单文件产物**：浏览器侧模块表没有相对 `require`，所以 `client/**/*.ts` 必须经
   esbuild 打成 `lib/client.js`；产物里 `react` 必须是**唯一一次运行期** `require(` 调用，零 `import`/`export`。
8. **注册形状**：keyed 座位的 `key` 必须是 tab 类型的 **id**（用 `kind` 会静默空白）；composer block
   不许覆盖别的插件的（只写空槽或自己的文案）；`dsh.client.platform` 必须精确等于 `"web"`。
9. **插件导出形态**：`src/index.ts` 的三个导出保持声明式（`export const name` / `export const Config` /
   `export async function apply`）。DSH 按 `isConstructor` 规则决定要不要 `new`，改成箭头常量会**静默**失效。

## 安全与隐私（硬规则）

- **绝不读写 `~/.dsh`**：那通常是用户正在运行的 DSH home。测试、脚本、端到端一律用
  `test/harness/.runs/` 下的 scratch home；测试台自带守卫会拒绝在活着的 home 里运行，**别绕过它**。
- **绝不用 `pkill -f`**：命令行里含同样的字符串会杀掉你自己的 shell。只按 `ps` 抓到的 pid 显式 `kill`。
- **绝不对真实的 `.envrc` 执行 `direnv allow/deny/block`**，也不要写用户真实的 allow 库；fixture 用
  临时 `direnv.toml` 里的 `[whitelist] prefix` 放行。
- **仓库里不允许出现与某台机器或某个人绑定的内容**：家目录绝对路径、用户名、私有项目名、本机端口、
  本机专属的二进制路径。要写就用 `os.homedir()` / `$HOME` / 环境变量 / 多候选探测。

## 贡献规则

- **TypeScript 纪律**：只用可擦除语法（禁 `enum`/`namespace`/构造函数参数属性）；相对导入写显式 `.ts`；
  纯类型导入用 `import type`；**禁 `any`**（`unknown` 仅在真边界且立即收窄）；**不许放宽 `tsconfig`**
  里的 strict 系列来让代码过关——改代码，或在报告里说明为什么某条规则不可行。
- **规模**：每个源文件 ≤ **400** 有效行，测试与测试台 ≤ **600**（有效行 = 非空、且非纯注释行）。
- **注释只写不变量与「为什么」**，不写「我改了什么」式备忘。每个模块头部一段说明它 owns 什么、
  以及**不做就会出错的那些约束**。
- **文档同步**：改 README 必须中英两版一起改，标题数一致、代码块逐字节相同；改面向用户的消息键必须
  同步内联表与 `locale/{en,zh}.json`（契约测试会逐键比对，漏一个就红）。
- **测试不许弱化**：不要为了让测试变绿而放宽断言、加 `.skip` 或改期望值。修 bug 要带一个**能失败的**
  回归用例；改不变量要顺手做一次变异复检（见下）。

## 验证纪律

- 改行为之后至少跑：`npm run typecheck`、`npm test`、`node test/client-boot.ts`、
  `test/harness/run.sh --all`。四套都是自包含的，不需要 API key。
- **强烈建议做变异复检**：故意改坏你刚改的那个不变量 → 确认对应用例真的挂掉 → **逐字节还原**（贴
  `md5sum`/`diff` 证据）。本仓库靠这一条抓出过多次「测试看着在验、其实没验」（例如内容哈希那条防线
  的用例其实抓的是另一处变化；删掉管道 `destroy()` 没人发现）。
- 核查别人的结论时，**自己复现一遍**再接受；也要复核「残留风险」是否真的可达（本项目出现过
  “结构上可伪造、但被前置分支挡住因而不可达”的判断）。
- 这个仓库的复杂度值得「实现者」与「独立核查者」分开：核查者应当能复现每条结论，并给出反例或
  明确说「未复现」。历史收益最大的一次核查直接抓出了一个致命契约错位。

## 已知边界

- 浏览器里的**视觉**行为（tab 是否渲染、composer 是否变灰、Toast 是否 3 秒消失）没有自动化覆盖，
  需要人眼在有浏览器的环境里过一遍；`test/client-boot.ts` 只覆盖「模块被正确交付 + 线格式通」。
- Windows 只有按构造降级（不做进程组杀），无实机验证。
- 真实 nix 工作区的冷 `use flake` 没有端到端覆盖（红线不允许写项目内 `.direnv/`），它的形状由
  hermetic fixture 复刻；想跑真实工作区请设 `DIRENV_EVAL_REAL_DIR=<path>` 并单独跑那条 opt-in 用例。
