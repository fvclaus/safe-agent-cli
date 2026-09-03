import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isSymlinkApproved,
  loadSymlinkApprovals,
  recordSymlinkApproval,
  saveSymlinkApprovals,
  symlinkApprovalsPath,
} from '../src/sbx/symlink-approvals.js';

describe('symlinkApprovalsPath', () => {
  test('defaults to ~/.config/safe-agent-cli/sbx-symlink-approvals.json', () => {
    expect(symlinkApprovalsPath({}, '/home/u')).toBe('/home/u/.config/safe-agent-cli/sbx-symlink-approvals.json');
  });

  test('respects XDG_CONFIG_HOME', () => {
    expect(symlinkApprovalsPath({ XDG_CONFIG_HOME: '/xdg' }, '/home/u'))
      .toBe('/xdg/safe-agent-cli/sbx-symlink-approvals.json');
  });
});

describe('loadSymlinkApprovals', () => {
  function withTmpDir(run: (dir: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), 'symlink-approvals-test-'));
    try {
      run(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test('missing file yields an empty store', () => {
    withTmpDir((dir) => {
      const store = loadSymlinkApprovals(join(dir, 'missing.json'));
      expect(store.data).toEqual({});
    });
  });

  test('corrupt JSON is treated as empty rather than thrown', () => {
    withTmpDir((dir) => {
      const path = join(dir, 'approvals.json');
      writeFileSync(path, '{not json', 'utf8');
      const store = loadSymlinkApprovals(path);
      expect(store.data).toEqual({});
    });
  });

  test('non-object JSON is treated as empty', () => {
    withTmpDir((dir) => {
      const path = join(dir, 'approvals.json');
      writeFileSync(path, '[1,2,3]', 'utf8');
      expect(loadSymlinkApprovals(path).data).toEqual({});
    });
  });

  test('round-trips through save/load', () => {
    withTmpDir((dir) => {
      const path = join(dir, 'nested', 'approvals.json');
      const store = { path, data: {} };
      recordSymlinkApproval(store, 'sandbox-a', '/proj/.env', '/home/u/.secrets/env');
      saveSymlinkApprovals(store);

      expect(existsSync(path)).toBe(true);
      const reloaded = loadSymlinkApprovals(path);
      expect(reloaded.data).toEqual({ 'sandbox-a': { '/proj/.env': '/home/u/.secrets/env' } });
    });
  });
});

describe('isSymlinkApproved / recordSymlinkApproval', () => {
  test('unknown sandbox/source is not approved', () => {
    const store = { path: '/tmp/x.json', data: {} };
    expect(isSymlinkApproved(store, 'sandbox-a', '/proj/.env', '/home/u/.secrets/env')).toBe(false);
  });

  test('records and reports approval for exact (source, target)', () => {
    const store = { path: '/tmp/x.json', data: {} };
    recordSymlinkApproval(store, 'sandbox-a', '/proj/.env', '/home/u/.secrets/env');
    expect(isSymlinkApproved(store, 'sandbox-a', '/proj/.env', '/home/u/.secrets/env')).toBe(true);
  });

  test('a different sandbox is not implicitly approved', () => {
    const store = { path: '/tmp/x.json', data: {} };
    recordSymlinkApproval(store, 'sandbox-a', '/proj/.env', '/home/u/.secrets/env');
    expect(isSymlinkApproved(store, 'sandbox-b', '/proj/.env', '/home/u/.secrets/env')).toBe(false);
  });

  test('a changed target re-invalidates approval (rotated/redirected symlink)', () => {
    const store = { path: '/tmp/x.json', data: {} };
    recordSymlinkApproval(store, 'sandbox-a', '/proj/.env', '/home/u/.secrets/env');
    expect(isSymlinkApproved(store, 'sandbox-a', '/proj/.env', '/home/u/.secrets/env-rotated')).toBe(false);
  });
});
