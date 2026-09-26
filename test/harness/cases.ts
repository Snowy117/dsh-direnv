/**
 * The declarative shape of a harness case (`cases/*.ts`) and the loader that
 * discovers them.
 *
 * A case is data: what to boot, what the fake LLM answers, and what must be true
 * afterwards. The shape is checked twice — every shipped case is compiled
 * against `HarnessCase` by `tsc -p tsconfig.test.json`, and the loader re-checks
 * the fields the runner dereferences on a dynamically imported module, which
 * arrives as `unknown`.
 *
 * Discovery is explicit and file-name-keyed: `--case <name>` selects
 * `cases/<name>.ts`, and a case whose `name` disagrees with its file name is
 * rejected outright. That is also why `npm test` keeps its explicit
 * `test/*.test.ts` glob — a bare `node --test` would execute these modules and
 * boot real DSH processes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { isJsonRecord } from './json.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const CASES_DIR = path.join(HERE, 'cases');

/**
 * The probe gate modes. `delay` sleeps `gateMs` then calls `next()`; `no-next`
 * returns `undefined` on purpose (the protocol-error probe); `allow` answers
 * `{kind:'allow'}` without waiting.
 */
export type GateMode = 'delay' | 'no-next' | 'allow';

export interface FakeToolCall {
  name: string;
  /** Serialised into the SSE `tool_calls[].function.arguments` stream. */
  arguments: Record<string, unknown>;
}

/**
 * The `fake` block of a case. Every knob is optional: the fake LLM applies the
 * same defaults when a key is absent from `FAKE_LLM_CONFIG_FILE`, so a case only
 * states what makes it different.
 */
export interface FakeLlmCaseConfig {
  /** Tool calls the opening (with-tools) request emits; one call when absent. */
  toolCalls?: FakeToolCall[];
  /** The model id the fake provider advertises; `fake-model` when absent. */
  model?: string;
  finalText?: string;
  titleText?: string;
  /** Deliberately break the SSE contract: no `finish_reason` is ever sent. */
  omitFinishReason?: boolean;
  omitUsage?: boolean;
  /** Send the argument JSON in one delta instead of two. */
  singleArgDelta?: boolean;
  chunkDelayMs?: number;
}

/** A string match: exact, substring, substring-absence, or regex source. */
export interface TextSpec {
  equals?: string;
  contains?: string | readonly string[];
  notContains?: string | readonly string[];
  matches?: string;
}

/** One tool result, addressed by position or by the `callId` the fake LLM wrote. */
export interface ToolResultSpec {
  callId?: string;
  isError?: boolean;
  equals?: string;
  contains?: string | readonly string[];
  notContains?: string | readonly string[];
}

/**
 * A metric expectation: an exact number, a `[min, max]` range, or an object with
 * `equals`/`min`/`max`. Ranges are the norm because these are wall-clock timings
 * measured across processes.
 */
export type MetricRange = number | readonly number[] | { equals?: number; min?: number; max?: number };

export type ExitCodeSpec = number | 'nonzero';

export interface CaseExpect {
  exitCode?: ExitCodeSpec;
  noTimeout?: boolean;
  finalText?: TextSpec;
  stdout?: TextSpec;
  stderr?: TextSpec;
  toolResultCount?: MetricRange;
  toolResults?: readonly ToolResultSpec[];
  timelineHas?: readonly string[];
  metrics?: Record<string, MetricRange>;
}

/** What a case's `prepare` and `prepareProfile` receive. */
export interface CaseContext {
  /** `.runs/<run name>` — the only writable area. */
  runDir: string;
  /** Session cwd inside the run dir; `{{WS}}` expands to this. */
  wsDir: string;
  /** The private `DSH_HOME` for this run. */
  dshHome: string;
  profile: string;
  profileDir: string;
  repoDir: string;
}

export interface PrepareResult {
  /** Extra child environment, applied last so it overrides the runner's defaults. */
  env?: Record<string, string>;
}

export interface HarnessCase {
  /** Must equal the file name; `--case <name>` selects `cases/<name>.ts`. */
  name: string;
  description: string;
  /** `pending-host` keeps the case out of `--all` until the host half is ready. */
  status?: 'ready' | 'pending-host';
  /** Repo files the case needs; a missing one degrades the case to pending. */
  requires?: { repoFiles?: readonly string[] };
  profile?: string;
  /** Initialize the scratch profile from the shipped `headless` template. */
  bootstrapProfileFirst?: boolean;
  gateMs?: number;
  gateMode?: GateMode;
  blockAgentCreatedMs?: number;
  timeoutMs?: number;
  task: string;
  /** Written into `wsDir` before boot; keys are relative paths. */
  files: Record<string, string>;
  fake?: FakeLlmCaseConfig;
  /** Extra overlay rows appended to `overlay.template.yml`. */
  extraRows?: string;
  /** Runs before the child env is frozen (e.g. to point `XDG_CONFIG_HOME` at a scratch dir). */
  prepare?: (ctx: CaseContext) => PrepareResult | undefined | Promise<PrepareResult | undefined>;
  /** Runs once the profile exists and before boot (e.g. to symlink the repo in). */
  prepareProfile?: (ctx: CaseContext) => void | Promise<void>;
  expect: CaseExpect;
}

/**
 * The fields the runner dereferences without a guard. Nested blocks (`fake`,
 * `requires`, `expect`) are proved to be objects; their contents are the
 * compiler's business, since every case module is part of this tsconfig project.
 */
function isHarnessCase(value: unknown): value is HarnessCase {
  if (!isJsonRecord(value)) return false;
  return typeof value.name === 'string'
    && typeof value.description === 'string'
    && typeof value.task === 'string'
    && isJsonRecord(value.files)
    && isJsonRecord(value.expect)
    && (value.fake === undefined || isJsonRecord(value.fake))
    && (value.requires === undefined || isJsonRecord(value.requires))
    && (value.extraRows === undefined || typeof value.extraRows === 'string');
}

function readCaseModule(file: string, module: unknown): HarnessCase {
  const def = isJsonRecord(module) ? module.default : undefined;
  if (!isJsonRecord(def) || typeof def.name !== 'string') {
    throw new Error(`${file}: case default export needs a name`);
  }
  if (!isHarnessCase(def)) throw new Error(`${file}: case default export is not a HarnessCase (see cases.ts)`);
  if (def.name !== path.basename(file, '.ts')) {
    throw new Error(`${file}: case name "${def.name}" must match the file name`);
  }
  return def;
}

/** One dynamic import per case module; the file name is the case's identity. */
export async function loadCases(): Promise<HarnessCase[]> {
  const files = fs.readdirSync(CASES_DIR).filter((f) => f.endsWith('.ts')).sort();
  const cases: HarnessCase[] = [];
  for (const file of files) {
    const module: unknown = await import(pathToFileURL(path.join(CASES_DIR, file)).href);
    cases.push(readCaseModule(file, module));
  }
  return cases;
}

export function describeCase(def: HarnessCase): string {
  const gate = def.gateMode && def.gateMode !== 'delay' ? `${def.gateMs}ms/${def.gateMode}` : `${def.gateMs ?? 0}ms`;
  const calls = (def.fake?.toolCalls ?? []).length || 1;
  return `${(def.status ?? 'ready').padEnd(12)} ${def.name.padEnd(18)} gate=${String(gate).padEnd(12)} toolCalls=${calls}`;
}
