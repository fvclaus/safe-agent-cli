#!/usr/bin/env bun
import React, { useState, useMemo } from 'react';
import { render, Box, Text, useApp, useInput } from 'ink';
import { object } from '@optique/core/constructs';
import { optional } from '@optique/core/modifiers';
import { argument, flag } from '@optique/core/primitives';
import { string } from '@optique/core/valueparser';
import { message } from '@optique/core/message';
import { run } from '@optique/run';
import { $ } from 'zx';
import chalk from 'chalk';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

$.verbose = false;

const log = (msg: string) => process.stderr.write(msg + '\n');

// ─── Ink: autocomplete project selector ──────────────────────────────────────
interface ProjectSelectorProps {
  projects: string[];
  initialValue: string;
  onSelect: (project: string) => void;
}

const ProjectSelector: React.FC<ProjectSelectorProps> = ({ projects, initialValue, onSelect }) => {
  const { exit } = useApp();
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState('');

  const suggestion = useMemo(() => {
    if (!value) return '';
    const match = projects.find(p => p.toLowerCase().startsWith(value.toLowerCase()));
    return match && match.toLowerCase() !== value.toLowerCase() ? match : '';
  }, [value, projects]);

  useInput((input, key) => {
    if (key.tab) {
      if (suggestion) setValue(suggestion);
      return;
    }
    if (key.return) {
      const final = value.trim();
      if (!final) {
        setError('Project ID cannot be empty.');
        return;
      }
      onSelect(final);
      exit();
      return;
    }
    if (key.backspace || key.delete) {
      setValue(prev => prev.slice(0, -1));
      setError('');
      return;
    }
    if (input && !key.ctrl && !key.meta && !key.escape) {
      setValue(prev => prev + input);
      setError('');
    }
  });

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold color="cyan">Select a GCP project</Text>
      <Box gap={1}>
        <Text color="cyan">›</Text>
        <Text>
          {value}
          {suggestion ? <Text dimColor>{suggestion.slice(value.length)}</Text> : null}
          {!value ? <Text dimColor>Type to search…</Text> : null}
        </Text>
      </Box>
      {error ? <Text color="red">{error}</Text> : null}
      <Text dimColor>Tab to accept · Enter to confirm · Ctrl+C to cancel</Text>
    </Box>
  );
};

// ─── Ink: y/N confirmation ────────────────────────────────────────────────────
interface ConfirmPromptProps {
  message: string;
  onConfirm: (yes: boolean) => void;
}

const ConfirmPrompt: React.FC<ConfirmPromptProps> = ({ message, onConfirm }) => {
  const { exit } = useApp();

  useInput((input, key) => {
    if (input === 'y' || input === 'Y') {
      onConfirm(true);
      exit();
    } else if (input === 'n' || input === 'N' || key.escape) {
      onConfirm(false);
      exit();
    }
  });

  return (
    <Box gap={1}>
      <Text>{message}</Text>
      <Text color="yellow" bold>[y/N]</Text>
    </Box>
  );
};

// ─── Render an ink element and wait until the app exits ───────────────────────
async function inkPrompt<T>(element: React.ReactElement, resolve: () => T): Promise<T> {
  const { waitUntilExit } = render(element);
  await waitUntilExit();
  return resolve();
}

// ─── Snap detection ───────────────────────────────────────────────────────────
function isSnap(binary: string): boolean {
  const which = spawnSync('which', [binary], { encoding: 'utf8' });
  if (which.status !== 0) return false;
  const realpath = spawnSync('realpath', [which.stdout.trim()], { encoding: 'utf8' });
  return realpath.status === 0 && realpath.stdout.trim() === '/usr/bin/snap';
}

function abortIfSnap(binary: string, installHint: string): void {
  if (!isSnap(binary)) return;
  log(chalk.bold.red('ERROR:') + ` ${binary} is installed via snap, which is not supported.`);
  log('Snap launchers require a systemd user session to set up confinement.');
  log(`When ${binary} is spawned as a subprocess it cannot create the required`);
  log('transient scope, causing all commands to fail silently.');
  log(`Install ${binary} directly instead:  ${installHint}`);
  process.exit(1);
}

// ─── Fetch GCP project IDs ────────────────────────────────────────────────────
interface ProjectListResult {
  projects: string[];
  error?: string;
}

