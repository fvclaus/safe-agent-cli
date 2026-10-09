#!/usr/bin/env bun
import React, { useState, useMemo } from 'react';
import { render, Box, Text, useApp, useInput } from 'ink';
import { object } from '@optique/core/constructs';
import { message } from '@optique/core/message';
import { run } from '@optique/run';
import chalk from 'chalk';
import { rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import type { GcpCliArgs } from '../integrations/gcp.js';
import { gcpCliOptions, setupGcpIntegration } from '../integrations/gcp.js';
import type { GithubCliArgs } from '../integrations/github.js';
import { githubCliOptions, setupGithubIntegration } from '../integrations/github.js';
import { checkSensitiveEnv } from '../env-check.js';
import { isGitRepo, missingMandatoryGithub } from '../git-remote.js';
import { acquireSessionLock, releaseSessionLock } from '../session-lock.js';

const log = (msg: string) => process.stderr.write(msg + '\n');

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

async function inkPrompt<T>(element: React.ReactElement, resolve: () => T): Promise<T> {
  const { waitUntilExit } = render(element);
  await waitUntilExit();
  return resolve();
}

function isSnap(binary: string): boolean {
  const which = spawnSync('which', [binary], { encoding: 'utf8' });
  if (which.status !== 0) return false;
  const realpath = spawnSync('realpath', [which.stdout.trim()], { encoding: 'utf8' });
  return realpath.status === 0 && realpath.stdout.trim() === '/usr/bin/snap';
}

function checkOriginHead(): void {
  if (!isGitRepo()) return;

  const lsRemote = spawnSync('git', ['ls-remote', '--symref', 'origin', 'HEAD'], {
    encoding: 'utf8',
    timeout: 5000,
  });

  if (lsRemote.status !== 0 || lsRemote.error) {
    const localHead = spawnSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], { encoding: 'utf8' });
    if (localHead.status !== 0) {
      log(chalk.bold.yellow('WARNING:') + ' origin/HEAD is not set and the remote is unreachable.');
      log('Worktrees created by agents may use the wrong base branch.');
      log('Fix with: git remote set-head origin --auto');
    }
    return;
  }

  const match = lsRemote.stdout.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD/m);
  if (!match) return;
  const remoteDefault = match[1];
  const expectedLocalRef = `refs/remotes/origin/${remoteDefault}`;

  const localHead = spawnSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], { encoding: 'utf8' });

  if (localHead.status !== 0) {
    log(chalk.bold.yellow('WARNING:') + ` origin/HEAD is not set. The remote's default branch is "${remoteDefault}".`);
    log('Worktrees created by agents will use the wrong base branch.');
    log('Fix with: git remote set-head origin --auto');
    return;
  }

  const resolvedRef = localHead.stdout.trim();
  if (resolvedRef !== expectedLocalRef) {
    log(chalk.bold.yellow('WARNING:') + ` origin/HEAD → "${resolvedRef}" but the remote's default branch is "${remoteDefault}".`);
    log('Worktrees created by agents will use the wrong base branch.');
    log('Fix with: git remote set-head origin --auto');
  }
}

export function abortIfSnap(binary: string, installHint: string): void {
  if (!isSnap(binary)) return;
  log(chalk.bold.red('ERROR:') + ` ${binary} is installed via snap, which is not supported.`);
  log('Snap-installed tools do not work at all inside the Claude Code sandbox.');
  log('Snap launchers require a systemd user session to set up confinement.');
  log(`When ${binary} is spawned as a subprocess it cannot create the required`);
  log('transient scope, causing all commands to fail silently.');
  log(`Install ${binary} directly instead:  ${installHint}`);
  process.exit(1);
}

interface ParsedArgs extends GithubCliArgs, GcpCliArgs {
  project: string | undefined;
  /** The adapter's own boolean flags (see AgentAdapter.flags) that were passed. */
  adapterFlags: ReadonlySet<string>;
  rest: readonly string[];
}

export interface SafeAgentLaunchContext {
  args: ParsedArgs;
  writableDirs: string[];
  credentialEnv: Record<string, string>;
  systemInstructionParts: string[];
  systemInstructionText: string;
  githubToken?: string;
  gcpToken?: string;
  gcpConfigDir?: string;
  gcpAdcFile?: string;
  ghStateDir?: string;
}

/** A boolean switch only one adapter understands, e.g. `--skip-settings-schema`. */
export interface AdapterFlag {
  name: string;
  /** Lines are separated by '\n' and aligned under the first in --help. */
  help: string;
}

export interface AgentAdapter {
  programName: string;
  brief: string;
  executable: string;
  forwardedArgsTarget: string;
  launchLabel: string;
  flags?: AdapterFlag[];
  prepareLaunch?: (context: SafeAgentLaunchContext) => void | Promise<void>;
  buildLaunchArgs: (context: SafeAgentLaunchContext) => string[];
  buildSpawnEnv?: (context: SafeAgentLaunchContext) => NodeJS.ProcessEnv;
}

