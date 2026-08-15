import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isAncestor } from './safe-chain.js';

// rtk (https://github.com/rtk-ai/rtk) rewrites Bash calls through a PreToolUse
// hook to compress command output. When it's absent or half-installed, Claude
// runs fine but burns tokens all session with nothing to flag it — so users
// who opt in via the `checkRtk` user setting get the checks below instead.
// This module only computes what's wrong; callers (see claude-code.ts) decide
// how to report it and whether to abort the launch.

const RTK_HOOK_COMMAND = 'rtk hook claude';

/** True when Claude Code settings contain the PreToolUse hook `rtk init -g` installs. */
export function hasRtkHook(settings: unknown): boolean {
  if (typeof settings !== 'object' || settings === null) return false;
  const hooks = (settings as Record<string, unknown>)['hooks'];
  if (typeof hooks !== 'object' || hooks === null) return false;
  const preToolUse = (hooks as Record<string, unknown>)['PreToolUse'];
  if (!Array.isArray(preToolUse)) return false;
  return preToolUse.some(entry => {
    if (typeof entry !== 'object' || entry === null) return false;
    const inner = (entry as Record<string, unknown>)['hooks'];
    return Array.isArray(inner) && inner.some(h =>
      typeof h === 'object' && h !== null &&
      typeof (h as Record<string, unknown>)['command'] === 'string' &&
      ((h as Record<string, unknown>)['command'] as string).trim() === RTK_HOOK_COMMAND,
    );
  });
}

/**
 * Everything wrong with the local rtk install, from the `checkRtk` user
 * setting's point of view. Empty array means rtk is fully initialized.
 *
 * RTK.md's existence is deliberately not checked here: when claudeFragmentsDir
 * is also set, generateClaudeLocalMd reads and appends it itself, and fails
 * the launch just as hard if it's missing. (If claudeFragmentsDir is NOT set,
 * that fallback doesn't run — RTK.md's presence goes unchecked in that case,
 * same as its content going unincluded without the old hand-maintained
 * `@RTK.md` import in CLAUDE.md.)
 */
export function rtkInitializationFailures(home: string = homedir()): string[] {
  const failures: string[] = [];

  const which = spawnSync('which', ['rtk'], { encoding: 'utf8' });
  if (which.status !== 0) {
    failures.push('the `rtk` binary is not on PATH');
  }

  const settingsPath = join(home, '.claude', 'settings.json');
  let hookInstalled = false;
  if (existsSync(settingsPath)) {
    try {
      hookInstalled = hasRtkHook(JSON.parse(readFileSync(settingsPath, 'utf8')));
    } catch { /* malformed — treated as hook missing */ }
  }
  if (!hookInstalled) {
    failures.push(`no PreToolUse hook "${RTK_HOOK_COMMAND}" in ${settingsPath}`);
  }

  return failures;
}

// rtk stores its history DB, config, and cache under these XDG-style dirs.
// Inside the bwrap sandbox, write access is only granted for paths listed in
// sandbox.filesystem.allowWrite — without an entry here rtk's own writes
// silently fail inside the sandbox.
export const RTK_REQUIRED_WRITE_PATHS = ['~/.local/share/rtk', '~/.cache/rtk', '~/.config/rtk'];

/**
 * Which of RTK_REQUIRED_WRITE_PATHS are covered by neither an exact entry nor
 * an ancestor directory in ~/.claude/settings.json's
 * sandbox.filesystem.allowWrite. Empty array means fully covered.
 */
export function missingRtkWritePaths(home: string = homedir()): string[] {
  const settingsPath = join(home, '.claude', 'settings.json');

  let allowWrite: string[] = [];
  if (existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
      const filesystem = ((settings['sandbox'] as Record<string, unknown> | undefined)
        ?.['filesystem'] ?? {}) as Record<string, unknown>;
      if (Array.isArray(filesystem['allowWrite'])) {
        allowWrite = filesystem['allowWrite'] as string[];
      }
    } catch { /* malformed — verifyClaudeSettingsJson already reported it */ }
  }

  const expand = (p: string): string => (p.startsWith('~/') ? join(home, p.slice(2)) : p);
  const isCovered = (target: string): boolean =>
    allowWrite.some(entry => {
      const e = expand(entry).replace(/[/\\]+$/, '');
      return e === target || isAncestor(e, target);
    });

  return RTK_REQUIRED_WRITE_PATHS.filter(p => !isCovered(expand(p)));
}
