/**
 * Grading and reporting for one harness run: the metric table, the assertion
 * list and the human-readable summary.
 *
 * Every number graded here was produced by another process — the probe log, the
 * fake LLM's request log and the durable session timeline are JSON that crossed
 * a process boundary, so each is lifted out of `unknown` by an explicit reader
 * before a metric or an assertion touches it.
 */
import { readBoolean, readNumber, readString } from './json.ts';
import type { JsonRecord } from './json.ts';
import type { HarnessCase, MetricRange, TextSpec } from './cases.ts';
import type { TimelineRow, ToolFlow } from './timeline.ts';

export type AssertionLevel = 'assert' | 'warning';

/** One graded assertion, exactly as `summary.txt` and `evidence.json` render it. */
export interface AssertionRow {
  name: string;
  expected: string;
  actual: string;
  ok: boolean;
  level: AssertionLevel;
}

/** What the repo audit saw change between the start and the end of a run. */
export interface AuditDiff {
  changed: string[];
  added: string[];
  removed: string[];
}

/** A `probe.jsonl` row, reduced to what the grader times against. */
export interface ProbeRow {
  ev: string;
  t: number;
  callId: string | undefined;
}

/** A `request` row of `fake-llm.requests.jsonl`, reduced to what the grader reads. */
export interface FakeRequestRow {
  n: number;
  t: number;
  hasTools: boolean;
  sawToolRole: boolean;
  decision: string;
  toolNames: (string | undefined)[];
  msgRoles: unknown[];
  maxCompletionTokens: number | null;
  route: string;
}

export interface FakeUnhandledRow {
  route: string;
}

/** The two row kinds `computeMetrics` and the summary care about. */
export interface FakeLog {
  requests: FakeRequestRow[];
  unhandled: FakeUnhandledRow[];
}

/**
 * Everything the assertions and the summary read, in the order `evidence.json`
 * writes it. `requests` and `probe` are the raw log rows on purpose: the file is
 * evidence, so it keeps what the processes wrote rather than what the grader
 * happened to use.
 */
export interface Evidence {
  case: string;
  runDir: string;
  dshHome: string;
  wsDir: string;
  profile: string;
  profileInitialized: boolean;
  dshBin: string;
  dshVersion: string;
  commandLine: string;
  childEnvKeys: string[];
  apiKeyEnv: string;
  apiKeyValueLength: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  wallMs: number;
  fakeLlm: { port: number; pid: number | undefined; stopped: boolean; forcedKill: boolean };
  sessionId: string | null;
  sessionLog: string | null;
  finalText: string;
  requests: JsonRecord[];
  probe: JsonRecord[];
  timeline: TimelineRow[];
  flow: ToolFlow;
  metrics: Record<string, number>;
  audit: AuditDiff | null;
  processes: { fakeLlmAlive: boolean; dshAlive: boolean };
  dshPid: number | undefined;
  fakeLlmPid: number | undefined;
  timelineText: string;
  stdout: string;
  stderr: string;
  assertions: AssertionRow[];
}

/**
 * The probe stamps every record with an absolute epoch ms; a row without one
 * cannot be cross-referenced against the durable log, so it is dropped.
 */
export function readProbeRows(rows: readonly JsonRecord[]): ProbeRow[] {
  const probe: ProbeRow[] = [];
  for (const row of rows) {
    const ev = readString(row, 'ev');
    const t = readNumber(row, 't');
    if (ev === undefined || t === undefined) continue;
    probe.push({ ev, t, callId: readString(row, 'callId') });
  }
  return probe;
}

/** Route the raw request log by record kind; unknown records are ignored. */
export function readFakeLog(rows: readonly JsonRecord[]): FakeLog {
  const requests: FakeRequestRow[] = [];
  const unhandled: FakeUnhandledRow[] = [];
  for (const row of rows) {
    const ev = readString(row, 'ev');
    if (ev === 'request') requests.push(readFakeRequest(row));
    else if (ev === 'unhandled') unhandled.push({ route: readString(row, 'route') ?? '' });
  }
  return { requests, unhandled };
}

function readFakeRequest(row: JsonRecord): FakeRequestRow {
  const tools = row.toolNames;
  const roles = row.msgRoles;
  const maxTokens = row.maxCompletionTokens;
  return {
    n: readNumber(row, 'n') ?? 0,
    t: readNumber(row, 't') ?? 0,
    hasTools: readBoolean(row, 'hasTools') === true,
    sawToolRole: readBoolean(row, 'sawToolRole') === true,
    decision: readString(row, 'decision') ?? '',
    toolNames: Array.isArray(tools) ? tools.map((name) => (typeof name === 'string' ? name : undefined)) : [],
    msgRoles: Array.isArray(roles) ? roles : [],
    maxCompletionTokens: typeof maxTokens === 'number' ? maxTokens : null,
    route: readString(row, 'route') ?? '',
  };
}

