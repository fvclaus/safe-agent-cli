import chalk from 'chalk';
import { claudeLocalSettingsPath, updateClaudeLocalSettings } from './claude-local-settings.js';

// Claude Code saves a `/model` pick as `model` in the user's global
// ~/.claude/settings.json, shared across every project — so a model picked in
// one project becomes the starting model of the next. This writes the user's
// `defaultClaudeModel` (safe-agent-cli's own settings) as `model` into the
// PROJECT's .claude/settings.local.json, which takes precedence over the
// global file, but only once: a `model` already in the project file, from a
// previous run or set by hand, is left untouched. Without a
// `defaultClaudeModel` nothing is written.
export function ensureDefaultModel(
  defaultModel: string | undefined,
  log: (msg: string) => void,
  cwd: string = process.cwd(),
): void {
  if (defaultModel === undefined) return;

  let seeded = false;
  updateClaudeLocalSettings(log, (settings) => {
    if (settings['model'] !== undefined) return;
    settings['model'] = defaultModel;
    seeded = true;
  }, cwd);

  if (seeded) {
    log(chalk.bold.green('OK:') + ` defaulted model to "${defaultModel}" in ${claudeLocalSettingsPath(cwd)}`);
  }
}
