import chalk from 'chalk';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// safe-agent-cli's own user settings, distinct from the .claude/settings*.json
// files owned by Claude Code. Optional file; every setting has a default.
//
// Parsing is deliberately strict: this tool's founding grievance is Claude Code
// silently ignoring malformed settings files, so ours hard-fails on bad JSON or
// wrong types, and warns on unrecognized keys (an opt-in boolean disabled by a
// typo would otherwise fail silently — the exact failure mode we exist to stop).

export interface UserSettings {
  /** Verify rtk (https://github.com/rtk-ai/rtk) is initialized before launching Claude. */
  checkRtk: boolean;
}

const DEFAULTS: UserSettings = { checkRtk: false };

// Keys tolerated without a warning but carrying no meaning for us.
const IGNORED_KEYS = new Set(['$schema']);

export function userSettingsPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const xdg = env['XDG_CONFIG_HOME']?.trim();
  return join(xdg || join(home, '.config'), 'safe-agent-cli', 'settings.json');
}

export interface ParsedUserSettings {
  settings: UserSettings;
  /** Non-fatal issues (e.g. unrecognized keys — possible typos). */
  warnings: string[];
  /** Fatal issues (malformed JSON, wrong types). Non-empty ⇒ settings are DEFAULTS. */
  errors: string[];
}

export function parseUserSettings(content: string): ParsedUserSettings {
  const warnings: string[] = [];
  const errors: string[] = [];

  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (e) {
    errors.push(`invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
    return { settings: DEFAULTS, warnings, errors };
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    errors.push('must be a JSON object');
    return { settings: DEFAULTS, warnings, errors };
  }

  const obj = raw as Record<string, unknown>;
  const settings: UserSettings = { ...DEFAULTS };

  for (const [key, value] of Object.entries(obj)) {
    if (key === 'checkRtk') {
      if (typeof value !== 'boolean') {
        errors.push(`"checkRtk" must be a boolean, got ${JSON.stringify(value)}`);
        continue;
      }
      settings.checkRtk = value;
    } else if (!IGNORED_KEYS.has(key)) {
      warnings.push(`unrecognized key "${key}" — check for typos (known keys: checkRtk)`);
    }
  }

  if (errors.length > 0) return { settings: DEFAULTS, warnings, errors };
  return { settings, warnings, errors };
}

/**
 * Load the user settings file, or defaults when it doesn't exist. Warnings are
 * logged; any error aborts the launch — a broken settings file must never
 * silently degrade into "setting off".
 */
export function loadUserSettings(
  log: (msg: string) => void,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): UserSettings {
  const path = userSettingsPath(env, home);
  if (!existsSync(path)) return { ...DEFAULTS };

  const { settings, warnings, errors } = parseUserSettings(readFileSync(path, 'utf8'));
  for (const w of warnings) {
    log(chalk.bold.yellow('WARNING:') + ` ${path}: ${w}`);
  }
  if (errors.length > 0) {
    for (const e of errors) {
      log(chalk.bold.red('ERROR:') + ` ${path}: ${e}`);
    }
    log('Fix the settings file before launching.');
    process.exit(1);
  }
  return settings;
}
