#!/usr/bin/env bun
/**
 * Test harness: mirrors what src/index.tsx does (GCP/GitHub env setup + bwrap
 * sandbox) but runs an arbitrary command instead of launching `claude`.
 *
 * Usage:
 *   bun src/test-sandbox.ts [--gcp [--project ID]] [--gh] <command>
 *   bun src/test-sandbox.ts bash          # interactive shell in the sandbox
 *   bun src/test-sandbox.ts --gcp --project my-project "gcloud projects list"
 *   bun src/test-sandbox.ts --gh "gh auth status"
 *
 * Sandbox filesystem policy is read from (merged, in order):
 *   1. ~/.claude/settings.json  — long form: sandbox.filesystem.{read,write}.*
 *   2. .claude/settings.json    — short form: sandbox.filesystem.{allowWrite,allowRead}
 *
 * Long form keys:
 *   read.denyOnly        → dirs mounted as tmpfs
 *   read.allowWithinDeny → paths re-bound ro after tmpfs
 *   write.allowOnly      → paths bound rw
 *   write.denyWithinAllow→ paths re-denied within write-allow (+ mandatory denies)
 *
 * Short form (project settings):
 *   allowWrite → same as write.allowOnly
 *   allowRead  → same as read.allowWithinDeny
 */

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

$.verbose = false;

const c = {
  red:    (s: string) => `\x1b[1;31m${s}\x1b[0m`,
  green:  (s: string) => `\x1b[1;32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[1;33m${s}\x1b[0m`,
  blue:   (s: string) => `\x1b[1;34m${s}\x1b[0m`,
  bold:   (s: string) => `\x1b[1m${s}\x1b[0m`,
};
const log = (msg: string) => process.stderr.write(msg + '\n');

// ── Paths ─────────────────────────────────────────────────────────────────────
const cwd  = process.cwd();
const home = process.env['HOME'] ?? '/home/' + process.env['USER'];
const binDir = join(fileURLToPath(new URL('.', import.meta.url)), 'bin');
const realBwrap = spawnSync('which', ['bwrap'], { encoding: 'utf8' }).stdout.trim() || '/usr/bin/bwrap';

// ── CLI args ──────────────────────────────────────────────────────────────────
// Flags mirror src/index.tsx; everything not recognized is the command.
const rawArgs = process.argv.slice(2);
let useGcp    = false;
let useGh     = false;
let projectId = '';
const cmdParts: string[] = [];

for (let i = 0; i < rawArgs.length; i++) {
  const a = rawArgs[i]!;
  if (a === '--gcp' || a === '--google-cloud') { useGcp = true; continue; }
  if (a === '--gh' || a === '--github')         { useGh  = true; continue; }
  if (a === '--project') { projectId = rawArgs[++i] ?? ''; continue; }
  if (a.startsWith('--project=')) { projectId = a.slice('--project='.length); continue; }
  cmdParts.push(a);
}

if (cmdParts.length === 0) {
  log('Usage: bun src/test-sandbox.ts [--gcp [--project ID]] [--gh] <command>');
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
  readDenyOnly:       string[];
  readAllowWithinDeny: string[];
  writeAllowOnly:     string[];
  writeDenyWithinAllow: string[];
}

