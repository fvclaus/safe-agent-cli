import chalk from 'chalk';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import type { AgentAdapter } from '../launcher/safe-agent-cli.js';
import { mergeReadPaths, safeChainReadPaths } from '../safe-chain.js';

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

// Claude Code's sandbox masks these .claude/ subdirectories (they're on its
// denyWithinAllow list). When a path doesn't exist on disk, bwrap has to
// fabricate a throwaway mountpoint through the read-write bind of the project
// root — which surfaces to any concurrent process as a real 0-byte stub file
// (and, observed with a long-running background process, a spurious nested
// .claude/.claude/ tree). Pre-creating each as a real directory with a tracked
// .gitkeep gives bwrap an existing mountpoint to bind over, so it never writes
// stubs into the working tree. Idempotent.
const CLAUDE_MASKED_DIRS = ['agents', 'commands', 'hooks', 'routines', 'skills', 'workflows'];

function ensureClaudeStubDirs(): void {
  for (const name of CLAUDE_MASKED_DIRS) {
    const dir = join(process.cwd(), '.claude', name);
    mkdirSync(dir, { recursive: true });
    const gitkeep = join(dir, '.gitkeep');
    if (!existsSync(gitkeep)) writeFileSync(gitkeep, '', 'utf8');
  }
  log(chalk.bold.green('OK:') + ` ensured .claude/{${CLAUDE_MASKED_DIRS.join(',')}}/ exist with .gitkeep`);
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

// safe-chain's install dirs are absolute and user-specific (e.g.
// ~/.safe-chain, ~/.nvm/versions/node/<v>), so they belong in the user's global
// settings — not the committed project settings.json. Merge them into
// ~/.claude/settings.json so the sandbox can resolve the `safe-chain` binary and
// stop printing "safe-chain is not available to protect you from installing
// malware" on every npm/pip/python3 call. Idempotent: only writes when a path is
// genuinely missing, and never clobbers unrelated settings.
function ensureUserSafeChainReadAccess(): void {
  const safeChainPaths = safeChainReadPaths();
  if (safeChainPaths.length === 0) return;

  const home = homedir();
  const settingsPath = join(home, '.claude', 'settings.json');
  if (!existsSync(settingsPath)) {
    log(chalk.bold.yellow('WARNING:') + ` ${settingsPath} not found — skipping safe-chain sandbox read-access setup.`);
    return;
  }

  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
  } catch {
    log(chalk.bold.yellow('WARNING:') + ` Could not parse ${settingsPath} — skipping safe-chain sandbox read-access setup.`);
    return;
  }

  const sandbox = (settings['sandbox'] ?? {}) as Record<string, unknown>;
  const filesystem = (sandbox['filesystem'] ?? {}) as Record<string, unknown>;
  const allowRead = Array.isArray(filesystem['allowRead'])
    ? (filesystem['allowRead'] as string[])
    : [];

  const merged = mergeReadPaths(allowRead, safeChainPaths, home);
  if (merged === null) return; // already covered — nothing to do

  filesystem['allowRead'] = merged;
  sandbox['filesystem'] = filesystem;
  settings['sandbox'] = sandbox;
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  const added = merged.slice(allowRead.length);
  log(chalk.bold.green('OK:') + ` granted sandbox read access to safe-chain in ${settingsPath}: ${added.join(', ')}`);
}

export const claudeCodeAdapter: AgentAdapter = {
  programName: 'safe-claude-code',
  brief: 'Launch Claude Code with GCP service-account impersonation.',
  executable: 'claude',
  forwardedArgsTarget: 'claude',
  launchLabel: 'Claude Code',
  prepareLaunch: () => {
    verifyClaudeSettingsJson();
    ensureClaudeStubDirs();
    ensureClaudeSandboxEnabled();
    ensureProjectSettingsJson();
    ensureUserSafeChainReadAccess();
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
  // Put our bwrap shim (src/bin/bwrap) on PATH so it intercepts Claude Code's
  // sandbox calls; REAL_BWRAP points it at the genuine bwrap.
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
