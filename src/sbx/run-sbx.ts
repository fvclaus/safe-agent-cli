import { spawnSync } from 'node:child_process';

export function runSbx(args: string[], what: string): void {
  const result = spawnSync('sbx', args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  if ((result.status ?? 1) !== 0) {
    throw new Error(`${what} failed: ${result.stderr || `exit code ${result.status}`}`);
  }
}
