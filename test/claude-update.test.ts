import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ClaudeUpdateResult,
  LAST_CLAUDE_UPDATE_KEY,
  localIsoTimestamp,
  updateClaudeCode,
  updatedToday,
} from '../src/claude-update.js';

function withTmpDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'claude-update-test-'));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const NOW = new Date(2026, 10, 10, 14, 3, 0);

function collect(
  statePath: string,
  run: () => ClaudeUpdateResult,
  extra: { skip?: boolean; now?: Date } = {},
): { lines: string[]; ran: boolean } {
  const lines: string[] = [];
  let ran = false;
  updateClaudeCode((msg) => lines.push(msg), {
    statePath,
    now: () => extra.now ?? NOW,
    run: () => {
      ran = true;
      return run();
    },
    ...(extra.skip !== undefined && { skip: extra.skip }),
  });
  return { lines, ran };
}

function readState(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const ok = (): ClaudeUpdateResult => ({ status: 0, output: 'Claude Code is up to date' });

describe('updateClaudeCode', () => {
  test('logs the command output and nothing else on success', () => withTmpDir((dir) => {
    const { lines } = collect(join(dir, 'state.json'), ok);
    expect(lines).toEqual(['>> Running claude update', 'Claude Code is up to date']);
  }));

  test('records a successful update in the state file', () => withTmpDir((dir) => {
    const path = join(dir, 'nested', 'state.json');
    collect(path, ok);
    expect(readState(path)[LAST_CLAUDE_UPDATE_KEY]).toBe(localIsoTimestamp(NOW));
  }));

  test('skips when it already ran today', () => withTmpDir((dir) => {
    const path = join(dir, 'state.json');
    collect(path, ok);
    const later = new Date(2026, 10, 10, 23, 59, 0);
    const { lines, ran } = collect(path, ok, { now: later });
    expect(ran).toBe(false);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('SKIP:');
    expect(lines[0]).toContain('already ran today');
  }));

  test('runs again on the next calendar day, even within 24 hours', () => withTmpDir((dir) => {
    const path = join(dir, 'state.json');
    collect(path, ok, { now: new Date(2026, 10, 10, 23, 0, 0) });
    const { ran } = collect(path, ok, { now: new Date(2026, 10, 11, 0, 30, 0) });
    expect(ran).toBe(true);
  }));

  test('--skip-update skips without touching the state file', () => withTmpDir((dir) => {
    const path = join(dir, 'state.json');
    const { lines, ran } = collect(path, ok, { skip: true });
    expect(ran).toBe(false);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('SKIP:');
    expect(lines[0]).toContain('--skip-update');
    expect(existsSync(path)).toBe(false);
  }));

  test('warns and records nothing when the update exits non-zero', () => withTmpDir((dir) => {
    const path = join(dir, 'state.json');
    const { lines } = collect(path, () => ({ status: 1, output: 'network down' }));
    expect(lines[1]).toBe('network down');
    expect(lines[2]).toContain('WARNING:');
    expect(lines[2]).toContain('status 1');
    expect(existsSync(path)).toBe(false);
    expect(collect(path, ok).ran).toBe(true);
  }));

  test('warns and records nothing when claude cannot be spawned', () => withTmpDir((dir) => {
    const path = join(dir, 'state.json');
    const { lines } = collect(path, () => ({ status: null, output: '', error: new Error('spawn claude ENOENT') }));
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('WARNING:');
    expect(lines[1]).toContain('spawn claude ENOENT');
    expect(existsSync(path)).toBe(false);
  }));

  test('keeps other keys in the state file', () => withTmpDir((dir) => {
    const path = join(dir, 'state.json');
    writeFileSync(path, JSON.stringify({ sbxSymlinkApprovals: { a: { '/x': '/y' } }, futureKey: 1 }), 'utf8');
    collect(path, ok);
    expect(readState(path)).toEqual({
      sbxSymlinkApprovals: { a: { '/x': '/y' } },
      futureKey: 1,
      [LAST_CLAUDE_UPDATE_KEY]: localIsoTimestamp(NOW),
    });
  }));

  test('a malformed state file is moved aside with a warning and the update runs', () => withTmpDir((dir) => {
    const path = join(dir, 'state.json');
    writeFileSync(path, '{not json', 'utf8');
    const { lines, ran } = collect(path, ok);
    expect(ran).toBe(true);
    expect(lines[0]).toContain('WARNING:');
    expect(lines[0]).toContain('state.json.bak');
    expect(readFileSync(`${path}.bak`, 'utf8')).toBe('{not json');
    expect(readState(path)[LAST_CLAUDE_UPDATE_KEY]).toBe(localIsoTimestamp(NOW));
  }));
});

describe('updatedToday', () => {
  test('rejects missing or unparseable values', () => {
    expect(updatedToday(undefined, NOW)).toBe(false);
    expect(updatedToday(42, NOW)).toBe(false);
    expect(updatedToday('yesterday', NOW)).toBe(false);
  });

  test('round-trips the stored timestamp format', () => {
    expect(updatedToday(localIsoTimestamp(NOW), NOW)).toBe(true);
  });
});

describe('localIsoTimestamp', () => {
  test('has the local time and the UTC offset', () => {
    expect(localIsoTimestamp(NOW)).toMatch(/^2026-11-10T14:03:00[+-]\d\d:\d\d$/);
  });
});
