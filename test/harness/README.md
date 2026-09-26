# test/harness — 假 LLM 端到端回归测试台

一个能在**没有 API key、没有浏览器、没有网络**的前提下跑通「真实 turn + 真实工具执行」的回归测试台。
它用一个本地假 LLM 顶替 `llm-pi-ai` 的 provider，让 `dsh headless --json` 真的启动、真的发请求、
真的执行 `bash` / `read` 工具，然后把**每一毫秒**落到磁盘上供断言和排查。

它回答的问题是：**替换子进程执行器、注入环境变量、门闸阻塞工具调用**这些行为，在真实 harness 里
到底成不成立。门闸延时、并发工具调用的串行化、协议错误路径、以及本插件的
「`.envrc` 变量真的到达子进程」都能在这里复现。

## 前置要求

- `node` ≥ 22.18（`.ts` 靠原生类型擦除直接跑；本机 24.x）
- `dsh` 在 `PATH` 里（Nix 安装常见于 `/run/current-system/sw/bin/dsh`、per-user profile 或
  `~/.nix-profile/bin/dsh`，脚本会依次探测）；也可以用 `HARNESS_DSH_BIN=/path/to/dsh` 指定
- `zstd` 在 `PATH` 里（读 durable session log 用）
- 不需要 `direnv allow`，不会碰用户真实的 allow 库与 `~/.dsh`（见「硬守卫」）

## 一条命令跑一个 case

```bash
cd "$(git rev-parse --show-toplevel)"
test/harness/run.sh gate-7000          # 跑一个 case
test/harness/run.sh --all              # 跑全部 ready 的 case，最后打一张总表
test/harness/run.sh --list             # 列出现有用例
test/harness/run.sh direnv-smoke       # 本插件专属用例（见下）
```

`run.sh` 会先**清掉环境里的 `DSH_*`** 再调用 `run.ts`。如果你的 shell 本来就没有
`DSH_HOME`/`DSH_PROFILE_DIR`（例如普通的登录 shell），也可以直接用：

```bash
node test/harness/run.ts --case gate-7000
```

## 文件构成

全部是 TypeScript，靠 Node 24 的原生类型擦除直接运行（不需要 loader / 构建）：

| 文件 | 职责 |
| --- | --- |
| `run.ts` | 主流程：CLI、硬守卫、子进程环境、一次 case 的完整生命周期（spawn dsh、收证据、落盘） |
| `cases.ts` | 用例的声明式形状（`HarnessCase` / `CaseExpect` / `CaseContext`）与用例发现（`loadCases`） |
| `evaluate.ts` | 断言与指标：日志读取器、`computeMetrics`、`evaluate`、`renderSummary` |
| `json.ts` | 所有 JSON 边界（配置、JSONL 日志、`--json` stdout）的 `unknown` 收窄读取器 |
| `fake-llm.ts` | 假 LLM 服务端（SSE、按请求形状分流） |
| `timeline.ts` | durable session log 的解压/解析/工具流提取 |
| `probe.ts` | 插进 scratch profile 的探针插件（门闸、dispatch、结果时间戳） |
| `cases/<name>.ts` | 一个 case 一个文件，**文件名必须等于 `name`**，默认导出 `satisfies HarnessCase` |

退出码：`0` 全绿、`1` 有断言失败、`2` 守卫拒跑、`3` 用例被标为 pending。

常用开关：`--out <name>`（换一个运行目录，用来连续跑两次留存两份证据）、
`--timeout <秒>`、`--force`（强行跑 pending 用例）、`--strict-audit`（把「仓库被外部改动」升级成失败）。

## 用例清单

| case | 验的是什么 | 关键期望 |
| --- | --- | --- |
| `gate-0` | 负对照：门闸 armed 但不等 | exit 0、`STUB-LLM-OK\n`、gate 保持 ~0ms |
| `gate-7000` | 门闸延时正确性 | `gate/enter → exit` ≈ 7001ms，结果与 `gate-0` **逐字节相同** |
| `two-reads` | 一条消息里两个并发工具调用 | 两次 gate 各 2000ms，`gateSpanMs` ≈ 4000ms（被串行化） |
| `no-finish-reason` | 协议错误路径 | 6 次请求（1 + 5 次退避重试，约 17s）、`TRANSPORT`、exit 1、**零工具执行** |
| `direnv-smoke` | 本插件端到端 | scratch profile 里加载 `dsh-direnv`，`bash` 看到 `.envrc` 里的 `SOME_DIRENV_VAR` |

## 证据在哪、怎么看

每次运行把 `.runs/<case>/` 清空重建（`.runs/` 已被 `.gitignore` 忽略）：

