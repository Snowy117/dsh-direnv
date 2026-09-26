# dsh-direnv

```bash
dsh plugin add dsh-direnv
```

装好之后，harness 运行的每条命令都会继承**它自己工作目录**的
[direnv](https://direnv.net/) 环境。安装约两分钟；需要 `PATH` 里有 `direnv`。

```
~/.dsh $ dsh web                 # no .envrc here
           └── session in ~/projects/api
                 └── bash: build      → has `cargo`, `DATABASE_URL`, …
```

## 安装

1. 先跑 `direnv version`。失败就先装 direnv——本插件**绝不会**替你执行 `direnv allow`。
2. 装上插件：

```bash
# once it is on npm
dsh plugin add dsh-direnv

# from a checkout instead: `npm install` runs the build that produces lib/
npm install && dsh plugin add "file:$PWD"
```

3. 确认补丁生效。期望看到 `disabled: true`：

```bash
dsh --profile <name> --dump-config | grep -A3 'id: subprocess'
```

## 检查它是否生效

1. 在一个有已批准 `.envrc` 的工作区里开一个会话。
2. 让模型执行 `bash -c 'echo $SOME_VAR_YOUR_ENVRC_SETS'`。
3. 看右侧栏的 direnv tab：状态、变量名，以及按优先级排列的 `PATH` 差分。

第 2 步打印出空行，就说明环境没加载进来，去「排障」。

## 它做什么

插件接管 harness 的 `subprocess` 缝隙，按工作目录求值 `direnv export json`。
三条流程共用这一个事实来源，且互不阻塞：

| 流程 | 行为 |
|---|---|
| **注入** | `spawn` 在缓存里查这个目录，把差量并进子进程环境。查找是同步的、永不等待：未知目录原样放行，求值在后台跑；而 `spawnTerminal`（你自己开的 PTY）会先等求值完成。 |
| **门闸** | 会话环境还未知时，工具调用会被拦下等待——模型可以说话、也可以*请求*工具，只是这些调用会像工具本身很慢一样停在原地。门闸每个会话只武装一次，最多等 `loadTimeoutMs`，而且它是延迟而不是过滤器：确定结果、超时、被取消，三者都会放行。放行**不会**取消求值，求值带着自己的预算继续跑（`evaluateTimeoutMs`，`0` = 永不杀）。 |
| **界面** | 一条 sourced 提示告诉模型加载了什么。右侧栏的 tab 告诉你变量名、`PATH` 差分（新增/移除/不变）与凭据名单——全部由 DSH 官方组件绘制，所以跟着你装的主题走。 |

上溯交给 direnv 自己：锚点是**每次 spawn 自己解析出来的 `cwd`**，所以
`cd` 进子目录的命令拿到的是那个子目录的环境，任何 `.envrc` 的改动都在下一次工具调用时生效。

## 配置

```yaml
- id: direnv-subprocess
  name: 'dsh-direnv'
  config:
    enabled: true
    direnvPath: ''            # empty = resolve `direnv` from PATH
    loadTimeoutMs: 300000     # tool calls wait at most this long, then proceed
    evaluateTimeoutMs: 0      # kill the direnv child after this long (0 = never kill)
    gateTools: all            # all | spawning | none   ('spawning' currently behaves like 'all')
    injectSensitive: all      # all | filter
    notifyModel: true         # one sourced message per workspace state change
    sidebar: true             # right-sidebar tab and composer placeholder
    disabledDirs: []          # absolute paths to leave alone
```

- `injectSensitive: filter` 会扣下名字像凭据的变量（`/KEY|PASSWORD|SECRET|TOKEN/i`）。只适合谨慎场景——它会让需要这些值的 dev shell 半残。
- `loadTimeoutMs` 是门闸的预算：一次工具调用最多被拦多久，超过就带着当时已知的信息放行。
- `evaluateTimeoutMs` 约束 `direnv` 子进程本身。`0` 表示永不杀，因为冷启动的 `use flake` 时长不可预测。代价是：一个永不结束的 `.envrc` 会在每个目录留一个 `direnv` 进程活到会话结束。

## 排障

这里几乎每一种失败都是**安静的**。别假定它工作了，先读启动输出。下面五条覆盖绝大多数情况：

| 你看到的 | 含义 | 怎么办 |
|---|---|---|
| `dsh: skipping profile bundle "dsh-direnv"` | peer 版本范围不匹配，整个 bundle 被跳过。它的补丁从未执行，`--dump-config` 看起来和一次干净安装一模一样。 | 换一个版本范围能接受的 DSH，或用 `dsh plugin allow-version` 接受风险。 |
| `dsh: disabling profile plugin row "direnv-subprocess"` | 行级预检把它禁用了。`--dump-config` **不显示这件事**。 | 同上。 |
| `dsh: warning: N entries did not activate` 加 `… pending (waiting for service: subprocess)` | 补丁生效了但插件没起来，于是命令连 `bash` 工具都没有。 | 找 `direnv-subprocess (…): failed to import`；确认包已安装、`exports` 能解析。 |
| `Error: service "subprocess" has been registered at <LocalSubprocessRuntime>` | 两行补丁没有一起生效，或者补丁没找到目标行。 | 两行都要留，并让 bundle 排在 `@deepseek-ai/dsh-base` 之后。 |
| 从源码检出安装后，web app 直接非零退出、不打印 URL | `exports` 指向 `lib/`，而它只有在构建后才存在。 | 跑 `npm install`（它的 `prepare` 会构建）或 `npm run build`。 |

<details>
<summary>另外两条</summary>

| 你看到的 | 含义 | 怎么办 |
|---|---|---|
| `patch: entry "subprocess" not found`（只出现在 `--dump-config` 的 stderr） | bundle 被排到了它要修改的那一行之前。 | 在 `dsh.profile.bundles` 里把它移到 `@deepseek-ai/dsh-base` 之后。 |
| 右侧栏的 tab 从来不出现 | client 半边被静默丢弃了。 | `dsh.client.platform` 必须精确等于 `"web"`，而 `dsh.client.inject` 的每一项都必须是精确的包名——`<pkg>/client` 这种后缀不会被归一化，什么都匹配不到。 |

</details>

`--dump-config` 并不能预测一切：它只组合补丁、不跑行级预检。补丁类警告只在它那里出现，兼容性拒绝只在启动时出现。两处都要读。

如果插件起来了、但某个工作区没有环境，就打开侧边栏那个 tab：它把 `blocked`、
`unreadable`、`absent` 分开报告，也会告诉你某个目录只是与「这里没有 `.envrc`」无法区分。

## 安全

- **`.envrc` 就是任意代码。** 求值会以你的身份在沙箱之外跑 `bash`。插件只求值 direnv 本来就会求值的文件，且绝不替你批准任何一个。
- **变量值不会以文本形式进模型上下文。** 提示里只有数量、路径与警告；要看名字、要按需展开值，去侧边栏。
- **名字像凭据的变量默认照注入。** overlay 叠在 harness 已清洗的环境之上。这正是插件的意义——也正是 `injectSensitive` 存在的原因。
- **求值器会剔除全部 `DIRENV_*`**，所以从一个 direnv 加载过的 shell 里启动的 harness，无法复活它已经清洗掉的变量。
- **状态路由自带围栏。** 请求走 harness 自己的连接校验，不像零围栏的 `/plugins/*` 载体。

## 局限

- **MCP server 与 host 侧辅助进程绕过这个缝隙。** 任何经 MCP SDK 或 host 进程直接 spawn 的东西都看不到工作区环境。覆盖到的是 harness 自己的 `shell`、`subprocess`、搜索、git 与 PTY 消费方。
- **另一个 subprocess provider 会把它挤掉。** 一个 context 只能有一个实现；插件输掉时会响亮报错。
- **有些目录看起来就是空的。** 不可读的 `.envrc`（`chmod 000`）或被 `direnv deny` 的目录，与「这里没有 `.envrc`」产出的空输出一模一样。
- **失败的 `.envrc` 可能半成功。** `source` 找不到文件、语法错误时 `direnv` 仍然退出 `0`，而更早的变量已经生效。侧边栏与模型提示都会把它标成 degraded。
- **harness 自己的名字过滤会赢两次。** 环境里名字**含有** `KEY`、`PASSWORD`、`SECRET`、`TOKEN` 的变量（包括 `TURKEY_MODE` 这种无辜名字）会在 overlay 之前被清洗掉。只有 `.envrc` 显式设置的值能活下来。

<details>
<summary>另外三条</summary>

- **求值不是免费的。** `direnv` 没有跨进程缓存，所以一个 `use nix` 的工作区每次工具调用都要重跑约 0.2 秒（缓存冷时是数秒）。便宜目录改用重新指纹来验证：`.envrc`、`.env`、`direnv.toml`、`lib/*.sh` 与 nix-direnv 会重写的 `.direnv/` 文件取内容哈希，普通 `watch_file` 目标取 `mtime+size`。
- **挂住的 `.envrc` 默认不会被杀。** 想给它兜底就设一个有限的 `evaluateTimeoutMs`。
- **超时或中止是「不再等」，不是「没有副作用」。** 整个进程组会被 SIGKILL——`direnv`、source `.envrc` 的 bash、以及它的后代——但那个 `.envrc` 可能已经写了文件或起了服务。这里没有任何东西**阻止** `.envrc` 运行；那是 allow 库和 `enabled: false` 的职责。

</details>

## 开发

```bash
npm run typecheck           # three projects: host, browser half, tests and harness
npm test                    # unit tests: evaluator (real direnv) + host wiring
npm run test:client         # client half: boot row, byte-identical module, and the fenced status route
test/harness/run.sh --all   # end-to-end cases, no API key needed
```

严格 TypeScript；装已发布的包不需要你这边构建：`src/**/*.ts` 逐文件编译到 `lib/`
（host 半边），`client/**/*.ts` 打成单文件 `lib/client.js` 交给浏览器。`npm install`
会通过 `prepare` 构建；`lib/` 不入库。`DESIGN.md` 记录了架构与每个决策背后的实测证据。

`npm test` 故意用显式的 `test/*.test.ts` glob：裸 `node --test` 会顺带*执行*
`test/harness/` 下的脚本。测试台要走 `run.sh`，而不是 `node test/harness/run.ts`——
包装会先清掉 `DSH_HOME`/`DSH_PROFILE_DIR`，而测试台按设计拒绝对一个活着的 DSH home 运行。
测试台用一个桩 LLM 驱动 `dsh headless`，所以真实的一轮对话与真实工具执行可以离线跑。

<details>
<summary>亲手试一试——一次性 home，不写 ~/.dsh</summary>

```bash
# build the checkout once (`npm install` runs the build through `prepare`)
cd /path/to/dsh-direnv && npm install

# a demo workspace in a scratch home
export DSH_HOME=$(mktemp -d)/dsh-home && mkdir -p "$DSH_HOME" /tmp/demo/proj
cd /tmp/demo/proj && printf 'export HANDS_ON=yes-from-envrc\n' > .envrc && direnv allow
dsh --profile demo --from-default-profile web --dump-config   # seed a profile
dsh plugin --profile demo add "file:/path/to/dsh-direnv"      # appends our bundle last
dsh --profile demo --no-open --port 30100                     # open the printed URL
```

打开那个 URL，在 `/tmp/demo/proj` 里开一个会话，看右边的 direnv tab。host 半边也可以从外部验证——cookie 来自打印出来的 `?token=` 链接：

```bash
curl -s -H "Cookie: $COOKIE" \
  "http://127.0.0.1:30100/plugins/dsh-direnv/status.json?dir=/tmp/demo/proj&force=1"
# {"ok":true,…,"status":{"state":"ok","envrcPath":"/tmp/demo/proj/.envrc","variables":[{"name":"HANDS_ON",…}]}}
```

一次性 home 没有配模型，所以侧边栏能渲染、真实对话发不出去。想看模型侧行为
（那条 sourced 提示、以及命令继承环境），就让你自己那份已配好的 home 跑一次——绝对路径条目**只挂 host 半边**（它不是包，没有清单，也就没有侧边栏 tab）：

```bash
cat > /tmp/dsh-direnv.yml <<'EOF'
- id: subprocess
  disabled: true
- insert:
    - id: direnv-subprocess
      name: '/path/to/dsh-direnv/lib/index.js'
EOF
dsh --profile web --patch /tmp/dsh-direnv.yml --no-open --port 30100
# then, in a workspace with an .envrc, ask the model to run:
#   bash -c 'echo $YOUR_VAR'
```

> **绝对不要**对 nix 托管的 profile 跑 `dsh plugin add`：它会把 profile 的软链替换成普通文件。
> 上面那种绝对路径 `insert`，或 `DESIGN.md` §6.3 的 nix 侧做法，才是非破坏性的路。

</details>

## 许可证

MIT
