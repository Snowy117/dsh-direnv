/**
 * Independent verification: the blocked path.
 *
 * `XDG_CONFIG_HOME` points at an EMPTY scratch config dir, so the workspace
 * prefix is not whitelisted and direnv refuses to export it. The tool must still
 * run (no hang, no error), with the harness environment, and the model must be
 * told it is blocked without being told to approve it itself.
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
  name: 'verify-blocked',
  description: 'Un-whitelisted .envrc: tool still runs, value empty, exit 0; the model notice must say blocked.',
  requires: { repoFiles: ['src/index.ts', 'lib/index.js'] },
  profile: 'verify-blocked',
  bootstrapProfileFirst: true,
  gateMs: 0,
  timeoutMs: 120000,
  task: "Use the bash tool to run: bash -c 'echo DIRENV_SMOKE=$SOME_DIRENV_VAR'",
  files: {
    '.envrc': 'export SOME_DIRENV_VAR=verify-blocked-should-not-appear\n',
  },
  fake: {
    toolCalls: [{
      name: 'bash',
      arguments: { command: "bash -c 'echo DIRENV_SMOKE=$SOME_DIRENV_VAR'", description: 'read from a blocked workspace' },
    }],
  },
  extraRows: PLUGIN_ROWS,
  prepare({ runDir, wsDir: _wsDir }) {
    // Deliberately EMPTY: no whitelist entry for wsDir, no ambient user config.
    const configDir = path.join(runDir, 'config-empty');
    fs.mkdirSync(path.join(configDir, 'direnv'), { recursive: true });
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
      'fake.toolRouteAttempts': 1,
      'fake.unhandled': 0,
    },
  },
} satisfies HarnessCase;
