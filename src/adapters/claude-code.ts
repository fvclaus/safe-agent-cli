import chalk from 'chalk';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import type { AgentAdapter } from '../launcher/safe-agent-cli.js';

const log = (msg: string) => process.stderr.write(msg + '\n');

function verifyClaudeSettingsJson(): void {
  const paths = [
    join(homedir(), '.claude', 'settings.json'),
    join(process.cwd(), '.claude', 'settings.json'),
    join(process.cwd(), '.claude', 'settings.local.json'),
  ];

  let hasError = false;
  for (const p of paths) {
    if (!existsSync(p)) continue;
    try {
      JSON.parse(readFileSync(p, 'utf8'));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(chalk.bold.red('ERROR:') + ` ${p} contains invalid JSON: ${msg}`);
      log('Claude Code silently ignores malformed settings files — fix it before launching.');
      hasError = true;
    }
  }
  if (hasError) process.exit(1);
}

function ensureClaudeSandboxEnabled(): void {
  const settingsPath = join(process.cwd(), '.claude', 'settings.local.json');
  let settings: Record<string, unknown> = {};

  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
    } catch {
      log(chalk.bold.yellow('WARNING:') + ` Could not parse ${settingsPath} — overwriting.`);
    }
  }

  settings['$schema'] = 'https://json.schemastore.org/claude-code-settings.json';
  const sandbox = (settings['sandbox'] ?? {}) as Record<string, unknown>;
  sandbox['enabled'] = true;
  settings['sandbox'] = sandbox;

  mkdirSync(join(process.cwd(), '.claude'), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  log(chalk.bold.green('OK:') + ` sandbox.enabled set to true in ${settingsPath}`);
}

function ensureProjectSettingsJson(): void {
  const settingsPath = join(process.cwd(), '.claude', 'settings.json');
  let settings: Record<string, unknown> = {};

  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
    } catch {
      log(chalk.bold.yellow('WARNING:') + ` Could not parse ${settingsPath} — overwriting.`);
    }
  }

  settings['$schema'] = 'https://json.schemastore.org/claude-code-settings.json';
  const sandbox = (settings['sandbox'] ?? {}) as Record<string, unknown>;
  const filesystem = (sandbox['filesystem'] ?? {}) as Record<string, unknown>;
  filesystem['allowWrite'] = ['.'];
  filesystem['allowRead'] = ['.'];
  sandbox['filesystem'] = filesystem;
  settings['sandbox'] = sandbox;

  mkdirSync(join(process.cwd(), '.claude'), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  log(chalk.bold.green('OK:') + ` sandbox.filesystem set in ${settingsPath}`);
}

export const claudeCodeAdapter: AgentAdapter = {
  programName: 'safe-claude-code',
  brief: 'Launch Claude Code with GCP service-account impersonation.',
  executable: 'claude',
  forwardedArgsTarget: 'claude',
  launchLabel: 'Claude Code',
  prepareLaunch: () => {
    verifyClaudeSettingsJson();
    ensureClaudeSandboxEnabled();
    ensureProjectSettingsJson();
  },
  buildLaunchArgs: (context) => [
    ...context.writableDirs.flatMap(d => ['--add-dir', d]),
    ...(Object.keys(context.credentialEnv).length > 0
      ? ['--settings', JSON.stringify({ env: context.credentialEnv })]
      : []),
    ...(context.systemInstructionText
      ? ['--append-system-prompt', context.systemInstructionText]
      : []),
    ...context.args.rest,
  ],
  buildSpawnEnv: () => {
    const realBwrap = spawnSync('which', ['bwrap'], { encoding: 'utf8' }).stdout.trim() || '/usr/bin/bwrap';
    const srcDir = fileURLToPath(new URL('../', import.meta.url));
    const binDir = join(srcDir, 'bin');
    chmodSync(join(binDir, 'bwrap'), 0o755);

    return {
      PATH: `${binDir}:${process.env['PATH'] ?? ''}`,
      REAL_BWRAP: realBwrap,
    };
  },
};
