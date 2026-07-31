import chalk from 'chalk';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import type { AgentAdapter } from '../launcher/safe-agent-cli.js';
import { mergeReadPaths, safeChainReadPaths } from '../safe-chain.js';
import { loadUserSettings } from '../user-settings.js';

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
    // A previous launch may have leaked a bind-mount stub here as a *file* (or
    // symlink) rather than a directory. mkdirSync(recursive) is a no-op when the
    // target is already a directory, but throws EEXIST when it's a non-directory
    // — so clear that stub first before (re)creating the real directory.
    if (existsSync(dir) && !lstatSync(dir).isDirectory()) {
      rmSync(dir, { force: true });
    }
    mkdirSync(dir, { recursive: true });
    const gitkeep = join(dir, '.gitkeep');
    if (!existsSync(gitkeep)) writeFileSync(gitkeep, '', 'utf8');
  }
  log(chalk.bold.green('OK:') + ` ensured .claude/{${CLAUDE_MASKED_DIRS.join(',')}}/ exist with .gitkeep`);
}

// The sandbox leaves bind-mount stubs in the working tree on every launch (see
// ensureClaudeStubDirs for the .claude/ directory case). The file stubs below
// can't be pre-created as directories, so we keep them out of version control.
// Each launch ensures .gitignore carries these patterns; only genuinely missing
// lines are appended, under their group comment, so it's idempotent and never
// clobbers a user's existing entries.
const GITIGNORE_STUB_GROUPS = [
  {
    comment: '# Claude Code sandbox bind-mount stubs (created automatically on each launch)',
    patterns: [
      '.bash_profile', '.bashrc', '.gitconfig', '.gitmodules', '.idea',
      '.mcp.json', '.profile', '.ripgreprc', '.zprofile', '.zshrc',
    ],
  },
  {
    comment: [
      '# Same, under .claude/. The masked *directories* (agents, commands, hooks,',
      '# routines, skills, workflows) are pre-created with a tracked .gitkeep by',
      '# safe-claude-code so bwrap binds over them instead of leaking stubs — see',
      '# ensureClaudeStubDirs() in src/adapters/claude-code.ts. These two are files,',
      "# not directories, so they can't be .gitkeep'd; ignore their launch-time stubs.",
    ].join('\n'),
    patterns: ['.claude/launch.json', '.claude/scheduled_tasks.json'],
  },
];

function ensureGitignoreStubs(): void {
  const gitignorePath = join(process.cwd(), '.gitignore');
  const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
  const present = new Set(
    existing.split('\n').map(l => l.trim()).filter(l => l.length > 0 && !l.startsWith('#')),
  );

  const blocks: string[] = [];
  let added = 0;
  for (const group of GITIGNORE_STUB_GROUPS) {
    const missing = group.patterns.filter(p => !present.has(p));
    if (missing.length === 0) continue;
    blocks.push(`${group.comment}\n${missing.join('\n')}`);
    added += missing.length;
  }
  if (blocks.length === 0) return;

  const sep = existing.length === 0 ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
  writeFileSync(gitignorePath, existing + sep + blocks.join('\n\n') + '\n', 'utf8');
  log(chalk.bold.green('OK:') + ` added ${added} sandbox-stub pattern(s) to ${gitignorePath}`);
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

  const before = JSON.stringify(settings);
  settings['$schema'] = 'https://json.schemastore.org/claude-code-settings.json';
  const sandbox = (settings['sandbox'] ?? {}) as Record<string, unknown>;
  sandbox['enabled'] = true;
  settings['sandbox'] = sandbox;

  // Don't rewrite (and reformat) the file when the desired values are already
  // present — some projects require their settings formatted a specific way.
  if (JSON.stringify(settings) === before) return;

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

  const before = JSON.stringify(settings);
  settings['$schema'] = 'https://json.schemastore.org/claude-code-settings.json';
  const sandbox = (settings['sandbox'] ?? {}) as Record<string, unknown>;
  const filesystem = (sandbox['filesystem'] ?? {}) as Record<string, unknown>;
  filesystem['allowWrite'] = ['.'];
  filesystem['allowRead'] = ['.'];
  sandbox['filesystem'] = filesystem;
  settings['sandbox'] = sandbox;

  // Don't rewrite (and reformat) the file when the desired values are already
  // present — some projects require their settings formatted a specific way.
  if (JSON.stringify(settings) === before) return;

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

// rtk (https://github.com/rtk-ai/rtk) rewrites Bash calls through a PreToolUse
// hook to compress command output. When it's absent or half-installed, Claude
// runs fine but burns tokens all session with nothing to flag it — so users who
// opt in via the `checkRtk` user setting get a hard stop instead.
const RTK_HOOK_COMMAND = 'rtk hook claude';

/** True when Claude Code settings contain the PreToolUse hook `rtk init -g` installs. */
export function hasRtkHook(settings: unknown): boolean {
  if (typeof settings !== 'object' || settings === null) return false;
  const hooks = (settings as Record<string, unknown>)['hooks'];
  if (typeof hooks !== 'object' || hooks === null) return false;
  const preToolUse = (hooks as Record<string, unknown>)['PreToolUse'];
  if (!Array.isArray(preToolUse)) return false;
  return preToolUse.some(entry => {
    if (typeof entry !== 'object' || entry === null) return false;
    const inner = (entry as Record<string, unknown>)['hooks'];
    return Array.isArray(inner) && inner.some(h =>
      typeof h === 'object' && h !== null &&
      typeof (h as Record<string, unknown>)['command'] === 'string' &&
      ((h as Record<string, unknown>)['command'] as string).trim() === RTK_HOOK_COMMAND,
    );
  });
}

function verifyRtkInitialized(): void {
  const failures: string[] = [];

  const which = spawnSync('which', ['rtk'], { encoding: 'utf8' });
  if (which.status !== 0) {
    failures.push('the `rtk` binary is not on PATH');
  }

  // verifyClaudeSettingsJson ran before us, so if the file exists it parses.
  const settingsPath = join(homedir(), '.claude', 'settings.json');
  let hookInstalled = false;
  if (existsSync(settingsPath)) {
    try {
      hookInstalled = hasRtkHook(JSON.parse(readFileSync(settingsPath, 'utf8')));
    } catch { /* malformed — treated as hook missing */ }
  }
  if (!hookInstalled) {
    failures.push(`no PreToolUse hook "${RTK_HOOK_COMMAND}" in ${settingsPath}`);
  }

  const rtkMdPath = join(homedir(), '.claude', 'RTK.md');
  if (!existsSync(rtkMdPath)) {
    failures.push(`${rtkMdPath} does not exist`);
  }

  if (failures.length === 0) {
    log(chalk.bold.green('OK:') + ' rtk is initialized');
    return;
  }
  log(chalk.bold.red('ERROR:') + ' checkRtk is enabled but rtk is not properly initialized:');
  for (const f of failures) log(`  - ${f}`);
  log('Fix with: rtk init -g   (see https://github.com/rtk-ai/rtk)');
  process.exit(1);
}

export const claudeCodeAdapter: AgentAdapter = {
  programName: 'safe-claude-code',
  brief: 'Launch Claude Code with GCP service-account impersonation.',
  executable: 'claude',
  forwardedArgsTarget: 'claude',
  launchLabel: 'Claude Code',
  prepareLaunch: () => {
    verifyClaudeSettingsJson();
    if (loadUserSettings(log).checkRtk) verifyRtkInitialized();
    ensureClaudeStubDirs();
    ensureGitignoreStubs();
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
