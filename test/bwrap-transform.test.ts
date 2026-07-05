import { describe, expect, test } from 'bun:test';
import {
  appendWritableRebinds,
  discoverProjectRoot,
  injectWorktreeBinds,
  isWithin,
  NEW_TRAP,
  OLD_TRAP,
  parseGitdir,
  resolveSettingsPath,
  stripDenyWall,
  stripUnshareNetAndFixTrap,
  type WorktreeProbe,
} from '../src/bin/bwrap-transform.js';

describe('stripUnshareNetAndFixTrap', () => {
  test('drops --unshare-net so the sandbox shares the host network namespace', () => {
    expect(stripUnshareNetAndFixTrap(['a', '--unshare-net', 'b'])).toEqual(['a', 'b']);
  });

  test('leaves unrelated args untouched', () => {
    const args = ['--ro-bind', '/', '/', '--dev', '/dev'];
    expect(stripUnshareNetAndFixTrap(args)).toEqual(args);
  });

  test('rewrites the trap so the real exit code is captured', () => {
    const arg = `socat &\ntrap "${OLD_TRAP}" EXIT`;
    expect(stripUnshareNetAndFixTrap([arg])).toEqual([`socat &\ntrap "${NEW_TRAP}" EXIT`]);
  });

  test('applies the trap rewrite exactly once (no doubling)', () => {
    const [out] = stripUnshareNetAndFixTrap([`pre ${OLD_TRAP} post`]);
    expect(out).toBe(`pre ${NEW_TRAP} post`);
    expect(out!.match(/rc=/g)).toHaveLength(1);
  });

  test('NEW_TRAP carries exactly one backslash before each $', () => {
    // Verified directly against real `zsh -c` and `bash -c`: one backslash is
    // what survives the single -c '...' layer the harness actually uses, and
    // fixes the exit-code bug (zsh: 0 -> 1 for a failing command) without
    // affecting bash, which never had the bug.
    expect(NEW_TRAP).toBe('rc=\\$?; kill %1 %2 2>/dev/null; exit \\$rc');
    expect(NEW_TRAP.match(/\\/g)).toHaveLength(2);
  });

  test('no-op when the trap is absent', () => {
    expect(stripUnshareNetAndFixTrap(['echo hi'])).toEqual(['echo hi']);
  });
});

describe('parseGitdir', () => {
  test('extracts the gitdir target', () => {
    expect(parseGitdir('gitdir: /main/.git/worktrees/wt\n')).toBe('/main/.git/worktrees/wt');
  });

  test('trims a trailing carriage return (CRLF pointer files)', () => {
    expect(parseGitdir('gitdir: /main/.git/worktrees/wt\r\n')).toBe('/main/.git/worktrees/wt');
  });

  test('returns null when there is no gitdir line', () => {
    expect(parseGitdir('not a pointer file')).toBeNull();
  });
});

describe('injectWorktreeBinds', () => {
  const pointerProbe = (contents: string): WorktreeProbe => ({
    isPointerFile: () => true,
    readPointer: () => contents,
  });

  test('injects main + worktree gitdir binds before the -- separator', () => {
    const args = ['--bind', '/wt/.git', '/wt/.git', '--', 'cmd'];
    const out = injectWorktreeBinds(args, pointerProbe('gitdir: /main/.git/worktrees/wt\n'));
    expect(out).toEqual([
      '--bind', '/wt/.git', '/wt/.git',
      '--bind', '/main/.git', '/main/.git',
      '--bind', '/main/.git/worktrees/wt', '/main/.git/worktrees/wt',
      '--', 'cmd',
    ]);
  });

  test('is a no-op when .git is not a pointer file (normal repo)', () => {
    const args = ['--bind', '/repo/.git', '/repo/.git', '--', 'cmd'];
    const probe: WorktreeProbe = { isPointerFile: () => false, readPointer: () => '' };
    expect(injectWorktreeBinds(args, probe)).toEqual(args);
  });

  test('ignores non-.git bind sources', () => {
    const args = ['--bind', '/repo/src', '/repo/src', '--', 'cmd'];
    const probe: WorktreeProbe = {
      isPointerFile: () => {
        throw new Error('should not probe a non-.git source');
      },
      readPointer: () => '',
    };
    expect(injectWorktreeBinds(args, probe)).toEqual(args);
  });
});

