import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  compareSkillStore,
  describeSkillStoreDrift,
  listSkillDirs,
  parseSkillStoreListing,
  SKILL_STORE_UPDATE_COMMAND,
} from '../src/sbx/skill-store-drift.js';
import { withPluginDir } from '../src/sbx/launch-log.js';

let root: string;
let host: string;
let agents: string;
let store: string;
let shared: string;

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'skill-store-drift-'));
  host = join(root, 'claude-skills');
  agents = join(root, 'agents-skills');
  store = join(root, 'store');
  shared = join(root, 'shared');
  mkdirSync(host);
  mkdirSync(store);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('compareSkillStore', () => {
  test('an identical store is in sync', () => {
    write(join(host, 'a', 'SKILL.md'), 'a');
    write(join(host, 'a', 'scripts', 'run.py'), 'print()');
    write(join(store, 'a', 'SKILL.md'), 'a');
    write(join(store, 'a', 'scripts', 'run.py'), 'print()');
    expect(compareSkillStore(host, store, [agents])).toEqual({ missing: [], changed: [] });
  });

  test('reports a missing skill, changed content, an extra file and a missing file', () => {
    write(join(host, 'missing', 'SKILL.md'), 'm');
    write(join(host, 'content', 'SKILL.md'), 'new');
    write(join(store, 'content', 'SKILL.md'), 'old');
    write(join(host, 'extra', 'SKILL.md'), 'e');
    write(join(store, 'extra', 'SKILL.md'), 'e');
    write(join(store, 'extra', '.sbx-host-synced'), 'marker');
    write(join(host, 'fewer', 'SKILL.md'), 'f');
    write(join(host, 'fewer', 'more.md'), 'f');
    write(join(store, 'fewer', 'SKILL.md'), 'f');
    expect(compareSkillStore(host, store, [agents])).toEqual({
      missing: ['missing'],
      changed: ['content', 'extra', 'fewer'],
    });
  });

  test('follows a top-level symlink, skips symlinks inside a skill, hidden entries and files', () => {
    write(join(shared, 'linked', 'SKILL.md'), 'l');
    symlinkSync(join(shared, 'linked'), join(host, 'linked'));
    symlinkSync(join(shared, 'linked', 'SKILL.md'), join(host, 'linked', 'alias.md'));
    symlinkSync(join(root, 'nowhere'), join(host, 'dangling'));
    write(join(host, '.gitkeep'), '');
    write(join(host, '.hidden', 'SKILL.md'), 'h');
    write(join(store, 'linked', 'SKILL.md'), 'l');
    expect(compareSkillStore(host, store, [agents])).toEqual({ missing: [], changed: [] });
  });

  test('a skill ~/.agents/skills also has is not compared', () => {
    write(join(host, 'both', 'SKILL.md'), 'claude copy');
    write(join(agents, 'both', 'SKILL.md'), 'agents copy');
    write(join(store, 'both', 'SKILL.md'), 'agents copy');
    expect(compareSkillStore(host, store, [agents])).toEqual({ missing: [], changed: [] });
  });

  test('store-only skills are not reported', () => {
    write(join(store, 'from-a-repo', 'SKILL.md'), 'r');
    expect(compareSkillStore(host, store, [agents])).toEqual({ missing: [], changed: [] });
  });

  test('a missing host skills directory has nothing to compare', () => {
    expect(compareSkillStore(join(root, 'absent'), store, [agents])).toEqual({ missing: [], changed: [] });
    expect(listSkillDirs(join(root, 'absent'))).toEqual([]);
  });
});

describe('describeSkillStoreDrift', () => {
  test('null when in sync', () => {
    expect(describeSkillStoreDrift({ missing: [], changed: [] }, '/s')).toBeNull();
  });

  test('names each skill and the update command', () => {
    const line = describeSkillStoreDrift({ missing: ['a', 'b'], changed: ['c'] }, '/s');
    expect(line).toContain('(/s)');
    expect(line).toContain('missing: a, b; differs: c');
    expect(line).toContain(`'${SKILL_STORE_UPDATE_COMMAND}'`);
  });
});

describe('parseSkillStoreListing', () => {
  test('reads the store path', () => {
    expect(parseSkillStoreListing('{"store":"/x/agent-skills","skills":["a"]}')).toBe('/x/agent-skills');
  });

  test('rejects a listing without a store', () => {
    expect(() => parseSkillStoreListing('{"skills":[]}')).toThrow('no "store" path');
  });
});

describe('withPluginDir', () => {
  test('adds env.CLAUDE_CODE_PLUGIN_DIRS, keeping other keys', () => {
    expect(withPluginDir({ theme: 'dark', env: { FOO: '1' } }, '/h/p')).toEqual({
      theme: 'dark',
      env: { FOO: '1', CLAUDE_CODE_PLUGIN_DIRS: '/h/p' },
    });
  });

  test('appends to an existing list once', () => {
    const once = withPluginDir({ env: { CLAUDE_CODE_PLUGIN_DIRS: '/a' } }, '/h/p');
    expect(once).toEqual({ env: { CLAUDE_CODE_PLUGIN_DIRS: '/a:/h/p' } });
    expect(withPluginDir(once, '/h/p')).toBe(once);
  });
});
