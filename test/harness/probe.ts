/**
 * Instrumentation probe plugin for the dsh-direnv regression harness.
 *
 * It is inserted into a scratch profile by `test/harness/overlay.template.yml`
 * (loaded from an absolute path) and records, with epoch-ms timestamps, what
 * happens around the tool pipeline:
 *
 *   agent/created      -> when the session agent is created. Awaiting here
 *                         delays session creation, so it is recorded but not
 *                         used by the gate. (DESIGN §7.1: awaiting costs
 *                         ~3s of first-LLM-request latency.)
 *   tools/pre-execute  -> the gate. Waterfall: a listener MUST always return
 *                         `next()` (or an explicit {kind:'deny'|'cancel'}).
 *                         Returning undefined makes the caller read
 *                         `gate.kind` of undefined and surface an internal
 *                         TypeError to the model as the tool result.
 *   tools/execute      -> around-dispatch timestamps per call.
 *   tools/result       -> the final result text (preview) per call.
 *
 * Config (from the overlay row):
 *   tag                  label of the run
 *   mode                 'delay'   sleep gateMs then next()          (default)
 *                        'no-next' sleep gateMs then return undefined
 *                        'allow'   return {kind:'allow'} immediately
 *   gateMs               simulated plugin-blocking delay (ms)
 *   blockAgentCreatedMs  if > 0, await this long inside agent/created
 *
 * Every record goes to PROBE_LOG (JSONL) and to stdout with a `[probe]` prefix.
 *
 * This file is loaded into the DSH process, so it deliberately imports nothing
 * but `node:fs` at runtime; the event and payload shapes below are declared
 * structurally, the way `src/types.ts` declares the plugin's own slices.
 */
import fs from 'node:fs';

import type { GateMode } from './cases.ts';

export const name = 'harness-probe';
export const inject: string[] = [];

/** One tool execution as the probe reads it; every field is optional on purpose. */
interface ToolExecutionSlice {
  name?: string;
  callId?: string;
  agent?: { id?: string };
}

interface ToolResultSlice {
  isError?: boolean;
  content?: { type?: string; text?: string }[];
  error?: { message?: string };
}

/** The DSH events the probe listens to, with the payload slice each handler reads. */
interface ProbeEvents {
  'agent/created'(payload: unknown): unknown;
  'session/created'(payload: unknown): unknown;
  'tools/pre-execute'(exec: ToolExecutionSlice, next: () => Promise<unknown>): Promise<unknown>;
  'tools/execute'(exec: ToolExecutionSlice, next: () => Promise<ToolResultSlice | undefined>): Promise<ToolResultSlice | undefined>;
  'tools/result'(exec: ToolExecutionSlice, result: ToolResultSlice): unknown;
}

interface ProbeContext {
  on<K extends keyof ProbeEvents>(name: K, listener: ProbeEvents[K]): unknown;
}

const T0 = performance.now();
const OUT = process.env.PROBE_LOG || '';

function rec(ev: string, fields: Record<string, unknown> = {}): void {
  const row = { t: Date.now(), mono: Number((performance.now() - T0).toFixed(1)), ev, ...fields };
  if (OUT) { try { fs.appendFileSync(OUT, JSON.stringify(row) + '\n'); } catch { /* never break the turn */ } }
  console.log(`[probe] ${new Date().toISOString()} +${row.mono}ms ${ev} ${JSON.stringify(fields)}`);
}

const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readGateMode(value: unknown): GateMode | undefined {
  if (value === 'delay' || value === 'no-next' || value === 'allow') return value;
  return undefined;
}

/** `Number(value ?? 0)`: the overlay writes numbers, a hand-edited row may not. */
function numberOrZero(value: unknown): number {
  return value === null || value === undefined ? 0 : Number(value);
}

export function apply(ctx: ProbeContext, config: unknown = {}): void {
  const settings: Record<string, unknown> = isRecord(config) ? config : {};
  const mode = readGateMode(settings.mode) ?? 'delay';
  const gateMs = numberOrZero(settings.gateMs);
  const blockMs = numberOrZero(settings.blockAgentCreatedMs);
  const tag = readString(settings.tag) ?? 'default';
  let inFlightGate = 0;

  rec('plugin/mounted', { tag, mode, gateMs, blockMs, pid: process.pid });

  ctx.on('agent/created', async (payload) => {
    const row = isRecord(payload) ? payload : {};
    const agent = isRecord(row.agent) ? row.agent : {};
    rec('agent/created/enter', { tag, source: readString(row.source) ?? null, agent: readString(agent.id) ?? null });
    if (blockMs > 0) {
      await sleep(blockMs);
      rec('agent/created/exit', { tag, awaitedMs: blockMs });
    } else {
      rec('agent/created/exit', { tag, awaitedMs: 0 });
    }
    return undefined;
  });

  ctx.on('session/created', (payload) => {
    rec('session/created', { tag, keys: isRecord(payload) ? Object.keys(payload) : typeof payload });
  });

  // The gate under test: a waterfall listener that models a plugin blocking a
  // tool call (e.g. waiting for the direnv environment to be ready).
  ctx.on('tools/pre-execute', async (exec, next) => {
    inFlightGate++;
    rec('gate/enter', { tag, tool: exec.name, callId: exec.callId, agent: exec.agent?.id ?? null, inFlightGate });
    if (gateMs > 0) await sleep(gateMs);
    if (mode === 'no-next') {
      inFlightGate--;
      rec('gate/return-undefined', { tag, tool: exec.name, callId: exec.callId, calledNext: false });
      return undefined; // deliberately do NOT call next() (protocol-error probe)
    }
    rec('gate/exit', { tag, tool: exec.name, callId: exec.callId, inFlightGate });
    inFlightGate--;
    if (mode === 'allow') return { kind: 'allow' };
    return next();
  });

  ctx.on('tools/execute', async (exec, next) => {
    rec('dispatch/enter', { tag, tool: exec.name, callId: exec.callId });
    const result = await next();
    rec('dispatch/exit', { tag, tool: exec.name, callId: exec.callId, isError: result?.isError === true });
    return result;
  });

  ctx.on('tools/result', (exec, result) => {
    const content = Array.isArray(result.content) ? result.content : [];
    const text = content.filter((b) => b?.type === 'text').map((b) => b.text).join('');
    rec('tools/result', {
      tag, tool: exec.name, callId: exec.callId,
      isError: result.isError === true,
      textPreview: text.slice(0, 200),
      error: result.error?.message ?? null,
    });
  });
}
