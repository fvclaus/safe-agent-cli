import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mergedDirectories, postCopyScript } from '../src/sbx/copy-into-home.js';
import { LAUNCH_LOG_PLUGIN_FILES } from '../src/sbx/launch-log.js';
import { LAUNCH_LOG_PLUGIN_DIR } from '../src/launch-log.js';

describe('mergedDirectories', () => {
  test('lists every ancestor of the owned trees once, outermost first', () => {
    expect(mergedDirectories(['.claude/skills/a', '.claude/skills/b', '.claude/safe-agent-cli'])).toEqual([
      '.claude',
      '.claude/skills',
    ]);
  });

  test('a top-level tree has no merged ancestors', () => {
    expect(mergedDirectories(['.claude'])).toEqual([]);
  });
});

describe('postCopyScript', () => {
  const script = postCopyScript('/home/agent', {
    ownedTrees: ['.claude/skills/a'],
    expectedFiles: ['.claude/skills/a/.marker'],
  });

  test('chowns merged directories shallowly and owned trees recursively', () => {
    expect(script).toContain(`sudo chown "$u:$g" '/home/agent/.claude' '/home/agent/.claude/skills'`);
    expect(script).toContain(`sudo chown -R "$u:$g" '/home/agent/.claude/skills/a'`);
  });

  test('fails naming the missing file', () => {
    expect(script).toContain(`[ -f '/home/agent/.claude/skills/a/.marker' ]`);
    expect(script).toContain('missing after copy: /home/agent/.claude/skills/a/.marker');
  });

  test('quotes paths containing a single quote', () => {
    const quoted = postCopyScript("/home/o'x", { ownedTrees: ['.claude/a'], expectedFiles: [] });
    expect(quoted).toContain(`'/home/o'\\''x/.claude/a'`);
  });
});

describe('LAUNCH_LOG_PLUGIN_FILES', () => {
  const files = new Set<string>(LAUNCH_LOG_PLUGIN_FILES);
  const read = (rel: string) => readFileSync(join(LAUNCH_LOG_PLUGIN_DIR, rel), 'utf8');

  test('contains every file the mod loads', () => {
    expect(files.has('.claude-plugin/plugin.json')).toBe(true);
    const modules = (JSON.parse(read('hooks/hooks.json')) as { modules: string[] }).modules;
    for (const m of modules) expect(files.has(`hooks/${m.replace(/^\.\//, '')}`)).toBe(true);
    for (const file of LAUNCH_LOG_PLUGIN_FILES.filter((f) => f.endsWith('.js'))) {
      const imports = [...read(file).matchAll(/from\s+'(\.\/[^']+)'/g)].map((m) => m[1]!);
      for (const imported of imports) expect(files.has(`hooks/${imported.replace(/^\.\//, '')}`)).toBe(true);
    }
  });

  test('lists only files that exist', () => {
    for (const file of LAUNCH_LOG_PLUGIN_FILES) expect(() => read(file)).not.toThrow();
  });
});
