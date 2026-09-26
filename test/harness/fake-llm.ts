#!/usr/bin/env node
/**
 * Fake LLM server for the dsh-direnv regression harness.
 *
 * It implements just enough of the `openai-completions` wire format for DSH's
 * `llm-pi-ai` route to drive a real turn with a real tool execution:
 *   - POST <baseURL>/chat/completions  (baseURL MUST include `/v1`, the OpenAI
 *     SDK appends `/chat/completions` itself)
 *   - SSE: `text/event-stream` + `data: {json}\n\n`, terminated by `data: [DONE]\n\n`
 *   - every chunk is `{"choices":[{"index":0,"delta":{...},"finish_reason":null}]}`
 *     and the FINAL chunk MUST carry a real `finish_reason` ("stop" or
 *     "tool_calls"). Without it pi-ai throws "Stream ended without finish_reason"
 *     and `llm-retry` burns 5 backoff retries (~17s) first — see the
 *     `no-finish-reason` case, which pins exactly that behaviour.
 *
 * Routing is by REQUEST SHAPE, never by request ordinal (the session-title
 * request is tool-less and races the main request):
 *   - no `tools`                          -> title text
 *   - `tools` and no `role:"tool"` history -> the configured tool calls
 *   - `tools` and some `role:"tool"`       -> the final text (the closing turn
 *                                             still carries the tool list)
 *
 * Config comes from `FAKE_LLM_CONFIG_FILE` (JSON) written by run.ts; the flat
 * env knobs are kept for manual poking from a shell.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isJsonRecord, parseJsonRecord, readRecords, readString } from './json.ts';
import type { JsonRecord } from './json.ts';
import type { FakeLlmCaseConfig, FakeToolCall } from './cases.ts';

/** The routing result, i.e. the `decision` field of every request record. */
export type ResponseKind = 'text-title' | 'text-final' | 'tool-calls';

export interface BuiltResponse {
  kind: ResponseKind;
  chunks: JsonRecord[];
  sawToolRole: boolean;
  hasTools: boolean;
}

const DEFAULT_TOOL_CALLS: FakeToolCall[] = [
  { name: 'bash', arguments: { command: 'echo STUB-LLM-OK', description: 'fake bash call 1' } },
];

const CONFIG_FILE = process.env.FAKE_LLM_CONFIG_FILE || '';
const fileCfg: JsonRecord = CONFIG_FILE ? parseJsonRecord(fs.readFileSync(CONFIG_FILE, 'utf8')) : {};

/**
 * The keys `FAKE_LLM_CONFIG_FILE` may carry: the runner's `port`/`logDir`
 * envelope plus every case knob. Naming them here is what keeps a renamed or
 * mistyped knob from silently falling back to its default.
 */
type ConfigKey = keyof FakeLlmCaseConfig | 'port' | 'logDir';

/** env knob first (even an empty one), then the config file, then the fallback. */
function rawPick(envKey: string, cfgKey: ConfigKey): unknown {
  const fromEnv = process.env[envKey];
  return fromEnv !== undefined ? fromEnv : fileCfg[cfgKey];
}

function pickString(envKey: string, cfgKey: ConfigKey, fallback: string): string {
  const raw = rawPick(envKey, cfgKey);
  if (raw === undefined) return fallback;
  return typeof raw === 'string' ? raw : String(raw);
}

function pickNumber(envKey: string, cfgKey: ConfigKey, fallback: number): number {
  const raw = rawPick(envKey, cfgKey);
  if (raw === undefined) return fallback;
  return Number(raw);
}

function pickBoolean(envKey: string, cfgKey: ConfigKey, fallback: boolean): boolean {
  const raw = rawPick(envKey, cfgKey);
  if (raw === undefined) return fallback;
  return raw === true || raw === 1 || raw === '1' || raw === 'true';
}

/**
 * The scripted tool calls. A string value is parsed as JSON (the env knob) and
 * an unparsable one falls back to the default; anything that is not an array of
 * `{name, arguments}` is rejected loudly, because a silently empty tool list
 * would turn every case into a false pass.
 */
function pickToolCalls(envKey: string, cfgKey: ConfigKey, fallback: FakeToolCall[]): FakeToolCall[] {
  const raw = rawPick(envKey, cfgKey);
  if (raw === undefined || raw === null) return fallback;
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw); } catch { return fallback; }
  }
  if (parsed === null || parsed === undefined) return fallback;
  if (!Array.isArray(parsed)) throw new Error('fake-llm: toolCalls must be a JSON array');
  return parsed.map((entry) => readToolCall(entry));
}

