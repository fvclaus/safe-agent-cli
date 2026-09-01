#!/usr/bin/env bun
import chalk from 'chalk';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expandHome, generateClaudeLocalMd } from '../claude-fragments.js';
import { ensureClaudeSandboxSetting } from '../claude-sandbox-setting.js';
import { isGithubConfigured } from '../sbx/github-secret.js';
import { requireGenericScript, resolveSandboxName, runGenericScript } from '../sbx/generic-script.js';
import { syncSkillsIntoSandbox } from '../sbx/copy-skills.js';
import { mergeSettingsSbxIntoSandbox } from '../sbx/merge-settings.js';
import { loadSettingsSbx } from '../sbx/settings-sbx.js';
import { loadUserSettings } from '../user-settings.js';

const log = (msg: string) => {
  process.stderr.write(msg + '\n');
};

interface Args {
  genericScript?: string;
  /** Everything after `--`: the launch command handed to the generic script verbatim. */
  launchCommand: string[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = { launchCommand: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // Everything past the first `--` belongs to the generic script, not us —
    // stop parsing so a flag meant for it is never swallowed here.
    if (a === '--') {
      args.launchCommand = argv.slice(i + 1);
      break;
    }
    if (a === '--generic-script') {
      const value = argv[++i];
      if (value !== undefined) args.genericScript = value;
    } else if (a?.startsWith('--generic-script=')) {
      args.genericScript = a.slice('--generic-script='.length);
    } else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else if (a === '--gh' || a === '--github' || a?.startsWith('--gh=') || a?.startsWith('--github=')) {
      throw new Error(
        `${a} is not supported by sbx-claude-code — GitHub access inside sbx is proxy-managed. ` +
        'Configure it with `sbx secret set github` instead.',
      );
    } else {
      throw new Error(`unrecognized flag: ${a}\nUse '--' to pass flags through to the launch command instead.`);
    }
  }
  return args;
}

function printHelp(): void {
  process.stdout.write(`Usage: sbx-claude-code --generic-script <path> -- <command...>

Runs Claude Code inside an sbx (Docker Sandboxes) sandbox, wiring up
user-authored hooks (e.g. desktop notifications relayed to the host) that the
sandbox-creation script alone doesn't know about.

Required:
  --generic-script <path>   Script that knows how to build/name the sandbox
                             (e.g. claude-generic.sh). Must support the
                             'build' and 'resolve-name' commands.
                             No default — must be passed explicitly.

  -- <command...>           Everything after '--' is passed to the generic
                             script verbatim as the final launch step, once
                             the sandbox is built and set up. Nothing is
                             assumed about the script's command names — with
                             claude-generic.sh this is typically '-- run'.

                             Any switches AFTER the command name are also
                             forwarded to 'build' and 'resolve-name', since a
                             switch can change which sandbox is meant. Express
                             mode as a switch, not a separate command:
                             use '-- run --clone', NOT '-- clone' — a bare
                             command name does not propagate, so the sandbox
                             that gets prepared would not be the one launched.

Reads (required, hard error if missing or malformed):
  ~/.claude/settings-sbx.json   User-authored settings.json overlay: every key
                                 it declares (must include "hooks") is merged
                                 into the sandbox's in-container
                                 ~/.claude/settings.json, overwriting only
                                 those keys — everything else Claude Code
                                 itself wrote survives. E.g. add "tui":
                                 "default" here to keep Claude Code's
                                 terminal-UI renderer off fullscreen (avoids it
                                 wiping this script's setup output) across
                                 every sandbox rebuild.

Also honors claudeFragmentsDir / checkRtk from
~/.config/safe-agent-cli/settings.json, same as safe-claude-code — generates
CLAUDE.local.md (isolation: sbx) before the sandbox starts. GitHub-scoped
fragments are matched based on whether a "github" sbx secret is configured
(\`sbx secret ls --service github\`) — there is no --gh/--github flag here;
GitHub access under sbx is proxy-managed, configure it with
\`sbx secret set github\`.

Example:
  sbx-claude-code --generic-script ~/workspace/infrastructure/sbx/claude-generic.sh -- run
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const genericScript = requireGenericScript(args.genericScript);
  if (args.launchCommand.length === 0) {
    throw new Error(
      'a launch command is required after `--`.\n' +
      'sbx-claude-code makes no assumption about what the generic script calls its launch ' +
      'command, so pass it explicitly — e.g. `-- run` for claude-generic.sh.',
    );
  }

  // The first token is the launch command's own name — the script's business,
  // and meaningless to `build` / `resolve-name`. Everything after it may change
  // WHICH sandbox is meant (e.g. claude-generic.sh's --clone changes the
  // sandbox name), so it has to reach those two as well or we'd prepare one
  // sandbox and launch another. See resolveSandboxName's comment.
  const launchSwitches = args.launchCommand.slice(1);

  // The sbx (Docker sandboxes) container already provides isolation; Claude
  // Code's own bwrap-based sandbox running again inside it is redundant and
  // can conflict (nested sandboxing). Writes to the project's
  // .claude/settings.local.json — the generic script bind-mounts this
  // directory into the sandbox at the same path, so this is the same file
  // Claude Code reads once launched inside the container.
  ensureClaudeSandboxSetting(false, log);

  const settingsSbxPath = join(homedir(), '.claude', 'settings-sbx.json');
  const settingsSbx = loadSettingsSbx(settingsSbxPath);
  log(chalk.bold.green('OK:') + ` loaded ${settingsSbxPath}`);

  log(chalk.bold.cyan('>>') + ` ${genericScript} ${['build', ...launchSwitches].join(' ')}`);
  runGenericScript(genericScript, ['build', ...launchSwitches]);

  const sandboxName = resolveSandboxName(genericScript, launchSwitches);
  log(chalk.bold.green('OK:') + ` resolved sandbox name: ${sandboxName}`);

  // sbx proxies GitHub credentials into the container itself (see
  // sbx/github-secret.ts) — there's no --gh flag to wire up, only whether a
  // "github" service secret is configured for this sandbox.
  const github = isGithubConfigured(sandboxName);
  log(chalk.bold.green('OK:') + ` github: ${github ? 'configured (sbx secret)' : 'not configured'}`);

  const userSettings = loadUserSettings(log);
  if (userSettings.claudeFragmentsDir) {
    const dir = expandHome(userSettings.claudeFragmentsDir, homedir());
    const rtkMdPath = userSettings.checkRtk ? join(homedir(), '.claude', 'RTK.md') : undefined;
    // sbx-claude-code doesn't wire up --gcp yet, so gcp-scoped fragments never match here.
    const result = generateClaudeLocalMd(
      dir,
      process.cwd(),
      { isolation: 'sbx', github, githubMasked: false, gcp: false },
      rtkMdPath,
    );
    log(
      chalk.bold.green('OK:') +
        ` generated CLAUDE.local.md from ${result.matchedCount}/${result.totalCount} fragment(s) in ${dir}` +
        (result.rtkAppended ? ' (+ RTK.md)' : ''),
    );
  }

  mergeSettingsSbxIntoSandbox(sandboxName, settingsSbx);
  const mergedKeys = Object.keys(settingsSbx.values).join(', ');
  log(chalk.bold.green('OK:') + ` merged {${mergedKeys}} from ${settingsSbxPath} into sandbox '${sandboxName}'`);

  // Mirror host ~/.claude/skills into the sandbox (always-on when the host dir
  // exists). Host-wins per skill; sandbox-local skills are preserved and
  // host-synced skills the host dropped are pruned — see copy-skills.ts.
  const hostSkillsDir = join(homedir(), '.claude', 'skills');
  if (existsSync(hostSkillsDir)) {
    const skills = syncSkillsIntoSandbox(sandboxName, hostSkillsDir);
    log(
      chalk.bold.green('OK:') +
        ` skills: synced ${skills.synced.length}, pruned ${skills.pruned.length} in ${skills.totalMs.toFixed(0)}ms` +
        ` into sandbox '${sandboxName}'`,
    );
  }

  log(chalk.bold.cyan('>>') + ` ${genericScript} ${args.launchCommand.join(' ')}`);
  runGenericScript(genericScript, args.launchCommand);
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  process.stderr.write(`ERROR: ${msg}\n`);
  process.exit(1);
});
