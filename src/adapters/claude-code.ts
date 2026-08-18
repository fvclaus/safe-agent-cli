import chalk from 'chalk';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { AgentAdapter } from '../launcher/safe-agent-cli.js';
import { mergeReadPaths, safeChainReadPaths } from '../safe-chain.js';
import { loadUserSettings } from '../user-settings.js';
import { expandHome, generateClaudeLocalMd } from '../claude-fragments.js';
import { missingRtkWritePaths, rtkInitializationFailures } from '../rtk.js';
import { resolveRealBwrap } from '../real-bwrap.js';

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
// runs fine but burns tokens all session with nothing to flag it — so users
// who opt in via the `checkRtk` user setting get a hard stop instead. See
// ../rtk.ts for the checks themselves; this just reports their results.
function verifyRtkInitialized(): void {
  const failures = rtkInitializationFailures();
  if (failures.length === 0) {
    log(chalk.bold.green('OK:') + ' rtk is initialized');
    return;
  }
  log(chalk.bold.red('ERROR:') + ' checkRtk is enabled but rtk is not properly initialized:');
  for (const f of failures) log(`  - ${f}`);
  log('Fix with: rtk init -g   (see https://github.com/rtk-ai/rtk)');
  process.exit(1);
}

// Non-fatal: unlike verifyRtkInitialized, this never blocks the launch, only
// warns, since rtk still mostly works (compression happens client-side)
// without its own storage.
function warnIfRtkWriteAccessMissing(): void {
  const missing = missingRtkWritePaths();
  if (missing.length === 0) return;

  const settingsPath = join(homedir(), '.claude', 'settings.json');
  log(
    chalk.bold.yellow('WARNING:') +
      ` checkRtk is enabled but ${settingsPath} is missing sandbox write access for: ${missing.join(', ')}`,
  );
  log(`  Add to sandbox.filesystem.allowWrite: ${JSON.stringify(missing)}`);
}

// A global ~/.claude/CLAUDE.md is easy to forget about once you've moved to
// fragment-generated CLAUDE.local.md — its content isn't part of any
// fragment and won't show up there. Non-fatal: existing is a plausible
// deliberate choice (e.g. content that doesn't fit the fragment model), not
// an error, so this only warns rather than aborting.
function warnIfGlobalClaudeMdExists(): void {
  const path = join(homedir(), '.claude', 'CLAUDE.md');
  if (existsSync(path)) {
    log(
      chalk.bold.yellow('WARNING:') +
        ` ${path} exists — its content is separate from the fragments in claudeFragmentsDir and won't appear in the generated CLAUDE.local.md.`,
    );
  }
}

interface SandboxSettingsFile {
  sandbox?: {
    credentials?: { envVars?: Array<{ name?: string; mode?: string }> };
    excludedCommands?: string[];
  };
}

// Same 3 files, same union-across-all approach as the bwrap shim's allowWrite/denyWrite
// merge (src/bin/bwrap) — this matches Claude Code's actual settings merge model.
// verifyClaudeSettingsJson already validated these files' JSON earlier in prepareLaunch,
// so parse failures here are unexpected; skip the file defensively rather than crash the
// launcher over it.
function readSandboxSettingsFiles(): SandboxSettingsFile[] {
  const paths = [
    join(homedir(), '.claude', 'settings.json'),
    join(process.cwd(), '.claude', 'settings.json'),
    join(process.cwd(), '.claude', 'settings.local.json'),
  ];
  const files: SandboxSettingsFile[] = [];
  for (const p of paths) {
    if (!existsSync(p)) continue;
    try {
      files.push(JSON.parse(readFileSync(p, 'utf8')) as SandboxSettingsFile);
    } catch {
      continue;
    }
  }
  return files;
}

// Claude Code's own sandbox can mask GITHUB_TOKEN (sandbox.credentials.envVars,
// mode: "mask"), independent of anything this repo controls — see git-sandboxed's own
// runtime prefix check for the matching runtime-side signal. Reading the declared
// config here lets the launcher fail fast, before the agent starts, instead of every
// git-sandboxed push silently failing to authenticate later.
function isGithubTokenMasked(): boolean {
  return readSandboxSettingsFiles().some(f =>
    (f.sandbox?.credentials?.envVars ?? []).some(v => v.name === 'GITHUB_TOKEN' && v.mode === 'mask'),
  );
}

// A bare 'git *' entry is confirmed unreliable — Claude Code's excludedCommands
// matcher treats the literal token `git` specially/racily, so the same 'git *' entry
// sometimes runs the command sandboxed anyway (see git-push-sandbox-debugging-transcript.md).
// Only an absolute-path git exclusion (e.g. '/usr/bin/git *' on Linux,
// '/opt/homebrew/bin/git *' on macOS) was reliable in testing. The exact path is
// machine-specific, so match the shape rather than one literal string.
const ABSOLUTE_GIT_EXCLUDED_COMMAND_RE = /^\S+\/git \*$/;