describe('discoverProjectRoot', () => {
  test('derives the root from the masked .claude/settings.json DEST', () => {
    const args = ['--ro-bind', '/home/proj/.claude/settings.json', '/home/proj/.claude/settings.json'];
    expect(discoverProjectRoot(args, '/cwd')).toBe('/home/proj');
  });

  test('falls back to cwd when no settings.json mask is present', () => {
    expect(discoverProjectRoot(['--ro-bind', '/', '/'], '/cwd')).toBe('/cwd');
  });
});

describe('resolveSettingsPath', () => {
  const root = '/home/proj';
  const home = '/home/me';
  const r = (p: string) => resolveSettingsPath(p, root, home);

  test('skips the bare project root ("." and the absolute root)', () => {
    expect(r('.')).toBeNull();
    expect(r(root)).toBeNull();
  });

  test('skips unsupported env-var forms', () => {
    expect(r('$TMPDIR')).toBeNull();
  });

  test('passes absolute paths through, stripping a trailing slash', () => {
    expect(r('/abs/path')).toBe('/abs/path');
    expect(r('/abs/path/')).toBe('/abs/path');
  });

  test('expands ~/ against HOME', () => {
    expect(r('~/x')).toBe('/home/me/x');
  });

  test('resolves ./ and bare relative entries against the project root', () => {
    expect(r('./x')).toBe('/home/proj/x');
    expect(r('.claude')).toBe('/home/proj/.claude');
    expect(r('.claude/')).toBe('/home/proj/.claude');
  });
});

describe('isWithin', () => {
  test('matches an exact path', () => {
    expect(isWithin('/a/b', ['/a/b'])).toBe(true);
  });

  test('matches a nested path', () => {
    expect(isWithin('/a/b/c', ['/a/b'])).toBe(true);
  });

  test('normalizes a trailing slash on the candidate', () => {
    expect(isWithin('/a/b/', ['/a/b'])).toBe(true);
  });

  test('respects path boundaries (no prefix-string false positives)', () => {
    expect(isWithin('/a/bc', ['/a/b'])).toBe(false);
  });

  test('is false against an empty prefix list', () => {
    expect(isWithin('/a/b', [])).toBe(false);
  });
});

