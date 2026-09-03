import { mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { runSbx } from './copy-skills.js';
import type { SymlinkMountCandidate } from './symlink-scan.js';

// A symlink target that's a FILE can't be bind-mounted directly — `sbx create`
// only accepts directory workspaces. Rather than bind-mount its parent
// directory (which would expose every sibling in it, not just the approved
// file), the file's content is pushed into the sandbox at its identical
// absolute path via `sbx cp`, the same mechanism copy-skills.ts already uses.
// This is a ONE-WAY, per-launch push: edits made to the copy inside the
// sandbox are never read back, and are overwritten with fresh host content on
// the next launch (see the CLAUDE.local.md notice generated alongside this —
// claude-fragments.ts's copiedSymlinkPaths).

/** Stages a dereferenced copy of one host file, then pushes it into the sandbox at the identical absolute path. */
function pushFile(sandboxName: string, absPath: string): void {
  const containerDir = dirname(absPath);
  // -u root: absPath mirrors an arbitrary host path (e.g. under
  // /home/<user>/...), not necessarily anywhere the sandbox's normal exec
  // user can create directories in the container's own filesystem — mkdir -p
  // as the default user fails with "Permission denied" there. mkdir -p
  // itself is what needs root; the ownership/mode `mkdir -p` leaves behind
  // (typically world-traversable by default) is enough for `sbx cp` and the
  // eventual reader.
  runSbx(
    ['exec', '-u', 'root', sandboxName, 'mkdir', '-p', containerDir],
    `creating ${containerDir} in sandbox '${sandboxName}'`,
  );

  const tmpDir = mkdtempSync(join(tmpdir(), 'sbx-claude-code-symlink-'));
  try {
    const staged = join(tmpDir, basename(absPath));
    // -L dereferences: if absPath is itself a symlink (e.g. a secrets
    // manager's own indirection), the sandbox gets real content, not another
    // dangling link.
    const cp = spawnSync('cp', ['-L', absPath, staged], { encoding: 'utf8' });
    if (cp.error) throw cp.error;
    if ((cp.status ?? 1) !== 0) {
      throw new Error(`staging ${absPath} failed: ${cp.stderr}`);
    }
    runSbx(['cp', staged, `${sandboxName}:${absPath}`], `copying ${absPath} into sandbox '${sandboxName}'`);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** Pushes every approved file-target symlink's content into the sandbox, at its identical absolute path. No-op for an empty list. */
export function copySymlinkFilesIntoSandbox(sandboxName: string, candidates: SymlinkMountCandidate[]): void {
  for (const candidate of candidates) {
    pushFile(sandboxName, candidate.target);
  }
}
