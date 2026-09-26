/**
 * direnv-smoke: the case this harness exists for.
 *
 * It boots a scratch profile that loads THIS repository's plugin instead of the
 * stock subprocess runtime (`subprocess: disabled` + `direnv-subprocess` inserted,
 * the same rows as the plugin's own cordis.patch.yml), drops an `.envrc` into the
 * session workspace, and asserts that a real `bash` tool call sees
 * `SOME_DIRENV_VAR` from that `.envrc`.
 *
 * The workspace `.envrc` is approved through direnv's own whitelist mechanism in a
 * scratch `direnv.toml` (`XDG_CONFIG_HOME=<run>/config`), so neither the user's
 * real allow database nor their real config is read or written.
 *
 * `prepare` writes that config and exports the env the child needs; it runs before
 * the child env is frozen. `prepareProfile` then makes the repo importable by bare
 * name from the scratch profile.
 */
import fs from 'node:fs';
import path from 'node:path';

import type { HarnessCase } from '../cases.ts';

export default {
  name: 'direnv-smoke',
  description: 'Load the repo plugin in a scratch profile; a bash tool call must see SOME_DIRENV_VAR from the workspace .envrc.',
  requires: { repoFiles: ['src/index.ts', 'lib/index.js'] },
  profile: 'direnv-smoke',
  bootstrapProfileFirst: true,
  gateMs: 0,
  task: "Use the bash tool to run: bash -c 'echo DIRENV_SMOKE=$SOME_DIRENV_VAR'",
  files: {
    '.envrc': 'export SOME_DIRENV_VAR=direnv-smoke-ok\n',
  },
  fake: {
    toolCalls: [{
      name: 'bash',
      arguments: { command: "bash -c 'echo DIRENV_SMOKE=$SOME_DIRENV_VAR'", description: 'read SOME_DIRENV_VAR through direnv' },
    }],
  },
  extraRows: [
    '- id: subprocess',
    '  disabled: true',
    '- insert:',
    '    - id: direnv-subprocess',
    "      name: 'dsh-direnv'",
  ].join('\n'),
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
    toolResults: [{ equals: 'DIRENV_SMOKE=direnv-smoke-ok\n', isError: false }],
    timelineHas: ['tool/call', 'tool/result'],
    metrics: {
      toolCalls: 1,
      toolResults: 1,
      'fake.toolRouteAttempts': 1,
      'fake.unhandled': 0,
    },
  },
} satisfies HarnessCase;
