import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  expandHome,
  fragmentMatches,
  generateClaudeLocalMd,
  parseFragment,
} from '../src/claude-fragments.js';

describe('parseFragment', () => {
  test('no frontmatter -> always-included fragment with the raw body', () => {
    const f = parseFragment('just some notes\n', '/f/a.md');
    expect(f).toEqual({ path: '/f/a.md', body: 'just some notes\n' });
  });

  test('parses org and isolation as string lists', () => {
    const content = '---\norg: acme\nisolation: [proxy, sbx]\n---\nbody text\n';
    const f = parseFragment(content, '/f/a.md');
    expect(f.org).toEqual(['acme']);
    expect(f.isolation).toEqual(['proxy', 'sbx']);
    expect(f.body).toBe('body text\n');
  });

  test('a single string value becomes a one-element list', () => {
    const f = parseFragment('---\norg: acme\n---\nbody\n', '/f/a.md');
    expect(f.org).toEqual(['acme']);
  });

  test('empty frontmatter yields an unconditioned fragment', () => {
    const f = parseFragment('---\n---\nbody\n', '/f/a.md');
    expect(f.org).toBeUndefined();
    expect(f.isolation).toBeUndefined();
  });

  test('unrecognized frontmatter key throws', () => {
    expect(() => parseFragment('---\norgs: acme\n---\nbody\n', '/f/a.md'))
      .toThrow(/unrecognized frontmatter key "orgs"/);
  });

  test('wrong-type value throws', () => {
    expect(() => parseFragment('---\norg: 123\n---\nbody\n', '/f/a.md'))
      .toThrow(/"org" must be a string or an array of strings/);
  });

  test('a list containing a non-string throws', () => {
    expect(() => parseFragment('---\norg: [acme, 123]\n---\nbody\n', '/f/a.md'))
      .toThrow(/"org" must be a string or an array of strings/);
  });

  test('invalid YAML throws', () => {
    expect(() => parseFragment('---\norg: [unterminated\n---\nbody\n', '/f/a.md'))
      .toThrow(/invalid frontmatter YAML/);
  });

  test('non-mapping frontmatter throws', () => {
    expect(() => parseFragment('---\n- a\n- b\n---\nbody\n', '/f/a.md'))
      .toThrow(/frontmatter must be a YAML mapping/);
  });
});

describe('fragmentMatches', () => {
  const base = { path: '/f/a.md', body: '' };

  test('no conditions always matches', () => {
    expect(fragmentMatches(base, { org: 'acme', isolation: 'proxy' })).toBe(true);
    expect(fragmentMatches(base, { org: undefined, isolation: 'sbx' })).toBe(true);
  });

  test('org match is case-insensitive', () => {
    const f = { ...base, org: ['Developer-Akademie-GmbH'] };
    expect(fragmentMatches(f, { org: 'developer-akademie-gmbh', isolation: 'proxy' })).toBe(true);
  });

  test('org list is OR', () => {
    const f = { ...base, org: ['a', 'b'] };
    expect(fragmentMatches(f, { org: 'b', isolation: 'proxy' })).toBe(true);
    expect(fragmentMatches(f, { org: 'c', isolation: 'proxy' })).toBe(false);
  });

  test('an org condition never matches when there is no org to compare (no remote)', () => {
    const f = { ...base, org: ['acme'] };
    expect(fragmentMatches(f, { org: undefined, isolation: 'proxy' })).toBe(false);
  });

  test('multiple keys are ANDed', () => {
    const f = { ...base, org: ['acme'], isolation: ['sbx'] };
    expect(fragmentMatches(f, { org: 'acme', isolation: 'sbx' })).toBe(true);
    expect(fragmentMatches(f, { org: 'acme', isolation: 'proxy' })).toBe(false);
    expect(fragmentMatches(f, { org: 'other', isolation: 'sbx' })).toBe(false);
  });
});