| 文件 | 内容 |
| --- | --- |
| `summary.txt` | **人读的那一份**：假 LLM 请求摘要、durable 时间线、工具流 epoch ms 差值、指标、断言逐条结果 |
| `evidence.json` | 机器读的那一份：上面全部内容 + 退出码 + 子进程 PID + `processes` 存活状态 + 仓库审计 diff |
| `timeline.txt` | durable session log 的时间线（`session.v4.jsonl.zstd` 解压后格式化） |
| `fake-llm.requests.jsonl` | 假 LLM 收到的每个请求：`decision`（按请求形状分流的结果）、`hasTools`、`sawToolRole`、`max_completion_tokens`、消息 roles |
| `probe.jsonl` | 探针插件的 epoch ms 事件：`gate/enter`、`gate/exit`、`dispatch/enter|exit`、`tools/result` |
| `dsh.out` / `dsh.err` | `dsh --json` 的原始 stdout / stderr（`dsh.out` 里混着 `[probe]` 行） |
| `fake-llm.out` | 假 LLM 的服务端日志（端口、pid、每个请求一行） |
| `overlay.yml` | 本次实际喂给 `--patch` 的 profile 补丁（占位符已替换） |
| `ws/` | 本次会话的工作目录（session cwd），`files` 里声明的内容写在这儿 |
| `home/` | **本次专用的 `DSH_HOME`**：profile、session log、projection cache 全在这里面 |
| `xdg-data/` `xdg-cache/` `config/` | 本次专用的 XDG 根（direnv 白名单配置、allow 库落点） |

时间线怎么读：`tool/call`（durable log）→ `gate/enter`（探针）→ `gate/exit` → `tool/result`（durable log），
四个事件都带 epoch ms，所以跨进程也能相减。`summary.txt` 的「tool flow」段直接把这些差值算好了：

```
tool/call     call_fake_1 bash t=1790403762225
  gate/enter  call_fake_1 t=1790403762226   (call -> gate = 1ms)
  gate/exit   call_fake_1 t=1790403769227   (gate held  = 7001ms)
tool/result   call_fake_1 isError=false t=1790403769427   (call -> result = 7202ms)
  text="STUB-LLM-OK\n"
```

指标名（`expect.metrics` 里用的就是这些键，值写成 `[min,max]`、数字或 `{min,max,equals}`）：

```
wallMs  toolCalls  toolResults  gateSpanMs  firstCallToLastResultMs
call->gate/enter:<callId>   gate/enter->exit:<callId>
gate/exit->result:<callId>  call->result:<callId>
fake.requests  fake.titleRoute  fake.toolRouteAttempts  fake.closingRoute  fake.unhandled
```

只想看一眼结果：

```bash
rg -N '^=== RESULT|^  (FAIL|WARN)' test/harness/.runs/*/summary.txt
node -e 'const e=require("/abs/path/test/harness/.runs/gate-7000/evidence.json");console.log(e.metrics)'
```

## 硬守卫（为什么 `run.ts` 可能拒跑）

历史事故：上一版 runner 写成 `DSH_HOME="${DSH_HOME:-…}"`，于是继承了外层会话的
`DSH_HOME=$HOME/.dsh`，**误写了用户真实的 DSH home**（留下 profile、session、projection cache）。
现在的规则是：

1. `DSH_HOME` 硬编码为 `.runs/<case>/home` 的**绝对路径**，绝不从环境继承；子进程的环境是重建的
   （所有 `DSH_*` 一律丢掉，`DSH_PERMISSION_MODE` 因此也不会被继承，默认走 `workspace-write`）。
2. 环境里若出现指向真实 home 的 `DSH_HOME` / `DSH_PROFILE_DIR`，**直接拒跑并 exit 2**，而不是"忽略"——
   宁可让你显式清环境，也不要在一个可疑的 shell 里启动。
3. 任何 `rm -rf` 的目标、`--out` 的名字、以及算出来的 `DSH_HOME`，都先断言落在
   `test/harness/.runs/` 之下才允许使用。
4. 只 kill 自己记录的 pid（`fake-llm.pid` + spawn 出来的 dsh 进程组），**从不 `pkill -f`**。
5. 每次运行结束会把 `dsh` / 假 LLM 的存活状态写进 `evidence.json` 的 `processes`，作为"没留进程"的证据。

被拒跑时的样子：

```
$ node test/harness/run.ts --case gate-0
[harness] REFUSING TO RUN: DSH_HOME=$HOME/.dsh points inside a live DSH home ($HOME/.dsh).
[harness] This harness always uses a private DSH_HOME; an inherited live-home value means the shell is
  unsafe to spawn from. Re-run through the wrapper (it scrubs DSH_*):
      test/harness/run.sh --case <name>
$ echo $?
2
```

## 写一个新 case

