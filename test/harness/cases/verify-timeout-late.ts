/**
 * Independent verification: after the timeout, the background evaluation still
 * completes and a LATER spawn is injected.
 *
 * `loadTimeoutMs: 500` + a sleep-3 `.envrc`, but the harness probe delays the
 * pre-execute dispatch by 4000ms (gateMs applies to the probe, not the plugin).
 * By the time the command is spawned the background evaluation has finished, so
 * the tool must see the value — proof that the timeout path continues loading
 * instead of giving up.
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
  name: 'verify-timeout-late',
  description: 'Timeout at 500ms + probe dispatch delay 4s: the later spawn must see the value, proving the background eval completed.',
  requires: { repoFiles: ['src/index.ts', 'lib/index.js'] },
  profile: 'verify-timeout-late',
  bootstrapProfileFirst: true,
  gateMs: 4000,
  timeoutMs: 120000,
  task: "Use the bash tool to run: bash -c 'echo DIRENV_SMOKE=$SOME_DIRENV_VAR'",
  files: {
    '.envrc': 'sleep 3\nexport SOME_DIRENV_VAR=verify-timeout-late-ok\n',
  },
  fake: {
    toolCalls: [{
      name: 'bash',
      arguments: { command: "bash -c 'echo DIRENV_SMOKE=$SOME_DIRENV_VAR'", description: 'read after the slow evaluation finished' },
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
    toolResults: [{ equals: 'DIRENV_SMOKE=verify-timeout-late-ok\n', isError: false }],
    timelineHas: ['tool/call', 'tool/result'],
    metrics: {
      toolCalls: 1,
      toolResults: 1,
      'call->result:call_fake_1': [3900, 20000],
      'fake.toolRouteAttempts': 1,
      'fake.unhandled': 0,
    },
  },
} satisfies HarnessCase;
