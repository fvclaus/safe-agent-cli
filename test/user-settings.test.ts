import { describe, expect, test } from 'bun:test';
import { parseUserSettings, userSettingsPath } from '../src/user-settings.js';
import { hasRtkHook } from '../src/adapters/claude-code.js';

describe('userSettingsPath', () => {
  test('defaults to ~/.config/safe-agent-cli/settings.json', () => {
    expect(userSettingsPath({}, '/home/u')).toBe('/home/u/.config/safe-agent-cli/settings.json');
  });

  test('respects XDG_CONFIG_HOME', () => {
    expect(userSettingsPath({ XDG_CONFIG_HOME: '/xdg' }, '/home/u'))
      .toBe('/xdg/safe-agent-cli/settings.json');
  });

  test('ignores an empty XDG_CONFIG_HOME', () => {
    expect(userSettingsPath({ XDG_CONFIG_HOME: '  ' }, '/home/u'))
      .toBe('/home/u/.config/safe-agent-cli/settings.json');
  });
});

describe('parseUserSettings', () => {
  test('empty object yields defaults with no issues', () => {
    const r = parseUserSettings('{}');
    expect(r.settings).toEqual({ checkRtk: false });
    expect(r.warnings).toEqual([]);
    expect(r.errors).toEqual([]);
  });

  test('reads checkRtk: true', () => {
    const r = parseUserSettings('{"checkRtk": true}');
    expect(r.settings.checkRtk).toBe(true);
    expect(r.errors).toEqual([]);
  });

  test('malformed JSON is an error, not a silent default', () => {
    const r = parseUserSettings('{"checkRtk": tru');
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain('invalid JSON');
  });

  test('non-object JSON is an error', () => {
    for (const content of ['[]', '"checkRtk"', 'null', 'true']) {
      expect(parseUserSettings(content).errors).toEqual(['must be a JSON object']);
    }
  });

  test('non-boolean checkRtk is an error', () => {
    const r = parseUserSettings('{"checkRtk": "true"}');
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain('"checkRtk" must be a boolean');
  });

  test('unrecognized key warns (typo protection for opt-in settings)', () => {
    const r = parseUserSettings('{"checkRTK": true}');
    expect(r.settings.checkRtk).toBe(false);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('checkRTK');
    expect(r.errors).toEqual([]);
  });

  test('$schema is tolerated silently', () => {
    const r = parseUserSettings('{"$schema": "x", "checkRtk": true}');
    expect(r.warnings).toEqual([]);
    expect(r.errors).toEqual([]);
    expect(r.settings.checkRtk).toBe(true);
  });
});

describe('hasRtkHook', () => {
  const withCommand = (command: string) => ({
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command }] }] },
  });

  test('finds the hook rtk init -g installs', () => {
    expect(hasRtkHook(withCommand('rtk hook claude'))).toBe(true);
  });

  test('tolerates surrounding whitespace in the command', () => {
    expect(hasRtkHook(withCommand(' rtk hook claude '))).toBe(true);
  });

  test('finds the hook among unrelated PreToolUse entries', () => {
    const settings = {
      hooks: {
        PreToolUse: [
          { matcher: 'Read|Grep', hooks: [{ type: 'command', command: 'other.sh' }] },
          { hooks: [{ type: 'command', command: 'rtk hook claude' }] },
        ],
      },
    };
    expect(hasRtkHook(settings)).toBe(true);
  });

  test('rejects a different rtk command', () => {
    expect(hasRtkHook(withCommand('rtk gain'))).toBe(false);
  });

  test('rejects settings without hooks', () => {
    expect(hasRtkHook({})).toBe(false);
    expect(hasRtkHook({ hooks: {} })).toBe(false);
    expect(hasRtkHook({ hooks: { PostToolUse: [] } })).toBe(false);
  });

  test('rejects non-object input', () => {
    expect(hasRtkHook(null)).toBe(false);
    expect(hasRtkHook('rtk hook claude')).toBe(false);
    expect(hasRtkHook([])).toBe(false);
  });

  test('tolerates malformed hook entries', () => {
    const settings = { hooks: { PreToolUse: [null, 'x', { hooks: 'not-an-array' }, { hooks: [null] }] } };
    expect(hasRtkHook(settings)).toBe(false);
  });
});
