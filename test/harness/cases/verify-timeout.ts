/**
 * Independent verification: the load timeout releases the gate.
 *
 * `loadTimeoutMs: 500` while the `.envrc` needs ~3000ms. The tool call must be
 * released by the timeout (call -> result far below 3000ms), must still execute,
 * and must see no overlay yet (the evaluation is still in flight), i.e. the
 * value is empty.
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
  name: 'verify-timeout',
  description: 'loadTimeoutMs=500 with a sleep-3 .envrc: gate released by the timeout, tool still runs, value still empty.',
  requires: { repoFiles: ['src/index.ts', 'lib/index.js'] },
  profile: 'verify-timeout',
  bootstrapProfileFirst: true,
  gateMs: 0,
  timeoutMs: 120000,
  task: "Use the bash tool to run: bash -c 'echo DIRENV_SMOKE=$SOME_DIRENV_VAR'",
  files: {
    '.envrc': 'sleep 3\nexport SOME_DIRENV_VAR=verify-timeout-ok\n',
  },
  fake: {
    toolCalls: [{
      name: 'bash',
      arguments: { command: "bash -c 'echo DIRENV_SMOKE=$SOME_DIRENV_VAR'", description: 'read before a slow evaluation finishes' },
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
    toolResults: [{ equals: 'DIRENV_SMOKE=\n', isError: false }],
    timelineHas: ['tool/call', 'tool/result'],
    metrics: {
      toolCalls: 1,
      toolResults: 1,
      'call->result:call_fake_1': [200, 1800], // released by the 500ms timeout, NOT held for 3000ms
      'fake.toolRouteAttempts': 1,
      'fake.unhandled': 0,
    },
  },
} satisfies HarnessCase;
