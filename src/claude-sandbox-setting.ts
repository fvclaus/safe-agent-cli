import chalk from 'chalk';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Forces `sandbox.enabled` in the project's .claude/settings.local.json —
// true for the bwrap-based (safe-claude-code) path, where Claude Code's own
// sandbox is the only isolation in play; false for the sbx (Docker sandboxes)
// path, where running Claude Code's bwrap sandbox again inside the already-
// isolated container is redundant and can conflict (nested sandboxing).
export function ensureClaudeSandboxSetting(enabled: boolean, log: (msg: string) => void): void {
  const settingsPath = join(process.cwd(), '.claude', 'settings.local.json');
  let settings: Record<string, unknown> = {};

  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
    } catch {
      log(chalk.bold.yellow('WARNING:') + ` Could not parse ${settingsPath} — overwriting.`);
    }
  }

  const before = JSON.stringify(settings);
  settings['$schema'] = 'https://json.schemastore.org/claude-code-settings.json';
  const sandbox = (settings['sandbox'] ?? {}) as Record<string, unknown>;
  sandbox['enabled'] = enabled;
  settings['sandbox'] = sandbox;

  // Don't rewrite (and reformat) the file when the desired values are already
  // present — some projects require their settings formatted a specific way.
  if (JSON.stringify(settings) === before) return;

  mkdirSync(join(process.cwd(), '.claude'), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  log(chalk.bold.green('OK:') + ` sandbox.enabled set to ${enabled} in ${settingsPath}`);
}
