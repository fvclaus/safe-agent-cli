#!/usr/bin/env bun
/**
 * Test harness: mirrors the shared launcher setup (GCP/GitHub env setup + bwrap
 * sandbox) but runs an arbitrary command instead of launching an agent CLI.
 *
 * Running this nested inside a session safe-agent-cli itself launched can make
 * `which bwrap` find this repo's own shim (already ahead on PATH) instead of the
 * real binary. src/real-bwrap.ts guards against that (skips any `which` match that
 * resolves to the shim), and src/bin/bwrap independently refuses to exec into
 * itself if REAL_BWRAP ever does end up pointing at it anyway — both would
 * otherwise recurse into themselves, growing their argument list without bound
 * until memory is exhausted. Still NEVER add this (or any `bwrap`-invoking
 * command) to a Claude Code `excludedCommands` entry — that runs it unsandboxed,
 * which is a separate, still-real risk independent of the above.
 *
 * Usage:
 *   bun scripts/test-sandbox.ts [--gcp [--project ID]] [--gh[=PAT_NAME]] <command>
 *   bun scripts/test-sandbox.ts bash          # interactive shell in the sandbox
 *   bun scripts/test-sandbox.ts --gcp --project my-project "gcloud projects list"
 *   bun scripts/test-sandbox.ts --gh "gh auth status"
 *   bun scripts/test-sandbox.ts --gh=my-token "gh auth status"   # explicit PAT name
 *
 * Sandbox filesystem policy is read from (merged, in order):
 *   1. ~/.claude/settings.json   (user)
 *   2. .claude/settings.json     (project)
 *   3. .claude/settings.local.json (local)
 *
 * Only the sandbox.filesystem keys defined by claude-code-settings.json are
 * honored (https://json.schemastore.org/claude-code-settings.json):
 *   allowWrite → paths bound rw
 *   denyWrite  → paths re-denied write within allowWrite (+ mandatory denies)
 *   denyRead   → dirs mounted as tmpfs (read denied)
 *   allowRead  → paths re-bound ro within denyRead regions
 */

import chalk from 'chalk';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
  existsSync,
  statSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { $ } from 'zx';
import { resolveRealBwrap } from '../src/real-bwrap.js';

$.verbose = false;

const log = (msg: string) => process.stderr.write(msg + '\n');

// ── Paths ─────────────────────────────────────────────────────────────────────
const cwd  = process.cwd();
const home = process.env['HOME'] ?? '/home/' + process.env['USER'];
const binDir = join(fileURLToPath(new URL('../src/', import.meta.url)), 'bin');
const realBwrap = resolveRealBwrap();

// ── CLI args ──────────────────────────────────────────────────────────────────
// Flags mirror src/launcher/safe-agent-cli.tsx; everything not recognized is the command.
const rawArgs = process.argv.slice(2);
let useGcp    = false;
let useGh     = false;
let ghPatName = '';
let projectId = '';
const cmdParts: string[] = [];

for (let i = 0; i < rawArgs.length; i++) {
  const a = rawArgs[i]!;
  if (a === '--gcp' || a === '--google-cloud') { useGcp = true; continue; }
  if (a === '--gh' || a === '--github')         { useGh  = true; continue; }
  if (a.startsWith('--gh=') || a.startsWith('--github=')) { useGh = true; ghPatName = a.slice(a.indexOf('=') + 1); continue; }
  if (a === '--project') { projectId = rawArgs[++i] ?? ''; continue; }
  if (a.startsWith('--project=')) { projectId = a.slice('--project='.length); continue; }
  cmdParts.push(a);
}

if (cmdParts.length === 0) {
  log('Usage: bun scripts/test-sandbox.ts [--gcp [--project ID]] [--gh[=PAT_NAME]] <command>');
  process.exit(1);
}
const userCommand = cmdParts.join(' ');

// ── Settings reader ───────────────────────────────────────────────────────────
function readJson(filePath: string): Record<string, unknown> | null {
  try { return JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>; }
  catch { return null; }
}

function expandPath(p: string): string {
  if (p === '.')      return cwd;
  if (p === '$TMPDIR') return tmpdir();
  if (p.startsWith('$')) return process.env[p.slice(1)] ?? p;
  if (p.startsWith('~/')) return join(home, p.slice(2));
  return resolve(p);
}

interface SandboxFsConfig {
  allowWrite: string[];
  denyWrite:  string[];
  denyRead:   string[];
  allowRead:  string[];
}

