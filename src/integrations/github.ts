import { or } from '@optique/core/constructs';
import { optional } from '@optique/core/modifiers';
import { flag, option } from '@optique/core/primitives';
import { string } from '@optique/core/valueparser';
import { $ } from 'zx';
import chalk from 'chalk';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { spawnSync } from 'node:child_process';

$.verbose = false;

export const githubCliOptions = {
  // flag() first so `--gh <agent-arg>` never swallows the next token;
  // an explicit PAT name therefore requires the `--gh=NAME` form.
  gh: optional(or(flag('--gh'), option('--gh', string({ metavar: 'PAT_NAME' })))),
  github: optional(or(flag('--github'), option('--github', string({ metavar: 'PAT_NAME' })))),
};

export interface GithubCliArgs {
  gh: boolean | string | undefined;
  github: boolean | string | undefined;
}

export interface GithubSetupResult {
  credentialEnv: Record<string, string>;
  writableDirs: string[];
  cleanupDirs: string[];
  systemInstructionParts: string[];
  githubToken?: string;
  ghStateDir?: string;
}

interface GithubSetupOptions {
  args: GithubCliArgs;
  log: (msg: string) => void;
  abortIfSnap: (binary: string, installHint: string) => void;
}

export async function setupGithubIntegration({
  args,
  log,
  abortIfSnap,
}: GithubSetupOptions): Promise<GithubSetupResult> {
  const ghArg = args.gh ?? args.github;
  if (ghArg === undefined) {
    return {
      credentialEnv: {},
      writableDirs: [],
      cleanupDirs: [],
      systemInstructionParts: [],
    };
  }

  abortIfSnap('gh', 'https://cli.github.com');

  const isMacOS = process.platform === 'darwin';

  if (isMacOS) {
    const securityAvailable = spawnSync('which', ['security'], { encoding: 'utf8' }).status === 0;
    if (!securityAvailable) {
      log(chalk.bold.red('ERROR:') + ' security command not found (expected at /usr/bin/security).');
      process.exit(1);
    }
  } else {
    const secretToolAvailable = spawnSync('which', ['secret-tool'], { encoding: 'utf8' }).status === 0;
    if (!secretToolAvailable) {
      log(chalk.bold.red('ERROR:') + ' secret-tool is not installed.');
      log('Install it with:');
      log('  sudo apt install libsecret-tools');
      process.exit(1);
    }
  }

  const patName = typeof ghArg === 'string' ? ghArg : basename(process.cwd());
  log(`\nLooking up GitHub PAT for ${chalk.bold(patName)}…`);

  let githubToken: string;
  try {
    if (isMacOS) {
      const out = spawnSync('security', ['find-generic-password', '-s', 'github.pat', '-a', patName, '-w'], { encoding: 'utf8' });
      if (out.status !== 0) throw new Error('not found');
      githubToken = out.stdout.trim();
      if (!githubToken) throw new Error('empty');
    } else {
      const out = await $`secret-tool lookup github.pat ${patName}`;
      githubToken = out.stdout.trim();
      if (!githubToken) throw new Error('empty');
    }
  } catch {
    log(chalk.bold.red('ERROR:') + ` No GitHub PAT found for "${patName}".`);
    log('Create a fine-grained PAT (contents, pull_requests, actions, workflows — read & write):');
    log(`  https://github.com/settings/personal-access-tokens/new?name=${encodeURIComponent(patName)}&expires_in=366&issues=write&contents=write&pull_requests=write&actions=write&workflows=write`);
    log('Then store it with:');
    if (isMacOS) {
      log(`  security add-generic-password -s github.pat -a ${patName} -w`);
    } else {
      log(`  secret-tool store --label="Github PAT ${patName}" github.pat ${patName}`);
    }
    process.exit(1);
  }

  let ghPermissionInfo = '';
  try {
    const resp = await fetch('https://api.github.com/user', {
      headers: { Authorization: `token ${githubToken}` },
    });
    const scopes = resp.headers.get('x-oauth-scopes');
    const expiry = resp.headers.get('github-authentication-token-expiration');
    if (scopes !== null) {
      const scopeList = scopes.split(',').map(s => s.trim()).filter(Boolean);
      log(chalk.bold.green('OK:') + ' GITHUB_TOKEN is a classic PAT.');
      log(`  Scopes: ${scopeList.join(', ') || '(none)'}`);
      ghPermissionInfo = `GITHUB_TOKEN is a classic PAT with scopes: ${scopeList.join(', ') || '(none)'}`;
    } else {
      ghPermissionInfo = `GITHUB_TOKEN is a fine-grained PAT${expiry ? ` (expires ${expiry})` : ''}. ` +
        `It was created with at least these repository permissions: contents (read & write), pull_requests (read & write), actions (read & write), workflows (read & write). ` +
        `Additional permissions may have been granted beyond these.`;

      log(chalk.bold.green('OK:') + ' GITHUB_TOKEN is a fine-grained PAT.');
      if (expiry) log(`  Expires:     ${expiry}`);
      log('  Permissions: contents (read & write), pull_requests (read & write),');
      log('               actions (read & write), workflows (read & write)');
      log('               (these are the minimum required; additional permissions may have been granted)');
    }
  } catch {
    log(chalk.bold.yellow('WARNING:') + ' Could not determine GitHub token info.');
  }

  const ghStateDir = mkdtempSync(join(tmpdir(), 'safe-agent-cli-gh-'));
  mkdirSync(join(ghStateDir, 'config'), { recursive: true });
  mkdirSync(join(ghStateDir, 'state', 'gh'), { recursive: true });

  return {
    credentialEnv: {
      GITHUB_TOKEN: githubToken,
      GH_CONFIG_DIR: join(ghStateDir, 'config'),
      XDG_STATE_HOME: join(ghStateDir, 'state'),
    },
    writableDirs: [ghStateDir],
    cleanupDirs: [ghStateDir],
    systemInstructionParts: ghPermissionInfo
      ? [
          `GitHub credentials are available via environment variables. ` +
          `The environment variable GITHUB_TOKEN is set to a GitHub PAT, and the gh CLI is ready to use ` +
          `(its config and state directories are pointed at a temporary location via the environment variables GH_CONFIG_DIR and XDG_STATE_HOME). ` +
          ghPermissionInfo,
        ]
      : [],
    githubToken,
    ghStateDir,
  };
}
