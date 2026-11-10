import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// safe-agent-cli's machine-local state, one file per machine and user. It sits
// next to settings.json, but unlike settings.json it is never synced between
// machines: everything in it (when Claude Code was last updated here, which
// symlinks were approved for which sandbox) is true only for this machine.
//
// Each feature owns one top-level key. Writes re-read the file and replace
// only their own key, so keys of other features — including ones this version
// doesn't know — survive.
//
// Unlike settings.json, a malformed state file is not worth stopping a
// launch for: it's moved aside to state.json.bak and replaced.

export type LocalState = Record<string, unknown>;

export function localStatePath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const xdg = env['XDG_CONFIG_HOME']?.trim();
  return join(xdg || join(home, '.config'), 'safe-agent-cli', 'state.json');
}

export interface LoadedLocalState {
  state: LocalState;
  /** Set when a malformed file was moved aside to `<path>.bak`. */
  warning?: string;
}

export function loadLocalState(path: string): LoadedLocalState {
  if (!existsSync(path)) return { state: {} };
  const content = readFileSync(path, 'utf8');
  let problem: string;
  try {
    const raw: unknown = JSON.parse(content);
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
      return { state: raw as LocalState };
    }
    problem = 'not a JSON object';
  } catch (e) {
    problem = `invalid JSON: ${e instanceof Error ? e.message : String(e)}`;
  }
  const backup = `${path}.bak`;
  renameSync(path, backup);
  return {
    state: {},
    warning: `${path} was malformed (${problem}); moved it to ${backup} and started with an empty state`,
  };
}

/**
 * Sets one top-level key, keeping every other key in the file. Returns the
 * warning from loading the file, if it had to be moved aside.
 */
export function writeLocalStateKey(path: string, key: string, value: unknown): string | undefined {
  const { state, warning } = loadLocalState(path);
  state[key] = value;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2) + '\n', 'utf8');
  return warning;
}
