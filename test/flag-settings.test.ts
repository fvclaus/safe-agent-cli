import { describe, expect, test } from 'bun:test';
import { buildFlagSettingsArgs } from '../src/adapters/claude-code.js';

describe('buildFlagSettingsArgs', () => {
  test('passes nothing when there is neither env nor a writable dir', () => {
    expect(buildFlagSettingsArgs({}, [])).toEqual([]);
  });

  test('grants writable dirs through sandbox allowWrite, never --add-dir', () => {
    const args = buildFlagSettingsArgs({ GH_CONFIG_DIR: '/tmp/gh/config' }, ['/tmp/gh']);
    expect(args).not.toContain('--add-dir');
    expect(args[0]).toBe('--settings');
    expect(JSON.parse(args[1]!)).toEqual({
      env: { GH_CONFIG_DIR: '/tmp/gh/config' },
      sandbox: { filesystem: { allowWrite: ['/tmp/gh'] } },
    });
  });
});
