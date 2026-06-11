import { optional } from '@optique/core/modifiers';
import { flag, option } from '@optique/core/primitives';
import { string } from '@optique/core/valueparser';
import { $ } from 'zx';
import chalk from 'chalk';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { spawnSync } from 'node:child_process';

$.verbose = false;

export const gcpCliOptions = {
  gcp: optional(flag('--gcp')),
  googleCloud: optional(flag('--google-cloud')),
  project: optional(option('--project', string({ metavar: 'PROJECT_ID' }))),
};

export interface GcpCliArgs {
  gcp: boolean | undefined;
  googleCloud: boolean | undefined;
  project: string | undefined;
}

export interface GcpSetupResult {
  credentialEnv: Record<string, string>;
  writableDirs: string[];
  cleanupDirs: string[];
  systemInstructionParts: string[];
  gcpToken?: string;
  gcpConfigDir?: string;
  gcpAdcFile?: string;
}

interface ProjectListResult {
  projects: string[];
  error?: string;
}

interface GcpPromptApi {
  selectProject: (projects: string[], initialValue: string) => Promise<string>;
  confirmAccess: (message: string) => Promise<boolean>;
}

interface GcpSetupOptions {
  args: GcpCliArgs;
  log: (msg: string) => void;
  abortIfSnap: (binary: string, installHint: string) => void;
  prompt: GcpPromptApi;
}

async function listProjects(): Promise<ProjectListResult> {
  const which = spawnSync('which', ['gcloud'], { encoding: 'utf8' });
  if (which.status !== 0) {
    return {
      projects: [],
      error: 'gcloud CLI not found. Install the Google Cloud SDK:\n  https://cloud.google.com/sdk/docs/install',
    };
  }

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

export async function setupGcpIntegration({
  args,
  log,
  abortIfSnap,
  prompt,
}: GcpSetupOptions): Promise<GcpSetupResult> {
  if (!args.gcp && !args.googleCloud) {
    return {
      credentialEnv: {},
      writableDirs: [],
      cleanupDirs: [],
      systemInstructionParts: [],
    };
  }

  abortIfSnap('gcloud', 'https://cloud.google.com/sdk/docs/install');

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
    projectId = await prompt.selectProject(projects, initialValue);
    if (!projectId) {
      log(chalk.bold.red('Aborted.'));
      process.exit(1);
    }
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

  log(`\nRoles assigned to ${sa}:`);
  let roles: string[] = [];
  try {
    const filter = `bindings.members:serviceAccount:${sa}`;
    const out = await $`gcloud projects get-iam-policy ${projectId} --flatten=${'bindings[].members'} --filter=${filter} --format=${'value(bindings.role)'}`;
    roles = out.stdout.trim().split('\n').filter(Boolean);
  } catch {
    // non-fatal
  }

  if (roles.length === 0) {
    log(chalk.bold.yellow('WARNING:') + ' No project-level roles found for this service account.');
  } else {
    for (const role of roles) {
      log(`  • ${role}`);
    }
  }

  if (!roles.includes('roles/run.admin')) {
    log(`\n${chalk.bold.blue('INFO:')} To deploy to Cloud Run, grant run.admin:`);
    log(`  gcloud projects add-iam-policy-binding ${projectId} \\`);
    log(`    --member="serviceAccount:${sa}" \\`);
    log(`    --role="roles/run.admin"`);
  }

  let confirmed = false;
  confirmed = await prompt.confirmAccess('Proceed with this access level?');
  if (!confirmed) {
    log(chalk.bold.red('Aborted.'));
    process.exit(1);
  }

  log(`\nGenerating access token for ${sa}…`);
  let gcpToken: string;
  try {
    const out = await $`gcloud auth print-access-token --impersonate-service-account=${sa}`;
    gcpToken = out.stdout.trim();
  } catch {
    let currentAccount = '';
    try {
      const acc = await $`gcloud config get-value account`;
      currentAccount = acc.stdout.trim();
    } catch {
      // ignore
    }
    log(chalk.bold.red('ERROR:') + ' Failed to generate access token.');
    log('To grant impersonation rights, run:\n');
    log(`  gcloud iam service-accounts add-iam-policy-binding ${sa} \\`);
    log(`    --member="user:${currentAccount}" \\`);
    log(`    --role="roles/iam.serviceAccountTokenCreator" \\`);
    log(`    --project="${projectId}" \\`);
    log(`    --account="${currentAccount}"\n`);
    process.exit(1);
  }

  log('Enabling required APIs…');
  try {
    await $`gcloud services enable cloudresourcemanager.googleapis.com --project=${projectId} --impersonate-service-account=${sa}`;
    log(chalk.bold.green('OK:') + ' cloudresourcemanager.googleapis.com');
  } catch {
    log(chalk.bold.yellow('WARNING:') + ' Could not enable cloudresourcemanager.googleapis.com (may already be enabled or insufficient permissions).');
  }

  const gcpConfigDir = mkdtempSync(join(tmpdir(), 'safe-agent-cli-gcp-'));
  mkdirSync(join(gcpConfigDir, 'configurations'), { recursive: true });

  const tokenFile = join(gcpConfigDir, 'access_token');
  writeFileSync(tokenFile, gcpToken, { mode: 0o600 });
  writeFileSync(join(gcpConfigDir, 'active_config'), 'default');
  writeFileSync(
    join(gcpConfigDir, 'configurations', 'config_default'),
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

  const gcpAdcFile = join(gcpConfigDir, 'application_default_credentials.json');
  writeFileSync(
    gcpAdcFile,
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

  log(chalk.bold.green('Environment ready.') + ` gcloud config: ${gcpConfigDir}`);
  log(chalk.bold.green('OK:') + ` ADC configured via ${sa} (valid until ${tokenExpiry} UTC).`);

  return {
    credentialEnv: {
      CLOUDSDK_CONFIG: gcpConfigDir,
      GOOGLE_OAUTH_ACCESS_TOKEN: gcpToken,
      FIREBASE_TOKEN: gcpToken,
      GOOGLE_APPLICATION_CREDENTIALS: gcpAdcFile,
    },
    writableDirs: [gcpConfigDir],
    cleanupDirs: [gcpConfigDir],
    systemInstructionParts: roles.length === 0
      ? []
      : [
          `GCP credentials are available via environment variables. ` +
          `The environment variable GOOGLE_OAUTH_ACCESS_TOKEN is set to a short-lived access token, ` +
          `GOOGLE_APPLICATION_CREDENTIALS points to an Application Default Credentials file, ` +
          `and CLOUDSDK_CONFIG points to a gcloud configuration directory — all scoped to the ` +
          `service account ${sa} in project ${projectId}. ` +
          `The service account has the following IAM roles on the project: ${roles.join(', ')}.`,
        ],
    gcpToken,
    gcpConfigDir,
    gcpAdcFile,
  };
}
