/**
 * Independent verification: the gate under a genuinely slow evaluation.
 *
 * `.envrc` sleeps 2000ms before exporting. The plugin's own gate (probe gate is
 * disarmed with gateMs=0) must hold the tool call for ~2s, while the model's
 * FIRST request must not be delayed: the durable session log shows the tool call
 * being held after `request/header` has already happened.
 */
import fs from 'node:fs';
import path from 'node:path';

const PLUGIN_ROWS = [
  '- id: subprocess',
  '  disabled: true',
  '- insert:',
  '    - id: direnv-subprocess',
  "      name: 'dsh-direnv'",
].join('\n');

import type { HarnessCase } from '../cases.ts';

export default {
  name: 'verify-slow-gate',
  description: 'Slow .envrc (sleep 2) with the plugin gate armed: tool call held ~2s, conversation path not delayed.',
  requires: { repoFiles: ['src/index.ts', 'lib/index.js'] },
  profile: 'verify-slow-gate',
  bootstrapProfileFirst: true,
  gateMs: 0,
  timeoutMs: 120000,
  task: "Use the bash tool to run: bash -c 'echo DIRENV_SMOKE=$SOME_DIRENV_VAR'",
  files: {
    '.envrc': 'sleep 2\nexport SOME_DIRENV_VAR=verify-slow-gate-ok\n',
  },
  fake: {
    toolCalls: [{
      name: 'bash',
      arguments: { command: "bash -c 'echo DIRENV_SMOKE=$SOME_DIRENV_VAR'", description: 'read through a 2s direnv evaluation' },
    }],
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
    toolResultCount: 1,
    toolResults: [{ equals: 'DIRENV_SMOKE=verify-slow-gate-ok\n', isError: false }],
    timelineHas: ['tool/call', 'tool/result'],
    metrics: {
      toolCalls: 1,
      toolResults: 1,
      'call->gate/enter:call_fake_1': [0, 1500],
      'call->result:call_fake_1': [1800, 15000],
      'fake.toolRouteAttempts': 1,
      'fake.unhandled': 0,
    },
  },
} satisfies HarnessCase;
