import chalk from 'chalk';
import { spawnSync } from 'node:child_process';

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

/**
 * Runs `claude update` and logs its output. A failed update only warns:
 * the installed Claude Code can still be launched.
 */
export function updateClaudeCode(
  log: (msg: string) => void,
  run: () => ClaudeUpdateResult = runClaudeUpdate,
): void {
  log('>> Running claude update');
  const result = run();
  if (result.output !== '') log(result.output);
  if (result.error !== undefined) {
    log(chalk.bold.yellow('WARNING:') + ` claude update could not run: ${result.error.message}`);
  } else if (result.status !== 0) {
    log(chalk.bold.yellow('WARNING:') + ` claude update exited with status ${result.status ?? 'unknown'}`);
  }
}
