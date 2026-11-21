import chalk from 'chalk';
import { claudeLocalSettingsPath, updateClaudeLocalSettings } from './claude-local-settings.js';

// Forces `sandbox.enabled` in the project's .claude/settings.local.json —
// true for the bwrap-based (safe-claude-code) path, where Claude Code's own
// sandbox is the only isolation in play; false for the sbx (Docker sandboxes)
// path, where running Claude Code's bwrap sandbox again inside the already-
// isolated container is redundant and can conflict (nested sandboxing).
export function ensureClaudeSandboxSetting(enabled: boolean, log: (msg: string) => void): void {
  const written = updateClaudeLocalSettings(log, (settings) => {
    const sandbox = (settings['sandbox'] ?? {}) as Record<string, unknown>;
    sandbox['enabled'] = enabled;
    settings['sandbox'] = sandbox;
  });
  if (written) {
    log(chalk.bold.green('OK:') + ` sandbox.enabled set to ${enabled} in ${claudeLocalSettingsPath()}`);
  }
}
