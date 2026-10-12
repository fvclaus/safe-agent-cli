import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  LAUNCH_LOG_HOME_RELATIVE_PATH,
  LAUNCH_LOG_PLUGIN_DIR,
  LAUNCH_LOG_PLUGIN_NAME,
  serializeLaunchLog,
} from '../launch-log.js';
import { copyStagedClaudeTreeIntoHome } from './copy-into-home.js';
import { resolveSandboxHome } from './home.js';
import { runSbx } from './run-sbx.js';

// Installs the launch-log mod (../launch-log-plugin) into the sandbox and
// hands it the log collected so far. Claude Code loads any folder under the
// in-container ~/.claude/skills that holds a .claude-plugin/plugin.json as a
// plugin in every session, so no env var or settings key has to reach the
// container. The mod finds the log at LAUNCH_LOG_HOME_RELATIVE_PATH below
// $HOME. Unlike the skills sync, the plugin carries no provenance marker, so a
// later sync never prunes it; it is replaced wholesale on every launch.
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

const SKILLS_RELATIVE_DIR = '.claude/skills';

export function installLaunchLogIntoSandbox(sandboxName: string): void {
  const home = resolveSandboxHome(sandboxName);
  const pluginRelative = `${SKILLS_RELATIVE_DIR}/${LAUNCH_LOG_PLUGIN_NAME}`;

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
      ownedTrees: [pluginRelative, dirname(LAUNCH_LOG_HOME_RELATIVE_PATH)],
      expectedFiles: [...LAUNCH_LOG_PLUGIN_FILES.map((f) => `${pluginRelative}/${f}`), LAUNCH_LOG_HOME_RELATIVE_PATH],
    });
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}