function readToolCall(entry: unknown): FakeToolCall {
  if (!isJsonRecord(entry) || typeof entry.name !== 'string') {
    throw new Error('fake-llm: every tool call needs a string `name`');
  }
  const args = entry.arguments;
  return { name: entry.name, arguments: isJsonRecord(args) ? args : {} };
}

const LOG_DIR = pickString('FAKE_LOG_DIR', 'logDir', '.');
fs.mkdirSync(LOG_DIR, { recursive: true });
const PORT_FILE = path.join(LOG_DIR, 'fake-llm.port');
const PID_FILE = path.join(LOG_DIR, 'fake-llm.pid');
const REQ_LOG = path.join(LOG_DIR, 'fake-llm.requests.jsonl');

const PORT = pickNumber('FAKE_LLM_PORT', 'port', 0);
const TOOL_CALLS = pickToolCalls('FAKE_TOOL_CALLS', 'toolCalls', DEFAULT_TOOL_CALLS);
const FINAL_TEXT = pickString('FAKE_FINAL_TEXT', 'finalText', 'FAKE-FINAL: tool run finished.');
const TITLE_TEXT = pickString('FAKE_TITLE_TEXT', 'titleText', 'fake title');
const MODEL = pickString('FAKE_MODEL', 'model', 'fake-model');
const OMIT_FINISH = pickBoolean('FAKE_OMIT_FINISH_REASON', 'omitFinishReason', false);
const OMIT_USAGE = pickBoolean('FAKE_OMIT_USAGE', 'omitUsage', false);
const SINGLE_ARG_DELTA = pickBoolean('FAKE_SINGLE_ARG_DELTA', 'singleArgDelta', false);
const CHUNK_DELAY = pickNumber('FAKE_CHUNK_DELAY_MS', 'chunkDelayMs', 2);

/** Every record in `fake-llm.requests.jsonl` is stamped with both clocks. */
const H0 = process.hrtime.bigint();
const stamp = (): { t: number; monoMs: number } => ({ t: Date.now(), monoMs: Number(process.hrtime.bigint() - H0) / 1e6 });
function logLine(file: string, obj: object): void {
  try { fs.appendFileSync(file, JSON.stringify(obj) + '\n'); } catch { /* keep serving */ }
}
function say(msg: string): void { process.stdout.write(`[fake-llm] ${new Date().toISOString()} ${msg}\n`); }

let seq = 0;

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => { resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
}

/** Route by request shape and build the SSE chunk list for it. */
export function buildResponse(body: unknown): BuiltResponse {
  const request = isJsonRecord(body) ? body : {};
  const messages = readRecords(request, 'messages');
  const tools = Array.isArray(request.tools) ? request.tools : [];
  const hasTools = tools.length > 0;
  const sawToolRole = messages.some((m) => m.role === 'tool');
  const kind: ResponseKind = !hasTools ? 'text-title' : (sawToolRole ? 'text-final' : 'tool-calls');

  const id = `chatcmpl-fake-${++seq}`;
  const created = Math.floor(Date.now() / 1000);
  const base = { id, object: 'chat.completion.chunk', created, model: readString(request, 'model') || MODEL };
  // The final chunk of every stream must carry a real finish_reason; the rest
  // carry `null`. `omitFinishReason` deliberately breaks that contract.
  const chunk = (delta: JsonRecord, finish?: string): JsonRecord => {
    const c: JsonRecord = { index: 0, delta };
    if (!OMIT_FINISH) c.finish_reason = finish ?? null;
    return { ...base, choices: [c] };
  };

  const out: JsonRecord[] = [];
  out.push(chunk({ role: 'assistant', content: '' }));

  if (kind === 'tool-calls') {
    const calls = TOOL_CALLS.map((spec, i) => ({
      index: i,
      id: `call_fake_${i + 1}`,
      type: 'function',
      function: { name: spec.name, arguments: JSON.stringify(spec.arguments) },
    }));
    // Announce name + empty arguments first, then stream the arguments, which
    // exercises pi-ai's argument reassembly across deltas.
    out.push(chunk({
      tool_calls: calls.map((c) => ({
        index: c.index, id: c.id, type: c.type, function: { name: c.function.name, arguments: '' },
      })),
    }));
    if (SINGLE_ARG_DELTA) {
      out.push(chunk({ tool_calls: calls.map((c) => ({ index: c.index, function: { arguments: c.function.arguments } })) }));
    } else {
      const half = calls.map((c) => Math.ceil(c.function.arguments.length / 2));
      out.push(chunk({ tool_calls: calls.map((c, i) => ({ index: i, function: { arguments: c.function.arguments.slice(0, half[i]) } })) }));
      out.push(chunk({ tool_calls: calls.map((c, i) => ({ index: i, function: { arguments: c.function.arguments.slice(half[i]) } })) }));
    }
    out.push(chunk({}, 'tool_calls'));
  } else {
    const text = kind === 'text-final' ? FINAL_TEXT : TITLE_TEXT;
    for (const word of text.split(' ')) out.push(chunk({ content: `${word} ` }));
    out.push(chunk({}, 'stop'));
  }

  if (!OMIT_USAGE) {
    out.push({ ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  }
  return { kind, chunks: out, sawToolRole, hasTools };
}

function streamSse(req: http.IncomingMessage, res: http.ServerResponse, chunks: readonly JsonRecord[], onEnd: (reason: string) => void): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-fake-llm': 'dsh-direnv-harness',
  });
  let closed = false;
  req.on('close', () => { closed = true; });
  let i = 0;
  const pump = (): void => {
    if (closed) { onEnd('client-closed'); return; }
    if (i >= chunks.length) {
      try { res.write('data: [DONE]\n\n'); res.end(); } catch { /* client gone */ }
      onEnd('done');
      return;
    }
    try { res.write(`data: ${JSON.stringify(chunks[i++])}\n\n`); } catch { onEnd('write-failed'); return; }
    setTimeout(pump, CHUNK_DELAY);
  };
  pump();
}

