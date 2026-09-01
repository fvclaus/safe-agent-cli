import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// Guards against two safe-agent-cli sessions running concurrently against the
// same project with different settings — e.g. one launched via the bwrap
// sandbox, one via sbx, or one with --gh and one without. Both write shared
// host-side state (CLAUDE.local.md, .claude/settings.local.json's
// sandbox.enabled) keyed only by the project directory, so a second launch
// with different settings silently invalidates what the first session may
// still be relying on mid-session. This is a confusion/wasted-effort risk,
// not a security boundary — the lock is best-effort (plain read/write, no
// atomic rename or flock) and only refuses a launch when the *other*
// session's process is still actually alive.
export interface SessionFingerprint {
  agent: 'claude' | 'codex';
  isolation: 'proxy' | 'sbx';
  github: boolean;
  gcp: boolean;
}

interface LockFile {
  pid: number;
  fingerprint: SessionFingerprint;
}

// Kept out of the project directory (unlike CLAUDE.local.md) so it never adds
// yet another file for the user to gitignore or trip over — this is purely
// internal bookkeeping, never meant to be read or edited by a human. Lives
// under the same config root as user-settings.ts's settings.json, keyed by a
// hash of repoRoot since a path can't be used directly as a filename.
function lockPath(
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const xdg = env['XDG_CONFIG_HOME']?.trim();
  const configDir = join(xdg || join(home, '.config'), 'safe-agent-cli');
  const key = createHash('sha256').update(repoRoot).digest('hex');
  return join(configDir, 'session-locks', `${key}.json`);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the process exists but is owned by someone else — still alive.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readLock(path: string): LockFile | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as LockFile;
  } catch {
    return undefined; // corrupt lock file — treat as absent, will be reclaimed
  }
}

let heldLockPath: string | undefined;

/**
 * Acquires the session lock for `repoRoot`. If another session's process is
 * still alive holding a lock with a *different* fingerprint, throws — the
 * caller is expected to treat that as fatal (both entrypoints already
 * `.catch()` and report thrown errors). A live lock with a matching
 * fingerprint is fine to run alongside (harmless, since both sessions would
 * write the same content). A dead-PID lock is silently reclaimed.
 */
export function acquireSessionLock(repoRoot: string, fingerprint: SessionFingerprint): void {
  const path = lockPath(repoRoot);
  const existing = readLock(path);

  if (existing && isProcessAlive(existing.pid)) {
    if (JSON.stringify(existing.fingerprint) === JSON.stringify(fingerprint)) {
      return;
    }
    throw new Error(
      `another safe-agent-cli session (pid ${existing.pid}) is already running against this project ` +
      `with different settings:\n${JSON.stringify(existing.fingerprint, null, 2)}\n` +
      'Close it first, or align the flags/mode, and retry.',
    );
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ pid: process.pid, fingerprint } satisfies LockFile, null, 2), 'utf8');
  heldLockPath = path;
}

/** Releases the lock this process holds, if any — a no-op if it was never acquired or already released. */
export function releaseSessionLock(): void {
  if (!heldLockPath) return;
  const path = heldLockPath;
  heldLockPath = undefined;
  const existing = readLock(path);
  if (existing?.pid === process.pid) {
    try { unlinkSync(path); } catch { /* ignore */ }
  }
}