async function listProjects(): Promise<ProjectListResult> {
  const which = spawnSync('which', ['gcloud'], { encoding: 'utf8' });
  if (which.status !== 0) {
    return {
      projects: [],
      error: 'gcloud CLI not found. Install the Google Cloud SDK:\n  https://cloud.google.com/sdk/docs/install',
    };
  }

  // Check there is an active authenticated account
  const authList = spawnSync('gcloud', ['auth', 'list', '--filter=status:ACTIVE', '--format=value(account)'], { encoding: 'utf8' });
  const activeAccount = authList.stdout.trim();
  if (!activeAccount) {
    return {
      projects: [],
      error: 'No active gcloud account found. Authenticate first:\n  gcloud auth login',
    };
  }

  try {
    const out = await $`gcloud projects list --format=${'value(projectId)'}`;
    return { projects: out.stdout.trim().split('\n').filter(Boolean) };
  } catch {
    return { projects: [], error: 'Could not list projects. Run manually to see the error:\n  gcloud projects list' };
  }
}

// ─── main ─────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const args = await run(
    object({
      gcp:         optional(flag('--gcp')),
      googleCloud: optional(flag('--google-cloud')),
      gh:          optional(flag('--gh')),
      github:      optional(flag('--github')),
      project:     optional(argument(string({ metavar: 'PROJECT_ID' }))),
    }),
    {
      programName: 'safe-claude-code',
      help: 'option',
      colors: true,
      brief: message`Launch Claude Code with GCP service-account impersonation.`,
    },
  );

  // Accumulate dirs (--add-dir) and system-prompt snippets for Claude
  const claudeDirs: string[]          = [];
  const systemPromptParts: string[]   = [];

  // ── Resolve GitHub PAT ─────────────────────────────────────────────────────
  let githubToken: string | undefined;
  if (args.gh || args.github) {
    abortIfSnap('gh', 'https://cli.github.com');
    const secretToolAvailable = spawnSync('which', ['secret-tool'], { encoding: 'utf8' }).status === 0;
    if (!secretToolAvailable) {
      log(chalk.bold.red('ERROR:') + ' secret-tool is not installed.');
      log('Install it with:');
      log('  sudo apt install libsecret-tools');
      process.exit(1);
    }

    const folderName = basename(process.cwd());
    log(`\nLooking up GitHub PAT for ${chalk.bold(folderName)}…`);
    try {
      const out = await $`secret-tool lookup github.pat ${folderName}`;
      githubToken = out.stdout.trim();
      if (!githubToken) throw new Error('empty');
      log(chalk.bold.green('OK:') + ' GitHub PAT found.');
    } catch {
      log(chalk.bold.red('ERROR:') + ` No GitHub PAT found for "${folderName}".`);
      log('To store one, run:');
      log(`  secret-tool store --label="Github PAT ${folderName}" github.pat ${folderName}`);
      process.exit(1);
    }

    // Query token info so Claude knows its GitHub permissions upfront.
    // Classic PATs return x-oauth-scopes; fine-grained PATs return null for that
    // header but include a github-authentication-token-expiration header instead.
    log('Fetching GitHub token info…');
    let ghPermissionInfo = '';
    try {
      const resp = await fetch('https://api.github.com/user', {
        headers: { Authorization: `token ${githubToken}` },
      });
      const scopes = resp.headers.get('x-oauth-scopes');
      const expiry = resp.headers.get('github-authentication-token-expiration');
      if (scopes !== null) {
        const scopeList = scopes.split(',').map(s => s.trim()).filter(Boolean);
        ghPermissionInfo = `GitHub classic PAT scopes: ${scopeList.join(', ') || '(none)'}`;
      } else {
        ghPermissionInfo = `GitHub fine-grained PAT${expiry ? `, expires ${expiry}` : ''}`;
      }
    } catch { /* non-fatal */ }

    if (ghPermissionInfo) {
      log(chalk.bold.green('OK:') + ` ${ghPermissionInfo}`);
      systemPromptParts.push(ghPermissionInfo);
    } else {
      log(chalk.bold.yellow('WARNING:') + ' Could not determine GitHub token info.');
    }
  }

  // ── GitHub CLI state dir (redirect writes away from ~/.local/state/gh) ──────
  let ghStateDir: string | undefined;

  if (githubToken !== undefined) {
    ghStateDir = mkdtempSync(join(tmpdir(), 'safe-claude-code-gh-'));
    mkdirSync(join(ghStateDir, 'config'), { recursive: true });
    mkdirSync(join(ghStateDir, 'state', 'gh'), { recursive: true });
    log(chalk.bold.green('OK:') + ` gh state dir: ${ghStateDir}`);

    claudeDirs.push(ghStateDir);
  }

  // ── GCP setup ─────────────────────────────────────────────────────────────
  let configDir: string | undefined;
  let adcFile: string | undefined;
  let gcpToken: string | undefined;

  if (args.gcp || args.googleCloud) {
    abortIfSnap('gcloud', 'https://cloud.google.com/sdk/docs/install');

    // Resolve project ID
    let projectId: string;
    if (args.project !== undefined) {
      projectId = args.project;
    } else {
      log('Fetching GCP project list…');
      const { projects, error: listError } = await listProjects();
      if (listError) {
        log(chalk.bold.yellow('WARNING:') + ' Could not list projects — enter project ID manually.');
        log(chalk.bold.yellow('REASON:') + ' ' + listError);
      }
      const folderName = basename(process.cwd()).toLowerCase();
      const initialValue = projects.find(p => p.toLowerCase().startsWith(folderName)) ?? '';
      let selected = '';
      projectId = await inkPrompt(
        <ProjectSelector projects={projects} initialValue={initialValue} onSelect={(p) => { selected = p; }} />,
        () => {
          if (!selected) {
            log(chalk.bold.red('Aborted.'));
            process.exit(1);
          }
          return selected;
        },
      );
    }

    const sa = `claude-code@${projectId}.iam.gserviceaccount.com`;

    // Verify service account
    log(`\nChecking for service account ${chalk.bold(sa)}…`);
    try {
      await $`gcloud iam service-accounts describe ${sa} --project=${projectId}`;
    } catch {
      log(chalk.bold.red('ERROR:') + ` Service account ${sa} not found in project ${projectId}.`);
      process.exit(1);
    }
    log(chalk.bold.green('OK:') + ' Service account found.');

    // List roles
    log(`\nRoles assigned to ${sa}:`);
    let roles: string[] = [];
    try {
      const filter = `bindings.members:serviceAccount:${sa}`;
      const out = await $`gcloud projects get-iam-policy ${projectId} --flatten=${'bindings[].members'} --filter=${filter} --format=${'value(bindings.role)'}`;
      roles = out.stdout.trim().split('\n').filter(Boolean);
    } catch {
      // non-fatal; roles stays empty
    }

    if (roles.length === 0) {
      log(chalk.bold.yellow('WARNING:') + ' No project-level roles found for this service account.');
    } else {
      for (const role of roles) {
        log(`  • ${role}`);
      }
      systemPromptParts.push(`GCP IAM roles (project: ${projectId}): ${roles.join(', ')}`);
    }

    if (!roles.includes('roles/run.admin')) {
      log(`\n${chalk.bold.blue('INFO:')} To deploy to Cloud Run, grant run.admin:`);
      log(`  gcloud projects add-iam-policy-binding ${projectId} \\`);
      log(`    --member="serviceAccount:${sa}" \\`);
      log(`    --role="roles/run.admin"`);
    }

    // Confirm
    let confirmed = false;
    await inkPrompt(
      <ConfirmPrompt
        message="Proceed with this access level?"
        onConfirm={(yes) => { confirmed = yes; }}
      />,
      () => confirmed,
    );
    if (!confirmed) {
      log(chalk.bold.red('Aborted.'));
      process.exit(1);
    }

    // Generate access token
    log(`\nGenerating access token for ${sa}…`);
    try {
      const out = await $`gcloud auth print-access-token --impersonate-service-account=${sa}`;
      gcpToken = out.stdout.trim();
    } catch {
      let currentAccount = '';
      try {
        const acc = await $`gcloud config get-value account`;
        currentAccount = acc.stdout.trim();
      } catch { /* ignore */ }
      log(chalk.bold.red('ERROR:') + ' Failed to generate access token.');
      log('To grant impersonation rights, run:\n');
      log(`  gcloud iam service-accounts add-iam-policy-binding ${sa} \\`);
      log(`    --member="user:${currentAccount}" \\`);
      log(`    --role="roles/iam.serviceAccountTokenCreator" \\`);
      log(`    --project="${projectId}" \\`);
      log(`    --account="${currentAccount}"\n`);
      process.exit(1);
    }

    // Enable required APIs
    log('Enabling required APIs…');
    try {
      await $`gcloud services enable cloudresourcemanager.googleapis.com --project=${projectId} --impersonate-service-account=${sa}`;
      log(chalk.bold.green('OK:') + ' cloudresourcemanager.googleapis.com');
    } catch {
      log(chalk.bold.yellow('WARNING:') + ' Could not enable cloudresourcemanager.googleapis.com (may already be enabled or insufficient permissions).');
    }

    // Write gcloud config and ADC
    configDir = mkdtempSync(join(tmpdir(), 'safe-claude-code-'));
    mkdirSync(join(configDir, 'configurations'), { recursive: true });

    const tokenFile = join(configDir, 'access_token');
    writeFileSync(tokenFile, gcpToken!, { mode: 0o600 });
    writeFileSync(join(configDir, 'active_config'), 'default');
    writeFileSync(
      join(configDir, 'configurations', 'config_default'),
      [
        '[core]',
        `account = ${sa}`,
        `project = ${projectId}`,
        '',
        '[auth]',
        `access_token_file = ${tokenFile}`,
      ].join('\n'),
    );

    const tokenExpiry = new Date(Date.now() + 3_600_000)
      .toISOString()
      .replace(/\.\d{3}Z$/, '');

    adcFile = join(configDir, 'application_default_credentials.json');
    writeFileSync(
      adcFile,
      JSON.stringify(
        {
          type: 'authorized_user',
          client_id: 'sa-impersonation',
          client_secret: 'n/a',
          refresh_token: 'n/a',
          token: gcpToken,
          access_token: gcpToken,
          expiry: tokenExpiry,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );

    log(chalk.bold.green('Environment ready.') + ` gcloud config: ${configDir}`);
    log(chalk.bold.green('OK:') + ` ADC configured via ${sa} (valid until ${tokenExpiry} UTC).`);

    claudeDirs.push(configDir);
  }

  // ── bwrap wrapper: strip --unshare-net ────────────────────────────────────
  const realBwrap = spawnSync('which', ['bwrap'], { encoding: 'utf8' }).stdout.trim() || '/usr/bin/bwrap';
  const binDir = join(fileURLToPath(new URL('.', import.meta.url)), 'bin');
  chmodSync(join(binDir, 'bwrap'), 0o755);

  // ── Cleanup on any exit ────────────────────────────────────────────────────
  const cleanup = () => {
    if (configDir) {
      try { rmSync(configDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    if (ghStateDir) {
      try { rmSync(ghStateDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  };
  process.on('exit', cleanup);
  process.on('SIGINT',  () => { cleanup(); process.exit(130); });
  process.on('SIGTERM', () => { cleanup(); process.exit(143); });

  // ── Launch Claude Code ─────────────────────────────────────────────────────
  log('Launching Claude Code…\n');

  const claudeArgs: string[] = [
    ...claudeDirs.flatMap(d => ['--add-dir', d]),
    ...(systemPromptParts.length > 0
      ? ['--append-system-prompt', systemPromptParts.join('\n')]
      : []),
  ];

  const result = spawnSync('claude', claudeArgs, {
    stdio: 'inherit',
    env: {
      ...process.env,
      ['PATH']: `${binDir}:${process.env['PATH'] ?? ''}`,
      REAL_BWRAP: realBwrap,
      ...(configDir ? {
        CLOUDSDK_CONFIG: configDir,
        GOOGLE_OAUTH_ACCESS_TOKEN: gcpToken!,
        FIREBASE_TOKEN: gcpToken!,
        GOOGLE_APPLICATION_CREDENTIALS: adcFile!,
      } : {}),
      ...(githubToken !== undefined ? { GITHUB_TOKEN: githubToken } : {}),
      ...(ghStateDir !== undefined ? {
        GH_CONFIG_DIR: join(ghStateDir, 'config'),
        XDG_STATE_HOME: join(ghStateDir, 'state'),
      } : {}),
    },
  });
  if (result.error) throw result.error;
  process.exit(result.status ?? 0);
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  log(chalk.bold.red('ERROR:') + ' ' + msg);
  process.exit(1);
});
