import chalk from 'chalk';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Claude Code stores modelSettings.<model>.effortLevel in the user's global
// ~/.claude/settings.json, shared across every project — so an effort level
// picked for one project leaks into the next. This defaults each model that
// appears there to "medium" in the PROJECT's .claude/settings.local.json
// (same merge pattern as ensureClaudeSandboxSetting), but only once: a model
// already given an effortLevel in the project file, by a previous run or by
// hand, is left untouched.
export function ensureDefaultModelEffortLevels(
  log: (msg: string) => void,
  home: string = homedir(),
  cwd: string = process.cwd(),
): void {
  const globalSettingsPath = join(home, '.claude', 'settings.json');
  if (!existsSync(globalSettingsPath)) return;

  const globalSettings = JSON.parse(readFileSync(globalSettingsPath, 'utf8')) as Record<string, unknown>;
  const globalModelSettings = globalSettings['modelSettings'] as Record<string, unknown> | undefined;
  const models = globalModelSettings ? Object.keys(globalModelSettings) : [];
  if (models.length === 0) return;

  const settingsPath = join(cwd, '.claude', 'settings.local.json');
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
  const modelSettings = (settings['modelSettings'] ?? {}) as Record<string, unknown>;
  const added: string[] = [];
  for (const model of models) {
    const existing = (modelSettings[model] ?? {}) as Record<string, unknown>;
    if (existing['effortLevel'] !== undefined) continue;
    modelSettings[model] = { ...existing, effortLevel: 'medium' };
    added.push(model);
  }
  settings['modelSettings'] = modelSettings;

  // Don't rewrite (and reformat) the file when nothing changed — some
  // projects require their settings formatted a specific way.
  if (JSON.stringify(settings) === before) return;

  mkdirSync(join(cwd, '.claude'), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  log(chalk.bold.green('OK:') + ` defaulted effortLevel to "medium" for ${added.join(', ')} in ${settingsPath}`);
}
