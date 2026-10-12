import { describe, expect, test } from 'bun:test';
import { updateClaudeCode } from '../src/claude-update.js';

function collect(run: Parameters<typeof updateClaudeCode>[1]): string[] {
  const lines: string[] = [];
  updateClaudeCode((msg) => lines.push(msg), run);
  return lines;
}

describe('updateClaudeCode', () => {
  test('logs the command output and nothing else on success', () => {
    const lines = collect(() => ({ status: 0, output: 'Claude Code is up to date' }));
    expect(lines).toEqual(['>> Running claude update', 'Claude Code is up to date']);
  });

  test('warns when the update exits non-zero', () => {
    const lines = collect(() => ({ status: 1, output: 'network down' }));
    expect(lines[1]).toBe('network down');
    expect(lines[2]).toContain('WARNING:');
    expect(lines[2]).toContain('status 1');
  });

  test('warns when claude cannot be spawned', () => {
    const lines = collect(() => ({ status: null, output: '', error: new Error('spawn claude ENOENT') }));
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('WARNING:');
    expect(lines[1]).toContain('spawn claude ENOENT');
  });
});
