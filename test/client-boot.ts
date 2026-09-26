#!/usr/bin/env node
/**
 * Delivery-level acceptance check for the browser half, for environments with no
 * browser available.
 *
 * It boots a scratch `web` profile that mounts this repository as the plugin, then
 * asserts the three things a broken client bundle would violate:
 *   1. the web app starts at all — a malformed manifest makes startup fail with no
 *      URL, so reaching the index is already a signal;
 *   2. the boot payload carries our row, with the exact `inject` list from
 *      package.json, and the module is part of the application batch;
 *   3. the served module is byte-identical to the artifact `exports["./client"]`
 *      names, plus the framing the DSH bundle carrier appends.
 *
 * What it cannot check (needs a real browser): whether the tab renders, whether the
 * composer greys out, whether the toast expires, and how the real SlotCore treats
 * our registrations at runtime.
 *
 *   node test/client-boot.ts [--keep]
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { isRecord } from './helpers/guards.ts';
import { CLIENT_FILE, MANIFEST, REPO } from './helpers/package-manifest.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUN_DIR = path.join(HERE, 'harness', '.runs', 'client-boot');
const HOME_DIR = path.join(RUN_DIR, 'home');
const PROFILE = 'clientboot';
const PROFILE_DIR = path.join(HOME_DIR, 'profiles', PROFILE);
/** Live DSH homes this script's scratch directory must never overlap. */
const PROTECTED = [...new Set([os.homedir(), process.env.HOME ?? '']
  .filter((home) => home !== '')
  .map((home) => path.resolve(home, '.dsh')))];

/** The server child, whose piped stdout/stderr this script reads as text. */
type PipedChild = ChildProcessByStdio<null, Readable, Readable>;

const keep = process.argv.includes('--keep');
let server: PipedChild | null = null;
let failures = 0;

function ok(label: string, detail?: unknown): void {
  process.stdout.write(`  PASS  ${label}${detail === undefined ? '' : `  ${detail}`}\n`);
}
function bad(label: string, detail?: unknown): void {
  failures += 1;
  process.stdout.write(`  FAIL  ${label}${detail === undefined ? '' : `  ${detail}`}\n`);
}
function check(condition: boolean, label: string, detail?: unknown): void {
  if (condition) ok(label, detail);
  else bad(label, detail);
}

function refuse(reason: string): never {
  process.stderr.write(`[client-boot] REFUSING TO RUN: ${reason}\n`);
  process.exit(2);
}

/** `String(error?.stack ?? error)` for a caught value, which is `unknown`. */
function describeError(error: unknown): string {
  const stack = error instanceof Error ? error.stack : undefined;
  return String(stack ?? error);
}

for (const protectedHome of PROTECTED) {
  const relative = path.relative(protectedHome, RUN_DIR);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    refuse(`${RUN_DIR} lives inside a live DSH home (${protectedHome})`);
  }
}

function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra, DSH_HOME: HOME_DIR };
  delete env.DSH_PROFILE_DIR;
  return env;
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(args: readonly string[], { timeoutMs = 120_000 }: { timeoutMs?: number } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn('dsh', args, { cwd: RUN_DIR, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('the probe socket has no TCP address'));
        return;
      }
      probe.close(() => resolve(address.port));
    });
  });
}

interface TextReply {
  status: number;
  headers: Headers;
  body: string;
}

async function fetchText(url: string, headers: Record<string, string> = {}): Promise<TextReply> {
  const response = await fetch(url, { headers, redirect: 'manual' });
  const body = await response.text();
  return { status: response.status, headers: response.headers, body };
}

interface BootRow {
  inject: unknown[];
  rev: unknown;
  url: string;
}

/**
 * The boot payload's row for this plugin, read out of the served index HTML.
 * The row is a `JSON.parse` boundary: it has to carry the `inject` list and the
 * `url` the module is served from, and a row without them fails exactly where the
 * unguarded `parsed.inject.join(...)` below always did.
 */
function readBootRow(row: string): BootRow {
  const parsed: unknown = JSON.parse(row);
  if (!isRecord(parsed)) throw new Error('the boot payload row is not an object');
  const inject = parsed.inject;
  const url = parsed.url;
  if (!Array.isArray(inject) || typeof url !== 'string') {
    throw new Error('the boot payload row carries no inject list or module url');
  }
  return { inject, rev: parsed.rev, url };
}

interface StatusReport {
  plugin: Record<string, unknown> | null;
  dir: unknown;
  status: {
    state: unknown;
    variables: { name: string }[];
    env: Record<string, unknown> | null;
  };
}

