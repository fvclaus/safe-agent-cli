import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  LAUNCH_LOG_HOME_RELATIVE_PATH,
  LAUNCH_LOG_PLUGIN_DIR,
  LAUNCH_LOG_PLUGIN_HOME_RELATIVE_DIR,
  serializeLaunchLog,
} from '../launch-log.js';
import { copyStagedClaudeTreeIntoHome } from './copy-into-home.js';
import { resolveSandboxHome } from './home.js';
import { runSbx } from './run-sbx.js';

// Installs the launch-log mod (../launch-log-plugin) into the sandbox and
// hands it the log collected so far. The mod goes into a folder of this
// sandbox's own, which the `env` block of the in-container
// ~/.claude/settings.json names in CLAUDE_CODE_PLUGIN_DIRS (see
// withPluginDir, applied by the settings merge). ~/.claude/skills is not
// used: there sbx mounts its skill store, shared by every sandbox on the
// machine. The mod finds the log at LAUNCH_LOG_HOME_RELATIVE_PATH below $HOME.
// Both are replaced wholesale on every launch.
//
// Must run after the last `log` call of the launch: whatever is logged later
// is not in the file the mod reads.

/** The mod's files, relative to its folder. Only these reach the sandbox; the folder also holds files Claude Code generates (tsconfig.json, types/, .claude/). */
export const LAUNCH_LOG_PLUGIN_FILES = [
  '.claude-plugin/plugin.json',
  'hooks/hooks.json',
  'hooks/register.js',
  'hooks/launch-log.js',
] as const;

/** `settings` with `dir` appended to `env.CLAUDE_CODE_PLUGIN_DIRS` (a ':'-separated list, as the sandbox runs Linux), unless already listed. */
export function withPluginDir(settings: Record<string, unknown>, dir: string): Record<string, unknown> {
  const env = settings['env'];
  const envObject = typeof env === 'object' && env !== null && !Array.isArray(env) ? (env as Record<string, unknown>) : {};
  const current = envObject['CLAUDE_CODE_PLUGIN_DIRS'];
  const dirs = typeof current === 'string' ? current.split(':').filter(Boolean) : [];
  if (dirs.includes(dir)) return settings;
  return { ...settings, env: { ...envObject, CLAUDE_CODE_PLUGIN_DIRS: [...dirs, dir].join(':') } };
}

export function installLaunchLogIntoSandbox(sandboxName: string): void {
  const home = resolveSandboxHome(sandboxName);
  const pluginRelative = LAUNCH_LOG_PLUGIN_HOME_RELATIVE_DIR;
  const ownedTree = dirname(LAUNCH_LOG_HOME_RELATIVE_PATH);

  runSbx(['exec', sandboxName, 'rm', '-rf', `${home}/${pluginRelative}`], 'removing the previous launch-log mod');

  const tmpDir = mkdtempSync(join(tmpdir(), 'sbx-claude-code-launch-log-'));
  try {
    for (const file of LAUNCH_LOG_PLUGIN_FILES) {
      const target = join(tmpDir, pluginRelative, file);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(join(LAUNCH_LOG_PLUGIN_DIR, file), target, { dereference: true });
    }
    const stagedLog = join(tmpDir, LAUNCH_LOG_HOME_RELATIVE_PATH);
    mkdirSync(dirname(stagedLog), { recursive: true });
    writeFileSync(stagedLog, serializeLaunchLog(), 'utf8');

    copyStagedClaudeTreeIntoHome({
      sandboxName,
      home,
      stagedRoot: tmpDir,
      ownedTrees: [ownedTree],
      expectedFiles: [...LAUNCH_LOG_PLUGIN_FILES.map((f) => `${pluginRelative}/${f}`), LAUNCH_LOG_HOME_RELATIVE_PATH],
    });
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}