function hasGitExcludedCommand(): boolean {
  return readSandboxSettingsFiles().some(f =>
    (f.sandbox?.excludedCommands ?? []).some(c => ABSOLUTE_GIT_EXCLUDED_COMMAND_RE.test(c)),
  );
}

// git-sandboxed is always bind-mounted onto PATH when --gh is enabled (see
// src/bin/bwrap), independent of claudeFragmentsDir — but its usage
// instructions only reach the agent via the built-in fragment merged into
// CLAUDE.local.md, which requires claudeFragmentsDir to be configured at all.
// Without it the tool is present but undiscoverable, so warn the human.
function warnIfGithubEnabledWithoutFragments(): void {
  log(
    chalk.bold.yellow('WARNING:') +
      ' --gh is enabled but claudeFragmentsDir is not configured — the agent has no way to learn ' +
      'about git-sandboxed (a git wrapper that authenticates with GITHUB_TOKEN). Configure ' +
      'claudeFragmentsDir in ~/.config/safe-agent-cli/settings.json to surface its usage instructions.',
  );
}

// claudeFragmentsDir's mere presence is the on/off switch for generating
// CLAUDE.local.md (see user-settings.ts) — no separate boolean. Any failure
// (missing dir, malformed fragment, non-GitHub remote) aborts the launch,
// same as verifyRtkInitialized: this feature never silently degrades.
function generateClaudeLocalMdOrExit(
  fragmentsDir: string,
  checkRtk: boolean,
  github: boolean,
  githubMasked = false,
): void {
  const dir = expandHome(fragmentsDir, homedir());
  const rtkMdPath = checkRtk ? join(homedir(), '.claude', 'RTK.md') : undefined;
  try {
    const result = generateClaudeLocalMd(dir, process.cwd(), 'proxy', github, githubMasked, rtkMdPath);
    log(
      chalk.bold.green('OK:') +
        ` generated CLAUDE.local.md from ${result.matchedCount}/${result.totalCount} fragment(s) in ${dir}` +
        (result.rtkAppended ? ' (+ RTK.md)' : ''),
    );
  } catch (e) {
    log(chalk.bold.red('ERROR:') + ` failed to generate CLAUDE.local.md: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

export const claudeCodeAdapter: AgentAdapter = {
  programName: 'safe-claude-code',
  brief: 'Launch Claude Code with GCP service-account impersonation.',
  executable: 'claude',
  forwardedArgsTarget: 'claude',
  launchLabel: 'Claude Code',
  prepareLaunch: (context) => {
    verifyClaudeSettingsJson();
    const settings = loadUserSettings(log);
    if (settings.checkRtk) {
      verifyRtkInitialized();
      warnIfRtkWriteAccessMissing();
    }
    warnIfGlobalClaudeMdExists();
    if (context.githubToken !== undefined) {
      const githubTokenMasked = isGithubTokenMasked();
      if (githubTokenMasked && !hasGitExcludedCommand()) {
        log(
          chalk.bold.red('ERROR:') +
            ' GITHUB_TOKEN is masked in this sandbox (sandbox.credentials.envVars), and no absolute-path ' +
            "git exclusion (e.g. '/usr/bin/git *') is in excludedCommands — the agent would have no " +
            "working fallback for push, fetch, clone, or pull. A bare 'git *' entry is not enough — " +
            "Claude Code's excludedCommands matcher treats the literal token `git` unreliably, so that " +
            'entry sometimes runs the command sandboxed anyway. Add an absolute-path git exclusion (find ' +
            'yours with `command -v git`) to excludedCommands in one of your settings.json files, or ' +
            'remove the GITHUB_TOKEN mask entry.',
        );
        process.exit(1);
      }
      if (settings.claudeFragmentsDir) {
        generateClaudeLocalMdOrExit(settings.claudeFragmentsDir, settings.checkRtk, true, githubTokenMasked);
      } else {
        warnIfGithubEnabledWithoutFragments();
      }
    } else if (settings.claudeFragmentsDir) {
      generateClaudeLocalMdOrExit(settings.claudeFragmentsDir, settings.checkRtk, false);
    }
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
  // sandbox calls; REAL_BWRAP points it at the genuine bwrap. git-sandboxed
  // lives in this same directory so it rides along on the same PATH entry —
  // no separate wiring needed, and it survives Claude Code's shell-snapshot
  // re-sourcing inside each sandboxed command (which clobbers any PATH set
  // via bwrap args, but not this one, since it was already part of the
  // snapshot's own captured PATH).
  buildSpawnEnv: () => {
    const realBwrap = resolveRealBwrap();
    const srcDir = fileURLToPath(new URL('../', import.meta.url));
    const binDir = join(srcDir, 'bin');
    chmodSync(join(binDir, 'bwrap'), 0o755);
    chmodSync(join(binDir, 'git-sandboxed'), 0o755);

    return {
      PATH: `${binDir}:${process.env['PATH'] ?? ''}`,
      REAL_BWRAP: realBwrap,
    };
  },
};
