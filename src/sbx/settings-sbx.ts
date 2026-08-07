import { existsSync, readFileSync } from 'node:fs';

// ~/.claude/settings-sbx.json is a user-authored file, distinct from both
// Claude Code's own .claude/settings*.json and safe-agent-cli's own
// ~/.config/safe-agent-cli/settings.json (see user-settings.ts). Every key it
// declares gets merged into the sandbox's in-container ~/.claude/settings.json
// (e.g. `hooks` for notification hooks pointed at a host-side relay, or `tui`
// to pin the terminal-UI-renderer preference) — see CLAUDE.md. safe-agent-cli
// never ships or assumes its content, only reads and forwards it verbatim;
// it doesn't need to know what any given key means.
//
// Unlike claudeFragmentsDir (an opt-in feature whose absence just skips it),
// this file is REQUIRED: sbx-claude-code has no useful default hook wiring of
// its own, so a missing or malformed file is a hard error rather than a
// silent no-op. `hooks` specifically must be present for the same reason;
// every other key is whatever the user chooses to declare.

export interface SettingsSbx {
  path: string;
  /** Every key declared in settings-sbx.json, merged verbatim into the sandbox's settings.json. */
  values: Record<string, unknown>;
}

export function loadSettingsSbx(path: string): SettingsSbx {
  if (!existsSync(path)) {
    throw new Error(
      `${path} does not exist.\n` +
      'sbx-claude-code requires a user-authored ~/.claude/settings-sbx.json declaring the `hooks` ' +
      'you want wired up inside the sandbox (e.g. notification hooks pointed at ' +
      'http://host.docker.internal:<port>/ via a host-side relay). This is deliberately not shipped ' +
      'by safe-agent-cli — see the design principle in CLAUDE.md.',
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`${path}: invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${path}: must be a JSON object`);
  }
  const obj = raw as Record<string, unknown>;
  if (!('hooks' in obj)) {
    throw new Error(`${path}: must declare a "hooks" key — nothing to merge otherwise`);
  }

  return { path, values: obj };
}
