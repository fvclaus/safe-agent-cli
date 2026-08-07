import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSandboxHome } from './home.js';
import type { SettingsSbx } from './settings-sbx.js';

// The sandbox's in-container ~/.claude/settings.json already carries real
// state Claude Code itself writes on first run (theme, bypassPermissions
// mode, etc.) — confirmed by inspecting a live sandbox. `sbx cp` (the only
// way to move a file in/out of the sandbox) overwrites its destination
// outright, like `docker cp`, so this pulls the existing file out, overlays
// every key settings-sbx.json declares, and pushes the result back — every
// key settings-sbx.json doesn't mention (e.g. theme, or `tui` if the user
// never set it there) survives untouched.

export function mergeSettingsSbxIntoSandbox(sandboxName: string, settingsSbx: SettingsSbx): void {
  const home = resolveSandboxHome(sandboxName);
  const remotePath = `${sandboxName}:${home}/.claude/settings.json`;

  const tmpDir = mkdtempSync(join(tmpdir(), 'sbx-claude-code-'));
  const localPath = join(tmpDir, 'settings.json');
  try {
    // A brand-new sandbox that's never run Claude yet has no settings.json —
    // that's not an error, just an empty starting point.
    const pull = spawnSync('sbx', ['cp', remotePath, localPath], { encoding: 'utf8' });

    let existing: Record<string, unknown> = {};
    if (pull.status === 0 && existsSync(localPath)) {
      try {
        existing = JSON.parse(readFileSync(localPath, 'utf8')) as Record<string, unknown>;
      } catch (e) {
        throw new Error(
          `sandbox '${sandboxName}'s existing ${home}/.claude/settings.json is not valid JSON: ` +
          `${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    const merged = { ...existing, ...settingsSbx.values };
    writeFileSync(localPath, JSON.stringify(merged, null, 2) + '\n', 'utf8');

    const push = spawnSync('sbx', ['cp', localPath, remotePath], { encoding: 'utf8' });
    if (push.error) throw push.error;
    if ((push.status ?? 1) !== 0) {
      throw new Error(`sbx cp into ${remotePath} failed: ${push.stderr}`);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}