function loadSandboxConfig(): SandboxFsConfig {
  const cfg: SandboxFsConfig = {
    allowWrite: [], denyWrite: [], denyRead: [], allowRead: [],
  };

  function mergeFile(raw: Record<string, unknown> | null) {
    if (!raw) return;
    const fs = (raw?.['sandbox'] as Record<string, unknown> | undefined)
               ?.['filesystem'] as Record<string, unknown> | undefined;
    if (!fs) return;

    // Only the keys defined by claude-code-settings.json are honored.
    const aw = fs['allowWrite'] as string[] | undefined;
    const dw = fs['denyWrite']  as string[] | undefined;
    const dr = fs['denyRead']   as string[] | undefined;
    const ar = fs['allowRead']  as string[] | undefined;
    if (aw) cfg.allowWrite.push(...aw.map(expandPath));
    if (dw) cfg.denyWrite.push(...dw.map(expandPath));
    if (dr) cfg.denyRead.push(...dr.map(expandPath));
    if (ar) cfg.allowRead.push(...ar.map(expandPath));
  }

  // Merged in precedence order: user settings, then project, then local.
  mergeFile(readJson(join(home, '.claude', 'settings.json')));
  for (const f of ['.claude/settings.json', '.claude/settings.local.json']) {
    mergeFile(readJson(join(cwd, f)));
  }

  return cfg;
}

// ── Sandbox builder ───────────────────────────────────────────────────────────
// Follows the argument order of linux-sandbox-utils.ts > generateFilesystemArgs:
//   1. --ro-bind / /  (write restrictions present)
//   2. --bind for write-allow paths
//   3. --tmpfs for each read-deny dir, then re-bind write + allow-read paths
//   4. denyWrite args emitted last
//   5. --dev /dev  --unshare-pid  --proc /proc

