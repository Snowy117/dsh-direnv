#!/usr/bin/env node
/**
 * Reader for DSH's durable session log (`session.v4.jsonl.zstd`) and for the
 * derived tool-flow timings the harness asserts on.
 *
 * The durable log is the primary evidence source: unlike stdout it survives
 * `--json` shape changes and carries an epoch-ms `time` per record, so it can be
 * cross-referenced with the probe's own epoch-ms timestamps.
 *
 * CLI: node timeline.ts <session.v4.jsonl.zstd>     (prints the timeline)
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isJsonRecord, readNumber, readString } from './json.ts';
import type { JsonRecord } from './json.ts';

/** One row of the rendered timeline; both absolute and session-relative time. */
export interface TimelineRow {
  seq: number | null;
  epochMs: number | null;
  relMs: number | null;
  dtMs: number | null;
  type: string;
  summary: string;
}

export interface ToolCall {
  callId: string | null;
  name: string | null;
  args: unknown;
  epochMs: number | null;
  seq: number | null;
}

export interface ToolResult {
  callId: string | null;
  isError: boolean;
  text: string;
  epochMs: number | null;
  seq: number | null;
}

export interface ToolFlow {
  calls: ToolCall[];
  results: ToolResult[];
}

/** A `--json` stdout line, with the fields the harness reads lifted out. */
export interface RunEvent {
  type: string;
  sessionId: string | undefined;
  text: string | undefined;
}

export function parseSessionLogText(text: string): JsonRecord[] {
  const records: JsonRecord[] = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const parsed: unknown = JSON.parse(s);
      records.push(isJsonRecord(parsed) ? parsed : { type: '(non-object)', raw: s.slice(0, 200) });
    } catch {
      records.push({ type: '(unparsable)', raw: s.slice(0, 200) });
    }
  }
  return records;
}

/** Decompress a session log with `zstd -dc`; returns null when unavailable. */
export function readSessionLog(file: string): JsonRecord[] | null {
  if (!fs.existsSync(file)) return null;
  try {
    return parseSessionLogText(execFileSync('zstd', ['-dc', file], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }));
  } catch {
    return null;
  }
}

function blockSummary(blocks: unknown): string {
  if (!Array.isArray(blocks)) return '';
  return blocks.map((b) => {
    if (!isJsonRecord(b)) return '?';
    if (b.type === 'text') return `text=${JSON.stringify(String(b.text ?? '').slice(0, 80))}`;
    if (b.type === 'tool-call' || b.name) return `call ${String(b.name)}(${String(b.arguments ?? '').slice(0, 80)})`;
    return readString(b, 'type') ?? '?';
  }).join(' | ');
}

function describe(record: JsonRecord): string {
  const data: JsonRecord = isJsonRecord(record.data) ? record.data : {};
  switch (readString(record, 'type')) {
    case 'session': return `id=${readString(record, 'id')} cwd=${readString(record, 'cwd')}`;
    case 'request/header': {
      const header: JsonRecord = isJsonRecord(data.header) ? data.header : {};
      const config: JsonRecord = isJsonRecord(header.config) ? header.config : {};
      const tools = Array.isArray(header.tools) ? header.tools.length : 0;
      return `model=${readString(config, 'provider')}/${readString(config, 'model')} tools=${tools}`;
    }
    case 'request/context': return `${readString(data, 'provider')}/${readString(data, 'model')}`;
    case 'assistant/message': {
      const message: JsonRecord = isJsonRecord(data.message) ? data.message : {};
      return blockSummary(message.content);
    }
    case 'tool/call': return `callId=${readString(data, 'callId')} name=${readString(data, 'name')} args=${String(data.arguments ?? '').slice(0, 100)}`;
    case 'tool/call/skipped': return `callId=${readString(data, 'callId')} name=${readString(data, 'name')}`;
    case 'tool/result': {
      const message: JsonRecord = isJsonRecord(data.message) ? data.message : {};
      const content = Array.isArray(message.content) ? message.content : [];
      const text = content.map((b) => (isJsonRecord(b) ? String(b.text ?? '') : '')).join('');
      const callId = readString(message, 'toolCallId') ?? readString(data, 'toolCallId');
      return `callId=${callId} isError=${String(message.isError)} text=${JSON.stringify(text.slice(0, 160))}`;
    }
    case 'step/start': case 'step/end': case 'turn/start': case 'turn/end':
      return `turn=${String(data.turn)} step=${String(data.step ?? '')} ${data.reason ? JSON.stringify(data.reason) : ''}`;
    case 'session/title': {
      const source: JsonRecord = isJsonRecord(data.source) ? data.source : {};
      return `title=${JSON.stringify(data.title)} source=${String(source.kind)}`;
    }
    default: return JSON.stringify(data).slice(0, 120);
  }
}

