import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { resolveSandboxName, runGenericScriptCaptured } from '../src/sbx/generic-script.js';

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

function scriptRunning(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'generic-script-test-'));
  const scriptPath = join(dir, 'script.sh');
  writeFileSync(scriptPath, `#!/usr/bin/env bash\n${body}`, { mode: 0o755 });
  return scriptPath;
}

function collector(): { stream: PassThrough; text: () => string } {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  return { stream, text: () => Buffer.concat(chunks).toString('utf8') };
}

describe('runGenericScriptCaptured', () => {
  test('returns stdout and stderr in order', async () => {
    const path = scriptRunning('echo one\necho two >&2\necho three\n');
    const echo = collector();
    expect(await runGenericScriptCaptured(path, ['build'], echo.stream)).toBe('one\ntwo\nthree\n');
  });

  test('echoes the output while capturing it', async () => {
    const path = scriptRunning('echo out\nprintf "Recreate the sandbox now? [y/N] " >&2\n');
    const echo = collector();
    await runGenericScriptCaptured(path, ['build'], echo.stream);
    expect(echo.text()).toBe('out\nRecreate the sandbox now? [y/N] ');
  });

  test('passes its arguments through', async () => {
    const path = scriptRunning('printf "%s|" "$@"\n');
    const echo = collector();
    expect(await runGenericScriptCaptured(path, ['build', '--bind-mount', '/a b'], echo.stream)).toBe('build|--bind-mount|/a b|');
  });

  test('rejects on a non-zero exit', async () => {
    const path = scriptRunning('echo nope\nexit 3\n');
    const echo = collector();
    await expect(runGenericScriptCaptured(path, ['build'], echo.stream)).rejects.toThrow('exited with code 3');
    expect(echo.text()).toBe('nope\n');
  });
});
