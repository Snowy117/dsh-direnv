#!/usr/bin/env node
/**
 * Regression harness for the dsh-direnv plugin: one case = one fake-LLM-driven
 * DSH headless run in a fully private, disposable environment.
 *
 *   node test/harness/run.ts --case gate-7000
 *   test/harness/run.sh gate-7000          (same thing, with a scrubbed env)
 *
 * Safety model (see README "硬守卫"):
 *   - the child's DSH_HOME is HARDCODED to .runs/<case>/home and never taken
 *     from the environment; every inherited DSH_* variable is dropped from the
 *     child env;
 *   - running this script while the ambient DSH_HOME/DSH_PROFILE_DIR points into
 *     a live home (~/.dsh) is refused outright (exit 2) rather than silently
 *     ignored;
 *   - every path handed to `rm -rf` is asserted to live under
 *     test/harness/.runs/ first, and the computed DSH_HOME is asserted not to be
 *     inside a live home;
 *   - the fake LLM listens on an ephemeral port (0) and publishes it through a
 *     port file; on exit only the PIDs this run recorded are signalled (never
 *     `pkill -f`), and the run reports whether anything survived.
 *
 * Evidence per run lands in .runs/<case>/: evidence.json (machine readable),
 * timeline.txt (durable session log), summary.txt (what was printed), plus the
 * raw stdout/stderr, the fake-LLM request log and the probe log.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { ChildProcess } from 'node:child_process';

import { describeCase, loadCases } from './cases.ts';
import type { CaseContext, FakeLlmCaseConfig, HarnessCase } from './cases.ts';
import { computeMetrics, evaluate, readFakeLog, readProbeRows, renderSummary } from './evaluate.ts';
import type { AuditDiff, Evidence } from './evaluate.ts';
import { isJsonRecord, readJsonl } from './json.ts';
import type { JsonRecord } from './json.ts';
import {
  buildTimeline,
  extractRunEvents,
  extractToolFlow,
  findSessionLog,
  formatTimeline,
  readSessionLog,
} from './timeline.ts';
import type { RunEvent, ToolFlow } from './timeline.ts';

const HARNESS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.resolve(HARNESS_DIR, '..', '..');
const RUNS_DIR = path.join(HARNESS_DIR, '.runs');
const FAKE_LLM = path.join(HARNESS_DIR, 'fake-llm.ts');
const PROBE = path.join(HARNESS_DIR, 'probe.ts');
const OVERLAY_TEMPLATE = path.join(HARNESS_DIR, 'overlay.template.yml');

/** Dummy credential handed to the fake route; never a real key. */
const API_KEY_ENV = 'HARNESS_FAKE_LLM_KEY';
const API_KEY_VALUE = 'harness-dummy-key-not-a-credential';
const DEFAULT_PROFILE = 'harness';
const AUDIT_SKIP = new Set(['.git', 'node_modules', '.direnv', '.runs']);

/** The live DSH homes no scratch directory may ever overlap; `$HOME` is
 *  honoured independently of `os.homedir()` because the two disagree under
 *  sudo or an overridden environment. */
const PROTECTED_HOMES = [
  ...new Set(
    [os.homedir(), process.env.HOME ?? '']
      .filter((home) => home !== '')
      .map((home) => path.resolve(home, '.dsh')),
  ),
];

let printed = '';
function out(line = ''): void {
  printed += `${line}\n`;
  process.stdout.write(`${line}\n`);
}
function refuse(reason: string, remedy?: string): never {
  process.stderr.write(`\n[harness] REFUSING TO RUN: ${reason}\n`);
  if (remedy) process.stderr.write(`[harness] ${remedy}\n`);
  process.exit(2);
}

function assertUnderRuns(target: string, label: string): string {
  const abs = path.resolve(target);
  if (abs === RUNS_DIR || !abs.startsWith(RUNS_DIR + path.sep)) {
    refuse(`${label} escapes the harness run root: ${abs}\n  run root: ${RUNS_DIR}`);
  }
  return abs;
}