/** Rows carry both absolute (epochMs) and session-relative (relMs) timing. */
export function buildTimeline(records: readonly JsonRecord[]): TimelineRow[] {
  const first = records.find((r) => readNumber(r, 'time'));
  const t0 = first ? (readNumber(first, 'time') ?? 0) : 0;
  let prev = t0;
  return records.map((r) => {
    const epochMs = readNumber(r, 'time') ?? null;
    const relMs = epochMs ? epochMs - t0 : null;
    const dtMs = epochMs ? epochMs - prev : null;
    if (epochMs) prev = epochMs;
    return {
      seq: readNumber(r, 'seq') ?? null,
      epochMs,
      relMs,
      dtMs,
      type: readString(r, 'type') ?? '',
      summary: describe(r),
    };
  });
}

export function formatTimeline(rows: readonly TimelineRow[]): string {
  return rows.map((row) => {
    const seq = String(row.seq ?? '-').padStart(3);
    const rel = row.relMs === null ? '     ?' : `${row.relMs}ms`.padStart(7);
    const dt = row.dtMs === null ? '  ?' : `${row.dtMs}`.padStart(5);
    return `seq=${seq} ${rel} (dt=${dt}) ${row.type.padEnd(26)} ${row.summary}`;
  }).join('\n');
}

/** Tool calls/results with absolute epoch ms, keyed for cross-source deltas. */
export function extractToolFlow(records: readonly JsonRecord[]): ToolFlow {
  const calls: ToolCall[] = [];
  const results: ToolResult[] = [];
  for (const r of records) {
    const data: JsonRecord = isJsonRecord(r.data) ? r.data : {};
    const type = readString(r, 'type');
    if (type === 'tool/call') {
      calls.push({
        callId: readString(data, 'callId') ?? null,
        name: readString(data, 'name') ?? null,
        args: data.arguments ?? null,
        epochMs: readNumber(r, 'time') ?? null,
        seq: readNumber(r, 'seq') ?? null,
      });
    } else if (type === 'tool/result') {
      const message: JsonRecord = isJsonRecord(data.message) ? data.message : {};
      const parts: string[] = [];
      if (Array.isArray(message.content)) {
        for (const b of message.content) {
          if (isJsonRecord(b) && b.type === 'text') parts.push(String(b.text ?? ''));
        }
      }
      results.push({
        callId: readString(message, 'toolCallId') ?? readString(data, 'toolCallId') ?? null,
        isError: message.isError === true,
        text: parts.join(''),
        epochMs: readNumber(r, 'time') ?? null,
        seq: readNumber(r, 'seq') ?? null,
      });
    }
  }
  return { calls, results };
}

/** Final answer text from the `--json` stdout stream (line-delimited events). */
export function extractRunEvents(stdout: string): RunEvent[] {
  const events: RunEvent[] = [];
  for (const line of stdout.split('\n')) {
    const s = line.trim();
    if (!s.startsWith('{')) continue;
    try {
      const parsed: unknown = JSON.parse(s);
      if (!isJsonRecord(parsed)) continue;
      const type = readString(parsed, 'type');
      if (type === undefined) continue;
      events.push({ type, sessionId: readString(parsed, 'sessionId'), text: readString(parsed, 'text') });
    } catch { /* probe lines and noise */ }
  }
  return events;
}

export function findSessionLog(dshHome: string, sessionId: string | null): string | null {
  const root = path.join(dshHome, 'sessions');
  const hits: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === 'session.v4.jsonl.zstd') hits.push(p);
    }
  };
  walk(root);
  if (sessionId) {
    const exact = hits.find((h) => h.includes(sessionId));
    if (exact) return exact;
  }
  if (!hits.length) return null;
  const newest = hits.map((h) => ({ h, m: fs.statSync(h).mtimeMs })).sort((a, b) => b.m - a.m)[0];
  return newest ? newest.h : null;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const file = process.argv[2];
  if (!file) {
    process.stderr.write('usage: node timeline.ts <session.v4.jsonl.zstd>\n');
    process.exit(2);
  }
  const records = readSessionLog(file);
  if (!records) {
    process.stderr.write(`cannot read session log: ${file}\n`);
    process.exit(1);
  }
  process.stdout.write(formatTimeline(buildTimeline(records)) + '\n');
}