一个 case 就是 `test/harness/cases/<name>.ts` 的默认导出，**文件名必须等于 `name`**。
整个对象用 `satisfies HarnessCase` 收口，所以字段名写错、`expect` 写宽（例如把
`stderr.notContains` 写成字符串数组以外的形状）都会在 `npm run typecheck` 里报出来；
发现逻辑只额外校验运行器会直接解引用的那几个字段：

```ts
import type { HarnessCase } from '../cases.ts';

export default {
  name: 'my-case',
  description: '一句话说明它证明什么',
  status: 'ready',                    // 或 'pending-host'（默认不跑，--force 才跑）
  requires: { repoFiles: ['src/index.ts', 'lib/index.js'] }, // 缺文件时自动降级成 pending
  profile: 'harness',                 // scratch profile 名
  gateMs: 3000, gateMode: 'delay',    // 'delay' | 'no-next' | 'allow'（探针门闸行为）
  blockAgentCreatedMs: 0,             // >0 时在 agent/created 里 await（会拖慢建会话）
  timeoutMs: 300000,
  task: 'Use the bash tool to run: echo hi',
  files: { 'a.txt': 'alpha\n' },      // 写进 .runs/<case>/ws/
  fake: {
    toolCalls: [{ name: 'bash', arguments: { command: 'echo hi', description: 'x' } }],
    finalText: 'FAKE-FINAL: tool run finished.',
    titleText: 'fake title',
    omitFinishReason: false, omitUsage: false, singleArgDelta: false, chunkDelayMs: 2,
  },
  extraRows: "- id: subprocess\n  disabled: true\n",  // 追加到 overlay.yml 顶层
  prepare(ctx) { return { env: { XDG_CONFIG_HOME: '…' } }; },   // 冻结子进程环境之前调用
  prepareProfile(ctx) { /* profile 建好之后、boot 之前调用（例如挂 node_modules 软链） */ },
  expect: {
    exitCode: 0, noTimeout: true,
    finalText: { contains: 'FAKE-FINAL' },
    stderr: { notContains: ['did not activate'] },
    stdout: { contains: 'turn_end' },
    toolResultCount: 1,
    toolResults: [{ equals: 'hi\n', isError: false }],   // 也支持 contains / notContains / callId
    timelineHas: ['tool/call', 'tool/result'],
    metrics: { 'call->result:call_fake_1': [0, 3000], 'fake.toolRouteAttempts': 1 },
  },
} satisfies HarnessCase;
```

`toolCalls[].arguments` 里的 `{{WS}}` 会替换成本次运行的绝对工作目录。

## `direnv-smoke` 详解

它做的事：scratch profile 里 `subprocess: disabled` + 插入 `dsh-direnv`（就是本插件
`cordis.patch.yml` 的那两行），仓库以软链挂进 `<profile>/node_modules/dsh-direnv`；
workspace 里放一个 `.envrc`（`export SOME_DIRENV_VAR=direnv-smoke-ok`），
然后断言 `bash -c 'echo DIRENV_SMOKE=$SOME_DIRENV_VAR'` 的**工具结果恰好等于**
`DIRENV_SMOKE=direnv-smoke-ok\n`，且 stderr 不含 `did not activate` / `has been registered at`
（这两句分别是"插件没激活"和"插件没抢到 subprocess 座位"的签名）。

**`.envrc` 怎么被 direnv 认可**：不用 `direnv allow`（那是用户的信任决定，而且会写用户真实 allow 库）。
`prepare()` 在 `.runs/direnv-smoke/config/direnv/direnv.toml` 里写 direnv 官方的白名单：

```toml
[whitelist]
prefix = ["/abs/path/to/.runs/direnv-smoke/ws"]
```

并让整个 dsh 子进程带上 `XDG_CONFIG_HOME=<run>/config`。实测 `~/.local/share/direnv/allow`
**零写入**（mtime 不变）。`DIRENV_CONFIG` 是备选，但它会被插件求值器当成 `DIRENV_*` 剔掉，所以用 `XDG_CONFIG_HOME`。

它依赖 `src/index.ts` 与 `lib/index.js` 存在（`requires.repoFiles`）。缺任何一个时用例自动降级为
pending（exit 3），不会被当成失败。

## 踩坑清单

协议侧（都是实测钉死的，别"顺手简化"）：

1. **`baseURL` 必须带 `/v1`**——OpenAI SDK 自己拼 `/chat/completions`。
2. **SSE 形状**：`text/event-stream` + `data: {json}\n\n`，`data: [DONE]\n\n` 收尾；
   chunk 最小形态 `{"choices":[{"index":0,"delta":{…},"finish_reason":null|"stop"|"tool_calls"}]}`。
