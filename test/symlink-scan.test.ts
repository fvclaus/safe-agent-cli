import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifySymlinkTarget, scanForExternalSymlinks } from '../src/sbx/symlink-scan.js';

describe('classifySymlinkTarget', () => {
  const projectRoot = '/home/u/project';

  test('relative target is unsupported regardless of where it points', () => {
    expect(classifySymlinkTarget('../secrets/.env', projectRoot, true).kind).toBe('relative-unsupported');
    expect(classifySymlinkTarget('.env.local', projectRoot, true).kind).toBe('relative-unsupported');
  });

  test('absolute target inside the project dir needs no mount', () => {
    expect(classifySymlinkTarget('/home/u/project/.env.local', projectRoot, true).kind).toBe('inside-project');
    expect(classifySymlinkTarget(projectRoot, projectRoot, true).kind).toBe('inside-project');
  });

  test('does not false-positive on a sibling dir with the project dir as a prefix', () => {
    // '/home/u/project-other' is NOT inside '/home/u/project' despite the string prefix match.
    const c = classifySymlinkTarget('/home/u/project-other/.env', projectRoot, true);
    expect(c.kind).not.toBe('inside-project');
  });

  test('absolute target outside the project that does not exist on host is dangling', () => {
    expect(classifySymlinkTarget('/home/u/.secrets/env', projectRoot, false).kind).toBe('dangling');
  });

  test('absolute target outside the project that exists on host is a candidate', () => {
    const c = classifySymlinkTarget('/home/u/.secrets/env', projectRoot, true);
    expect(c.kind).toBe('candidate');
    if (c.kind === 'candidate') expect(c.target).toBe('/home/u/.secrets/env');
  });
});

describe('scanForExternalSymlinks', () => {
  function withTmpProject(build: (root: string) => void, run: (root: string) => void): void {
    const root = mkdtempSync(join(tmpdir(), 'symlink-scan-test-'));
    try {
      build(root);
      run(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  test('finds an absolute-target symlink pointing outside the project dir', () => {
    const outsideDir = mkdtempSync(join(tmpdir(), 'symlink-scan-outside-'));
    try {
      const targetFile = join(outsideDir, 'real-env');
      writeFileSync(targetFile, 'SECRET=1\n', 'utf8');

      withTmpProject(
        (root) => symlinkSync(targetFile, join(root, '.env')),
        (root) => {
          const result = scanForExternalSymlinks(root);
          expect(result.candidates).toEqual([{ source: join(root, '.env'), target: targetFile }]);
          expect(result.warnings).toEqual([]);
        },
      );
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test('warns (does not mount) a relative-target symlink pointing outside the project', () => {
    withTmpProject(
      (root) => symlinkSync('../../outside/.env', join(root, '.env')),
      (root) => {
        const result = scanForExternalSymlinks(root);
        expect(result.candidates).toEqual([]);
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0]).toContain('relative symlink target');
      },
    );
  });

  test('warns (does not mount) a dangling absolute-target symlink', () => {
    withTmpProject(
      (root) => symlinkSync('/does/not/exist/on/host', join(root, '.env')),
      (root) => {
        const result = scanForExternalSymlinks(root);
        expect(result.candidates).toEqual([]);
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0]).toContain('target does not exist on the host');
      },
    );
  });

  test('skips excluded directories entirely', () => {
    const outsideDir = mkdtempSync(join(tmpdir(), 'symlink-scan-outside-'));
    try {
      const targetFile = join(outsideDir, 'real-env');
      writeFileSync(targetFile, 'SECRET=1\n', 'utf8');

      withTmpProject(
        (root) => {
          mkdirSync(join(root, 'node_modules'));
          symlinkSync(targetFile, join(root, 'node_modules', '.env'));
        },
        (root) => {
          const result = scanForExternalSymlinks(root);
          expect(result.candidates).toEqual([]);
        },
      );
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test('a custom excludeDirs EXTENDS the defaults rather than replacing them', () => {
    const outsideDir = mkdtempSync(join(tmpdir(), 'symlink-scan-outside-'));
    try {
      const targetFile = join(outsideDir, 'real-env');
      writeFileSync(targetFile, 'SECRET=1\n', 'utf8');

      withTmpProject(
        (root) => {
          mkdirSync(join(root, 'node_modules'));
          symlinkSync(targetFile, join(root, 'node_modules', '.env'));
          mkdirSync(join(root, 'venv'));
          symlinkSync(targetFile, join(root, 'venv', '.env'));
        },
        (root) => {
          // Passing a custom list (e.g. from sbxSymlinkScanExcludeDirs) must
          // still skip the built-in defaults (node_modules), not just the
          // custom entry (venv) — regression test for a bug where a custom
          // list silently replaced the defaults instead of adding to them.
          const result = scanForExternalSymlinks(root, { excludeDirs: ['venv'] });
          expect(result.candidates).toEqual([]);
        },
      );
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test('does not flag a symlink whose target is inside the project dir', () => {
    withTmpProject(
      (root) => {
        writeFileSync(join(root, '.env.local'), 'SECRET=1\n', 'utf8');
        symlinkSync(join(root, '.env.local'), join(root, '.env'));
      },
      (root) => {
        const result = scanForExternalSymlinks(root);
        expect(result.candidates).toEqual([]);
        expect(result.warnings).toEqual([]);
      },
    );
  });

  test('recurses into nested (non-excluded) directories', () => {
    const outsideDir = mkdtempSync(join(tmpdir(), 'symlink-scan-outside-'));
    try {
      const targetFile = join(outsideDir, 'real-env');
      writeFileSync(targetFile, 'SECRET=1\n', 'utf8');

      withTmpProject(
        (root) => {
          mkdirSync(join(root, 'apps', 'api'), { recursive: true });
          symlinkSync(targetFile, join(root, 'apps', 'api', '.env'));
        },
        (root) => {
          const result = scanForExternalSymlinks(root);
          expect(result.candidates).toEqual([{ source: join(root, 'apps', 'api', '.env'), target: targetFile }]);
        },
      );
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});