describe('generateClaudeLocalMd', () => {
  function withTempDirs(run: (fragmentsDir: string, repoRoot: string) => void): void {
    const fragmentsDir = mkdtempSync(join(tmpdir(), 'fragments-'));
    const repoRoot = mkdtempSync(join(tmpdir(), 'repo-'));
    try {
      run(fragmentsDir, repoRoot);
    } finally {
      rmSync(fragmentsDir, { recursive: true, force: true });
      rmSync(repoRoot, { recursive: true, force: true });
    }
  }

  test('throws when the fragments directory does not exist', () => {
    withTempDirs((fragmentsDir, repoRoot) => {
      expect(() => generateClaudeLocalMd(join(fragmentsDir, 'missing'), repoRoot))
        .toThrow(/claudeFragmentsDir does not exist/);
    });
  });

  test('concatenates only matching fragments, alphabetically, with provenance and a header', () => {
    withTempDirs((fragmentsDir, repoRoot) => {
      writeFileSync(join(fragmentsDir, 'b-universal.md'), 'universal rule\n');
      writeFileSync(join(fragmentsDir, 'a-sbx-only.md'), '---\nisolation: sbx\n---\nsbx rule\n');
      writeFileSync(join(fragmentsDir, 'z-not-md.txt'), 'ignored\n');

      const result = generateClaudeLocalMd(fragmentsDir, repoRoot, 'proxy');
      expect(result.totalCount).toBe(2);
      expect(result.matchedCount).toBe(1);
      expect(result.rtkAppended).toBe(false);

      const outPath = join(repoRoot, 'CLAUDE.local.md');
      expect(result.outputPath).toBe(outPath);
      const content = readFileSync(outPath, 'utf8');

      expect(content).toContain('AUTO-GENERATED by safe-agent-cli');
      expect(content).toContain(fragmentsDir);
      expect(content).toContain('universal rule');
      expect(content).toContain('fragment: b-universal.md');
      expect(content).not.toContain(join(fragmentsDir, 'b-universal.md'));
      expect(content).not.toContain('sbx rule');
    });
  });

  test('a malformed fragment aborts generation entirely (no partial file written silently)', () => {
    withTempDirs((fragmentsDir, repoRoot) => {
      writeFileSync(join(fragmentsDir, 'ok.md'), 'fine\n');
      writeFileSync(join(fragmentsDir, 'bad.md'), '---\ntypo: x\n---\nbad\n');

      expect(() => generateClaudeLocalMd(fragmentsDir, repoRoot)).toThrow(/unrecognized frontmatter key/);
    });
  });

  test('appends RTK.md content last, unconditionally, when rtkMdPath is given', () => {
    withTempDirs((fragmentsDir, repoRoot) => {
      writeFileSync(join(fragmentsDir, 'a.md'), 'fragment rule\n');
      const rtkMdPath = join(repoRoot, 'RTK.md');
      writeFileSync(rtkMdPath, 'rtk rule\n');

      const result = generateClaudeLocalMd(fragmentsDir, repoRoot, 'proxy', rtkMdPath);
      expect(result.rtkAppended).toBe(true);
      expect(result.matchedCount).toBe(1); // rtkMdPath isn't counted as a fragment

      const content = readFileSync(join(repoRoot, 'CLAUDE.local.md'), 'utf8');
      expect(content).toContain('fragment rule');
      expect(content).toContain('rtk rule');
      expect(content).toContain('fragment: RTK.md');
      expect(content).not.toContain(rtkMdPath);
      expect(content.indexOf('fragment rule')).toBeLessThan(content.indexOf('rtk rule'));
    });
  });

  test('a missing rtkMdPath aborts generation, same as any other malformed input', () => {
    withTempDirs((fragmentsDir, repoRoot) => {
      writeFileSync(join(fragmentsDir, 'a.md'), 'fragment rule\n');

      expect(() => generateClaudeLocalMd(fragmentsDir, repoRoot, 'proxy', join(repoRoot, 'RTK.md')))
        .toThrow(/checkRtk is enabled but .*RTK\.md does not exist/);
    });
  });
});

describe('expandHome', () => {
  test('expands a bare ~', () => {
    expect(expandHome('~', '/home/u')).toBe('/home/u');
  });

  test('expands ~/...', () => {
    expect(expandHome('~/shared/claude', '/home/u')).toBe('/home/u/shared/claude');
  });

  test('leaves an absolute path untouched', () => {
    expect(expandHome('/abs/path', '/home/u')).toBe('/abs/path');
  });

  test('does not expand a mid-string tilde', () => {
    expect(expandHome('/abs/~weird', '/home/u')).toBe('/abs/~weird');
  });
});
