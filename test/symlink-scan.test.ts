import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { classifySymlinkTarget, scanForExternalSymlinks } from '../src/sbx/symlink-scan.js';

describe('classifySymlinkTarget', () => {
  const projectRoot = '/home/u/project';

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
          expect(result.errors).toEqual([]);
        },
      );
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test('a relative target outside the project is resolved and offered as a candidate', () => {
    const outsideDir = realpathSync(mkdtempSync(join(tmpdir(), 'symlink-scan-outside-')));
    try {
      const targetFile = join(outsideDir, 'real-env');
      writeFileSync(targetFile, 'SECRET=1\n', 'utf8');
      withTmpProject(
        (root) => {
          mkdirSync(join(root, 'config'));
          symlinkSync(relative(join(root, 'config'), targetFile), join(root, 'config', '.env'));
        },
        (root) => {
          const result = scanForExternalSymlinks(root);
          expect(result.candidates).toEqual([{ source: join(root, 'config', '.env'), target: targetFile }]);
          expect(result.warnings).toEqual([]);
          expect(result.errors).toEqual([]);
        },
      );
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test('a relative target that stays inside the project is silent', () => {
    withTmpProject(
      (root) => {
        mkdirSync(join(root, 'bin'));
        mkdirSync(join(root, 'src'));
        writeFileSync(join(root, 'src', 'tool'), '#!/bin/sh\n', 'utf8');
        symlinkSync('../src/tool', join(root, 'bin', 'tool'));
      },
      (root) => {
        expect(scanForExternalSymlinks(root)).toEqual({ candidates: [], warnings: [], errors: [] });
      },
    );
  });

  test('a relative target outside the project that does not exist is an error', () => {
    withTmpProject(
      (root) => symlinkSync('../../outside/.env', join(root, '.env')),
      (root) => {
        const result = scanForExternalSymlinks(root);
        expect(result.candidates).toEqual([]);
        expect(result.warnings).toEqual([]);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toContain('target does not exist on the host');
      },
    );
  });

  test('a dangling absolute-target symlink is an error', () => {
    withTmpProject(
      (root) => symlinkSync('/does/not/exist/on/host', join(root, '.env')),
      (root) => {
        const result = scanForExternalSymlinks(root);
        expect(result.candidates).toEqual([]);
        expect(result.warnings).toEqual([]);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toContain('target does not exist on the host');
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
