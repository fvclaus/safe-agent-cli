import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isRtkHookInstalled } from '../src/rtk.js';

describe('isRtkHookInstalled', () => {
  function withHome(settings: string | undefined, run: (home: string) => void): void {
    const home = mkdtempSync(join(tmpdir(), 'home-'));
    try {
      if (settings !== undefined) {
        mkdirSync(join(home, '.claude'));
        writeFileSync(join(home, '.claude', 'settings.json'), settings);
      }
      run(home);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }

  test('true when ~/.claude/settings.json installs the rtk PreToolUse hook', () => {
    const settings = JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'rtk hook claude' }] }] },
    });
    withHome(settings, home => expect(isRtkHookInstalled(home)).toBe(true));
  });

  test('false when the settings have no rtk hook', () => {
    withHome(JSON.stringify({ hooks: { PreToolUse: [] } }), home => expect(isRtkHookInstalled(home)).toBe(false));
  });

  test('false when the settings file is missing or malformed', () => {
    withHome(undefined, home => expect(isRtkHookInstalled(home)).toBe(false));
    withHome('{ not json', home => expect(isRtkHookInstalled(home)).toBe(false));
  });
});
