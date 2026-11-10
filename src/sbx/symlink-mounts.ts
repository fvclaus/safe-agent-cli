import { statSync } from 'node:fs';
import {
  isSymlinkApproved,
  loadSymlinkApprovals,
  recordSymlinkApproval,
  saveSymlinkApprovals,
} from './symlink-approvals.js';
import { localStatePath } from '../local-state.js';
import { scanForExternalSymlinks, type SymlinkMountCandidate } from './symlink-scan.js';
import { promptSymlinkChecklist, type ChecklistOutcome } from './symlink-approval-prompt.js';

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
  /** From the scan: slow-subfolder notices. */
  warnings: string[];
  /** From the scan: symlinks whose target does not exist on the host. Non-empty ⇒ the launch must stop. */
  errors: string[];
}

export interface ResolveSymlinkMountPlanOptions {
  projectRoot: string;
  sandboxName: string;
  excludeDirs?: string[];
  warnMs?: number;
  /** Overrides the local state file holding the approvals — for tests. */
  approvalsPath?: string;
  /** Overrides the interactive checklist — for tests. Called only with not-yet-approved candidates. */
  select?: (
    sandboxName: string,
    candidates: SymlinkMountCandidate[],
    kinds: SymlinkTargetKind[],
  ) => Promise<ChecklistOutcome>;
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
    errors: scan.errors,
  };
  if (scan.candidates.length === 0) return result;

  const loaded = loadSymlinkApprovals(options.approvalsPath ?? localStatePath());
  if (loaded.warning !== undefined) result.warnings.push(loaded.warning);
  const store = loaded.store;
  const pending = scan.candidates.filter(
    (c) => !isSymlinkApproved(store, options.sandboxName, c.source, c.target),
  );
  const approved = new Set(scan.candidates.filter((c) => !pending.includes(c)));
  let storeChanged = false;

  if (pending.length > 0) {
    const kinds = pending.map((c) => classifySymlinkTargetKind(c.target));
    let outcome: ChecklistOutcome;
    if (options.select !== undefined) {
      outcome = await options.select(options.sandboxName, pending, kinds);
    } else if (process.stdin.isTTY) {
      outcome = await promptSymlinkChecklist(options.sandboxName, options.projectRoot, pending, kinds);
    } else {
      result.warnings.push(
        `no terminal to ask about ${pending.length} project symlink(s) pointing outside the project dir; declining them for this launch`,
      );
      outcome = pending.map(() => false);
    }
    if (outcome === null) {
      result.errors.push('symlink approval aborted (Ctrl+C)');
      return result;
    }
    pending.forEach((candidate, i) => {
      if (outcome[i]) {
        recordSymlinkApproval(store, options.sandboxName, candidate.source, candidate.target);
        storeChanged = true;
        approved.add(candidate);
      }
    });
  }

  for (const candidate of scan.candidates) {
    if (!approved.has(candidate)) {
      result.declined.push(candidate);
      continue;
    }
    if (classifySymlinkTargetKind(candidate.target) === 'directory') {
      result.mounted.push(candidate);
      result.bindMountArgs.push('--bind-mount', candidate.target);
    } else {
      result.fileCopies.push(candidate);
    }
  }

  if (storeChanged) {
    const warning = saveSymlinkApprovals(store);
    if (warning !== undefined) result.warnings.push(warning);
  }
  return result;
}
