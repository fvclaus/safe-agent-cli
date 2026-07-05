/**
 * Pure argument-transformation logic for the bwrap shim (src/bin/bwrap).
 *
 * Kept free of process/env/fs side effects so it can be unit-tested. The shim
 * itself is the thin I/O layer that reads argv/env, probes the filesystem, calls
 * these functions and execs the real bwrap.
 */
import { dirname, join } from 'node:path';

// Claude Code wraps each sandboxed command with a proxy-cleanup trap:
//     trap "kill %1 %2 2>/dev/null; exit" EXIT
// Under zsh a bare `exit` in a trap takes the status of the trap's last command
// (the `kill`), so the command's real exit code is lost — verified directly:
// `zsh -c 'trap "kill %1 %2 2>/dev/null; exit" EXIT; false'` reports 0, not 1.
// Rewrite it to capture $? first. Exactly one backslash before each `$` is what
// survives the single `zsh -c '...'` / `bash -c '...'` layer the harness actually
// uses, so $?/$rc expand at trap-fire time rather than when the trap is
// installed — verified against both `zsh -c` and `bash -c` directly; the fix is
// shell-agnostic and a no-op risk-free under bash, which doesn't have this bug.
export const OLD_TRAP = 'kill %1 %2 2>/dev/null; exit';
export const NEW_TRAP = 'rc=\\$?; kill %1 %2 2>/dev/null; exit \\$rc';

/**
 * Step 1: drop `--unshare-net` (so the sandbox shares the host network
 * namespace) and rewrite the exit-code-eating trap in every argument.
 */
export function stripUnshareNetAndFixTrap(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (const a of argv) {
    if (a === '--unshare-net') continue;
    out.push(a.split(OLD_TRAP).join(NEW_TRAP));
  }
  return out;
}

/** Extract the target path from a git worktree `.git` pointer file's contents. */
export function parseGitdir(pointerContents: string): string | null {
  const line = pointerContents.split('\n').find((l) => l.startsWith('gitdir:'));
  if (!line) return null;
  return line.slice('gitdir:'.length).trim().replace(/\r$/, '');
}

export interface WorktreeProbe {
  /** True when `src` is a git worktree pointer file (exists, is a file, ends in /.git). */
  isPointerFile(src: string): boolean;
  /** Read the pointer file's contents. Only called when isPointerFile(src) is true. */
  readPointer(src: string): string;
}

/**
 * Step 3: when the project is a git worktree, `.git` is a pointer file rather than
 * a directory. Claude Code binds only the pointer, not its target, so git fails
 * inside the sandbox. Inject the missing gitdir binds before the `--` separator.
 */
export function injectWorktreeBinds(args: readonly string[], probe: WorktreeProbe): string[] {
  const extra: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--ro-bind' && args[i] !== '--bind') continue;
    const src = args[i + 1];
    if (!src || !src.endsWith('/.git') || !probe.isPointerFile(src)) continue;

    const gitdir = parseGitdir(probe.readPointer(src));
    if (!gitdir) continue;

    // .git/worktrees/<name> -> .git (main repo git dir).
    // mainGitDir (.git) holds refs/heads, objects, packed-refs;
    // gitdir (.git/worktrees/<name>) holds HEAD, MERGE_HEAD, lock files.
    const mainGitDir = dirname(dirname(gitdir));
    extra.push('--bind', mainGitDir, mainGitDir, '--bind', gitdir, gitdir);
  }

  if (extra.length === 0) return [...args];

  const out: string[] = [];
  for (const a of args) {
    if (a === '--') out.push(...extra);
    out.push(a);
  }
  return out;
}

const SETTINGS_SUFFIX = '/.claude/settings.json';

/**
 * Discover the project root from the bwrap args. Claude Code always masks
 * <root>/.claude/settings.json, so its DEST reveals the root. Falls back to `cwd`.
 */
export function discoverProjectRoot(args: readonly string[], cwd: string): string {
  for (const a of args) {
    if (a.endsWith(SETTINGS_SUFFIX)) return a.slice(0, -SETTINGS_SUFFIX.length);
  }
  return cwd;
}

