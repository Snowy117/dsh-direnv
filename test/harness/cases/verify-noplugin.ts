/**
 * Independent-verification negative control #2 (no plugin overlay).
 *
 * Byte-identical workspace, `.envrc`, whitelist config and fake-LLM tool call as
 * `direnv-smoke`, but WITHOUT the two overlay rows that disable the stock
 * `subprocess` row and insert `dsh-direnv`.
 *
 * If `bash` still exists (it must: it is the official runtime) and the variable
 * is empty, the smoke case really did measure the plugin. If the variable is
 * still populated here, the smoke case proved nothing.
 */
import fs from 'node:fs';
import path from 'node:path';

import type { HarnessCase } from '../cases.ts';

export default {
  name: 'verify-noplugin',
  description: 'Negative control: same workspace/.envrc as direnv-smoke but NO plugin rows; bash must exist and the value must be empty.',
  profile: 'verify-noplugin',
  bootstrapProfileFirst: true,
  gateMs: 0,
  task: "Use the bash tool to run: bash -c 'echo DIRENV_SMOKE=$SOME_DIRENV_VAR'",
  files: {
    '.envrc': 'export SOME_DIRENV_VAR=verify-noplugin-should-not-appear\n',
  },
  fake: {
    toolCalls: [{
      name: 'bash',
      arguments: { command: "bash -c 'echo DIRENV_SMOKE=$SOME_DIRENV_VAR'", description: 'read SOME_DIRENV_VAR with no direnv plugin' },
    }],
  },
  // No `extraRows`: the stock subprocess provider stays in place.
  prepare({ runDir, wsDir }) {
    const configDir = path.join(runDir, 'config');
    fs.mkdirSync(path.join(configDir, 'direnv'), { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'direnv', 'direnv.toml'),
      `[whitelist]\nprefix = [${JSON.stringify(wsDir)}]\n`,
    );
    return { env: { XDG_CONFIG_HOME: configDir } };
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
