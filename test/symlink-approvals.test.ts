import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isSymlinkApproved,
  loadSymlinkApprovals,
  recordSymlinkApproval,
  saveSymlinkApprovals,
  SYMLINK_APPROVALS_KEY,
} from '../src/sbx/symlink-approvals.js';

function withTmpDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'symlink-approvals-test-'));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('loadSymlinkApprovals', () => {
  test('missing file yields an empty store', () => withTmpDir((dir) => {
    const { store, warning } = loadSymlinkApprovals(join(dir, 'state.json'));
    expect(store.data).toEqual({});
    expect(warning).toBeUndefined();
  }));

  test('a malformed state file is moved aside with a warning', () => withTmpDir((dir) => {
    const path = join(dir, 'state.json');
    writeFileSync(path, '{not json', 'utf8');
    const { store, warning } = loadSymlinkApprovals(path);
    expect(store.data).toEqual({});
    expect(warning).toContain('state.json.bak');
    expect(existsSync(`${path}.bak`)).toBe(true);
    expect(existsSync(path)).toBe(false);
  }));

  test('non-object approvals are treated as empty', () => withTmpDir((dir) => {
    const path = join(dir, 'state.json');
    writeFileSync(path, JSON.stringify({ [SYMLINK_APPROVALS_KEY]: [1, 2, 3] }), 'utf8');
    expect(loadSymlinkApprovals(path).store.data).toEqual({});
  }));

  test('deletes the obsolete sbx-symlink-approvals.json without carrying it over', () => withTmpDir((dir) => {
    const legacy = join(dir, 'sbx-symlink-approvals.json');
    writeFileSync(legacy, JSON.stringify({ 'sandbox-a': { '/proj/.env': '/home/u/.env' } }), 'utf8');
    const { store } = loadSymlinkApprovals(join(dir, 'state.json'));
    expect(existsSync(legacy)).toBe(false);
    expect(store.data).toEqual({});
  }));

  test('round-trips through save/load and keeps other keys', () => withTmpDir((dir) => {
    const path = join(dir, 'nested', 'state.json');
    const { store } = loadSymlinkApprovals(path);
    recordSymlinkApproval(store, 'sandbox-a', '/proj/.env', '/home/u/.secrets/env');
    saveSymlinkApprovals(store);
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), lastClaudeUpdate: 'x' }), 'utf8');

    const reloaded = loadSymlinkApprovals(path).store;
    expect(reloaded.data).toEqual({ 'sandbox-a': { '/proj/.env': '/home/u/.secrets/env' } });
    recordSymlinkApproval(reloaded, 'sandbox-b', '/proj/.env', '/home/u/.secrets/env');
    saveSymlinkApprovals(reloaded);
    expect(JSON.parse(readFileSync(path, 'utf8')).lastClaudeUpdate).toBe('x');
  }));
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
