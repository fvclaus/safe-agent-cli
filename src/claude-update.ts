import chalk from 'chalk';
import { spawnSync } from 'node:child_process';
import { loadLocalState, localStatePath, writeLocalStateKey } from './local-state.js';

export const SKIP_UPDATE_FLAG = '--skip-update';

/** Local state key holding the time of the last successful `claude update` on this machine. */
export const LAST_CLAUDE_UPDATE_KEY = 'lastClaudeUpdate';

export interface ClaudeUpdateResult {
  status: number | null;
  output: string;
  error?: Error;
}

export function runClaudeUpdate(): ClaudeUpdateResult {
  const result = spawnSync('claude', ['update'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return {
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim(),
    ...(result.error !== undefined ? { error: result.error } : {}),
  };
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function localDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** ISO 8601 in local time with the UTC offset, e.g. `2026-11-10T14:03:00+01:00`. */
export function localIsoTimestamp(date: Date): string {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return `${localDate(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** Whether `lastUpdate` (as stored in the local state) falls on the same local calendar day as `now`. */
export function updatedToday(lastUpdate: unknown, now: Date): boolean {
  if (typeof lastUpdate !== 'string') return false;
  const last = new Date(lastUpdate);
  if (Number.isNaN(last.getTime())) return false;
  return localDate(last) === localDate(now);
}

export interface UpdateClaudeCodeOptions {
  /** Set by `--skip-update`. */
  skip?: boolean;
  statePath?: string;
  now?: () => Date;
  run?: () => ClaudeUpdateResult;
}

function warn(log: (msg: string) => void, msg: string): void {
  log(chalk.bold.yellow('WARNING:') + ` ${msg}`);
}

/**
 * Runs `claude update` at most once per local calendar day and logs its
 * output. Only a successful update is recorded, so a failed one is retried on
 * the next launch. A failed update only warns: the installed Claude Code can
 * still be launched.
 */
export function updateClaudeCode(log: (msg: string) => void, options: UpdateClaudeCodeOptions = {}): void {
  if (options.skip) {
    log(chalk.bold.yellow('SKIP:') + ` claude update (${SKIP_UPDATE_FLAG})`);
    return;
  }
  const statePath = options.statePath ?? localStatePath();
  const now = options.now ?? (() => new Date());

  try {
    const { state, warning } = loadLocalState(statePath);
    if (warning !== undefined) warn(log, warning);
    if (updatedToday(state[LAST_CLAUDE_UPDATE_KEY], now())) {
      log(chalk.bold.yellow('SKIP:') + ' claude update (already ran today)');
      return;
    }
  } catch (e) {
    warn(log, `could not read ${statePath}: ${e instanceof Error ? e.message : String(e)}`);
  }

  log('>> Running claude update');
  const result = (options.run ?? runClaudeUpdate)();
  if (result.output !== '') log(result.output);
  if (result.error !== undefined) {
    warn(log, `claude update could not run: ${result.error.message}`);
    return;
  }
  if (result.status !== 0) {
    warn(log, `claude update exited with status ${result.status ?? 'unknown'}`);
    return;
  }
  try {
    const warning = writeLocalStateKey(statePath, LAST_CLAUDE_UPDATE_KEY, localIsoTimestamp(now()));
    if (warning !== undefined) warn(log, warning);
  } catch (e) {
    warn(log, `could not record the update in ${statePath}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
