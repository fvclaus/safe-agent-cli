import { statSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import {
  isSymlinkApproved,
  loadSymlinkApprovals,
  recordSymlinkApproval,
  saveSymlinkApprovals,
  symlinkApprovalsPath,
} from './symlink-approvals.js';
import { scanForExternalSymlinks, type SymlinkMountCandidate } from './symlink-scan.js';

// Ties the scan (symlink-scan.ts) and the approval store (symlink-approvals.ts)
// together into a mount plan. `sbx create` only accepts DIRECTORY workspaces,
// so a symlink target is routed by kind:
//   - directory -> `--bind-mount <target>` passed to `build` (live, two-way;
//     see CLAUDE.md's sbx adapter section).
//   - file -> pushed one-way via `sbx cp` after the sandbox exists (see
//     symlink-copy.ts) rather than bind-mounting its parent directory, which
//     would expose every sibling in it beyond what was actually approved.
// Both land at the identical absolute path inside the sandbox, so the
// project's existing (otherwise dangling) symlink resolves without rewriting.

export type SymlinkTargetKind = 'directory' | 'file';

/**
 * Routes a target to the bind-mount path (directory) or the copy path
 * (file). Best-effort: if the target vanished after the scan, falls back to
 * 'file' — the copy path surfaces its own clear error rather than silently
 * dropping the candidate.
 */
export function classifySymlinkTargetKind(target: string): SymlinkTargetKind {
  try {
    return statSync(target).isDirectory() ? 'directory' : 'file';
  } catch {
    return 'file';
  }
}

export interface SymlinkMountPlan {
  /** Ready to append to the `build` argv, e.g. ['--bind-mount', '/abs/dir', ...]. Directory targets only. */
  bindMountArgs: string[];
  /** Directory-target candidates, live bind-mounted via `bindMountArgs`. */
  mounted: SymlinkMountCandidate[];
  /** File-target candidates, approved but not yet pushed — push after `build` via symlink-copy.ts. */
  fileCopies: SymlinkMountCandidate[];
  declined: SymlinkMountCandidate[];
  /** From the scan: relative-target, dangling, or slow-subfolder notices. */
  warnings: string[];
}

async function promptSymlinkApproval(candidate: SymlinkMountCandidate, sandboxName: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const behaviorNote =
      classifySymlinkTargetKind(candidate.target) === 'directory'
        ? '  This is a directory: it will be live bind-mounted (edits sync both ways).\n'
        : '  This is a file: its content will be copied in at launch (one-way — edits\n' +
          '  made inside the sandbox are not synced back, and are overwritten with\n' +
          '  fresh host content on the next launch).\n';
    const answer = await rl.question(
      `sbx-claude-code: sandbox '${sandboxName}' has a project symlink pointing outside the project dir:\n` +
      `  ${candidate.source}\n  -> ${candidate.target}\n` +
      behaviorNote +
      'Let the sandbox see this host path so the symlink resolves? [y/N] ',
    );
    const normalized = answer.trim().toLowerCase();
    return normalized === 'y' || normalized === 'yes';
  } finally {
    rl.close();
  }
}

export interface ResolveSymlinkMountPlanOptions {
  projectRoot: string;
  sandboxName: string;
  excludeDirs?: string[];
  warnMs?: number;
  /** Overrides the approval store location — for tests. */
  approvalsPath?: string;
  /** Overrides the interactive prompt — for tests. */
  confirm?: (candidate: SymlinkMountCandidate, sandboxName: string) => Promise<boolean>;
}

export async function resolveSymlinkMountPlan(
  options: ResolveSymlinkMountPlanOptions,
): Promise<SymlinkMountPlan> {
  const scan = scanForExternalSymlinks(options.projectRoot, {
    ...(options.excludeDirs !== undefined && { excludeDirs: options.excludeDirs }),
    ...(options.warnMs !== undefined && { warnMs: options.warnMs }),
  });

  const result: SymlinkMountPlan = {
    bindMountArgs: [],
    mounted: [],
    fileCopies: [],
    declined: [],
    warnings: scan.warnings,
  };
  if (scan.candidates.length === 0) return result;

  const approvalsPath = options.approvalsPath ?? symlinkApprovalsPath();
  const store = loadSymlinkApprovals(approvalsPath);
  const confirm = options.confirm ?? promptSymlinkApproval;
  let storeChanged = false;

  for (const candidate of scan.candidates) {
    const alreadyApproved = isSymlinkApproved(store, options.sandboxName, candidate.source, candidate.target);
    if (!alreadyApproved) {
      const approved = await confirm(candidate, options.sandboxName);
      if (!approved) {
        result.declined.push(candidate);
        continue;
      }
      recordSymlinkApproval(store, options.sandboxName, candidate.source, candidate.target);
      storeChanged = true;
    }

    if (classifySymlinkTargetKind(candidate.target) === 'directory') {
      result.mounted.push(candidate);
      result.bindMountArgs.push('--bind-mount', candidate.target);
    } else {
      result.fileCopies.push(candidate);
    }
  }

  if (storeChanged) saveSymlinkApprovals(store);
  return result;
}