describe('stripDenyWall', () => {
  const write = ['/proj/.claude'];

  test('drops deny ro-binds within an allowWrite path so the rw bind shows through', () => {
    const undenied: string[] = [];
    const args = [
      '--ro-bind', '/', '/',
      '--bind', '/proj', '/proj',
      '--ro-bind', '/proj/.claude/settings.json', '/proj/.claude/settings.json',
      '--ro-bind', '/dev/null', '/proj/.claude/launch.json',
      '--', 'cmd',
    ];
    const out = stripDenyWall(args, write, [], (d) => undenied.push(d));
    expect(out).toEqual(['--ro-bind', '/', '/', '--bind', '/proj', '/proj', '--', 'cmd']);
    expect(undenied).toEqual(['/proj/.claude/settings.json', '/proj/.claude/launch.json']);
  });

  test('keeps deny ro-binds outside any allowWrite path (.git stays read-only)', () => {
    const args = ['--ro-bind', '/proj/.git/config', '/proj/.git/config'];
    expect(stripDenyWall(args, write, [])).toEqual(args);
  });

  test('keeps a masked deny for a different project root', () => {
    const args = ['--ro-bind', '/other/.claude/skills', '/other/.claude/skills'];
    expect(stripDenyWall(args, write, [])).toEqual(args);
  });

  test('re-protects a subtree listed in denyWrite', () => {
    const args = [
      '--ro-bind', '/proj/.claude/secret', '/proj/.claude/secret',
      '--ro-bind', '/proj/.claude/open', '/proj/.claude/open',
    ];
    const out = stripDenyWall(args, write, ['/proj/.claude/secret']);
    expect(out).toEqual(['--ro-bind', '/proj/.claude/secret', '/proj/.claude/secret']);
  });

  test('handles --ro-bind-try the same as --ro-bind', () => {
    const args = ['--ro-bind-try', '/proj/.claude/hooks', '/proj/.claude/hooks'];
    expect(stripDenyWall(args, write, [])).toEqual([]);
  });

  test('does nothing when there are no allowWrite prefixes', () => {
    const args = ['--ro-bind', '/proj/.claude/settings.json', '/proj/.claude/settings.json'];
    expect(stripDenyWall(args, [], [])).toEqual(args);
  });

  test('never leaves a dangling arg — the SRC/DEST pair is skipped cleanly', () => {
    const args = [
      '--ro-bind', '/dev/null', '/proj/.claude/launch.json',
      '--bind', '/keep', '/keep',
    ];
    expect(stripDenyWall(args, write, [])).toEqual(['--bind', '/keep', '/keep']);
  });

  test('does not treat --bind as a deny (write binds are preserved)', () => {
    const args = ['--bind', '/proj/.claude', '/proj/.claude'];
    expect(stripDenyWall(args, write, [])).toEqual(args);
  });
});

describe('appendWritableRebinds', () => {
  test('re-binds a whitelisted subdir after an ancestor deny so it wins (last mount)', () => {
    // The real-world da_system_backend case: allowWrite ".claude/hooks/.venv"
    // while the harness denies the parent ".claude/hooks" as a whole.
    const rebound: string[] = [];
    const args = [
      '--bind', '/proj/.claude/hooks/.venv', '/proj/.claude/hooks/.venv', // harness rw bind (too early)
      '--ro-bind', '/proj/.claude/hooks', '/proj/.claude/hooks', // deny wall shadows the venv bind
      '--', 'cmd',
    ];
    const out = appendWritableRebinds(args, ['/proj/.claude/hooks/.venv'], (p) => rebound.push(p));
    expect(out).toEqual([
      '--bind', '/proj/.claude/hooks/.venv', '/proj/.claude/hooks/.venv',
      '--ro-bind', '/proj/.claude/hooks', '/proj/.claude/hooks',
      '--bind', '/proj/.claude/hooks/.venv', '/proj/.claude/hooks/.venv', // re-bound last -> writable
      '--', 'cmd',
    ]);
    expect(rebound).toEqual(['/proj/.claude/hooks/.venv']);
  });

  test('inserts the rebinds immediately before the -- separator', () => {
    const args = ['--ro-bind', '/', '/', '--', 'cmd'];
    expect(appendWritableRebinds(args, ['/proj/.venv'])).toEqual([
      '--ro-bind', '/', '/', '--bind', '/proj/.venv', '/proj/.venv', '--', 'cmd',
    ]);
  });

  test('re-binds multiple whitelisted paths', () => {
    const out = appendWritableRebinds(['--', 'cmd'], ['/a', '/b']);
    expect(out).toEqual(['--bind', '/a', '/a', '--bind', '/b', '/b', '--', 'cmd']);
  });

  test('is a no-op with no prefixes', () => {
    const args = ['--ro-bind', '/', '/', '--', 'cmd'];
    expect(appendWritableRebinds(args, [])).toEqual(args);
  });

  test('does nothing when there is no -- separator (not a sandbox invocation)', () => {
    const args = ['--version'];
    expect(appendWritableRebinds(args, ['/a'])).toEqual(args);
  });
});
