import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { isGitRepo, missingMandatoryGithub } from '../src/git-remote.js';

describe('isGitRepo', () => {
  function withCwd(run: () => void): void {
    const originalCwd = process.cwd();
    try {
      run();
    } finally {
      process.chdir(originalCwd);
    }
  }

  test('true inside a git repository', () => {
    withCwd(() => {
      const dir = mkdtempSync(join(tmpdir(), 'repo-'));
      try {
        spawnSync('git', ['init', '--quiet'], { cwd: dir });
        process.chdir(dir);
        expect(isGitRepo()).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  test('false outside a git repository', () => {
    withCwd(() => {
      const dir = mkdtempSync(join(tmpdir(), 'not-a-repo-'));
      try {
        process.chdir(dir);
        expect(isGitRepo()).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

describe('missingMandatoryGithub', () => {
  test('true when in a git repo without GitHub integration enabled', () => {
    expect(missingMandatoryGithub(false, true)).toBe(true);
  });

  test('false when in a git repo with GitHub integration enabled', () => {
    expect(missingMandatoryGithub(true, true)).toBe(false);
  });

  test('false when not in a git repo, regardless of GitHub integration', () => {
    expect(missingMandatoryGithub(false, false)).toBe(false);
    expect(missingMandatoryGithub(true, false)).toBe(false);
  });
});
