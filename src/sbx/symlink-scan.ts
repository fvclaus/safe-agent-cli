import { existsSync, readdirSync, readlinkSync } from 'node:fs';
import { isAbsolute, join, sep } from 'node:path';

// sbx only mounts the project dir into the sandbox. A symlink inside the
// project dir whose target lives outside it (e.g. `.env` -> a real secrets
// file under $HOME, or a path injected by direnv/1Password/chezmoi) dangles
// in the sandbox — the target simply isn't there. This module finds such
// symlinks so sbx-claude-code can bind-mount their targets in (see
// symlink-mounts.ts for the approval + mount-arg orchestration).
//
// Only ABSOLUTE-target symlinks are handled. A relative symlink's resolution
// depends on the *sandbox's* directory layout matching the host's closely
// enough for the relative hops to land in the same place — not guaranteed,
// and not something safe-agent-cli can verify, so those are only warned
// about, never auto-mounted.
//
// Cost control: named directories (node_modules, .git, ...) are skipped
// outright by default (extendable via sbxSymlinkScanExcludeDirs), and if
// listing + recursing through the rest of one directory's entries takes
// longer than `warnMs`, the remaining entries in that directory are skipped
// (once, with a warning) rather than scanning an arbitrarily large subtree
// unconditionally.

export const DEFAULT_SYMLINK_SCAN_EXCLUDE_DIRS = ['node_modules', '.git', 'dist', 'build', '.next', 'target', 'vendor'];
export const DEFAULT_SYMLINK_SCAN_WARN_MS = 300;

export interface SymlinkMountCandidate {
  /** Absolute host path of the symlink itself, inside the project dir. */
  source: string;
  /**
   * Absolute host path the symlink points at (immediate readlink() target).
   * Also the bind-mount destination inside the sandbox, at the identical
   * absolute path — the mount presents the real content there regardless of
   * how many further symlink hops the host-side target itself involves.
   */
  target: string;
}

export interface SymlinkScanResult {
  candidates: SymlinkMountCandidate[];
  warnings: string[];
}

type SymlinkClassification =
  | { kind: 'inside-project' }
  | { kind: 'relative-unsupported' }
  | { kind: 'dangling' }
  | { kind: 'candidate'; target: string };

/** Pure classification, no I/O — testable without touching a real filesystem. */
export function classifySymlinkTarget(
  rawTarget: string,
  projectRoot: string,
  targetExistsOnHost: boolean,
): SymlinkClassification {
  if (!isAbsolute(rawTarget)) {
    return { kind: 'relative-unsupported' };
  }
  if (rawTarget === projectRoot || rawTarget.startsWith(projectRoot + sep)) {
    return { kind: 'inside-project' };
  }
  if (!targetExistsOnHost) {
    return { kind: 'dangling' };
  }
  return { kind: 'candidate', target: rawTarget };
}

export function scanForExternalSymlinks(
  projectRoot: string,
  options: { excludeDirs?: string[]; warnMs?: number } = {},
): SymlinkScanResult {
  const excludeDirs = new Set([...DEFAULT_SYMLINK_SCAN_EXCLUDE_DIRS, ...(options.excludeDirs ?? [])]);
  const warnMs = options.warnMs ?? DEFAULT_SYMLINK_SCAN_WARN_MS;
  const result: SymlinkScanResult = { candidates: [], warnings: [] };

  function walk(dir: string): void {
    const start = performance.now();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — nothing we can do
    }
    for (const entry of entries) {
      if (excludeDirs.has(entry.name)) continue;
      if (performance.now() - start > warnMs) {
        result.warnings.push(
          `scanning ${dir} for symlinks took longer than ${warnMs}ms — skipping the rest of this folder`,
        );
        return;
      }
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        let rawTarget: string;
        try {
          rawTarget = readlinkSync(full);
        } catch {
          continue;
        }
        const targetExists = isAbsolute(rawTarget) && existsSync(rawTarget);
        const classification = classifySymlinkTarget(rawTarget, projectRoot, targetExists);
        switch (classification.kind) {
          case 'inside-project':
            break; // already visible to the sandbox, nothing to do
          case 'relative-unsupported':
            result.warnings.push(
              `${full} -> ${rawTarget}: relative symlink target cannot be reliably bind-mounted into ` +
              'the sandbox (resolution depends on the sandbox\'s mount layout) — leaving as-is',
            );
            break;
          case 'dangling':
            result.warnings.push(`${full} -> ${rawTarget}: target does not exist on the host — skipping`);
            break;
          case 'candidate':
            result.candidates.push({ source: full, target: classification.target });
            break;
        }
      } else if (entry.isDirectory()) {
        walk(full);
      }
    }
  }

  walk(projectRoot);
  return result;
}
