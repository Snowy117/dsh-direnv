/**
 * Independent-verification bonus: the value is generated INSIDE the .envrc at
 * evaluation time (`od /dev/urandom`), so no process outside direnv ever knows
 * it. The durable session log must contain a non-empty
 * `DIRENV_SMOKE=verify-live-<hex>` result; nothing else in the run directory may
 * contain that literal (checked out-of-band by grepping the whole run dir).
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
  name: 'verify-random-live',
  description: 'The .envrc generates the value at eval time from /dev/urandom; result must be a non-empty verify-live-<hex> string.',
  requires: { repoFiles: ['src/index.ts', 'lib/index.js'] },
  profile: 'verify-random-live',
  bootstrapProfileFirst: true,
  gateMs: 0,
  task: "Use the bash tool to run: bash -c 'echo DIRENV_SMOKE=$SOME_DIRENV_VAR'",
  files: {
    '.envrc': "export SOME_DIRENV_VAR=\"verify-live-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \\n')\"\n",
  },
  fake: {
    toolCalls: [{
      name: 'bash',
      arguments: { command: "bash -c 'echo DIRENV_SMOKE=$SOME_DIRENV_VAR'", description: 'read an eval-time generated value' },
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
    toolResults: [{ isError: false, contains: 'DIRENV_SMOKE=verify-live-', notContains: 'DIRENV_SMOKE=\n' }],
    timelineHas: ['tool/call', 'tool/result'],
    metrics: {
      toolCalls: 1,
      toolResults: 1,
      'fake.toolRouteAttempts': 1,
      'fake.unhandled': 0,
    },
  },
} satisfies HarnessCase;
