/**
 * Independent-verification negative control #3 (fresh random value per run).
 *
 * The value is generated in this module when the harness loads the case, so it
 * cannot have existed before the run and cannot be guessed by the fake LLM: the
 * fake LLM only ever sees the literal command `echo DIRENV_SMOKE=$SOME_DIRENV_VAR`.
 * The assertion therefore excludes "the stub echoed the expected value back".
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const VALUE = `verify-random-${randomUUID()}`;

const PLUGIN_ROWS = [
  '- id: subprocess',
  '  disabled: true',
  '- insert:',
  '    - id: direnv-subprocess',
  "      name: 'dsh-direnv'",
].join('\n');

import type { HarnessCase } from '../cases.ts';

export default {
  name: 'verify-random',
  description: 'The .envrc carries a fresh UUID generated at case-load time; the bash tool result must equal it exactly.',
  requires: { repoFiles: ['src/index.ts', 'lib/index.js'] },
  profile: 'verify-random',
  bootstrapProfileFirst: true,
  gateMs: 0,
  task: "Use the bash tool to run: bash -c 'echo DIRENV_SMOKE=$SOME_DIRENV_VAR'",
  files: {
    '.envrc': `export SOME_DIRENV_VAR=${VALUE}\n`,
  },
  fake: {
    toolCalls: [{
      name: 'bash',
      arguments: { command: "bash -c 'echo DIRENV_SMOKE=$SOME_DIRENV_VAR'", description: 'read a per-run random value' },
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
    toolResults: [{ equals: `DIRENV_SMOKE=${VALUE}\n`, isError: false }],
    timelineHas: ['tool/call', 'tool/result'],
    metrics: {
      toolCalls: 1,
      toolResults: 1,
      'fake.toolRouteAttempts': 1,
      'fake.unhandled': 0,
    },
  },
} satisfies HarnessCase;