function loadSandboxConfig(): SandboxFsConfig {
  const cfg: SandboxFsConfig = {
    readDenyOnly: [], readAllowWithinDeny: [],
    writeAllowOnly: [], writeDenyWithinAllow: [],
  };

  function mergeFile(raw: Record<string, unknown> | null, isShortForm: boolean) {
    if (!raw) return;
    const fs = (raw?.['sandbox'] as Record<string, unknown> | undefined)
               ?.['filesystem'] as Record<string, unknown> | undefined;
    if (!fs) return;

    if (isShortForm) {
      // allowWrite / allowRead
      const aw = fs['allowWrite'] as string[] | undefined;
      const ar = fs['allowRead']  as string[] | undefined;
      if (aw) cfg.writeAllowOnly.push(...aw.map(expandPath));
      if (ar) cfg.readAllowWithinDeny.push(...ar.map(expandPath));
    }

    // Long form (may appear in either file)
    const read  = fs['read']  as Record<string, string[]> | undefined;
    const write = fs['write'] as Record<string, string[]> | undefined;
    if (read?.['denyOnly'])        cfg.readDenyOnly.push(...read['denyOnly'].map(expandPath));
    if (read?.['allowWithinDeny']) cfg.readAllowWithinDeny.push(...read['allowWithinDeny'].map(expandPath));
    if (write?.['allowOnly'])      cfg.writeAllowOnly.push(...write['allowOnly'].map(expandPath));
    if (write?.['denyWithinAllow']) cfg.writeDenyWithinAllow.push(...write['denyWithinAllow'].map(expandPath));
  }

  // 1. Global user settings — long form
  mergeFile(readJson(join(home, '.claude', 'settings.json')), false);

  // 2. Project settings — short form (or long form if present)
  for (const f of ['.claude/settings.json', '.claude/settings.local.json']) {
    mergeFile(readJson(join(cwd, f)), true);
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
  const allowedWritePaths = cfg.writeAllowOnly.filter(existsSync);

  // 1. Read-only root
  args.push('--ro-bind', '/', '/');

  // 2. Write-allow paths
  for (const p of allowedWritePaths) {
    args.push('--bind', p, p);
  }

  // Buffered denyWrite args (emitted in step 4)
  const denyWriteArgs: string[] = [];

  // Mandatory write-deny: .git/hooks, .git/config
  const mandatoryDeny = [...cfg.writeDenyWithinAllow];
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
  const readAllowPaths = cfg.readAllowWithinDeny.filter(existsSync);
  for (const denyDir of cfg.readDenyOnly) {
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

// ── GCP setup (mirrors src/index.tsx) ────────────────────────────────────────
async function setupGcp(): Promise<{
  configDir: string;
  adcFile: string;
  gcpToken: string;
  envVars: Record<string, string>;
}> {
  if (!projectId) {
    log(c.red('ERROR:') + ' --gcp requires --project PROJECT_ID for the test harness.');
    process.exit(1);
  }
  const sa = `claude-code@${projectId}.iam.gserviceaccount.com`;

  log(`\nChecking for service account ${c.bold(sa)}…`);
  try {
    await $`gcloud iam service-accounts describe ${sa} --project=${projectId}`;
  } catch {
    log(c.red('ERROR:') + ` Service account ${sa} not found in project ${projectId}.`);
    process.exit(1);
  }
  log(c.green('OK:') + ' Service account found.');

  log(`\nGenerating access token for ${sa}…`);
  let gcpToken = '';
  try {
    const out = await $`gcloud auth print-access-token --impersonate-service-account=${sa}`;
    gcpToken = out.stdout.trim();
  } catch {
    log(c.red('ERROR:') + ' Failed to generate access token.');
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

  log(c.green('OK:') + ` GCP env ready (${sa}, expires ${tokenExpiry} UTC).`);
  return {
    configDir, adcFile, gcpToken,
    envVars: {
      CLOUDSDK_CONFIG: configDir,
      GOOGLE_OAUTH_ACCESS_TOKEN: gcpToken,
      FIREBASE_TOKEN: gcpToken,
      GOOGLE_APPLICATION_CREDENTIALS: adcFile,
    },
  };
}

// ── GitHub setup (mirrors src/index.tsx) ─────────────────────────────────────
async function setupGh(): Promise<{
  ghStateDir: string;
  githubToken: string;
  envVars: Record<string, string>;
}> {
  const folderName = basename(cwd);
  log(`\nLooking up GitHub PAT for ${c.bold(folderName)}…`);
  let githubToken = '';
  try {
    const out = await $`secret-tool lookup github.pat ${folderName}`;
    githubToken = out.stdout.trim();
    if (!githubToken) throw new Error('empty');
    log(c.green('OK:') + ' GitHub PAT found.');
  } catch {
    log(c.red('ERROR:') + ` No GitHub PAT found for "${folderName}".`);
    log(`  secret-tool store --label="Github PAT ${folderName}" github.pat ${folderName}`);
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
  };
}

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
  chmodSync(join(binDir, 'bwrap'), 0o755);

  let extraEnv: Record<string, string> = {};
  let configDir: string | undefined;
  let ghStateDir: string | undefined;

  if (useGcp) {
    const gcp = await setupGcp();
    configDir = gcp.configDir;
    extraEnv = { ...extraEnv, ...gcp.envVars };
  }

  if (useGh) {
    const gh = await setupGh();
    ghStateDir = gh.ghStateDir;
    extraEnv = { ...extraEnv, ...gh.envVars };
  }

  const cleanup = () => {
    if (configDir) try { rmSync(configDir, { recursive: true, force: true }); } catch { /* ignore */ }
    if (ghStateDir) try { rmSync(ghStateDir, { recursive: true, force: true }); } catch { /* ignore */ }
  };
  process.on('exit', cleanup);
  process.on('SIGINT',  () => { cleanup(); process.exit(130); });
  process.on('SIGTERM', () => { cleanup(); process.exit(143); });

  const cfg = loadSandboxConfig();
  const bwrapArgs = buildBwrapArgs(cfg, userCommand);

  log(`${c.blue('[sandbox]')} ${userCommand}\n`);

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
  log(c.red('ERROR:') + ' ' + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
