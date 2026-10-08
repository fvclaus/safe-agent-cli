import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  LAUNCH_LOG_HOME_RELATIVE_PATH,
  LAUNCH_LOG_PLUGIN_DIR,
  LAUNCH_LOG_PLUGIN_NAME,
  serializeLaunchLog,
} from '../launch-log.js';
import { runSbx } from './copy-skills.js';
import { resolveSandboxHome } from './home.js';

// Installs the launch-log mod (../launch-log-plugin) into the sandbox and
// hands it the log collected so far. Claude Code loads any folder under the
// in-container ~/.claude/skills that holds a .claude-plugin/plugin.json as a
// plugin in every session, so no env var or settings key has to reach the
// container. The mod finds the log at LAUNCH_LOG_HOME_RELATIVE_PATH below
// $HOME. Unlike the skills sync, the plugin carries no provenance marker, so a
// later sync never prunes it; it is replaced wholesale on every launch.
//
// Same `sbx cp` contents-form and 0777 staging as copy-skills.ts, for the same
// reasons: the copy carries the staging dir's own owner/mode onto the existing
// destination, and the sandbox user must stay able to read, rewrite (the mod
// marks the log consumed) and `rm -rf` these paths.

export function installLaunchLogIntoSandbox(sandboxName: string): void {
  const home = resolveSandboxHome(sandboxName);
  const pluginDest = `${home}/.claude/skills/${LAUNCH_LOG_PLUGIN_NAME}`;
  const logDest = `${home}/${LAUNCH_LOG_HOME_RELATIVE_PATH}`;
  const logDir = dirname(logDest);

  runSbx(['exec', sandboxName, 'rm', '-rf', pluginDest], 'removing the previous launch-log mod');
  runSbx(['exec', sandboxName, 'mkdir', '-p', pluginDest, logDir], 'creating the launch-log mod directories');

  const tmpDir = mkdtempSync(join(tmpdir(), 'sbx-claude-code-launch-log-'));
  try {
    const stagedPlugin = join(tmpDir, 'plugin');
    const stagedLog = join(tmpDir, 'log');
    cpSync(LAUNCH_LOG_PLUGIN_DIR, stagedPlugin, { recursive: true, dereference: true });
    mkdirSync(stagedLog);
    writeFileSync(join(stagedLog, basename(logDest)), serializeLaunchLog(), 'utf8');
    const chmodRes = spawnSync('chmod', ['-R', '0777', tmpDir], { encoding: 'utf8' });
    if (chmodRes.error) throw chmodRes.error;
    if ((chmodRes.status ?? 1) !== 0) {
      throw new Error(`chmod of staging dir failed: ${chmodRes.stderr}`);
    }

    runSbx(['cp', `${stagedPlugin}/.`, `${sandboxName}:${pluginDest}`], 'copying the launch-log mod into sandbox');
    runSbx(['cp', `${stagedLog}/.`, `${sandboxName}:${logDir}`], 'copying the launch log into sandbox');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}