function isVariableList(value: unknown): value is { name: string }[] {
  return Array.isArray(value) && value.every((entry) => isRecord(entry) && typeof entry.name === 'string');
}

/**
 * The status route's answer as these checks read it, or `null` while the host has
 * no status record for the session yet (the `status: null` branch of
 * `src/status-route.ts`, which is not a failure).
 */
function readStatusReport(body: string): StatusReport | null {
  const parsed: unknown = JSON.parse(body);
  if (!isRecord(parsed)) throw new Error('the status route did not answer an object');
  const status = parsed.status;
  if (!isRecord(status)) return null;
  const variables = status.variables;
  if (!isVariableList(variables)) return null;
  const env = status.env;
  return {
    plugin: isRecord(parsed.plugin) ? parsed.plugin : null,
    dir: parsed.dir,
    status: { state: status.state, variables, env: isRecord(env) ? env : null },
  };
}

async function main(): Promise<void> {
  fs.rmSync(RUN_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(RUN_DIR, 'ws'), { recursive: true });

  const bootstrap = await run(['--profile', PROFILE, '--from-default-profile', 'web', '--dump-config']);
  if (bootstrap.code !== 0) refuse(`profile bootstrap failed (exit ${String(bootstrap.code)}): ${bootstrap.stderr.trim()}`);

  const modules = path.join(PROFILE_DIR, 'node_modules');
  fs.mkdirSync(modules, { recursive: true });
  fs.symlinkSync(REPO, path.join(modules, 'dsh-direnv'), 'dir');

  const overlayPath = path.join(RUN_DIR, 'overlay.yml');
  fs.writeFileSync(
    overlayPath,
    ['- id: subprocess', '  disabled: true', '- insert:', '    - id: direnv-subprocess', "      name: 'dsh-direnv'", ''].join('\n'),
  );

  // An approved workspace for the status route: `[whitelist] prefix` keeps direnv's
  // real allow store out of it, exactly as the headless harness does.
  const ws = path.join(RUN_DIR, 'ws');
  fs.writeFileSync(path.join(ws, '.envrc'), 'export CLIENT_BOOT_VAR=client-boot-ok\n');
  const xdgConfig = path.join(RUN_DIR, 'config');
  fs.mkdirSync(path.join(xdgConfig, 'direnv'), { recursive: true });
  fs.writeFileSync(path.join(xdgConfig, 'direnv', 'direnv.toml'), `[whitelist]\nprefix = ["${ws}"]\n`);

  const port = await freePort();
  const base = `http://127.0.0.1:${String(port)}`;
  server = spawn('dsh', ['--profile', PROFILE, '--patch', overlayPath, '--no-open', '--port', String(port)], {
    cwd: ws,
    env: childEnv({ XDG_CONFIG_HOME: xdgConfig }),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let out = '';
  let err = '';
  server.stdout.on('data', (chunk: Buffer) => {
    out += chunk.toString();
  });
  server.stderr.on('data', (chunk: Buffer) => {
    err += chunk.toString();
  });

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && !/http:\/\/127\.0\.0\.1/.test(out)) {
    if (server.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  fs.writeFileSync(path.join(RUN_DIR, 'web.out'), out);
  fs.writeFileSync(path.join(RUN_DIR, 'web.err'), err);

  process.stdout.write(`\n=== dsh-direnv client acceptance (${PROFILE} web profile) ===\n`);
  const url = /(http:\/\/127\.0\.0\.1:\d+\/\?token=[\w.-]+)/.exec(out)?.[1];
  check(url !== undefined, 'web app started and printed an authenticated URL');
  if (url === undefined) {
    bad('startup stderr', err.trim().split('\n').slice(0, 3).join(' | ') || '(empty)');
    return;
  }
  check(!/did not activate|pending \(waiting|failed to import|has been registered|skipping profile bundle/.test(err), 'no degradation signature on stderr');

  const initial = await fetch(url, { redirect: 'manual' });
  // `Headers.entries()` collapses `set-cookie`; only getSetCookie() exposes it.
  const cookie = (initial.headers.getSetCookie?.() ?? [])[0]?.split(';')[0];
  check(initial.status === 303 || initial.status === 302 || initial.status === 200, 'token exchange accepted', `http=${String(initial.status)}`);
  check(cookie !== undefined, 'token exchange issued a cookie');
  const index = cookie === undefined ? await fetchText(url) : await fetchText(`${base}/`, { cookie });
  check(index.status === 200, 'index served to the authenticated browser', `http=${String(index.status)}`);

  const row = /\{"id":"dsh-direnv"[^}]*\}/.exec(index.body)?.[0];
  check(row !== undefined, 'boot payload carries the dsh-direnv client row');
  if (row === undefined) return;

  const parsed = readBootRow(row);
  const expectedInject = MANIFEST.clientInject;
  check(
    JSON.stringify(parsed.inject) === JSON.stringify(expectedInject),
    'inject list matches package.json',
    parsed.inject.join(', '),
  );
  check(typeof parsed.rev === 'string' && parsed.rev.length > 0, 'row carries a revision', parsed.rev);
  check(index.body.includes('??dsh-direnv/client.js'), 'module is referenced by the application batch');

  const served = await fetch(`${base}/${parsed.url}`);
  const bytes = Buffer.from(await served.arrayBuffer());
  const source = fs.readFileSync(CLIENT_FILE);
  check(served.status === 200, 'plugin module is served', `http=${String(served.status)} bytes=${String(bytes.length)}`);
  check(bytes.subarray(0, source.length).equals(source), 'served module starts byte-identical to the client artifact');
  const tail = bytes.subarray(source.length).toString('utf8');
  check(/^;\n\/\/# sourceMappingURL=/.test(tail), 'only the carrier sourceMappingURL tail is appended', JSON.stringify(tail.trim()));

  await checkStatusRoute(base, cookie!, ws);

  process.stdout.write(`\n=== RESULT: ${failures === 0 ? 'PASS' : `FAIL (${String(failures)})`} ===\n`);
  process.stdout.write(`evidence: ${RUN_DIR}\n`);
}

/**
 * Exercises the one route the client polls. This is the only place the host's
 * StatusRecord and the browser's reader meet over real HTTP, and `/plugins/*`
 * carries no fence of its own, so the unauthenticated request matters as much as
 * the authenticated one.
 */
async function checkStatusRoute(base: string, cookie: string, ws: string): Promise<void> {
  const route = `${base}/plugins/dsh-direnv/status.json?sessionId=clientboot&dir=${encodeURIComponent(ws)}`;

  const anonymous = await fetchText(route);
  check(
    anonymous.status === 401 || anonymous.status === 403,
    'status route refuses an unauthenticated request',
    `http=${String(anonymous.status)}`,
  );

  const first = await fetchText(`${route}&force=1`, { cookie });
  check(first.status === 200, 'status route answers the admitted browser', `http=${String(first.status)}`);
  check(/application\/json/.test(first.headers.get('content-type') ?? ''), 'status route answers JSON, not the SPA fallback');

  let payload: StatusReport | null = null;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const polled = await fetchText(route, { cookie });
    const body = readStatusReport(polled.body);
    if (body?.status.state === 'ok') {
      payload = body;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  check(payload !== null, 'force=1 drives the evaluation to ok');
  if (payload === null) return;
  check(payload.plugin?.name === 'dsh-direnv', 'payload identifies the plugin');
  check(payload.dir === ws, 'payload echoes the resolved directory');
  check(
    payload.status.variables.some((entry) => entry.name === 'CLIENT_BOOT_VAR'),
    'status lists the variable name',
    payload.status.variables.map((entry) => entry.name).join(', '),
  );
  check(payload.status.env === null, 'variable values stay out of the default payload');

  const valued = readStatusReport((await fetchText(`${route}&values=1`, { cookie })).body);
  check(valued?.status.env?.CLIENT_BOOT_VAR === 'client-boot-ok', '?values=1 returns values to the admitted operator');
}

/** The server child this process started, or `null` before `main` spawns it. */
function liveServer(): PipedChild | null {
  return server;
}

function stop(): void {
  const running = liveServer();
  if (running === null || running.pid === undefined) return;
  try {
    process.kill(-running.pid, 'SIGTERM');
  } catch {
    try {
      running.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
}

try {
  await main();
} catch (error) {
  bad('unexpected error', describeError(error));
} finally {
  stop();
  await new Promise((resolve) => setTimeout(resolve, 500));
  const watched = liveServer();
  const alive = watched !== null && watched.exitCode === null && watched.signalCode === null;
  if (watched !== null && alive && watched.pid !== undefined) {
    try {
      process.kill(-watched.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  process.stdout.write(alive ? 'server stopped (escalated to SIGKILL)\n' : 'server stopped cleanly\n');
  if (!keep) {
    /* keep the evidence directory: it is inside .runs/, which is ignored */
  }
  process.exitCode = failures === 0 ? 0 : 1;
}
