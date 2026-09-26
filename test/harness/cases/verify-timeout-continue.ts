/**
 * Regression: the gate budget and the evaluation budget are independent, so a
 * slow `.envrc` still reaches later commands in the same session.
 *
 * `loadTimeoutMs: 500` (gate) + `evaluateTimeoutMs: 60000` (evaluation child)
 * with a sleep-3 `.envrc`:
 *
 *   call 1 — released by the 500ms gate timeout, runs immediately (value still
 *            empty), and sleeps 5s, so that
 *   call 2 — is spawned seconds after the background evaluation finished and
 *            must see `SOME_DIRENV_VAR`.
 *
 * `call->result` for call 1 also separates the two budgets: ~500ms of gate plus
 * the tool's own 5s sleep. A gate that waited for the 3s evaluation would push
 * it past 8s.
 *
 * Before the fix, `loadTimeoutMs` was also the evaluation child's kill deadline,
 * so the evaluation died at 500ms and every later spawn stayed empty.
 */
import fs from 'node:fs';
import path from 'node:path';

const PLUGIN_ROWS = [
  '- id: subprocess',
  '  disabled: true',
  '- insert:',
  '    - id: direnv-subprocess',
  "      name: 'dsh-direnv'",
  '      config:',
  '        loadTimeoutMs: 500',
  '        evaluateTimeoutMs: 60000',
].join('\n');

import type { HarnessCase } from '../cases.ts';

export default {
  name: 'verify-timeout-continue',
  description: 'loadTimeoutMs=500 (gate) with evaluateTimeoutMs=60000 and a sleep-3 .envrc: the tool is released and runs, and a later spawn gets the environment.',
  requires: { repoFiles: ['src/index.ts', 'lib/index.js'] },
  profile: 'verify-timeout-continue',
  bootstrapProfileFirst: true,
  gateMs: 0,
  timeoutMs: 120000,
  task: "Use the bash tool to run: bash -c 'echo FIRST=$SOME_DIRENV_VAR; sleep 5'",
  files: {
    '.envrc': 'sleep 3\nexport SOME_DIRENV_VAR=verify-timeout-continue-ok\n',
  },
  fake: {
    toolCalls: [
      {
        name: 'bash',
        arguments: {
          command: "bash -c 'echo FIRST=$SOME_DIRENV_VAR; sleep 5'",
          description: 'released by the gate timeout; stays busy while the evaluation finishes in the background',
        },
      },
      {
        name: 'bash',
        arguments: {
          command: "bash -c 'echo SECOND=$SOME_DIRENV_VAR'",
          description: 'spawned later: the background evaluation must have landed',
        },
      },
    ],
  },
  extraRows: PLUGIN_ROWS,
  prepare({ runDir, wsDir }) {
    const configDir = path.join(runDir, 'config');
    fs.mkdirSync(path.join(configDir, 'direnv'), { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'direnv', 'direnv.toml'),
      `[whitelist]\nprefix = [${JSON.stringify(wsDir)}]\n`,
    );
    return { env: { XDG_CONFIG_HOME: configDir } };
  },
  prepareProfile({ profileDir, repoDir }) {
    const link = path.join(profileDir, 'node_modules', 'dsh-direnv');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    if (!fs.existsSync(link)) fs.symlinkSync(repoDir, link, 'dir');
  },
  expect: {
    exitCode: 0,
    noTimeout: true,
    finalText: { contains: 'FAKE-FINAL' },
    stderr: { notContains: ['did not activate', 'has been registered at'] },
    toolResultCount: 2,
    toolResults: [
      { callId: 'call_fake_1', isError: false, contains: 'FIRST=\n' },
      { callId: 'call_fake_2', isError: false, equals: 'SECOND=verify-timeout-continue-ok\n' },
    ],
    timelineHas: ['tool/call', 'tool/result'],
    metrics: {
      toolCalls: 2,
      toolResults: 2,
      'call->result:call_fake_1': [5000, 7500], // 500ms gate + 5s sleep, not 3s evaluation + 5s sleep
      'call->result:call_fake_2': [0, 2000], // calls are dispatched in order: an instant call 2 means it did not wait for anything
      'fake.requests': 3,
      'fake.titleRoute': 1,
      'fake.toolRouteAttempts': 1,
      'fake.closingRoute': 1,
      'fake.unhandled': 0,
    },
  },
} satisfies HarnessCase;
