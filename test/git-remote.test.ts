import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { gitDir, gitRepoDetectedMessage, isGitRepo, missingMandatoryGithub } from '../src/git-remote.js';

function withCwd(run: () => void): void {
  const originalCwd = process.cwd();
  try {
    run();
  } finally {
    process.chdir(originalCwd);
  }
}

describe('gitDir', () => {
  test('points at the parent .git from a plain subdirectory', () => {
    withCwd(() => {
      const dir = mkdtempSync(join(tmpdir(), 'repo-'));
      try {
        spawnSync('git', ['init', '--quiet'], { cwd: dir });
        const sub = join(dir, 'empty-subdir');
        mkdirSync(sub);
        process.chdir(sub);
        expect(gitDir()).toBe(join(realpathSync(dir), '.git'));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  test('undefined outside a git repository', () => {
    withCwd(() => {
      const dir = mkdtempSync(join(tmpdir(), 'not-a-repo-'));
      try {
        process.chdir(dir);
        expect(gitDir()).toBeUndefined();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

describe('gitRepoDetectedMessage', () => {
  test('names the detected .git location', () => {
    expect(gitRepoDetectedMessage('/home/u/.git')).toBe('this directory is a git repository (git found /home/u/.git)');
  });
});

describe('isGitRepo', () => {
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
