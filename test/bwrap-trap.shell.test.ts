/**
 * Regression coverage for NEW_TRAP against real shells.
 *
 * The pure-function tests in bwrap-transform.test.ts only check that NEW_TRAP is
 * the expected string — they can't catch a wrong backslash count, since a wrong
 * count is still a fixed string that string-equality happily matches. That's
 * exactly how the trap shipped broken: the old 3-backslash NEW_TRAP passed every
 * unit test while producing "exit: $rc: numeric argument required" under bash
 * and a "bad math expression" parse error under zsh. These tests catch that
 * class of bug by actually installing the trap in a real shell and checking the
 * exit code that comes out.
 */
import { spawnSync } from 'node:child_process';
import { describe, expect, test } from 'bun:test';
import { NEW_TRAP, OLD_TRAP } from '../src/bin/bwrap-transform.js';

function hasShell(shell: string): boolean {
  return spawnSync(shell, ['-c', 'true']).status === 0;
}

/** Installs `trap` as an EXIT trap around `cmd`, mirroring the harness's real
 * layout: two backgrounded jobs (%1 %2) the trap kills on exit. */
function runWithTrap(shell: string, trap: string, cmd: string): number | null {
  const script = `sleep 5 &\nsleep 5 &\ntrap "${trap}" EXIT\n${cmd}`;
  return spawnSync(shell, ['-c', script]).status;
}

const SHELLS = ['bash', 'zsh'].filter(hasShell);

describe.each(SHELLS)('NEW_TRAP under %s -c', (shell) => {
  test('preserves a failing command\'s exit code', () => {
    expect(runWithTrap(shell, NEW_TRAP, 'false')).toBe(1);
  });

  test("preserves a passing command's exit code", () => {
    expect(runWithTrap(shell, NEW_TRAP, 'true')).toBe(0);
  });
});

// zsh only: documents the bug NEW_TRAP exists to fix. Skipped (not failed) when
// zsh isn't installed, since it asserts pre-existing, upstream zsh behavior.
test.skipIf(!hasShell('zsh'))(
  'regression: bare OLD_TRAP loses the real exit code under zsh',
  () => {
    expect(runWithTrap('zsh', OLD_TRAP, 'false')).toBe(0);
  },
);
