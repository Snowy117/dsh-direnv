/**
 * The `unknown`-narrowing seams for every JSON boundary in the harness.
 *
 * The fake LLM's request bodies, `FAKE_LLM_CONFIG_FILE`, the JSONL logs the
 * runner reads back and the `--json` stdout stream all arrive as `unknown`.
 * Every read goes through one of these readers, so a field that is missing or
 * mistyped becomes a typed `undefined` at the point of use instead of an
 * implicit `any` that would spread silently into the grader.
 */
import fs from 'node:fs';

import { isRecord } from '../helpers/guards.ts';

/** One parsed JSON object — the only shape a harness reader accepts. */
export type JsonRecord = Record<string, unknown>;

export function isJsonRecord(value: unknown): value is JsonRecord {
  return isRecord(value);
}

/** Parse a JSON object, refusing anything that is not one. */
export function parseJsonRecord(text: string): JsonRecord {
  const parsed: unknown = JSON.parse(text);
  if (!isJsonRecord(parsed)) throw new Error('expected a JSON object');
  return parsed;
}

export function readString(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

/** Only finite numbers narrow: a `NaN` timing must read as "not measured". */
export function readNumber(record: JsonRecord, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function readBoolean(record: JsonRecord, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}

/** The object members of a JSON array field (`messages`, `tools`, `content`). */
export function readRecords(record: JsonRecord, key: string): JsonRecord[] {
  const value = record[key];
  return Array.isArray(value) ? value.filter(isJsonRecord) : [];
}

/**
 * Read a JSONL log back. An unparsable line becomes a one-line evidence row
 * instead of aborting the run, and valid JSON that is not an object is kept in
 * the same spirit; both stay visible in `evidence.json`.
 */
export function readJsonl(file: string): JsonRecord[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim()).map((line) => {
    try {
      const parsed: unknown = JSON.parse(line);
      return isJsonRecord(parsed) ? parsed : { ev: '(non-object)', raw: line.slice(0, 200) };
    } catch {
      return { ev: '(unparsable)', raw: line.slice(0, 200) };
    }
  });
}