/** Layer 2 guard: never operate in a shell that already points at a live home. */
function guardEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  for (const key of ['DSH_HOME', 'DSH_PROFILE_DIR']) {
    const raw = env[key];
    if (!raw) continue;
    const abs = path.resolve(raw);
    for (const live of PROTECTED_HOMES) {
      if (abs === live || abs.startsWith(live + path.sep)) {
        refuse(
          `${key}=${abs} points inside a live DSH home (${live}).`,
          'This harness always uses a private DSH_HOME; an inherited live-home value means the shell is\n' +
          '  unsafe to spawn from. Re-run through the wrapper (it scrubs DSH_*):\n' +
          '      test/harness/run.sh --case <name>\n' +
          '  or scrub manually:\n' +
          '      env -u DSH_HOME -u DSH_PROFILE_DIR node test/harness/run.ts --case <name>',
        );
      }
    }
    process.stderr.write(`[harness] warning: inherited ${key}=${abs} is ignored (the child gets a private home)\n`);
  }
}

/** Child env: ambient DSH_* is dropped wholesale, never inherited. */
function buildChildEnv({ dshHome, probeLog }: { dshHome: string; probeLog: string }): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    // `process.env` never yields undefined values; the guard satisfies the index type.
    if (v === undefined) continue;
    if (/^dsh_/i.test(k)) continue;
    if (['PROBE_LOG', 'NODE_OPTIONS', 'FAKE_LLM_CONFIG_FILE', 'FAKE_LOG_DIR', 'FAKE_LLM_PORT'].includes(k)) continue;
    if (['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME'].includes(k)) continue;
    env[k] = v;
  }
  env.DSH_HOME = dshHome;
  env.DSH_TELEMETRY_DISABLED = '1';
  env[API_KEY_ENV] = API_KEY_VALUE;
  env.PROBE_LOG = probeLog;
  return env;
}

function resolveDshBin(): string {
  const explicit = process.env.HARNESS_DSH_BIN;
  if (explicit) return explicit;
  const which = spawnSync('sh', ['-c', 'command -v dsh'], { encoding: 'utf8' });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
  // Nix installs `dsh` outside the login PATH in some shells; probe the usual
  // profile locations rather than assuming one per-user layout.
  const candidates = [
    '/run/current-system/sw/bin/dsh',
    `/etc/profiles/per-user/${os.userInfo().username}/bin/dsh`,
    path.join(os.homedir(), '.nix-profile', 'bin', 'dsh'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? 'dsh';
}

// ------------------------------------------------------------------ utilities

const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

function snapshotTree(root: string): Map<string, string> {
  const map = new Map<string, string>();
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (AUDIT_SKIP.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        const st = fs.statSync(p);
        map.set(path.relative(root, p), `${Math.round(st.mtimeMs)}:${st.size}`);
      }
    }
  };
  walk(root);
  return map;
}

function diffSnapshots(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): AuditDiff {
  const changed: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  for (const [k, v] of after) {
    if (!before.has(k)) added.push(k);
    else if (before.get(k) !== v) changed.push(k);
  }
  for (const k of before.keys()) if (!after.has(k)) removed.push(k);
  return { changed, added, removed };
}

function alive(pid: number | undefined): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function signalTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try { process.kill(-pid, signal); } catch { try { process.kill(pid, signal); } catch { /* already gone */ } }
}

async function stopChild(child: ChildProcess | null, name: string, { graceMs = 3000 }: { graceMs?: number } = {}): Promise<{ stopped: boolean; forced: boolean }> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return { stopped: true, forced: false };
  const pid = child.pid;
  const exited = new Promise<void>((resolve) => { child.once('exit', () => { resolve(); }); });
  signalTree(pid, 'SIGTERM');
  const soft = await Promise.race([exited.then(() => true), sleep(graceMs).then(() => false)]);
  if (soft) return { stopped: true, forced: false };
  signalTree(pid, 'SIGKILL');
  await Promise.race([exited, sleep(2000)]);
  process.stderr.write(`[harness] warning: ${name} (pid ${pid}) needed SIGKILL\n`);
  return { stopped: true, forced: true };
}

