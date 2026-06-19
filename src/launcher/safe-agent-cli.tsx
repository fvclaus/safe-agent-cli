#!/usr/bin/env bun
import React, { useState, useMemo } from 'react';
import { render, Box, Text, useApp, useInput } from 'ink';
import { object } from '@optique/core/constructs';
import { passThrough } from '@optique/core/primitives';
import { message } from '@optique/core/message';
import { run } from '@optique/run';
import chalk from 'chalk';
import { rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import type { GcpCliArgs } from '../integrations/gcp.js';
import { gcpCliOptions, setupGcpIntegration } from '../integrations/gcp.js';
import type { GithubCliArgs } from '../integrations/github.js';
import { githubCliOptions, setupGithubIntegration } from '../integrations/github.js';

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
  const gitCheck = spawnSync('git', ['rev-parse', '--git-dir'], { encoding: 'utf8' });
  if (gitCheck.status !== 0) return;

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

export interface AgentAdapter {
  programName: string;
  brief: string;
  executable: string;
  forwardedArgsTarget: string;
  launchLabel: string;
  prepareLaunch?: (context: SafeAgentLaunchContext) => void;
  buildLaunchArgs: (context: SafeAgentLaunchContext) => string[];
  buildSpawnEnv?: (context: SafeAgentLaunchContext) => NodeJS.ProcessEnv;
}

export async function runSafeAgentCli(adapter: AgentAdapter): Promise<void> {
  abortIfSnap('uv', 'https://docs.astral.sh/uv/getting-started/installation/');
  const args = await run(
    object({
      ...gcpCliOptions,
      ...githubCliOptions,
      rest:        passThrough({ format: 'greedy', description: message`Extra arguments forwarded to ${adapter.forwardedArgsTarget}.` }),
    }),
    {
      programName: adapter.programName,
      help: 'option',
      colors: true,
      brief: message`${adapter.brief}`,
    },
  );

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
    for (const dir of [...gcp.cleanupDirs, ...github.cleanupDirs]) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  };

  process.on('exit', cleanup);
  process.on('SIGINT',  () => { cleanup(); process.exit(130); });
  process.on('SIGTERM', () => { cleanup(); process.exit(143); });

  checkOriginHead();
  adapter.prepareLaunch?.(context);

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
