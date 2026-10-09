import chalk from 'chalk';
import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import ajvFormats from 'ajv-formats';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { applySchemaOverlay } from './claude-settings-schema-overlay.js';

// Claude Code silently ignores a settings file it can't parse, and silently
// drops keys or values its schema doesn't accept — so a typo in a sandbox or
// permission rule just quietly disappears. Every launch path checks the
// user-authored settings files up front: syntax always, and shape against the
// schemastore schema unless --skip-settings-schema is passed. The schema is
// fetched live on every launch, so it tracks schemastore; a failed fetch is as
// fatal as a violation, since "strict" means "don't launch unvalidated".

export const CLAUDE_SETTINGS_SCHEMA_URL = 'https://json.schemastore.org/claude-code-settings.json';
const SCHEMA_FETCH_TIMEOUT_MS = 5000;

export const SKIP_SETTINGS_SCHEMA_FLAG = '--skip-settings-schema';

export type SchemaFetcher = () => Promise<unknown>;

export async function fetchClaudeSettingsSchema(): Promise<unknown> {
  const res = await fetch(CLAUDE_SETTINGS_SCHEMA_URL, { signal: AbortSignal.timeout(SCHEMA_FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return res.json();
}

/** The user, project and local settings.json files Claude Code merges at launch. */
export function claudeSettingsPaths(home = homedir(), project = process.cwd()): string[] {
  return [
    join(home, '.claude', 'settings.json'),
    join(project, '.claude', 'settings.json'),
    join(project, '.claude', 'settings.local.json'),
  ];
}

export interface ValidateOptions {
  skipSchema: boolean;
  fetchSchema?: SchemaFetcher;
}

export function compileSettingsValidator(schema: object): ValidateFunction {
  // strict: false — schemastore schemas use annotation keywords ajv's strict
  // mode rejects; allErrors so one launch reports every problem at once.
  const ajv = new Ajv({ strict: false, allErrors: true });
  // ajv-formats is CommonJS; under NodeNext the default import is the whole
  // module, whose `default` property is the plugin function.
  ajvFormats.default(ajv);
  return ajv.compile(schema);
}

function formatSchemaError(path: string, e: ErrorObject): string {
  const where = e.instancePath === '' ? '/' : e.instancePath;
  const detail = e.keyword === 'additionalProperties'
    ? `${e.message}: "${String(e.params['additionalProperty'])}"`
    : e.message ?? e.keyword;
  return `${path}: ${where} ${detail}`;
}

/**
 * Checks each existing file in `paths` (missing files are skipped) and
 * returns one message per problem; an empty array means everything passed.
 */
export async function validateClaudeSettingsFiles(paths: string[], options: ValidateOptions): Promise<string[]> {
  const errors: string[] = [];
  const parsed: Array<{ path: string; value: unknown }> = [];
  for (const path of paths) {
    if (!existsSync(path)) continue;
    try {
      parsed.push({ path, value: JSON.parse(readFileSync(path, 'utf8')) });
    } catch (e) {
      errors.push(`${path} contains invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (options.skipSchema || parsed.length === 0) return errors;

  let schema: unknown;
  try {
    schema = await (options.fetchSchema ?? fetchClaudeSettingsSchema)();
  } catch (e) {
    errors.push(
      `could not fetch the settings schema from ${CLAUDE_SETTINGS_SCHEMA_URL}: ` +
        `${e instanceof Error ? e.message : String(e)} (pass ${SKIP_SETTINGS_SCHEMA_FLAG} to launch without it)`,
    );
    return errors;
  }

  let validate: ValidateFunction;
  try {
    validate = compileSettingsValidator(applySchemaOverlay(schema));
  } catch (e) {
    errors.push(`${e instanceof Error ? e.message : String(e)} (pass ${SKIP_SETTINGS_SCHEMA_FLAG} to launch without it)`);
    return errors;
  }
  for (const { path, value } of parsed) {
    if (validate(value)) continue;
    for (const e of validate.errors ?? []) errors.push(formatSchemaError(path, e));
  }
  return errors;
}

export async function verifyClaudeSettingsOrExit(
  paths: string[],
  skipSchema: boolean,
  log: (msg: string) => void,
): Promise<void> {
  const errors = await validateClaudeSettingsFiles(paths, { skipSchema });
  if (errors.length === 0) {
    log(
      chalk.bold.green('OK:') +
        (skipSchema ? ` settings JSON syntax valid (schema check skipped via ${SKIP_SETTINGS_SCHEMA_FLAG})` : ' settings valid against schema'),
    );
    return;
  }
  for (const e of errors) log(chalk.bold.red('ERROR:') + ` ${e}`);
  log('Claude Code silently ignores malformed settings — fix them before launching.');
  if (!skipSchema) log(`To launch anyway, pass ${SKIP_SETTINGS_SCHEMA_FLAG} (syntax is still checked).`);
  process.exit(1);
}