function readToolNames(body: JsonRecord): (string | undefined)[] {
  const tools = body.tools;
  if (!Array.isArray(tools)) return [];
  return tools.map((tool) => {
    if (!isJsonRecord(tool)) return undefined;
    const fn = isJsonRecord(tool.function) ? tool.function : {};
    return readString(fn, 'name');
  });
}

function createServer(): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const route = `${req.method} ${url.pathname}`;

    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, server: 'dsh-direnv-harness-fake-llm', pid: process.pid }));
      return;
    }
    if (req.method === 'GET' && url.pathname.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: MODEL, object: 'model', created: 0, owned_by: 'fake' }] }));
      return;
    }
    if (req.method === 'POST' && url.pathname.endsWith('/chat/completions')) {
      const raw = await readBody(req);
      let body: JsonRecord;
      try { body = parseJsonRecord(raw); } catch { body = {}; }
      const messages = readRecords(body, 'messages');
      const built = buildResponse(body);
      const rec = {
        ev: 'request', n: seq + 1, ...stamp(), route, path: url.pathname,
        model: readString(body, 'model'), stream: body.stream === true,
        msgRoles: messages.map((m) => m.role),
        toolNames: readToolNames(body),
        hasTools: built.hasTools, sawToolRole: built.sawToolRole, decision: built.kind,
        maxCompletionTokens: typeof body.max_completion_tokens === 'number' ? body.max_completion_tokens : null,
        maxTokens: typeof body.max_tokens === 'number' ? body.max_tokens : null,
        topKeys: Object.keys(body).sort(),
      };
      logLine(REQ_LOG, rec);
      say(`REQ#${rec.n} ${route} model=${rec.model} tools=${rec.hasTools ? rec.toolNames.length : 0} sawToolRole=${rec.sawToolRole} -> ${rec.decision} max_completion_tokens=${rec.maxCompletionTokens}`);

      if (body.stream !== true) {
        const text = built.kind === 'tool-calls' ? '' : (built.kind === 'text-final' ? FINAL_TEXT : TITLE_TEXT);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: `chatcmpl-fake-${seq}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }));
        logLine(REQ_LOG, { ev: 'response-end', n: rec.n, reason: 'non-stream', ...stamp() });
        return;
      }
      streamSse(req, res, built.chunks, (reason) => { logLine(REQ_LOG, { ev: 'response-end', n: rec.n, reason, ...stamp() }); });
      return;
    }

    logLine(REQ_LOG, { ev: 'unhandled', ...stamp(), route });
    say(`UNHANDLED ${route}`);
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `fake-llm: unhandled ${route}`, type: 'invalid_request_error' } }));
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const server = createServer();
  server.on('error', (err) => { say(`FATAL ${err.stack || err}`); process.exit(1); });
  server.listen(PORT, '127.0.0.1', () => {
    const addr = server.address();
    const boundPort = typeof addr === 'object' && addr !== null ? addr.port : PORT;
    fs.writeFileSync(PORT_FILE, String(boundPort));
    fs.writeFileSync(PID_FILE, String(process.pid));
    say(`listening http://127.0.0.1:${boundPort} (baseURL .../v1) pid=${process.pid} toolCalls=${TOOL_CALLS.length} omitFinish=${OMIT_FINISH} logDir=${LOG_DIR}`);
  });
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { say(`stopping on ${sig}`); server.close(() => { process.exit(0); }); setTimeout(() => { process.exit(0); }, 500).unref(); });
  }
}
