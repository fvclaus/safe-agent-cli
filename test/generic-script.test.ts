import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSandboxName } from '../src/sbx/generic-script.js';

function scriptPrinting(stdout: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'generic-script-test-'));
  const payloadPath = join(dir, 'payload.txt');
  writeFileSync(payloadPath, stdout);
  const scriptPath = join(dir, 'script.sh');
  writeFileSync(scriptPath, `#!/usr/bin/env bash\ncat ${JSON.stringify(payloadPath)}\n`, { mode: 0o755 });
  return scriptPath;
}

describe('resolveSandboxName', () => {
  test('returns the plain name when it is the only line', () => {
    const path = scriptPrinting('claude-student-progress\n');
    expect(resolveSandboxName(path)).toBe('claude-student-progress');
  });

  test('takes the last non-empty line when a wrapper logs to stdout first', () => {
    const path = scriptPrinting(
      '>> project wrapper detected (/path/to/claude.sh) — delegating to it...\nclaude-student-progress\n',
    );
    expect(resolveSandboxName(path)).toBe('claude-student-progress');
  });

  test('throws when the script prints nothing', () => {
    const path = scriptPrinting('');
    expect(() => resolveSandboxName(path)).toThrow('printed no output');
  });
});
