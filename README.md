# dsh-direnv

Every command the DeepSeek Harness runs inherits the [direnv](https://direnv.net/)
environment of **its own working directory**.

You already keep `PATH`, toolchains, and per-project secrets in `.envrc` files and
let direnv inject them into your shell. `dsh-direnv` gives the harness the same
deal: a workspace behaves as if `dsh` itself had been launched from inside a
direnv-loaded shell, so the model's `bash`, background jobs, subagents, terminals,
`git`, and `rg` all see the project's dev shell without being told about it.

```
~/.dsh $ dsh web                 # no .envrc here
           └── session in ~/projects/api
                 └── bash: build      → has `cargo`, `DATABASE_URL`, …
```

## How it works

The plugin takes over the harness's `subprocess` seam and evaluates
`direnv export json` per working directory. Three flows share that one fact
source, and they never block each other:

| Flow | Behaviour |
|---|---|
| **Injection** | `spawn` looks the directory up in a cache and merges the diff into the child's environment. The lookup is synchronous and never waits: an unknown directory is forwarded untouched while its evaluation runs in the background, and `spawnTerminal` (a PTY the user opened) awaits the evaluation first. |
| **Gate** | While the session's environment is still unknown, tool calls are held — the model may talk and may *ask* for tools, but those calls wait as though the tool itself were slow. The gate arms once per session, waits at most `loadTimeoutMs`, and is a delay rather than a filter: a determinate result, the timeout, and a cancellation all release it. A released call does **not** cancel the evaluation: that keeps running under its own budget (`evaluateTimeoutMs`, `0` = never kill), so a slow `.envrc` finishes in the background and the next command in that workspace gets the environment. |
| **Surfaces** | One sourced notice tells the model what was loaded; a right-sidebar tab tells you the variable names, the `PATH` diff (added, removed or unchanged, in priority order) and the credential list. |

Direnv does the walking: the anchor is each spawn's **own resolved `cwd`**, so a
command that `cd`s into a subdirectory gets that subdirectory's environment, and
a change to any `.envrc` takes effect on the next tool call.

## Install

```bash
# from a checkout: `npm install` runs the build that produces lib/
npm install
dsh plugin add "file:$PWD"

# once it is on npm
dsh plugin add dsh-direnv
```

`.envrc` files stay under your control: the plugin reads the environment direnv
already knows how to produce and **never calls `direnv allow` for you**. If a
file is not approved, commands run with the harness environment and the sidebar
says so.

### Installing by hand

`dsh-direnv` ships a bundle patch that disables the stock `subprocess` row and
inserts its own. Add the package to your profile's `node_modules`, list it in
`dsh.profile.bundles`, and keep both rows of `cordis.patch.yml` intact:

- with only the `insert` row, startup reports
  `Error: service "subprocess" has been registered at <LocalSubprocessRuntime>`
  and the plugin has no effect;
- the bundle must come **after** `@deepseek-ai/dsh-base` in `dsh.profile.bundles`,
  otherwise the patch misses its target
  (`patch: entry "subprocess" not found`) and you get the same duplicate-service
  failure. `dsh plugin add` appends, so the normal path is already correct.

### Requirements

- Node ≥ 22.18 to build and test a checkout (installing the published package needs no build on your side).
- `direnv` on `PATH` (or set `direnvPath`). The plugin does nothing else — no
  shell hook, no `.envrc` edits, no approval prompts.
- DSH `~0.1.7-rc.1`. The version range is deliberately narrow: this plugin
  subclasses an internal runtime class, and a silent mismatch is worse than a
  refused install.

## Verify it

```bash
dsh --profile <name> --dump-config | grep -A3 'id: subprocess'   # disabled: true
```

Then, in a session whose workspace has an approved `.envrc`, ask the model to run:

```bash
printenv | grep -c .        # and: echo "$SOME_VAR_YOUR_ENVRC_SETS"
```

If the variable is missing, see [Troubleshooting](#troubleshooting) — the failure
signatures are specific and mostly quiet.

## Troubleshooting

Nearly every way this plugin can fail is **quiet**, so read the startup output
before assuming it works:

| What you see | What it means | What to do |
|---|---|---|
| `dsh: skipping profile bundle "dsh-direnv"` | The peer range did not match, so the whole bundle was skipped. Its patch never ran, the stock provider is still in place, and `--dump-config` looks identical to a clean install. | Install a DSH the range accepts, or accept the risk with `dsh plugin allow-version`. |
| `dsh: disabling profile plugin row "direnv-subprocess"` | The row was disabled by the row-level preflight. `--dump-config` **does not show this** — it prints the patch composition only. | Same as above. |
| `dsh: warning: N entries did not activate`, followed by `… pending (waiting for service: subprocess)` | The patch applied but the plugin never came up, so commands have no `bash` tool at all. | Look for `direnv-subprocess (…): failed to import`; the underlying reason is swallowed, so check that the package is installed and its `exports` resolve. |
| `Error: service "subprocess" has been registered at <LocalSubprocessRuntime>` | Both patch rows were not applied together, or the patch missed its target. | Keep both rows, keep the bundle after `@deepseek-ai/dsh-base`, and look for `patch: entry "subprocess" not found`. |
| `patch: entry "subprocess" not found` (appears only in `--dump-config` stderr) | The bundle was composed before the row it patches. | Move it after `@deepseek-ai/dsh-base` in `dsh.profile.bundles`. |
| The web app exits non-zero without printing a URL, right after installing from a source checkout | The package's `exports` point at `lib/`, which only exists after a build. | Run `npm install` in the checkout (its `prepare` script builds), or `npm run build`. |
| The right-sidebar tab never appears | The client half was dropped silently. | `dsh.client.platform` must be exactly `"web"`, and every `dsh.client.inject` entry must be an exact package name — a `<pkg>/client` suffix is not normalized and matches nothing. |

`--dump-config` is **not** a complete prediction of what mounts: it composes
patches without running the row-level preflight, and the two diagnostic families
are split — patch warnings appear only there, compatibility refusals only at
startup. Read both.

If the plugin is up but a workspace has no environment, open the sidebar tab: it
reports `blocked`, `unreadable`, and `absent` separately, and tells you when a
directory is merely indistinguishable from one without an `.envrc`.

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

`injectSensitive: filter` withholds variables whose names look like credentials
(`/KEY|PASSWORD|SECRET|TOKEN/i`). It exists for cautious setups and will break dev
shells that need those values; the default injects them faithfully, because that
is what "the workspace environment" means.

The two timeouts answer different questions. `loadTimeoutMs` is the gate's budget:
how long a tool call may be held before it is released to run with whatever is
known. `evaluateTimeoutMs` bounds the `direnv` child itself, and its default `0`
means it is never killed, because a cold `use flake` build has no predictable
duration and killing it would lose the work. The cost: an `.envrc` that never
finishes (`sleep infinity`, a stuck download) keeps **one** `direnv` process per
directory alive for the session — in-flight dedup makes sure it stays one, the
gate still releases tool calls at `loadTimeoutMs`, and setting a finite
`evaluateTimeoutMs` bounds it. When that deadline does fire — or the run is
aborted — the whole process group is killed: `direnv`, the `bash` it sources the
`.envrc` in, and anything that bash started. It is still *"stop waiting"*, not
*"no side effects"*: see Known limitations.

## Security

- **A `.envrc` is arbitrary code.** Evaluating one runs `bash` as you, outside any
  sandbox — it can write files, and `nix-direnv` will populate `.direnv/` inside
  the project. `dsh-direnv` only ever evaluates files direnv would already
  evaluate, and it never approves one on your behalf.
- **Variable values never reach the model as text.** The sourced notice carries
  counts, paths, and warnings; the sidebar is where an operator inspects names and
  reveals values on demand. Requests to that route are admitted through the
  harness's own connection fence, unlike the unfenced `/plugins/*` carrier.
- **Credentials are injected deliberately.** The overlay is applied on top of the
  harness's scrubbed environment, so values a `.envrc` provides do reach commands.
  That is the point of the plugin — and the reason `injectSensitive` exists.
- The evaluator strips every `DIRENV_*` variable from the environment it hands to
  `direnv`, so a harness started from a direnv-loaded shell cannot resurrect
  variables the harness deliberately scrubbed.

## Known limitations

- **MCP servers and host-side helpers bypass the seam.** Anything that spawns
  through the MCP SDK or the host process directly does not see the workspace
  environment; the covered paths are the harness's own `shell`, `subprocess`,
  search, git, and PTY consumers.
- **Another subprocess provider would be shadowed.** Only one provider can hold
  the seat; the plugin reports loudly when it loses it.
- **Some directories are indistinguishable from empty ones.** A `.envrc` that is
  unreadable (`chmod 000`) or a directory the user ran `direnv deny` in produces
  the same empty output as "no `.envrc` here".
- **A failing `.envrc` can still half-succeed.** `direnv` exits `0` for `source`
  misses and syntax errors, with earlier variables already applied — the sidebar
  and the model notice both report these as degraded.
- **The harness's own name filter wins twice.** Ambient variables whose names
  merely *contain* `KEY`, `PASSWORD`, `SECRET`, or `TOKEN` (including innocent
  ones like `TURKEY_MODE`) are scrubbed before an overlay is applied; only values
  a `.envrc` sets explicitly survive.
- **Evaluation is not free.** `direnv` keeps no cross-process cache, so a
  workspace with `use nix` costs roughly 0.2 s of re-evaluation per tool call
  (seconds when its cache is cold). Cheap directories are validated by
  re-fingerprinting the inputs instead: content hashes for `.envrc`, `.env`,
  `direnv.toml`, `lib/*.sh` and the `.direnv/` cache files nix-direnv rewrites,
  `mtime+size` for ordinary `watch_file` targets. That is a handful of small
  reads plus one profile-sized read per validation (measured ≈ +1 ms for a
  68 KB nix-direnv profile).
- **A hanging `.envrc` is not killed by default.** `evaluateTimeoutMs: 0`
  deliberately lets a slow dev shell finish; the price is one long-lived
  `direnv` process per directory for an `.envrc` that never terminates. Set a
  finite `evaluateTimeoutMs` if that trade is wrong for you.
- **A timeout or abort is "stop waiting", not "no side effects".** When the
  deadline fires, the whole process group is SIGKILLed — `direnv`, the bash it
  sources the `.envrc` in, and its descendants — so nothing is left orphaned.
  But the `.envrc` may already have written files, started a service, or
  changed git state before it died, and killing it later cannot undo that.
  Nothing here *prevents* an `.envrc` from running; that is what the allow
  library (and `enabled: false`) are for.

## Development

The plugin is written in strict TypeScript and built to plain ESM: `src/**/*.ts`
compiles per file to `lib/` (the host half), and `client/**/*.ts` is bundled into
the single file `lib/client.js` the browser is served — the client module table
has no relative `require`, so that half must ship as one file. `npm install` runs
the build through `prepare`, so a fresh checkout is usable after installing;
`lib/` itself is not committed. `DESIGN.md` records the architecture and the
measured evidence behind every decision, including the failure signatures above.

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


`npm test` uses an explicit `test/*.test.ts` glob on purpose: bare `node --test`
would also try to *execute* the scripts under `test/harness/`. And invoke the
harness through `run.sh`, not `node test/harness/run.ts` — the wrapper scrubs
`DSH_HOME`/`DSH_PROFILE_DIR` before spawning anything, and the harness refuses to
run against a live DSH home by design.

The harness drives a local stub LLM against `dsh headless`, so a real turn with
real tool execution can be exercised offline.

`npm run test:client` boots a scratch `web` profile with this repo mounted and
checks what can be checked without a browser: the client row is in the boot
payload, the served module is byte-identical to the built `lib/client.js`, and the status route
rejects cookie-less requests and keeps values out by default. It cannot tell you
whether the tab actually renders, the composer greys out, the toast disappears
after three seconds, or how the real `SlotCore` reacts to those registrations —
that still needs a browser.

## License

MIT