interface FakeLlmHandle {
  child: ChildProcess;
  port: number;
  pid: number | undefined;
}

async function startFakeLlm({ runDir, fakeCfg, env }: { runDir: string; fakeCfg: FakeLlmCaseConfig; env: Record<string, string> }): Promise<FakeLlmHandle> {
  const cfgFile = path.join(runDir, 'fake-llm.config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ port: 0, logDir: runDir, ...fakeCfg }, null, 2));
  const log = fs.openSync(path.join(runDir, 'fake-llm.out'), 'a');
  const child = spawn(process.execPath, [FAKE_LLM], {
    detached: true,
    stdio: ['ignore', log, log],
    env: { ...env, FAKE_LLM_CONFIG_FILE: cfgFile },
  });
  child.unref();

  const portFile = path.join(runDir, 'fake-llm.port');
  const deadline = Date.now() + 15000;
  let port: number | null = null;
  while (Date.now() < deadline) {
    if (fs.existsSync(portFile)) {
      port = Number(fs.readFileSync(portFile, 'utf8').trim());
      if (port) break;
    }
    await sleep(50);
  }
  if (port === null || !port) throw new Error(`fake LLM did not publish a port (see ${runDir}/fake-llm.out)`);
  const published = port;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${published}/health`);
      if (res.ok) return { child, port: published, pid: child.pid };
    } catch { /* not up yet */ }
    await sleep(50);
  }
  throw new Error(`fake LLM on port ${published} never became healthy`);
}

interface DshRunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  wallMs: number;
  pid: number | undefined;
  child: ChildProcess;
  error?: string | undefined;
}

/** The same run without the handle: what the evidence needs once it has settled. */
type DshOutcome = Omit<DshRunResult, 'child'>;

function runDsh({ bin, args, cwd, env, timeoutMs, outFile, errFile }: {
  bin: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  outFile: string;
  errFile: string;
}): Promise<DshRunResult> {
  return new Promise((resolve) => {
    const outFd = fs.openSync(outFile, 'w');
    const errFd = fs.openSync(errFile, 'w');
    const started = Date.now();
    const child = spawn(bin, args, { cwd, env, detached: true, stdio: ['ignore', outFd, errFd] });
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(async () => {
      timedOut = true;
      await stopChild(child, 'dsh');
    }, timeoutMs);
    child.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fs.closeSync(outFd); fs.closeSync(errFd);
      resolve({ code, signal, timedOut, wallMs: Date.now() - started, pid: child.pid, child });
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fs.closeSync(outFd); fs.closeSync(errFd);
      resolve({ code: null, signal: null, timedOut, wallMs: Date.now() - started, pid: child.pid, child, error: String(err) });
    });
  });
}

/** `{{WS}}` in a tool call's arguments expands to this run's workspace. */
function substituteWorkspace(args: Record<string, unknown>, wsDir: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(JSON.stringify(args).replaceAll('{{WS}}', wsDir));
  return isJsonRecord(parsed) ? parsed : args;
}

// ------------------------------------------------------------------- the run

interface CaseRunOptions {
  timeoutMs: number;
  audit: boolean;
  out?: string | undefined;
  strictAudit?: boolean | undefined;
}

async function runCase(def: HarnessCase, opts: CaseRunOptions): Promise<boolean> {
  const runName = opts.out || def.name;
  if (!/^[A-Za-z0-9._-]+$/.test(runName)) refuse(`--out must match [A-Za-z0-9._-]+ (got ${JSON.stringify(runName)})`);

  const runDir = assertUnderRuns(path.join(RUNS_DIR, runName), 'run dir');
  const dshHome = assertUnderRuns(path.join(runDir, 'home'), 'DSH_HOME');
  for (const live of PROTECTED_HOMES) {
    if (dshHome === live || dshHome.startsWith(live + path.sep)) {
      refuse(`computed DSH_HOME ${dshHome} is inside a live DSH home (${live})`);
    }
  }
  const wsDir = assertUnderRuns(path.join(runDir, 'ws'), 'session cwd');
  const profile = def.profile ?? DEFAULT_PROFILE;
  const overlayPath = path.join(runDir, 'overlay.yml');
  const probeLog = path.join(runDir, 'probe.jsonl');

  fs.rmSync(runDir, { recursive: true, force: true }); // guarded above
  fs.mkdirSync(wsDir, { recursive: true });
  for (const [rel, content] of Object.entries(def.files)) {
    const target = assertUnderRuns(path.join(wsDir, rel), `case file ${rel}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }

  const ctxInfo: CaseContext = { runDir, wsDir, dshHome, profile, profileDir: path.join(dshHome, 'profiles', profile), repoDir: REPO_DIR };
  const prepared = def.prepare ? await def.prepare(ctxInfo) : undefined;
  const childEnv: Record<string, string> = {
    XDG_DATA_HOME: path.join(runDir, 'xdg-data'),
    XDG_CACHE_HOME: path.join(runDir, 'xdg-cache'),
    ...buildChildEnv({ dshHome, probeLog }),
    ...(prepared?.env ?? {}),
  };
  const dshBin = resolveDshBin();
  const version = spawnSync(dshBin, ['--version'], { encoding: 'utf8' });
  const dshVersion = String(version.stdout || version.stderr || '').trim() || 'unknown';

  const auditBefore = opts.audit ? snapshotTree(REPO_DIR) : null;

  const fakeCfg: FakeLlmCaseConfig = { chunkDelayMs: 2, ...def.fake };
  for (const call of fakeCfg.toolCalls ?? []) {
    if (call.arguments) call.arguments = substituteWorkspace(call.arguments, wsDir);
  }

  out('');
  out(`[harness] case ${def.name} -> ${runDir}`);
  const llm = await startFakeLlm({ runDir, fakeCfg, env: childEnv });
  let dshResult: DshOutcome = { code: null, signal: null, timedOut: false, wallMs: 0, pid: undefined };
  let probe: JsonRecord[] = [];
  let requests: JsonRecord[] = [];
  let records: JsonRecord[] = [];
  let flow: ToolFlow = { calls: [], results: [] };
  let runEvents: RunEvent[] = [];
  let stdoutText = '', stderrText = '';
  let profileInitialized = false;
  let fakeStop = { stopped: true, forced: false };
  let commandLine = '';

  try {
    const boot = ['--profile', profile];
    const profilePkg = path.join(dshHome, 'profiles', profile, 'package.json');
    if (def.bootstrapProfileFirst && !fs.existsSync(profilePkg)) {
      const bootOnly = runDsh({
        bin: dshBin, args: [...boot, '--from-default-profile', 'headless', '--dump-config'],
        cwd: wsDir, env: childEnv, timeoutMs: 120000,
        outFile: path.join(runDir, 'dsh.bootstrap.out'), errFile: path.join(runDir, 'dsh.bootstrap.err'),
      });
      const r = await bootOnly;
      if (r.code !== 0) throw new Error(`profile bootstrap failed (exit ${r.code}); see dsh.bootstrap.err`);
      profileInitialized = true;
    }
    if (def.prepareProfile) await def.prepareProfile(ctxInfo);
    if (!fs.existsSync(profilePkg)) {
      boot.push('--from-default-profile', 'headless');
      profileInitialized = true;
    }
    boot.push('--patch', overlayPath);

    const overlay = fs.readFileSync(OVERLAY_TEMPLATE, 'utf8')
      .replaceAll('__PORT__', String(llm.port))
      .replaceAll('__API_KEY_ENV__', API_KEY_ENV)
      .replaceAll('__PROBE_PATH__', PROBE)
      .replaceAll('__TAG__', runName)
      .replaceAll('__GATE_MODE__', def.gateMode ?? 'delay')
      .replaceAll('__GATE_MS__', String(def.gateMs ?? 0))
      .replaceAll('__BLOCK_AGENT_CREATED_MS__', String(def.blockAgentCreatedMs ?? 0))
      .replaceAll('__EXTRA_ROWS__', (def.extraRows ?? '').trimEnd());
    fs.writeFileSync(overlayPath, overlay);

    const args = [...boot, '--json', def.task];
    commandLine = `dsh ${args.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}`;
    out(`[harness] ${commandLine}`);
    dshResult = await runDsh({
      bin: dshBin, args, cwd: wsDir, env: childEnv, timeoutMs: def.timeoutMs ?? opts.timeoutMs,
      outFile: path.join(runDir, 'dsh.out'), errFile: path.join(runDir, 'dsh.err'),
    });
  } finally {
    fakeStop = await stopChild(llm.child, 'fake-llm');
  }

  stdoutText = fs.existsSync(path.join(runDir, 'dsh.out')) ? fs.readFileSync(path.join(runDir, 'dsh.out'), 'utf8') : '';
  stderrText = fs.existsSync(path.join(runDir, 'dsh.err')) ? fs.readFileSync(path.join(runDir, 'dsh.err'), 'utf8') : '';
  probe = readJsonl(probeLog);
  requests = readJsonl(path.join(runDir, 'fake-llm.requests.jsonl'));
  runEvents = extractRunEvents(stdoutText);
  const sessionEvent = runEvents.find((e) => e.type === 'session');
  const sessionId = sessionEvent?.sessionId ?? null;
  const finalText = runEvents.filter((e) => e.type === 'text').map((e) => e.text ?? '').join('');
  const sessionLog = findSessionLog(dshHome, sessionId);
  records = sessionLog ? (readSessionLog(sessionLog) ?? []) : [];
  const timeline = buildTimeline(records);
  flow = extractToolFlow(records);

  const metrics = computeMetrics({
    flow,
    probeRows: readProbeRows(probe),
    fake: readFakeLog(requests),
    wallMs: dshResult.wallMs,
    finalText,
  });
  const auditAfter = opts.audit ? snapshotTree(REPO_DIR) : null;

  const evidence: Evidence = {
    case: def.name,
    runDir,
    dshHome,
    wsDir,
    profile,
    profileInitialized,
    dshBin,
    dshVersion,
    commandLine,
    childEnvKeys: Object.keys(childEnv).sort(),
    apiKeyEnv: API_KEY_ENV,
    apiKeyValueLength: API_KEY_VALUE.length,
    exitCode: dshResult.code,
    signal: dshResult.signal,
    timedOut: dshResult.timedOut,
    wallMs: dshResult.wallMs,
    fakeLlm: { port: llm.port, pid: llm.pid, stopped: fakeStop.stopped, forcedKill: fakeStop.forced },
    sessionId,
    sessionLog,
    finalText,
    requests,
    probe,
    timeline,
    flow,
    metrics,
    audit: auditBefore && auditAfter ? diffSnapshots(auditBefore, auditAfter) : null,
    processes: {
      fakeLlmAlive: alive(llm.pid),
      dshAlive: alive(dshResult.pid),
    },
    dshPid: dshResult.pid,
    fakeLlmPid: llm.pid,
    timelineText: '',
    stdout: '',
    stderr: '',
    assertions: [],
  };

  const timelineText = formatTimeline(timeline);
  fs.writeFileSync(path.join(runDir, 'timeline.txt'), timelineText + '\n');
  evidence.timelineText = timelineText;
  evidence.stdout = stdoutText;
  evidence.stderr = stderrText;
  evidence.assertions = evaluate(def, evidence, opts);

  const ok = renderSummary(evidence, def, out);
  fs.writeFileSync(path.join(runDir, 'summary.txt'), printed);
  fs.writeFileSync(path.join(runDir, 'evidence.json'), JSON.stringify(evidence, null, 2));
  printed = '';
  if (dshResult.error) process.stderr.write(`[harness] spawn error: ${dshResult.error}\n`);
  return ok;
}

