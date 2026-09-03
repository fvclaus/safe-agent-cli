import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// Bind-mounting a symlink's target into the sandbox (see symlink-mounts.ts)
// deliberately punches a hole in sbx's filesystem isolation — the sandbox
// gets to see a real host path outside the project dir. That's opt-in: the
// user is asked once per (sandbox, symlink source, resolved target) triple,
// and the approval is remembered here so they aren't re-asked on every
// launch. Keying on the target too (not just the source path) means a
// rotated or redirected symlink — a materially different exposure — always
// re-prompts rather than silently inheriting an old approval.
//
// Lives under the same config root as session-lock.ts and user-settings.ts.
// Kept out of the project directory for the same reason as the session lock:
// purely internal bookkeeping, never meant to be read or edited by a human.

export interface SymlinkApprovalStore {
  path: string;
  /** sandboxName -> symlink source path -> approved resolved target path. */
  data: Record<string, Record<string, string>>;
}

export function symlinkApprovalsPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const xdg = env['XDG_CONFIG_HOME']?.trim();
  return join(xdg || join(home, '.config'), 'safe-agent-cli', 'sbx-symlink-approvals.json');
}

export function loadSymlinkApprovals(path: string): SymlinkApprovalStore {
  if (!existsSync(path)) return { path, data: {} };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
      return { path, data: raw as Record<string, Record<string, string>> };
    }
  } catch {
    // corrupt file — treat as empty; the next save overwrites it with valid JSON.
  }
  return { path, data: {} };
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

export function saveSymlinkApprovals(store: SymlinkApprovalStore): void {
  mkdirSync(dirname(store.path), { recursive: true });
  writeFileSync(store.path, JSON.stringify(store.data, null, 2), 'utf8');
}
