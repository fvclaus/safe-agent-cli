/**
 * Regression coverage for the trap rewrite against real shells.
 *
 * The pure-function tests in bwrap-transform.test.ts only check that NEW_TRAP is
 * the expected string — they can't catch a wrong backslash count, since a wrong
 * count is still a fixed string that string-equality happily matches. That's
 * exactly how the trap shipped broken: the old 3-backslash NEW_TRAP passed every
 * unit test while producing "exit: $rc: numeric argument required" under bash
 * and a "bad math expression" parse error under zsh. These tests catch that
 * class of bug by actually installing the trap in a real shell and checking the
 * exit code that comes out.
 *
 * They also run the whole transform over the trap current Claude Code installs
 * itself, so a match that is too loose (rewriting the `kill …; exit` inside an
 * already-fixed trap into `exit \$rc $rc`) fails here instead of breaking every
 * sandboxed command.
 */
import { spawnSync } from 'node:child_process';
import { describe, expect, test } from 'bun:test';
import {
  NEW_TRAP,
  OLD_TRAP,
  stripUnshareNetAndFixTrap,
  UPSTREAM_FIXED_TRAP,
} from '../src/bin/bwrap-transform.js';

function hasShell(shell: string): boolean {
  return spawnSync(shell, ['-c', 'true']).status === 0;
}

/** Runs `trapLine` as the EXIT-trap line of a script around `cmd`, mirroring the
 * harness's real layout: two backgrounded jobs (%1 %2) the trap kills on exit. */
function runWithTrapLine(shell: string, trapLine: string, cmd: string): number | null {
  const script = `sleep 5 &\nsleep 5 &\n${trapLine}\n${cmd}`;
  return spawnSync(shell, ['-c', script]).status;
}

/** Same, but through the outer `shell -c '<script>'` layer the harness wraps the
 * script in, with the script transformed by the shim first. */
function runNestedThroughShim(shell: string, trapLine: string, cmd: string): number | null {
  const script = `sleep 5 &\nsleep 5 &\n${trapLine}\n${cmd}`;
  const outer = `${shell} -c '${script.split("'").join(`'"'"'`)}'`;
  const [transformed] = stripUnshareNetAndFixTrap([outer]);
  return spawnSync(shell, ['-c', transformed!]).status;
}

const SHELLS = ['bash', 'zsh'].filter(hasShell);

describe.each(SHELLS)('NEW_TRAP under %s -c', (shell) => {
  test("preserves a failing command's exit code", () => {
    expect(runWithTrapLine(shell, NEW_TRAP, 'false')).toBe(1);
  });

  test("preserves a passing command's exit code", () => {
    expect(runWithTrapLine(shell, NEW_TRAP, 'true')).toBe(0);
  });

  test('transformed old trap preserves exit codes through the outer -c layer', () => {
    expect(runNestedThroughShim(shell, OLD_TRAP, 'false')).toBe(1);
    expect(runNestedThroughShim(shell, OLD_TRAP, 'true')).toBe(0);
  });
});

describe.each(SHELLS)('upstream-fixed trap under %s -c', (shell) => {
  test('preserves exit codes on its own', () => {
    expect(runWithTrapLine(shell, UPSTREAM_FIXED_TRAP, 'false')).toBe(1);
    expect(runWithTrapLine(shell, UPSTREAM_FIXED_TRAP, 'true')).toBe(0);
  });

  test('still preserves exit codes after passing through the shim transform', () => {
    expect(runNestedThroughShim(shell, UPSTREAM_FIXED_TRAP, 'false')).toBe(1);
    expect(runNestedThroughShim(shell, UPSTREAM_FIXED_TRAP, 'true')).toBe(0);
  });
});

// zsh only: documents the bug NEW_TRAP exists to fix. Skipped (not failed) when
// zsh isn't installed, since it asserts pre-existing, upstream zsh behavior.
test.skipIf(!hasShell('zsh'))(
  'regression: bare OLD_TRAP loses the real exit code under zsh',
  () => {
    expect(runWithTrapLine('zsh', OLD_TRAP, 'false')).toBe(0);
  },
);