export interface MetricsInput {
  flow: ToolFlow;
  probeRows: readonly ProbeRow[];
  fake: FakeLog;
  wallMs: number;
  finalText: string;
}

/**
 * The metric table. Keys of the form `<from>-><to>:<callId>` are cross-source
 * deltas: the durable log and the probe run in different processes and both
 * stamp absolute epoch ms, which is the whole point of the probe.
 */
export function computeMetrics({ flow, probeRows, fake, wallMs, finalText }: MetricsInput): Record<string, number> {
  const m: Record<string, number> = { wallMs, finalTextLength: finalText.length };
  m.toolCalls = flow.calls.length;
  m.toolResults = flow.results.length;

  const gateEnter = new Map<string | null, number>();
  const gateExit = new Map<string | null, number>();
  for (const row of probeRows) {
    if (!row.callId) continue;
    if (row.ev === 'gate/enter') gateEnter.set(row.callId, row.t);
    if (row.ev === 'gate/exit') gateExit.set(row.callId, row.t);
  }
  const callAt = new Map(flow.calls.map((c) => [c.callId, c.epochMs]));
  for (const r of flow.results) {
    const at = callAt.get(r.callId);
    if (at && r.epochMs) m[`call->result:${r.callId}`] = r.epochMs - at;
  }
  for (const c of flow.calls) {
    const g = gateEnter.get(c.callId);
    if (g && c.epochMs) m[`call->gate/enter:${c.callId}`] = g - c.epochMs;
    const x = gateExit.get(c.callId);
    if (g && x) m[`gate/enter->exit:${c.callId}`] = x - g;
    const r = flow.results.find((it) => it.callId === c.callId);
    if (x && r?.epochMs) m[`gate/exit->result:${c.callId}`] = r.epochMs - x;
  }
  const enters = [...gateEnter.values()];
  const exits = [...gateExit.values()];
  if (enters.length && exits.length) m.gateSpanMs = Math.max(...exits) - Math.min(...enters);
  const firstCall = flow.calls[0];
  const lastResult = flow.results[flow.results.length - 1];
  // A record with no timestamp counts as 0, exactly as the untyped subtraction
  // did; the guard is on the arrays being non-empty, not on the timestamps.
  if (firstCall && lastResult) m.firstCallToLastResultMs = Number(lastResult.epochMs) - Number(firstCall.epochMs);

  m['fake.requests'] = fake.requests.length;
  m['fake.titleRoute'] = fake.requests.filter((r) => !r.hasTools).length;
  m['fake.toolRouteAttempts'] = fake.requests.filter((r) => r.hasTools && !r.sawToolRole).length;
  m['fake.closingRoute'] = fake.requests.filter((r) => r.hasTools && r.sawToolRole).length;
  m['fake.unhandled'] = fake.unhandled.length;
  for (const r of fake.requests) {
    if (r.maxCompletionTokens !== null) m.maxCompletionTokens = r.maxCompletionTokens;
  }
  return m;
}

// ---------------------------------------------------------------- assertions

/** `contains`/`notContains` accept a single string or a list, as the cases write them. */
function asList(value: string | readonly string[] | undefined): readonly string[] {
  if (value === undefined) return [];
  return typeof value === 'string' ? [value] : value;
}

/**
 * `Array.isArray` does not remove a `readonly` union member, so the range form
 * is narrowed by a named guard instead.
 */
function isRangeTuple(value: MetricRange): value is readonly number[] {
  return Array.isArray(value);
}

function inRange(actual: number, range: MetricRange): boolean {
  if (typeof range === 'number') return actual === range;
  if (isRangeTuple(range)) {
    const min = range[0];
    const max = range[1];
    return min !== undefined && max !== undefined && actual >= min && actual <= max;
  }
  if (range.equals !== undefined && actual !== range.equals) return false;
  if (range.min !== undefined && actual < range.min) return false;
  if (range.max !== undefined && actual > range.max) return false;
  return true;
}

