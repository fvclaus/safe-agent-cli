import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadLocalState, writeLocalStateKey } from '../local-state.js';

// Bind-mounting a symlink's target into the sandbox (see symlink-mounts.ts)
// deliberately punches a hole in sbx's filesystem isolation — the sandbox
// gets to see a real host path outside the project dir. That's opt-in: the
// user is asked once per (sandbox, symlink source, resolved target) triple,
// and the approval is remembered so they aren't re-asked on every launch.
// Keying on the target too (not just the source path) means a rotated or
// redirected symlink — a materially different exposure — always re-prompts
// rather than silently inheriting an old approval.
//
// Approvals are machine-local state, kept under one key of the local state
// file (see local-state.ts).

export const SYMLINK_APPROVALS_KEY = 'sbxSymlinkApprovals';

export interface SymlinkApprovalStore {
  /** The local state file holding the approvals. */
  path: string;
  /** sandboxName -> symlink source path -> approved resolved target path. */
  data: Record<string, Record<string, string>>;
}

export interface LoadedSymlinkApprovals {
  store: SymlinkApprovalStore;
  /** Set when the local state file was malformed and moved aside. */
  warning?: string;
}

// TODO: remove soon. Deletes the approvals file used before approvals moved
// into the local state file; its approvals are not carried over.
function removeLegacySymlinkApprovals(statePath: string): void {
  rmSync(join(dirname(statePath), 'sbx-symlink-approvals.json'), { force: true });
}

export function loadSymlinkApprovals(statePath: string): LoadedSymlinkApprovals {
  removeLegacySymlinkApprovals(statePath);
  const { state, warning } = loadLocalState(statePath);
  const raw = state[SYMLINK_APPROVALS_KEY];
  const data = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, Record<string, string>>
    : {};
  return { store: { path: statePath, data }, ...(warning !== undefined && { warning }) };
}

export function isSymlinkApproved(
  store: SymlinkApprovalStore,
  sandboxName: string,
  source: string,
  target: string,
): boolean {
  return store.data[sandboxName]?.[source] === target;
}

export function recordSymlinkApproval(
  store: SymlinkApprovalStore,
  sandboxName: string,
  source: string,
  target: string,
): void {
  (store.data[sandboxName] ??= {})[source] = target;
}

/** Returns a warning if the local state file had become malformed and was moved aside. */
export function saveSymlinkApprovals(store: SymlinkApprovalStore): string | undefined {
  return writeLocalStateKey(store.path, SYMLINK_APPROVALS_KEY, store.data);
}