// ----------------------------------------------------------------------- main

interface CliOptions extends CaseRunOptions {
  force?: boolean | undefined;
  list?: boolean | undefined;
  all?: boolean | undefined;
  help?: boolean | undefined;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const opts: CliOptions = { timeoutMs: 300000, audit: true };
  const wanted: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--case') {
      const name = argv[++i];
      if (name === undefined) refuse('--case needs a case name');
      wanted.push(name);
    }
    else if (a === '--out') { const value = argv[++i]; if (value !== undefined) opts.out = value; }
    else if (a === '--timeout') opts.timeoutMs = Number(argv[++i]) * 1000;
    else if (a === '--no-audit') opts.audit = false;
    else if (a === '--force') opts.force = true;
    else if (a === '--strict-audit') opts.strictAudit = true;
    else if (a === '--list') opts.list = true;
    else if (a === '--all') opts.all = true;
    else if (a === '-h' || a === '--help') opts.help = true;
    else refuse(`unknown argument: ${a}`);
  }

  const cases = await loadCases();
  if (opts.help) {
    out('usage: node test/harness/run.ts --case <name> [--out <dir>] [--timeout <s>] [--force] [--no-audit] [--strict-audit]');
    out('       node test/harness/run.ts --list | --all');
    return 0;
  }
  if (opts.list) {
    out('cases (status / name / gate / fake tool calls):');
    for (const def of cases) out('  ' + describeCase(def));
    return 0;
  }
  if (!wanted.length && !opts.all) {
    out('usage: node test/harness/run.ts --case <name>   (or --list / --all)');
    return 0;
  }
  if (opts.all && opts.out) refuse('--out cannot be combined with --all (every case needs its own run dir)');

  guardEnvironment();

  const selected = opts.all
    ? cases.filter((c) => (c.status ?? 'ready') === 'ready')
    : wanted.map((name) => {
      const def = cases.find((c) => c.name === name);
      if (!def) refuse(`unknown case ${JSON.stringify(name)} (see --list)`);
      return def;
    });

  const results: { def: HarnessCase; status: 'pass' | 'fail' | 'pending'; ok: boolean }[] = [];
  for (const def of selected) {
    const missing = (def.requires?.repoFiles ?? []).filter((f) => !fs.existsSync(path.join(REPO_DIR, f)));
    if (((def.status ?? 'ready') === 'pending-host' || missing.length) && !opts.force) {
      out('');
      out(`=== dsh-direnv harness: ${def.name} -> PENDING (declared pending-host) ===`);
      out(`${def.description}`);
      out(`requires: ${(def.requires?.repoFiles ?? ['(nothing declared)']).map((f) => `${f} (${missing.includes(f) ? 'MISSING' : 'present'})`).join(', ')}`);
      out('this case is written but declared pending-host: the plugin host half is not ready yet; see README.md "direnv-smoke"');
      out('re-run with --force to attempt it anyway and capture the current failure');
      results.push({ def, status: 'pending', ok: false });
      continue;
    }
    const ok = await runCase(def, { timeoutMs: opts.timeoutMs, audit: opts.audit, out: opts.out, strictAudit: opts.strictAudit });
    results.push({ def, status: ok ? 'pass' : 'fail', ok });
  }

  if (results.length > 1) {
    out('');
    out('=== summary ===');
    for (const r of results) out(`  ${r.status.toUpperCase().padEnd(8)} ${r.def.name}`);
  }
  if (results.some((r) => r.status === 'fail')) return 1;
  if (results.some((r) => r.status === 'pending')) return 3;
  return 0;
}

main().then((code) => {
  process.exitCode = code;
}).catch((err: unknown) => {
  // `err?.stack || err`, with the shape of a thrown value proved before use.
  const stack = isJsonRecord(err) ? err.stack : undefined;
  process.stderr.write(`[harness] fatal: ${typeof stack === 'string' && stack ? stack : String(err)}\n`);
  process.exitCode = 1;
});
