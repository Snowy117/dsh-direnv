# dsh-direnv

[English](README.md) | 中文

DeepSeek Harness 运行的每一条命令，都会继承**它所在工作目录**的 [direnv](https://direnv.net/) 环境。

你早就把 `PATH`、工具链和各项目的密钥写在 `.envrc` 里，交给 direnv 注入自己的 shell。`dsh-direnv` 也让 harness 享受同样的待遇：工作区就像 `dsh` 本身是从一个已加载 direnv 的 shell 里启动的一样。于是模型的 `bash`、后台任务、子代理、终端、`git`、`rg`，不必被特别告知，就能看见项目的 dev shell。

```
~/.dsh $ dsh web                 # no .envrc here
           └── session in ~/projects/api
                 └── bash: build      → has `cargo`, `DATABASE_URL`, …
```

## 工作原理

插件接管 harness 的 `subprocess` 缝隙——也就是它启动子进程的那道接口。插件按工作目录逐个求值 `direnv export json`。三条流程共用这一个事实源，彼此之间从不阻塞：

| 数据流 | 行为 |
|---|---|
| **注入** | `spawn` 只拿目录去缓存里查一次表，再把 overlay（direnv 给出的环境增量）合并进子进程的环境。查表是同步的，而且从不等待：没见过的目录原样放行，它的求值改在后台进行；而 `spawnTerminal`（用户亲手打开的 PTY，也就是侧边栏终端）会先 await 求值结果。 |
| **门闸** | 会话环境还未知的时候，工具调用会被拦下等待——模型可以说话，也可以*请求*工具，只是这些调用会像工具自身很慢一样停在原地。门闸每个会话只武装一次，最多等 `loadTimeoutMs`，而且它是延迟而不是过滤器：有确定结果、超时、被取消，三者都会放行。放行**不会**取消求值：求值带着自己的预算继续跑（`evaluateTimeoutMs`，`0` = 永不杀），所以慢 `.envrc` 会在后台跑完，同一工作区的下一条命令就能拿到环境。 |
| **界面** | 一条 sourced user 消息（以 user 角色注入、并带上来源标记）告诉模型这次加载了什么；右侧边栏的 tab 则告诉你变量名、`PATH` 新增项和凭据名单。 |

目录的上溯交给 direnv 自己完成：锚点是每次 spawn **自己解析出来的 `cwd`**，所以一条 `cd` 进子目录的命令，拿到的是那个子目录的环境；而对任何 `.envrc` 的改动，都会在下一次工具调用时生效。

## 安装

```bash
# from a checkout: `npm install` runs the build that produces lib/
npm install
dsh plugin add "file:$PWD"

# once it is on npm
dsh plugin add dsh-direnv
```

`.envrc` 始终由你掌管：插件只读取 direnv 已经知道怎么产出的那份环境，**绝不会替你调用 `direnv allow`**。如果某个文件还没获批，命令就会带着 harness 环境运行，侧边栏也会如实说明。

### 手工安装

`dsh-direnv` 自带一份 bundle patch：它关掉官方那条 `subprocess` 行，再插入自己的一条。把包放进 profile 的 `node_modules`，把它列进 `dsh.profile.bundles`，并让 `cordis.patch.yml` 的这两行都保持完整——缺一不可：

- 只留 `insert` 那一行的话，启动会报
  `Error: service "subprocess" has been registered at <LocalSubprocessRuntime>`，
  而插件不产生任何效果；
- bundle 在 `dsh.profile.bundles` 里必须排在 `@deepseek-ai/dsh-base` **之后**，否则这条 patch 找不到目标
  (`patch: entry "subprocess" not found`)，你得到的还是同一个服务重复注册的失败。`dsh plugin add` 是追加安装的，所以正常路径本来就是对的。

### 环境要求

- `direnv` 在 `PATH` 上（或者设置 `direnvPath`）。插件不做别的事——没有 shell hook，不改 `.envrc`，也不弹审批提示。
- DSH `~0.1.7-rc.1`。这个版本范围是**故意收窄**的：插件继承了 DSH 的一个内部运行时类，静默失效比安装被拒更糟糕。

## 验证

```bash
dsh --profile <name> --dump-config | grep -A3 'id: subprocess'   # disabled: true
```

然后，在一个工作区里已经有获批 `.envrc` 的会话中，请模型运行：

```bash
printenv | grep -c .        # and: echo "$SOME_VAR_YOUR_ENVRC_SETS"
```

如果那个变量没有出现，见[故障排除](#故障排除)——这些失败签名各有特征，而且大多悄无声息。

## 故障排除

这个插件几乎每一种失败方式都是**悄无声息**的，所以在假定它能用之前，先读一读启动输出：

| 你会看到什么 | 它意味着什么 | 怎么办 |
|---|---|---|
| `dsh: skipping profile bundle "dsh-direnv"` | peer 版本范围不匹配，于是整个 bundle 被跳过。它的 patch 从未执行，官方 provider 还在原位，而 `--dump-config` 看起来与一次干净安装完全一样。 | 换一个版本范围能接受的 DSH，或者用 `dsh plugin allow-version` 接受风险。 |
| `dsh: disabling profile plugin row "direnv-subprocess"` | 这一行被 row 级 preflight 关掉了。`--dump-config` **不会显示这件事**——它打印的只是 patch 组合的结果。 | 同上。 |
| `dsh: warning: N entries did not activate`，后面跟着 `… pending (waiting for service: subprocess)` | patch 生效了，但插件从未起来，于是命令连 `bash` 工具都没有。 | 去找 `direnv-subprocess (…): failed to import`；底层原因被吞掉了，所以要确认包已经装好、它的 `exports` 能解析。 |
| `Error: service "subprocess" has been registered at <LocalSubprocessRuntime>` | 两条 patch 行没有一起生效，或者 patch 没打中目标。 | 两行都保留，让 bundle 排在 `@deepseek-ai/dsh-base` 之后，并去找 `patch: entry "subprocess" not found`。 |
| `patch: entry "subprocess" not found`（只出现在 `--dump-config` 的 stderr 里） | bundle 在它要 patch 的那一行之前就被组合了。 | 在 `dsh.profile.bundles` 里把它移到 `@deepseek-ai/dsh-base` 之后。 |
| 从源码检出安装后，web app 直接非零退出、不打印 URL | 包的 `exports` 指向 `lib/`，而它只有在构建后才存在。 | 在检出目录里跑 `npm install`（它的 `prepare` 会构建），或 `npm run build`。 |
| 右侧边栏的 tab 从不出现 | client 半边被静默丢弃了。 | `dsh.client.platform` 必须精确等于 `"web"`，而 `dsh.client.inject` 的每一项都必须是精确的包名——`<pkg>/client` 这种后缀不会被归一化，什么都匹配不到。 |

`--dump-config` **不是**「最终挂载了什么」的完整预言：它只组合 patch，却不跑 row 级 preflight；而且两类诊断信息是分家的——patch 警告只出现在它这里，兼容性拒绝只在启动时出现。两边都要读。

如果插件起来了，而某个工作区没有环境，就打开侧边栏那个 tab：它把 `blocked`、`unreadable`、`absent` 分开报告，也会告诉你某个目录只是与「没有 `.envrc`」的目录无法区分。

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

`injectSensitive: filter` 会扣下名字看起来像凭据的变量（`/KEY|PASSWORD|SECRET|TOKEN/i`）。它是给格外谨慎的部署准备的，代价是让需要这些值的 dev shell 半残；默认值则忠实注入，因为「工作区环境」说的本来就是这个意思。

两个超时回答的是两个不同的问题。`loadTimeoutMs` 是门闸的预算：一次工具调用最多被拦多久，超过就带着当时已知的信息放行。`evaluateTimeoutMs` 约束的是 `direnv` 子进程本身，默认 `0` 表示永不杀——冷启动的 `use flake` 构建时长不可预测，杀掉等于丢掉那部分工作。代价是：一个永远跑不完的 `.envrc`（`sleep infinity`、卡住的下载）会让每个目录有**一个** `direnv` 进程一直挂到会话结束——in-flight 去重保证它只会有一个，门闸仍会在 `loadTimeoutMs` 放行工具调用，而设一个有限的 `evaluateTimeoutMs` 就能给它兜底。这个期限真的触发（或者这次运行被中止）时，杀的是**整个进程组**：`direnv`、它 source `.envrc` 的 bash、以及 bash 起的东西。即便如此，它的语义仍然是「不再等」而不是「没有副作用」——见「已知限制」。

## 安全性

- **`.envrc` 就是任意代码。** 求值一个 `.envrc`，等于以你的用户身份、在任何沙箱之外运行 `bash`——它可以写文件，`nix-direnv` 还会在项目里铺开 `.direnv/`。`dsh-direnv` 只会求值 direnv 本来就会求值的文件，并且绝不替你批准其中任何一个。
- **变量值永远不会以文本形式到达模型。** sourced 消息里只有数量、路径和警告——没有变量值，也没有凭据变量的名字；要查看名字、要按需展开值，都在侧边栏——那是操作者的位置。通往这条路由的请求会经过 harness 自己的连接围栏，而不像默认不设防的 `/plugins/*` 通道那样敞开。
- **凭据是故意注入的。** overlay 叠在 harness 已清洗的环境之上，所以 `.envrc` 提供的值确实会到达命令手里——这正是插件的意义所在，也是 `injectSensitive` 存在的理由。
- 求值器会把交给 `direnv` 的环境里的每一个 `DIRENV_*` 变量都剔除，这样，从一个已加载 direnv 的 shell 里启动的 harness，也无法把 harness 特意清洗掉的变量重新「复活」回来。

## 已知限制

- **MCP server 与宿主侧 helper 绕过这条缝隙。** 任何经由 MCP SDK 或宿主进程直接 spawn 的东西都看不到工作区环境；覆盖到的路径是 harness 自己的 `shell`、`subprocess`、搜索、git 与 PTY 消费方。
- **换一个 subprocess provider 就会被盖住。** 这个座位只能有一个 provider；插件在丢掉它时会大声报告。
- **有些目录与空目录无法区分。** 一个不可读的 `.envrc`（`chmod 000`），或者用户跑过 `direnv deny` 的目录，产出的空输出与「这里没有 `.envrc`」完全一样。
- **失败的 `.envrc` 仍可能半成功。** 对 `source` 找不到文件乃至语法错误，`direnv` 都退出 `0`，而更早的变量已经生效——侧边栏与模型消息都会把这类情况报成降级。
- **harness 自己的名字过滤器赢两次。** ambient 变量只要名字*包含* `KEY`、`PASSWORD`、`SECRET`、`TOKEN`（包括 `TURKEY_MODE` 这种无辜的名字），都会在 overlay 叠上之前被清洗掉；只有 `.envrc` 显式设置的值能活下来。
- **求值不是免费的。** direnv 不保留任何跨进程缓存，所以 `use nix` 的工作区每跑一次工具调用就要重新求值约 0.2 s（缓存冷的时候是数秒）。插件用「廉价校验 + 分级 memo」应对：便宜目录靠重新指纹化输入来校验——`.envrc`、`.env`、`direnv.toml`、`lib/*.sh` 与 nix-direnv 会重写的 `.direnv/` 缓存文件取内容哈希，普通 `watch_file` 目标取 `mtime+size`——代价是每次校验几个小文件加一次 profile 级读取（实测 68 KB 的 nix-direnv profile 约 +1 ms）。
- **挂住的 `.envrc` 默认不会被杀。** `evaluateTimeoutMs: 0` 是有意让慢 dev shell 跑完的；代价是：一个永不结束的 `.envrc` 会在每个目录留下一个长寿的 `direnv` 进程。如果这笔交易对你不合适，就把 `evaluateTimeoutMs` 设成有限值。
- **超时/中止是「不再等」，不是「没有副作用」。** 期限一到（或本次运行被中止）就按**进程组** SIGKILL：`direnv`、它 source `.envrc` 用的 bash、以及那个 bash 起的东西一起死，不留孤儿进程。但被杀之前，`.envrc` 可能已经写过文件、起过服务、改过 git 状态，事后杀掉无法撤销。本插件从不*阻止* `.envrc` 执行——那是 allow 库（与 `enabled: false`）的职责。

## 开发

插件用严格 TypeScript 写成、构建成纯 ESM：`src/**/*.ts` 逐文件编译到 `lib/`（host 半边），`client/**/*.ts` 打成单文件 `lib/client.js` 交给浏览器——客户端模块表没有相对 `require`，所以那半边只能以单文件发布。`npm install` 会通过 `prepare` 自动构建，因此新检出装完即可用；`lib/` 本身不入库。`DESIGN.md` 记录了架构，以及每个决策背后的实测证据，上面那些失败签名也在其中。

```bash
npm run typecheck           # three projects: host, browser half, tests and harness
npm test                    # unit tests: evaluator (real direnv) + host wiring
npm run test:client         # client half: boot row, byte-identical module, and the fenced status route
test/harness/run.sh --all   # end-to-end cases, no API key needed
```

### Trying it by hand

The commands above are self-contained. To watch the plugin work in a real app,
use a throwaway DSH home — nothing below writes to `~/.dsh`:

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

Open that URL, start a session in `/tmp/demo/proj`, and look for the direnv tab on
the right. The host half can also be checked from the outside — the cookie comes
from the printed `?token=` link:

```bash
curl -s -H "Cookie: $COOKIE" \
  "http://127.0.0.1:30100/plugins/dsh-direnv/status.json?dir=/tmp/demo/proj&force=1"
# {"ok":true,…,"status":{"state":"ok","envrcPath":"/tmp/demo/proj/.envrc","variables":[{"name":"HANDS_ON",…}]}}
```

A scratch home has no model provider configured, so the sidebar renders but a real
conversation will not. To see the model-side behaviour (the sourced notice, and
commands inheriting the environment), point your own configured home at the plugin
for a single run — an absolute-path entry mounts the **host half only** (it is not
a package, so it has no manifest and no sidebar tab):

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

> Never run `dsh plugin add` against a profile your Nix configuration manages: it
> replaces the profile's symlinks with real files. An absolute-path `insert` (above)
> or the Nix-side route in `DESIGN.md` §6.3 are the non-destructive options.


`npm test` 故意用显式的 `test/*.test.ts` glob：裸 `node --test` 会顺带*执行* `test/harness/` 下的脚本。测试台则要走 `run.sh` 包装，而不是 `node test/harness/run.ts`——包装会先清掉 `DSH_HOME`/`DSH_PROFILE_DIR`，而测试台按设计拒绝对一个活着的 DSH home 运行。

测试台让一个本地 stub LLM 对着 `dsh headless` 跑，所以一次真实的 turn、连同真实的工具执行，可以完全离线地演练。

`npm run test:client` 会起一个 scratch `web` profile 并把本仓库挂进去，检查所有「没有浏览器也能查」的部分：client 行在启动载荷里、取回的模块与构建产物 `lib/client.js` 逐字节相同、状态路由会拒绝不带 cookie 的请求并默认不返回值。它验证不到 tab 是否真的渲染、composer 是否真的变灰、Toast 是否真的 3 秒消失、以及真实 `SlotCore` 对那几笔注册的反应——那些仍然需要浏览器。

## 许可证

MIT