function strCheck(label: string, actualText: string, spec: TextSpec | undefined): AssertionRow[] {
  const rows: AssertionRow[] = [];
  if (!spec) return rows;
  const text = String(actualText);
  if (spec.equals !== undefined) rows.push({ name: label, expected: `equals ${JSON.stringify(spec.equals)}`, actual: JSON.stringify(text), ok: text === spec.equals, level: 'assert' });
  for (const s of asList(spec.contains)) rows.push({ name: `${label} contains`, expected: JSON.stringify(s), actual: JSON.stringify(text.slice(0, 200)), ok: text.includes(s), level: 'assert' });
  for (const s of asList(spec.notContains)) rows.push({ name: `${label} !contains`, expected: JSON.stringify(s), actual: JSON.stringify(text.slice(0, 200)), ok: !text.includes(s), level: 'assert' });
  if (spec.matches !== undefined) rows.push({ name: `${label} matches`, expected: spec.matches, actual: JSON.stringify(text.slice(0, 200)), ok: new RegExp(spec.matches).test(text), level: 'assert' });
  return rows;
}

export interface EvaluateOptions {
  strictAudit?: boolean | undefined;
}

export function evaluate(def: HarnessCase, ev: Evidence, opts: EvaluateOptions = {}): AssertionRow[] {
  const rows: AssertionRow[] = [];
  const exp = def.expect;
  const fail = (name: string, expected: string, actual: string, level: AssertionLevel = 'assert'): void => {
    rows.push({ name, expected, actual, ok: false, level });
  };
  const pass = (name: string, expected: string, actual: string, level: AssertionLevel = 'assert'): void => {
    rows.push({ name, expected, actual, ok: true, level });
  };

  if (exp.exitCode !== undefined) {
    const ok = exp.exitCode === 'nonzero' ? ev.exitCode !== 0 : ev.exitCode === exp.exitCode;
    (ok ? pass : fail)('dsh exit code', String(exp.exitCode), String(ev.exitCode));
  }
  if (exp.noTimeout) (ev.timedOut ? fail : pass)('dsh did not time out', 'no timeout', ev.timedOut ? `timeout after ${ev.wallMs}ms` : `${ev.wallMs}ms`);

  rows.push(...strCheck('final text', ev.finalText, exp.finalText));
  rows.push(...strCheck('stderr', ev.stderr, exp.stderr));
  rows.push(...strCheck('stdout', ev.stdout, exp.stdout));

  if (exp.toolResults) {
    const actual = ev.flow.results;
    if (exp.toolResultCount !== undefined && !inRange(actual.length, exp.toolResultCount)) {
      fail('tool result count', JSON.stringify(exp.toolResultCount), String(actual.length));
    }
    exp.toolResults.forEach((spec, i) => {
      const r = spec.callId ? actual.find((x) => x.callId === spec.callId) : actual[i];
      if (!r) { fail(`tool result[${i}]`, 'present', 'missing'); return; }
      if (spec.isError !== undefined) (r.isError === spec.isError ? pass : fail)(`tool result[${i}].isError`, String(spec.isError), String(r.isError));
      if (spec.equals !== undefined) (r.text === spec.equals ? pass : fail)(`tool result[${i}].text`, JSON.stringify(spec.equals), JSON.stringify(r.text.slice(0, 200)));
      for (const s of asList(spec.contains)) (r.text.includes(s) ? pass : fail)(`tool result[${i}] contains`, JSON.stringify(s), JSON.stringify(r.text.slice(0, 200)));
      for (const s of asList(spec.notContains)) (!r.text.includes(s) ? pass : fail)(`tool result[${i}] !contains`, JSON.stringify(s), JSON.stringify(r.text.slice(0, 200)));
    });
  }

  for (const [metric, range] of Object.entries(exp.metrics ?? {})) {
    const actual = ev.metrics[metric];
    if (actual === undefined) { fail(`metric ${metric}`, JSON.stringify(range), 'not measured'); continue; }
    (inRange(actual, range) ? pass : fail)(`metric ${metric}`, JSON.stringify(range), String(actual));
  }

  for (const type of exp.timelineHas ?? []) {
    const ok = ev.timeline.some((r) => r.type === type);
    (ok ? pass : fail)(`timeline has ${type}`, 'present', ok ? 'present' : 'absent');
  }

  if (ev.audit) {
    const dirty = [...ev.audit.changed, ...ev.audit.added, ...ev.audit.removed];
    // The repo is a shared workspace while the plugin is being written, so an
    // unrelated edit during the run is reported but is not a harness failure
    // unless --strict-audit is given (run that on a quiescent tree).
    const level: AssertionLevel = opts.strictAudit ? 'assert' : 'warning';
    (dirty.length === 0 ? pass : fail)('no writes outside .runs/', '[]', JSON.stringify(dirty.slice(0, 10)), level);
  }
  const leftovers: string[] = [];
  if (ev.processes.fakeLlmAlive) leftovers.push('fake-llm');
  if (ev.processes.dshAlive) leftovers.push('dsh');
  (leftovers.length === 0 ? pass : fail)('no leftover processes', '[]', JSON.stringify(leftovers));
  return rows;
}

