import chalk from 'chalk';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function claudeLocalSettingsPath(cwd: string = process.cwd()): string {
  return join(cwd, '.claude', 'settings.local.json');
}

// Applies `mutate` to the project's (host-side) .claude/settings.local.json,
// keeping every key it does not touch, and makes sure the file names its
// schema. Returns whether the file was written: when the result equals what is
// already on disk the file is left alone, not rewritten (and reformatted) —
// some projects require their settings formatted a specific way. A file that
// cannot be parsed aborts the launch.
export function updateClaudeLocalSettings(
  log: (msg: string) => void,
  mutate: (settings: Record<string, unknown>) => void,
  cwd: string = process.cwd(),
): boolean {
  const settingsPath = claudeLocalSettingsPath(cwd);
  let settings: Record<string, unknown> = {};

  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
    } catch (e) {
      log(chalk.bold.red('ERROR:') + ` Could not parse ${settingsPath}: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
  }

  const before = JSON.stringify(settings);
  settings['$schema'] = 'https://json.schemastore.org/claude-code-settings.json';
  mutate(settings);
  if (JSON.stringify(settings) === before) return false;

  mkdirSync(join(cwd, '.claude'), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  return true;
}
