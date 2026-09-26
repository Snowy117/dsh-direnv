# dsh-direnv

```bash
dsh plugin add dsh-direnv
```

Every command the harness runs then inherits the [direnv](https://direnv.net/)
environment of **its own working directory**. Two minutes to install; needs
`direnv` on `PATH`.

```
~/.dsh $ dsh web                 # no .envrc here
           └── session in ~/projects/api
                 └── bash: build      → has `cargo`, `DATABASE_URL`, …
```

## Install

1. Run `direnv version`. If it fails, install direnv first — this plugin never runs `direnv allow` for you.
2. Add the plugin:

```bash
# once it is on npm
dsh plugin add dsh-direnv

# from a checkout instead: `npm install` runs the build that produces lib/
npm install && dsh plugin add "file:$PWD"
```

3. Confirm the patch landed. Expect `disabled: true`:

```bash
dsh --profile <name> --dump-config | grep -A3 'id: subprocess'
```

## Check it works

1. Open a session in a workspace with an approved `.envrc`.
2. Ask the model to run `bash -c 'echo $SOME_VAR_YOUR_ENVRC_SETS'`.
3. Read the direnv tab in the right sidebar: state, variable names, and the `PATH` diff in priority order.

An empty line from step 2 means the environment is not loading. Go to
Troubleshooting.

## What it does

The plugin takes over the harness's `subprocess` seam and evaluates
`direnv export json` per working directory. Three flows share that one fact
source and never block each other:

| Flow | Behaviour |
|---|---|
| **Injection** | `spawn` looks the directory up in a cache and merges the diff into the child's environment. The lookup is synchronous and never waits: an unknown directory is forwarded untouched while its evaluation runs in the background, and `spawnTerminal` (a PTY you opened) awaits the evaluation first. |
| **Gate** | While the session's environment is unknown, tool calls are held — the model may talk and may *ask* for tools, but those calls wait as though the tool itself were slow. The gate arms once per session, waits at most `loadTimeoutMs`, and is a delay rather than a filter: a determinate result, the timeout, and a cancellation all release it. A released call does **not** cancel the evaluation; that keeps running under its own budget (`evaluateTimeoutMs`, `0` = never kill). |
| **Surfaces** | One sourced notice tells the model what was loaded. The right-sidebar tab tells you the variable names, the `PATH` diff (added, removed, unchanged) and the credential list, drawn entirely from DSH's own UI components so it follows your theme. |

Direnv does the walking: the anchor is each spawn's **own resolved `cwd`**, so a
command that `cd`s into a subdirectory gets that subdirectory's environment, and
a change to any `.envrc` takes effect on the next tool call.

## Configure

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

- `injectSensitive: filter` withholds variables whose names look like credentials (`/KEY|PASSWORD|SECRET|TOKEN/i`). Cautious setups only; it breaks dev shells that need those values.
- `loadTimeoutMs` is the gate's budget: how long a tool call may be held before it runs with whatever is known.
- `evaluateTimeoutMs` bounds the `direnv` child. `0` never kills it, because a cold `use flake` has no predictable duration. The price: an `.envrc` that never finishes keeps one `direnv` process per directory alive for the session.

## Troubleshooting

Almost every failure here is **quiet**. Read startup output before assuming it
works. These five cover nearly all of it:

| What you see | What it means | What to do |
|---|---|---|
| `dsh: skipping profile bundle "dsh-direnv"` | Peer range mismatch, so the whole bundle was skipped. Its patch never ran and `--dump-config` looks identical to a clean install. | Install a DSH the range accepts, or accept the risk with `dsh plugin allow-version`. |
| `dsh: disabling profile plugin row "direnv-subprocess"` | The row-level preflight disabled it. `--dump-config` **does not show this**. | Same as above. |
| `dsh: warning: N entries did not activate` + `… pending (waiting for service: subprocess)` | The patch applied but the plugin never came up, so commands have no `bash` tool at all. | Look for `direnv-subprocess (…): failed to import`; check the package is installed and its `exports` resolve. |
| `Error: service "subprocess" has been registered at <LocalSubprocessRuntime>` | Both patch rows were not applied together, or the patch missed its target. | Keep both rows, keep the bundle after `@deepseek-ai/dsh-base`. |
| The web app exits non-zero without printing a URL, right after a checkout install | `exports` point at `lib/`, which only exists after a build. | Run `npm install` (its `prepare` builds) or `npm run build`. |

<details>
<summary>Two more</summary>

| What you see | What it means | What to do |
|---|---|---|
| `patch: entry "subprocess" not found` (only in `--dump-config` stderr) | The bundle was composed before the row it patches. | Move it after `@deepseek-ai/dsh-base` in `dsh.profile.bundles`. |
| The right-sidebar tab never appears | The client half was dropped silently. | `dsh.client.platform` must be exactly `"web"`, and every `dsh.client.inject` entry must be an exact package name — a `<pkg>/client` suffix is not normalized and matches nothing. |

</details>

`--dump-config` does not predict everything: it composes patches without the
row-level preflight. Patch warnings appear only there; compatibility refusals
only at startup. Read both.

If the plugin is up but a workspace has no environment, open the sidebar tab: it
reports `blocked`, `unreadable` and `absent` separately, and says when a
directory is merely indistinguishable from one without an `.envrc`.

## Security

- **A `.envrc` is arbitrary code.** Evaluating one runs `bash` as you, outside any sandbox. The plugin only evaluates files direnv would already evaluate, and never approves one for you.
- **Values never reach the model as text.** The notice carries counts, paths and warnings; the sidebar is where you inspect names and reveal values on demand.
- **Credential-shaped names reach commands by default.** The overlay sits on top of the harness's scrubbed environment. That is the point of the plugin — and why `injectSensitive` exists.
- **The evaluator strips every `DIRENV_*`** from the environment it hands to `direnv`, so a harness started from a direnv-loaded shell cannot resurrect variables the harness scrubbed.
- **The status route is fenced.** Requests go through the harness's own connection check, unlike the unfenced `/plugins/*` carrier.

## Limits

- **MCP servers and host-side helpers bypass the seam.** Anything spawning through the MCP SDK or the host process does not see the workspace environment. Covered: the harness's `shell`, `subprocess`, search, git and PTY consumers.
- **Another subprocess provider would be shadowed.** Only one provider holds the seat; the plugin reports loudly when it loses it.
- **Some directories look empty.** An unreadable `.envrc` (`chmod 000`) or a `direnv deny`ed directory produces the same empty output as "no `.envrc` here".
- **A failing `.envrc` can half-succeed.** `direnv` exits `0` for `source` misses and syntax errors with earlier variables already applied. Both the sidebar and the notice report these as degraded.
- **The harness's name filter wins twice.** Ambient names that merely *contain* `KEY`, `PASSWORD`, `SECRET` or `TOKEN` (including `TURKEY_MODE`) are scrubbed before an overlay applies. Only values a `.envrc` sets explicitly survive.

<details>
<summary>Three more</summary>

- **Evaluation is not free.** `direnv` keeps no cross-process cache, so a `use nix` workspace costs roughly 0.2 s of re-evaluation per tool call (seconds when cold). Cheap directories are validated by re-fingerprinting instead: content hashes for `.envrc`, `.env`, `direnv.toml`, `lib/*.sh` and the `.direnv/` files nix-direnv rewrites; `mtime+size` for ordinary `watch_file` targets.
- **A hanging `.envrc` is not killed by default.** Set a finite `evaluateTimeoutMs` if you would rather bound it.
- **A timeout or abort is "stop waiting", not "no side effects".** The whole process group is SIGKILLed — `direnv`, the bash that sourced the `.envrc`, its descendants — but the `.envrc` may already have written files or started a service. Nothing here *prevents* an `.envrc` from running; that is what the allow library and `enabled: false` are for.

</details>

## Development

```bash
npm run typecheck           # three projects: host, browser half, tests and harness
npm test                    # unit tests: evaluator (real direnv) + host wiring
npm run test:client         # client half: boot row, byte-identical module, and the fenced status route
test/harness/run.sh --all   # end-to-end cases, no API key needed
```

Strict TypeScript, no build on your side for the published package: `src/**/*.ts`
compiles per file to `lib/` (host half), and `client/**/*.ts` is bundled into the
single file `lib/client.js` the browser is served. `npm install` builds through
`prepare`; `lib/` is not committed. `DESIGN.md` records the architecture and the
measured evidence behind every decision.

`npm test` uses an explicit `test/*.test.ts` glob on purpose: bare `node --test`
would also *execute* the scripts under `test/harness/`. Invoke the harness through
`run.sh`, not `node test/harness/run.ts` — the wrapper scrubs
`DSH_HOME`/`DSH_PROFILE_DIR`, and the harness refuses to run against a live DSH
home by design. The harness drives a stub LLM against `dsh headless`, so a real
turn with real tool execution runs offline.

<details>
<summary>Trying it by hand — a scratch home, no writes to ~/.dsh</summary>

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

Open that URL, start a session in `/tmp/demo/proj`, and look for the direnv tab.
The host half can also be checked from the outside — the cookie comes from the
printed `?token=` link:

```bash
curl -s -H "Cookie: $COOKIE" \
  "http://127.0.0.1:30100/plugins/dsh-direnv/status.json?dir=/tmp/demo/proj&force=1"
# {"ok":true,…,"status":{"state":"ok","envrcPath":"/tmp/demo/proj/.envrc","variables":[{"name":"HANDS_ON",…}]}}
```

A scratch home has no model provider configured, so the sidebar renders but a real
conversation will not. To see the model-side behaviour, point your own configured
home at the plugin for one run — an absolute-path entry mounts the **host half
only** (it is not a package, so it has no manifest and no sidebar tab):

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

</details>

## License

MIT