function isDirectory(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

function buildBwrapArgs(cfg: SandboxFsConfig, command: string): string[] {
  const args: string[] = ['--new-session', '--die-with-parent'];
  const allowedWritePaths = cfg.allowWrite.filter(existsSync);

  // 1. Read-only root
  args.push('--ro-bind', '/', '/');

  // 2. Write-allow paths
  for (const p of allowedWritePaths) {
    args.push('--bind', p, p);
  }

  // Buffered denyWrite args (emitted in step 4)
  const denyWriteArgs: string[] = [];

  // Mandatory write-deny: .git/hooks, .git/config
  const mandatoryDeny = [...cfg.denyWrite];
  const dotGit = join(cwd, '.git');
  if (isDirectory(dotGit)) {
    mandatoryDeny.push(join(cwd, '.git/hooks'), join(cwd, '.git/config'));
  }

  for (const p of mandatoryDeny) {
    if (!existsSync(p)) continue;
    const inAllowed = allowedWritePaths.some(w => p.startsWith(w + '/') || p === w);
    if (inAllowed) denyWriteArgs.push('--ro-bind', p, p);
  }

  // 3. Read-deny dirs (tmpfs) + re-binds
  const readAllowPaths = cfg.allowRead.filter(existsSync);
  for (const denyDir of cfg.denyRead) {
    if (!isDirectory(denyDir)) continue;
    args.push('--tmpfs', denyDir);

    // Re-bind write paths wiped by the tmpfs
    for (const w of allowedWritePaths) {
      if (w.startsWith(denyDir + '/') || w === denyDir) args.push('--bind', w, w);
    }

    // Re-bind allowed read paths within the denied dir
    const sep = denyDir + '/';
    for (const a of readAllowPaths) {
      if (!a.startsWith(sep) && a !== denyDir) continue;
      // Skip if already covered by a write re-bind above
      const coveredByWrite = allowedWritePaths.some(
        w => (w.startsWith(sep) || w === denyDir) && (a === w || a.startsWith(w + '/')),
      );
      if (coveredByWrite) continue;
      args.push('--ro-bind', a, a);
    }
  }

  // 4. denyWrite args last (layers on top of re-binds)
  args.push(...denyWriteArgs);

  // 5. Device + PID namespace
  args.push('--dev', '/dev');
  args.push('--unshare-pid');
  args.push('--proc', '/proc');

  args.push('--', 'bash', '-c', command);
  return args;
}

// ── Integration setup result ──────────────────────────────────────────────────
interface SetupResult {
  envVars: Record<string, string>;
  /** Directories that need to be added to the sandbox write-allow list. */
  dirs: string[];
}

// ── GCP setup (mirrors src/launcher/safe-agent-cli.tsx) ──────────────────────
async function setupGcp(): Promise<SetupResult & { configDir: string; adcFile: string; gcpToken: string }> {
  if (!projectId) {
    log(chalk.bold.red('ERROR:') + ' --gcp requires --project PROJECT_ID for the test harness.');
    process.exit(1);
  }
  const sa = `claude-code@${projectId}.iam.gserviceaccount.com`;

  log(`\nChecking for service account ${chalk.bold(sa)}…`);
  try {
    await $`gcloud iam service-accounts describe ${sa} --project=${projectId}`;
  } catch {
    log(chalk.bold.red('ERROR:') + ` Service account ${sa} not found in project ${projectId}.`);
    process.exit(1);
  }
  log(chalk.bold.green('OK:') + ' Service account found.');

  log(`\nGenerating access token for ${sa}…`);
  let gcpToken = '';
  try {
    const out = await $`gcloud auth print-access-token --impersonate-service-account=${sa}`;
    gcpToken = out.stdout.trim();
  } catch {
    log(chalk.bold.red('ERROR:') + ' Failed to generate access token.');
    process.exit(1);
  }

  const configDir = mkdtempSync(join(tmpdir(), 'safe-claude-code-'));
  mkdirSync(join(configDir, 'configurations'), { recursive: true });

  const tokenFile = join(configDir, 'access_token');
  writeFileSync(tokenFile, gcpToken, { mode: 0o600 });
  writeFileSync(join(configDir, 'active_config'), 'default');
  writeFileSync(
    join(configDir, 'configurations', 'config_default'),
    ['[core]', `account = ${sa}`, `project = ${projectId}`, '', '[auth]', `access_token_file = ${tokenFile}`].join('\n'),
  );

  const tokenExpiry = new Date(Date.now() + 3_600_000).toISOString().replace(/\.\d{3}Z$/, '');
  const adcFile = join(configDir, 'application_default_credentials.json');
  writeFileSync(
    adcFile,
    JSON.stringify({ type: 'authorized_user', client_id: 'sa-impersonation',
      client_secret: 'n/a', refresh_token: 'n/a', token: gcpToken,
      access_token: gcpToken, expiry: tokenExpiry }, null, 2),
    { mode: 0o600 },
  );

  log(chalk.bold.green('OK:') + ` GCP env ready (${sa}, expires ${tokenExpiry} UTC).`);
  return {
    configDir, adcFile, gcpToken,
    envVars: {
      CLOUDSDK_CONFIG: configDir,
      GOOGLE_OAUTH_ACCESS_TOKEN: gcpToken,
      FIREBASE_TOKEN: gcpToken,
      GOOGLE_APPLICATION_CREDENTIALS: adcFile,
    },
    dirs: [configDir],
  };
}

// ── GitHub setup (mirrors src/launcher/safe-agent-cli.tsx) ───────────────────
async function setupGh(patName: string): Promise<SetupResult & { ghStateDir: string; githubToken: string }> {
  log(`\nLooking up GitHub PAT for ${chalk.bold(patName)}…`);
  let githubToken = '';
  try {
    const out = await $`secret-tool lookup github.pat ${patName}`;
    githubToken = out.stdout.trim();
    if (!githubToken) throw new Error('empty');
    log(chalk.bold.green('OK:') + ' GitHub PAT found.');
  } catch {
    log(chalk.bold.red('ERROR:') + ` No GitHub PAT found for "${patName}".`);
    log(`  secret-tool store --label="Github PAT ${patName}" github.pat ${patName}`);
    process.exit(1);
  }

  const ghStateDir = mkdtempSync(join(tmpdir(), 'safe-claude-code-gh-'));
  mkdirSync(join(ghStateDir, 'config'), { recursive: true });
  mkdirSync(join(ghStateDir, 'state', 'gh'), { recursive: true });

  return {
    ghStateDir, githubToken,
    envVars: {
      GITHUB_TOKEN: githubToken,
      GH_CONFIG_DIR: join(ghStateDir, 'config'),
      XDG_STATE_HOME: join(ghStateDir, 'state'),
    },
    dirs: [ghStateDir],
  };
}

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
  chmodSync(join(binDir, 'bwrap'), 0o755);

  let extraEnv: Record<string, string> = {};
  let configDir: string | undefined;
  let ghStateDir: string | undefined;

  const cfg = loadSandboxConfig();

  if (useGcp) {
    const gcp = await setupGcp();
    configDir = gcp.configDir;
    extraEnv = { ...extraEnv, ...gcp.envVars };
    cfg.allowWrite.push(...gcp.dirs);
    cfg.allowRead.push(...gcp.dirs);
  }

  if (useGh) {
    const gh = await setupGh(ghPatName || basename(cwd));
    ghStateDir = gh.ghStateDir;
    extraEnv = { ...extraEnv, ...gh.envVars };
    cfg.allowWrite.push(...gh.dirs);
    cfg.allowRead.push(...gh.dirs);
  }

  const cleanup = () => {
    if (configDir) try { rmSync(configDir, { recursive: true, force: true }); } catch { /* ignore */ }
    if (ghStateDir) try { rmSync(ghStateDir, { recursive: true, force: true }); } catch { /* ignore */ }
  };
  process.on('exit', cleanup);
  process.on('SIGINT',  () => { cleanup(); process.exit(130); });
  process.on('SIGTERM', () => { cleanup(); process.exit(143); });

  const bwrapArgs = buildBwrapArgs(cfg, userCommand);

  log(`${chalk.blue('[sandbox]')} ${userCommand}\n`);

  const result = spawnSync(join(binDir, 'bwrap'), bwrapArgs, {
    stdio: 'inherit',
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env['PATH'] ?? ''}`,
      REAL_BWRAP: realBwrap,
      ...extraEnv,
    },
  });

  if (result.error) throw result.error;
  process.exit(result.status ?? 0);
}

main().catch((e: unknown) => {
  log(chalk.bold.red('ERROR:') + ' ' + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