// --help/-h before `--` prints this launcher's own help; after `--` it is
// forwarded to the agent like any other argument.
function printHelpAndExit(adapter: AgentAdapter): never {
  log(adapter.brief);
  log('');
  const flags = adapter.flags ?? [];
  const flagUsage = flags.map(f => ` [${f.name}]`).join('');
  log(`Usage: ${adapter.programName} [--gh | --github [PAT_NAME]] [--gcp | --google-cloud] [--project <id>] [--service-account <name>]${flagUsage} [-- ...]`);
  log('');
  log('  --gh, --github [PAT_NAME]     Enable GitHub CLI integration (required when the');
  log('                                current directory is a git repository).');
  log('  --gcp, --google-cloud         Enable GCP integration.');
  log('  --project <id>                GCP project id, used with --gcp/--google-cloud.');
  log('  --service-account <name>      GCP service account to impersonate.');
  for (const f of flags) {
    const [first, ...more] = f.help.split('\n');
    log(`  ${f.name.padEnd(30)}${first}`);
    for (const line of more) log(`${' '.repeat(32)}${line}`);
  }
  log(`  -- ...                        Everything after '--' is forwarded to ${adapter.forwardedArgsTarget}.`);
  log('                                Unknown switches before \'--\' are an error.');
  process.exit(0);
}

// Only arguments after the first `--` are forwarded to the agent. Everything
// before it is parsed strictly, so an unknown switch (e.g. a typo like
// `--gcpp`) or a switch missing its value (e.g. a bare `--project`) is an
// error instead of being silently forwarded.
function splitAtSeparator(argv: string[]): { ownArgv: string[]; rest: string[] } {
  const separator = argv.indexOf('--');
  return separator === -1
    ? { ownArgv: argv, rest: [] }
    : { ownArgv: argv.slice(0, separator), rest: argv.slice(separator + 1) };
}

export async function runSafeAgentCli(adapter: AgentAdapter): Promise<void> {
  const { ownArgv, rest } = splitAtSeparator(process.argv.slice(2));
  if (ownArgv.some((a) => a === '--help' || a === '-h')) {
    printHelpAndExit(adapter);
  }

  abortIfSnap('uv', 'https://docs.astral.sh/uv/getting-started/installation/');
  // Adapter flags are plain booleans, so they're pulled out before the shared
  // integration options are parsed; anything left over is still parsed strictly.
  const adapterFlagNames = new Set((adapter.flags ?? []).map(f => f.name));
  const adapterFlags = new Set(ownArgv.filter(a => adapterFlagNames.has(a)));
  const parsed = await run(
    object({
      ...gcpCliOptions,
      ...githubCliOptions,
    }),
    {
      programName: adapter.programName,
      args: ownArgv.filter(a => !adapterFlagNames.has(a)),
      colors: true,
      brief: message`${adapter.brief}`,
    },
  );
  const args: ParsedArgs = { ...parsed, adapterFlags, rest };

  if (missingMandatoryGithub(args.gh !== undefined || args.github !== undefined, isGitRepo())) {
    log(chalk.bold.red('ERROR:') + ' this directory is a git repository; --gh/--github is required.');
    process.exit(1);
  }

  const github = await setupGithubIntegration({ args, log, abortIfSnap });
  const gcp = await setupGcpIntegration({
    args,
    log,
    abortIfSnap,
    prompt: {
      selectProject: async (projects, initialValue) => {
        let selected = '';
        return inkPrompt(
          <ProjectSelector projects={projects} initialValue={initialValue} onSelect={(project) => { selected = project; }} />,
          () => {
            if (!selected) {
              log(chalk.bold.red('Aborted.'));
              process.exit(1);
            }
            return selected;
          },
        );
      },
      confirmAccess: async (message) => {
        let confirmed = false;
        return inkPrompt(
          <ConfirmPrompt message={message} onConfirm={(yes) => { confirmed = yes; }} />,
          () => confirmed,
        );
      },
    },
  });

  const writableDirs = [...github.writableDirs, ...gcp.writableDirs];
  const credentialEnv = { ...github.credentialEnv, ...gcp.credentialEnv };
  const systemInstructionParts = [...github.systemInstructionParts, ...gcp.systemInstructionParts];

  const context: SafeAgentLaunchContext = {
    args,
    writableDirs,
    credentialEnv,
    systemInstructionParts,
    systemInstructionText: systemInstructionParts.join('\n'),
    ...(github.githubToken !== undefined ? { githubToken: github.githubToken } : {}),
    ...(gcp.gcpToken !== undefined ? { gcpToken: gcp.gcpToken } : {}),
    ...(gcp.gcpConfigDir !== undefined ? { gcpConfigDir: gcp.gcpConfigDir } : {}),
    ...(gcp.gcpAdcFile !== undefined ? { gcpAdcFile: gcp.gcpAdcFile } : {}),
    ...(github.ghStateDir !== undefined ? { ghStateDir: github.ghStateDir } : {}),
  };

  const cleanup = () => {
    releaseSessionLock();
    for (const dir of [...gcp.cleanupDirs, ...github.cleanupDirs]) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  };

  process.on('exit', cleanup);
  process.on('SIGINT',  () => { cleanup(); process.exit(130); });
  process.on('SIGTERM', () => { cleanup(); process.exit(143); });

  acquireSessionLock(process.cwd(), {
    agent: adapter.executable === 'codex' ? 'codex' : 'claude',
    isolation: 'proxy',
    github: context.githubToken !== undefined,
    gcp: context.gcpToken !== undefined,
  });

  checkOriginHead();
  await checkSensitiveEnv(credentialEnv, log);
  await adapter.prepareLaunch?.(context);

  log(`Launching ${adapter.launchLabel}…\n`);

  const launchArgs = adapter.buildLaunchArgs(context);
  const result = spawnSync(adapter.executable, launchArgs, {
    stdio: 'inherit',
    env: {
      ...process.env,
      ...credentialEnv,
      ...adapter.buildSpawnEnv?.(context),
    },
  });
  if (result.error) throw result.error;
  process.exit(result.status ?? 0);
}