// ------------------------------------------------------------------ rendering

export type OutFn = (line?: string) => void;

export function renderSummary(ev: Evidence, def: HarnessCase, out: OutFn): boolean {
  const fake = readFakeLog(ev.requests);
  const probe = readProbeRows(ev.probe);

  out('');
  out(`=== dsh-direnv harness: ${def.name} ===`);
  out(def.description);
  out(`run dir        : ${ev.runDir}`);
  out(`DSH_HOME       : ${ev.dshHome}  (hardcoded; inherited DSH_* scrubbed)`);
  out(`profile        : ${ev.profile}${ev.profileInitialized ? " (initialized from the shipped 'headless' template)" : ''}`);
  out(`session cwd    : ${ev.wsDir}`);
  out(`dsh            : ${ev.dshBin} (${ev.dshVersion})`);
  out(`fake LLM       : http://127.0.0.1:${ev.fakeLlm.port} (pid ${ev.fakeLlm.pid})`);
  out(`command        : ${ev.commandLine}`);
  out(`dsh exit       : ${ev.exitCode}   wall=${ev.wallMs}ms${ev.timedOut ? '   [TIMED OUT]' : ''}`);

  out('');
  out('--- fake LLM requests (routing is by request shape) ---');
  for (const r of fake.requests) {
    out(`#${String(r.n).padStart(2)} t=${r.t} tools=${r.hasTools ? r.toolNames.length : 0} sawToolRole=${r.sawToolRole} -> ${String(r.decision).padEnd(10)} max_completion_tokens=${r.maxCompletionTokens ?? 'absent'} roles=[${r.msgRoles.join(',')}]`);
  }
  for (const r of fake.unhandled) out(`!! unhandled request: ${r.route}`);

  out('');
  out(`--- durable session timeline (${ev.sessionId ?? 'no session id'}) ---`);
  out(ev.timelineText || '(no session log found)');

  out('');
  out('--- tool flow (absolute epoch ms) ---');
  const gateEnter = new Map<string | null, number>();
  const gateExit = new Map<string | null, number>();
  for (const row of probe) {
    if (!row.callId) continue;
    if (row.ev === 'gate/enter') gateEnter.set(row.callId, row.t);
    if (row.ev === 'gate/exit') gateExit.set(row.callId, row.t);
  }
  for (const c of ev.flow.calls) {
    out(`tool/call     ${c.callId} ${c.name} t=${c.epochMs} args=${c.args}`);
    const g = gateEnter.get(c.callId);
    const x = gateExit.get(c.callId);
    if (g) out(`  gate/enter  ${c.callId} t=${g}   (call -> gate = ${g - Number(c.epochMs)}ms)`);
    if (g && x) out(`  gate/exit   ${c.callId} t=${x}   (gate held  = ${x - g}ms)`);
  }
  for (const r of ev.flow.results) {
    const c = ev.flow.calls.find((x) => x.callId === r.callId);
    const d = c ? `   (call -> result = ${Number(r.epochMs) - Number(c.epochMs)}ms)` : '';
    out(`tool/result   ${r.callId} isError=${r.isError} t=${r.epochMs}${d}`);
    out(`  text=${JSON.stringify(r.text)}`);
  }

  out('');
  out('--- metrics ---');
  for (const [k, v] of Object.entries(ev.metrics)) out(`  ${k.padEnd(30)} ${v}`);

  out('');
  out('--- assertions ---');
  for (const a of ev.assertions) out(`  ${a.ok ? 'PASS' : (a.level === 'warning' ? 'WARN' : 'FAIL')}  ${a.name}   expected=${a.expected} actual=${String(a.actual).slice(0, 160)}`);
  const failed = ev.assertions.filter((a) => !a.ok && a.level !== 'warning');
  const warned = ev.assertions.filter((a) => !a.ok && a.level === 'warning');
  out('');
  out(`=== RESULT: ${failed.length ? 'FAIL' : 'PASS'} (${ev.assertions.length - failed.length - warned.length}/${ev.assertions.length} assertions${warned.length ? `, ${warned.length} warning` : ''}) ===`);
  return failed.length === 0;
}