3. **最终 chunk 必须有真值 `finish_reason`**。漏了会抛 `Stream ended without finish_reason`，
   而且 `llm-retry` 先退避重试 5 次（约 16–17s）才报错——**调试时极易误判成卡死**。
   这就是 `no-finish-reason` 用例存在的原因，它把这 6 次请求和 ~17s 钉成了期望值。
4. **按请求形状分流，不能按请求序号**：无 `tools` = 标题请求（与主请求几乎同时到达、会交错）；
   有 `tools` 且历史无 `role:"tool"` → 回 `tool_calls`；有 `tools` 且历史有 `role:"tool"` → 回最终文本
   （**收尾轮同样带 tools**）。假 LLM 的 `decision` 字段就是分流结果，证据里逐请求可见。
5. **必须给非空 dummy key**（`apiKeyEnv` + 环境变量）。空/缺失 ⇒ `MISSING_CREDENTIAL`，一个请求都不会发。
6. 请求里是 `max_completion_tokens`（非 DeepSeek 路由）。主请求 8192，标题请求 64。
7. **`tool_calls.arguments` 支持分片**：假 LLM 先发名字 + 空 arguments，再分两片发参数；
   `singleArgDelta: true` 可以切成单片做对照。
8. `bash` 工具要求 `arguments` 里有 `description`，少了会得到
   `Error: invalid arguments: missing required property "description"`（工具结果层面，不是崩溃）。

运行姿势侧：

9. 每次运行必须用**私有临时 `DSH_HOME`**、**私有端口（`port 0` + 端口文件）**、并清掉 `DSH_PROFILE_DIR`。
10. `DSH_TELEMETRY_DISABLED=1`。
11. **`--json` 是内层 app 参数，必须在 `--patch` 之后**；放前面会报 `unknown option '--patch'`。
12. `--from-default-profile headless` **只在全新 `DSH_HOME` 首次可用**，重复会报 profile 已存在；
    runner 每次重建 `.runs/<case>/home`，所以每次都会用它。
13. **不需要 `DSH_PERMISSION_MODE=danger-full-access`**（已证伪）：默认 `workspace-write` 下写 `/tmp`
    直接成功（沙箱把整个 `/tmp` 加进可写根），`read-only` 下被拒也是以工具结果返回，不会悬挂。
    默认模式顺带把沙箱路径也验了——`gate-0` 的时间线里能看到 `permission/preset: workspace-write`。
14. **门闸会把同一步的并行工具调用串行化**（`two-reads`：2 × 2000ms ≈ 4000ms，而不是 2000ms）。
    对本设计可接受（门闸 promise 只解析一次，之后立即放行），但**加载期间**同一步的 N 个调用会退化成 N 倍等待。
15. **门闸必须永远 `return next()`**：`tools/pre-execute` 是逐次调用的 waterfall，返回 `undefined`
    会让上层读 `gate.kind` 抛 TypeError，并被吞成工具结果暴露给模型。
16. `[ '--all' != -* ]` 这种写法在 bash 5.3 下**不按预期工作**（`run.sh` 用 `case` 重写了），
    改 wrapper 的参数预处理时别踩回去。

## 已知限制

- 假 LLM 只实现了 openai-completions 的 SSE 子集：没有真实模型语义，回答由请求形状决定；
  不适合测 prompt 质量。
- `no-finish-reason` 依赖 `llm-retry` 的退避节奏（约 17s），换 harness 版本要重新对齐期望区间。
- 仓库审计默认是**警告**不是失败：开发期仓库可能同时被别人改（本仓库当前就有多个 agent 在写
  `src/**`），审计会把这类外部改动如实列出来；在安静的树上用 `--strict-audit` 才把它升级成失败。
- `direnv-smoke` 只证明"变量到达子进程"这一条主链路，不覆盖 memo、blocked、`.env`、`use flake` 等分支。
- 平台假设：Linux + landlock 沙箱 + `zstd`；没有验证 Windows / pwsh。

## 故障排查

- **卡住不动** → 看 `fake-llm.out` 最后一个 `REQ#`，以及 `dsh.err`。缺 `finish_reason` 的典型症状是
  17 秒后才报错（不是卡死）。
- **`did not activate` / `pending (waiting for service: subprocess)`** → 插件没抢到座位：
  检查 `extraRows` 里 `subprocess: disabled` 与插件 entry 是否成对，以及 `<profile>/node_modules/dsh-direnv` 软链。
- **`soft link 形态下裸名 import 解析不到`** → 插件自己的依赖解析可能落到仓库外；对照实验是把
  `lib/` / `package.json` / `cordis.patch.yml` **真拷贝**进 `<profile>/node_modules/dsh-direnv/`。
- **`no session log found`** → 说明这次 turn 连 session 都没建起来，先看 `dsh.err`。
