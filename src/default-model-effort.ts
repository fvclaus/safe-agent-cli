import chalk from 'chalk';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { claudeLocalSettingsPath, updateClaudeLocalSettings } from './claude-local-settings.js';

// Claude Code stores modelSettings.<model>.effortLevel in the user's global
// ~/.claude/settings.json, shared across every project — so an effort level
// picked for one project leaks into the next. This defaults each model that
// appears there to "medium" in the PROJECT's .claude/settings.local.json, but
// only once: a model already given an effortLevel in the project file, by a
// previous run or by hand, is left untouched.
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

  const added: string[] = [];
  updateClaudeLocalSettings(log, (settings) => {
    const modelSettings = (settings['modelSettings'] ?? {}) as Record<string, unknown>;
    for (const model of models) {
      const existing = (modelSettings[model] ?? {}) as Record<string, unknown>;
      if (existing['effortLevel'] !== undefined) continue;
      modelSettings[model] = { ...existing, effortLevel: 'medium' };
      added.push(model);
    }
    settings['modelSettings'] = modelSettings;
  }, cwd);

  if (added.length > 0) {
    log(
      chalk.bold.green('OK:') +
        ` defaulted effortLevel to "medium" for ${added.join(', ')} in ${claudeLocalSettingsPath(cwd)}`,
    );
  }
}
