/**
 * Regression: a workspace whose evaluation outlives the gate must still end up
 * with an environment.
 *
 * The gate budget (`loadTimeoutMs: 500`) is deliberately far below the 3 s the
 * `.envrc` sleeps, and the probe delays each pre-execute by 4 s so both calls in
 * one message are spawned after the evaluation has finished. This case exists
 * because those two budgets used to be the same number — the timeout then killed
 * the evaluation as well, and the session never recovered. Both calls must now
 * see the value: the gate releases early, the evaluation keeps running, and a
 * later spawn picks it up.
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
].join('\n');

import type { HarnessCase } from '../cases.ts';

export default {
  name: 'verify-timeout-retry',
  description: 'Two calls spawned after a 3s evaluation while the gate budget is 500ms: both must see the environment.',
  requires: { repoFiles: ['src/index.ts', 'lib/index.js'] },
  profile: 'verify-timeout-retry',
  bootstrapProfileFirst: true,
  gateMs: 4000,
  timeoutMs: 120000,
  task: "Use the bash tool to run: bash -c 'echo DIRENV_SMOKE=$SOME_DIRENV_VAR'",
  files: {
    '.envrc': 'sleep 3\nexport SOME_DIRENV_VAR=verify-timeout-retry-ok\n',
  },
  fake: {
    toolCalls: [
      { name: 'bash', arguments: { command: "bash -c 'echo FIRST=$SOME_DIRENV_VAR'", description: 'first spawn after the gate released' } },
      { name: 'bash', arguments: { command: "bash -c 'echo SECOND=$SOME_DIRENV_VAR'", description: 'second spawn after the gate released' } },
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
      { callId: 'call_fake_1', isError: false, equals: 'FIRST=verify-timeout-retry-ok\n' },
      { callId: 'call_fake_2', isError: false, equals: 'SECOND=verify-timeout-retry-ok\n' },
    ],
    timelineHas: ['tool/call', 'tool/result'],
    metrics: {
      toolCalls: 2,
      toolResults: 2,
      'call->result:call_fake_1': [3900, 20000],
      'call->result:call_fake_2': [3900, 30000],
      'fake.toolRouteAttempts': 1,
      'fake.unhandled': 0,
    },
  },
} satisfies HarnessCase;
