import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  expandHome,
  fragmentMatches,
  generateClaudeLocalMd,
  parseFragment,
  type MatchContext,
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

  test('parses github as a boolean', () => {
    expect(parseFragment('---\ngithub: true\n---\nbody\n', '/f/a.md').github).toBe(true);
    expect(parseFragment('---\ngithub: false\n---\nbody\n', '/f/a.md').github).toBe(false);
  });

  test('a non-boolean github value throws', () => {
    expect(() => parseFragment('---\ngithub: yes\n---\nbody\n', '/f/a.md'))
      .toThrow(/"github" must be a boolean/);
  });

  test('parses githubMasked as a boolean', () => {
    expect(parseFragment('---\ngithubMasked: true\n---\nbody\n', '/f/a.md').githubMasked).toBe(true);
    expect(parseFragment('---\ngithubMasked: false\n---\nbody\n', '/f/a.md').githubMasked).toBe(false);
  });

  test('a non-boolean githubMasked value throws', () => {
    expect(() => parseFragment('---\ngithubMasked: yes\n---\nbody\n', '/f/a.md'))
      .toThrow(/"githubMasked" must be a boolean/);
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

  // Defaults githubMasked to false so callers only need to override the dimension
  // they're actually testing — mirrors generateClaudeLocalMd's own default.
  function ctx(overrides: Partial<MatchContext> & Pick<MatchContext, 'org' | 'isolation' | 'github'>): MatchContext {
    return { githubMasked: false, ...overrides };
  }

  test('no conditions always matches', () => {
    expect(fragmentMatches(base, ctx({ org: 'acme', isolation: 'proxy', github: true }))).toBe(true);
    expect(fragmentMatches(base, ctx({ org: undefined, isolation: 'sbx', github: false }))).toBe(true);
  });

  test('org match is case-insensitive', () => {
    const f = { ...base, org: ['Developer-Akademie-GmbH'] };
    expect(fragmentMatches(f, ctx({ org: 'developer-akademie-gmbh', isolation: 'proxy', github: false }))).toBe(true);
  });

  test('org list is OR', () => {
    const f = { ...base, org: ['a', 'b'] };
    expect(fragmentMatches(f, ctx({ org: 'b', isolation: 'proxy', github: false }))).toBe(true);
    expect(fragmentMatches(f, ctx({ org: 'c', isolation: 'proxy', github: false }))).toBe(false);
  });

  test('an org condition never matches when there is no org to compare (no remote)', () => {
    const f = { ...base, org: ['acme'] };
    expect(fragmentMatches(f, ctx({ org: undefined, isolation: 'proxy', github: false }))).toBe(false);
  });

  test('multiple keys are ANDed', () => {
    const f = { ...base, org: ['acme'], isolation: ['sbx'] };
    expect(fragmentMatches(f, ctx({ org: 'acme', isolation: 'sbx', github: false }))).toBe(true);
    expect(fragmentMatches(f, ctx({ org: 'acme', isolation: 'proxy', github: false }))).toBe(false);
    expect(fragmentMatches(f, ctx({ org: 'other', isolation: 'sbx', github: false }))).toBe(false);
  });

  test('github: true only matches when github is enabled', () => {
    const f = { ...base, github: true };
    expect(fragmentMatches(f, ctx({ org: undefined, isolation: 'proxy', github: true }))).toBe(true);
    expect(fragmentMatches(f, ctx({ org: undefined, isolation: 'proxy', github: false }))).toBe(false);
  });

  test('github: false only matches when github is disabled', () => {
    const f = { ...base, github: false };
    expect(fragmentMatches(f, ctx({ org: undefined, isolation: 'proxy', github: false }))).toBe(true);
    expect(fragmentMatches(f, ctx({ org: undefined, isolation: 'proxy', github: true }))).toBe(false);
  });

  test('githubMasked: true only matches when GITHUB_TOKEN is masked', () => {
    const f = { ...base, github: true, githubMasked: true };
    expect(fragmentMatches(f, ctx({ org: undefined, isolation: 'proxy', github: true, githubMasked: true }))).toBe(true);
    expect(fragmentMatches(f, ctx({ org: undefined, isolation: 'proxy', github: true, githubMasked: false }))).toBe(false);
  });

  test('githubMasked: false only matches when GITHUB_TOKEN is not masked', () => {
    const f = { ...base, github: true, githubMasked: false };
    expect(fragmentMatches(f, ctx({ org: undefined, isolation: 'proxy', github: true, githubMasked: false }))).toBe(true);
    expect(fragmentMatches(f, ctx({ org: undefined, isolation: 'proxy', github: true, githubMasked: true }))).toBe(false);
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
      // +2 built-in fragments shipped in src/fragments (both github: true, neither
      // matches here since github defaults to false) counted in totalCount but not
      // matchedCount — see the 'built-in fragments' describe block below.
      expect(result.totalCount).toBe(4);
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

  test('the built-in git-sandboxed fragment only appears (last) when github is enabled and unmasked', () => {
    withTempDirs((fragmentsDir, repoRoot) => {
      writeFileSync(join(fragmentsDir, 'a-user.md'), 'user rule\n');

      const withoutGithub = generateClaudeLocalMd(fragmentsDir, repoRoot, 'proxy', false);
      const contentWithout = readFileSync(join(repoRoot, 'CLAUDE.local.md'), 'utf8');
      expect(contentWithout).not.toContain('git-sandboxed');
      expect(withoutGithub.matchedCount).toBe(1);

      const withGithub = generateClaudeLocalMd(fragmentsDir, repoRoot, 'proxy', true, false);
      const contentWithGithub = readFileSync(join(repoRoot, 'CLAUDE.local.md'), 'utf8');
      expect(contentWithGithub).toContain('git-sandboxed');
      expect(withGithub.matchedCount).toBe(2);
      expect(contentWithGithub.indexOf('user rule')).toBeLessThan(contentWithGithub.indexOf('git-sandboxed'));
    });
  });

  test('the built-in git-excluded fragment replaces git-sandboxed when GITHUB_TOKEN is masked', () => {
    withTempDirs((fragmentsDir, repoRoot) => {
      writeFileSync(join(fragmentsDir, 'a-user.md'), 'user rule\n');

      const result = generateClaudeLocalMd(fragmentsDir, repoRoot, 'proxy', true, true);
      const content = readFileSync(join(repoRoot, 'CLAUDE.local.md'), 'utf8');
      expect(content).not.toContain('git-sandboxed push origin main');
      expect(content).toContain('excludedCommands');
      expect(content).toContain('git -C');
      expect(result.matchedCount).toBe(2);
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

      const result = generateClaudeLocalMd(fragmentsDir, repoRoot, 'proxy', false, false, rtkMdPath);
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

      expect(() => generateClaudeLocalMd(fragmentsDir, repoRoot, 'proxy', false, false, join(repoRoot, 'RTK.md')))
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