/**
 * Expand an allowWrite/denyWrite settings entry to an absolute path, or null to
 * skip it. The bare project root (`.` or the root itself) is skipped on purpose:
 * it is already the default rw mount, and honoring it would blanket-undeny
 * .git/config, .mcp.json and the dotfiles too. Env-var forms are unsupported.
 */
export function resolveSettingsPath(
  p: string,
  projectRoot: string,
  home: string,
): string | null {
  if (p === '.' || p === projectRoot) return null;
  if (p.startsWith('$')) return null;
  const s = p.replace(/\/$/, '');
  if (s.startsWith('/')) return s;
  if (s.startsWith('~/')) return join(home, s.slice(2));
  if (s.startsWith('./')) return join(projectRoot, s.slice(2));
  return join(projectRoot, s);
}

/** True when `dest` equals or is nested under any of `prefixes`. */
export function isWithin(dest: string, prefixes: readonly string[]): boolean {
  const d = dest.replace(/\/$/, '');
  return prefixes.some((w) => d === w || d.startsWith(w + '/'));
}

/**
 * Step 4a: reverse the harness's hardcoded deny wall for whitelisted paths whose
 * whole subtree is covered. Drop any `--ro-bind SRC DEST` triple whose DEST falls
 * inside an allowWrite prefix (and not inside a denyWrite prefix). bwrap applies
 * binds in order (last wins), so removing the later deny lets the earlier
 * read-write bind show through.
 *
 * This alone does NOT cover a whitelisted path *nested under* a denied parent
 * (e.g. allowWrite ".claude/hooks/.venv" while the harness denies ".claude/hooks"
 * as a whole): the parent's deny DEST is not inside the write prefix, so it is
 * kept, and — being mounted after the child's rw bind — it shadows the child.
 * appendWritableRebinds handles that case.
 *
 * `onUndeny` is invoked with each removed DEST for optional debug logging.
 */
export function stripDenyWall(
  args: readonly string[],
  writePrefixes: readonly string[],
  denyPrefixes: readonly string[],
  onUndeny?: (dest: string) => void,
): string[] {
  if (writePrefixes.length === 0) return [...args];

  const kept: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if ((a === '--ro-bind' || a === '--ro-bind-try') && i + 2 < args.length) {
      const dest = args[i + 2]!;
      if (isWithin(dest, writePrefixes) && !isWithin(dest, denyPrefixes)) {
        onUndeny?.(dest);
        i += 2; // skip the SRC and DEST that follow
        continue;
      }
    }
    kept.push(a);
  }
  return kept;
}

/**
 * Step 4b: guarantee each whitelisted path is writable by re-binding it
 * read-write *after* the deny wall, just before the `--` separator. bwrap applies
 * binds in order (last wins), so this overrides any ancestor `--ro-bind` the
 * harness layered on top — the case stripDenyWall can't reach (a whitelisted
 * subdir nested under a denied parent, e.g. ".claude/hooks/.venv" under a denied
 * ".claude/hooks"). The harness itself binds such paths rw, but too early, so its
 * own parent deny shadows them; re-binding last fixes the ordering.
 *
 * `prefixes` should already be filtered to paths that exist on disk (bwrap fails
 * to bind a missing source) and are not re-denied by denyWrite. Re-binding a path
 * that is already writable is a harmless idempotent mount.
 *
 * `onRebind` is invoked with each re-bound path for optional debug logging.
 */
export function appendWritableRebinds(
  args: readonly string[],
  prefixes: readonly string[],
  onRebind?: (path: string) => void,
): string[] {
  if (prefixes.length === 0) return [...args];

  const binds: string[] = [];
  for (const p of prefixes) {
    onRebind?.(p);
    binds.push('--bind', p, p);
  }

  const sep = args.indexOf('--');
  if (sep === -1) return [...args]; // no bwrap separator — not a sandbox invocation
  return [...args.slice(0, sep), ...binds, ...args.slice(sep)];
}
