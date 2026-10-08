import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

// Every status line the launcher prints before Claude Code starts goes through
// `log`: it still writes to stderr (so a failed launch is readable in the
// terminal), and keeps a copy that the launch-log mod (./launch-log-plugin)
// shows inside the session. Claude Code's fullscreen renderer uses the
// alternate screen, which hides everything printed before it started.

/** Env var carrying the log file's path to the mod on the bwrap path. */
export const LAUNCH_LOG_ENV = 'SAFE_AGENT_CLI_LAUNCH_LOG';

/** The mod's plugin directory, shipped in this repo. */
export const LAUNCH_LOG_PLUGIN_DIR = fileURLToPath(new URL('./launch-log-plugin', import.meta.url));

/** Directory name of the mod once copied into a sandbox's ~/.claude/skills. */
export const LAUNCH_LOG_PLUGIN_NAME = 'safe-agent-cli-launch-log';

/** The mod's fallback log location, relative to $HOME, when the env var is not set (sbx). */
export const LAUNCH_LOG_HOME_RELATIVE_PATH = '.claude/safe-agent-cli/launch-log.json';

export type LaunchLogLevel = 'ok' | 'info' | 'warning' | 'error' | 'skip' | 'progress';

export interface LaunchLogEntry {
  level: LaunchLogLevel;
  text: string;
}

/** The file the mod reads; the mod rewrites it with `consumed: true` once shown. */
export interface LaunchLogFile {
  version: 1;
  consumed: boolean;
  entries: LaunchLogEntry[];
}

const PREFIX_LEVELS: ReadonlyArray<readonly [string, LaunchLogLevel]> = [
  ['OK:', 'ok'],
  ['WARNING:', 'warning'],
  ['ERROR:', 'error'],
  ['INFO:', 'info'],
  ['SKIP:', 'skip'],
  ['>>', 'progress'],
];

/** The level a log line announces through its leading `OK:` / `WARNING:` / ... prefix; unprefixed lines are `info`. */
export function levelOfLine(line: string): LaunchLogLevel {
  const text = stripVTControlCharacters(line).trimStart();
  for (const [prefix, level] of PREFIX_LEVELS) {
    if (text.startsWith(prefix)) return level;
  }
  return 'info';
}

/** One entry per non-blank line, colors stripped. */
export function entriesFromMessage(msg: string): LaunchLogEntry[] {
  return msg
    .split('\n')
    .map((line) => stripVTControlCharacters(line).trimEnd())
    .filter((text) => text.trim() !== '')
    .map((text) => ({ level: levelOfLine(text), text }));
}

const entries: LaunchLogEntry[] = [];

export function log(msg: string): void {
  process.stderr.write(msg + '\n');
  entries.push(...entriesFromMessage(msg));
}

export function launchLogEntries(): readonly LaunchLogEntry[] {
  return entries;
}

export function resetLaunchLog(): void {
  entries.length = 0;
}

export function serializeLaunchLog(source: readonly LaunchLogEntry[] = entries): string {
  const file: LaunchLogFile = { version: 1, consumed: false, entries: [...source] };
  return JSON.stringify(file) + '\n';
}

/** Writes the log collected so far to `path`, creating its directory. */
export function writeLaunchLogFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeLaunchLog(), 'utf8');
}
