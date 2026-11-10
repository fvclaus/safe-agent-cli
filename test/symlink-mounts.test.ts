import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifySymlinkTargetKind, resolveSymlinkMountPlan } from '../src/sbx/symlink-mounts.js';
import { loadSymlinkApprovals } from '../src/sbx/symlink-approvals.js';

describe('classifySymlinkTargetKind', () => {
  test('directory target', () => {
    const dir = mkdtempSync(join(tmpdir(), 'classify-kind-test-'));
    try {
      expect(classifySymlinkTargetKind(dir)).toBe('directory');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('file target', () => {
    const dir = mkdtempSync(join(tmpdir(), 'classify-kind-test-'));
    try {
      const file = join(dir, 'real-env');
      writeFileSync(file, 'SECRET=1\n', 'utf8');
      expect(classifySymlinkTargetKind(file)).toBe('file');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('vanished target falls back to file (routes to the copy path, which surfaces its own error)', () => {
    expect(classifySymlinkTargetKind('/does/not/exist/anymore')).toBe('file');
  });
});

function withProjectAndTarget(
  buildTarget: (outsideDir: string) => string,
  run: (root: string, target: string) => Promise<void> | void,
) {
  const outsideDir = mkdtempSync(join(tmpdir(), 'symlink-mounts-outside-'));
  const root = mkdtempSync(join(tmpdir(), 'symlink-mounts-project-'));
  const target = buildTarget(outsideDir);
  symlinkSync(target, join(root, '.env'));
  return Promise.resolve(run(root, target)).finally(() => {
    rmSync(outsideDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });
}

function fileTarget(outsideDir: string): string {
  const target = join(outsideDir, 'real-env');
  writeFileSync(target, 'SECRET=1\n', 'utf8');
  return target;
}

function dirTarget(outsideDir: string): string {
  const target = join(outsideDir, 'real-env-dir');
  mkdirSync(target);
  return target;
}

describe('resolveSymlinkMountPlan', () => {
  test('no candidates: no prompt, empty plan', async () => {
    const root = mkdtempSync(join(tmpdir(), 'symlink-mounts-empty-'));
    try {
      const approvalsPath = join(root, 'approvals.json');
      let confirmCalls = 0;
      const plan = await resolveSymlinkMountPlan({
        projectRoot: root,
        sandboxName: 'sandbox-a',
        approvalsPath,
        select: async (_n, cs) => { confirmCalls++; return cs.map(() => true); },
      });
      expect(plan).toEqual({ bindMountArgs: [], mounted: [], fileCopies: [], declined: [], warnings: [], errors: [] });
      expect(confirmCalls).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('approving a FILE target routes it to fileCopies, not bindMountArgs', () =>
    withProjectAndTarget(fileTarget, async (root, target) => {
      const approvalsPath = join(root, '..', `approvals-${Date.now()}.json`);
      try {
        const plan = await resolveSymlinkMountPlan({
          projectRoot: root,
          sandboxName: 'sandbox-a',
          approvalsPath,
          select: async (_n, cs) => cs.map(() => true),
        });
        expect(plan.bindMountArgs).toEqual([]);
        expect(plan.mounted).toEqual([]);
        expect(plan.fileCopies).toEqual([{ source: join(root, '.env'), target }]);
        expect(plan.declined).toEqual([]);

        const { store } = loadSymlinkApprovals(approvalsPath);
        expect(store.data['sandbox-a']?.[join(root, '.env')]).toBe(target);
      } finally {
        rmSync(approvalsPath, { force: true });
      }
    }));

  test('approving a DIRECTORY target routes it to bindMountArgs, not fileCopies', () =>
    withProjectAndTarget(dirTarget, async (root, target) => {
      const approvalsPath = join(root, '..', `approvals-${Date.now()}.json`);
      try {
        const plan = await resolveSymlinkMountPlan({
          projectRoot: root,
          sandboxName: 'sandbox-a',
          approvalsPath,
          select: async (_n, cs) => cs.map(() => true),
        });
        expect(plan.bindMountArgs).toEqual(['--bind-mount', target]);
        expect(plan.mounted).toEqual([{ source: join(root, '.env'), target }]);
        expect(plan.fileCopies).toEqual([]);
      } finally {
        rmSync(approvalsPath, { force: true });
      }
    }));

  test('declining a candidate skips it without persisting an approval', () =>
    withProjectAndTarget(fileTarget, async (root, target) => {
      const approvalsPath = join(root, '..', `approvals-${Date.now()}.json`);
      try {
        const plan = await resolveSymlinkMountPlan({
          projectRoot: root,
          sandboxName: 'sandbox-a',
          approvalsPath,
          select: async (_n, cs) => cs.map(() => false),
        });
        expect(plan.bindMountArgs).toEqual([]);
        expect(plan.fileCopies).toEqual([]);
        expect(plan.declined).toEqual([{ source: join(root, '.env'), target }]);

        const { store } = loadSymlinkApprovals(approvalsPath);
        expect(store.data['sandbox-a']).toBeUndefined();
      } finally {
        rmSync(approvalsPath, { force: true });
      }
    }));

  test('a previously approved (source, target) is not re-confirmed', () =>
    withProjectAndTarget(fileTarget, async (root, target) => {
      const approvalsPath = join(root, '..', `approvals-${Date.now()}.json`);
      try {
        let confirmCalls = 0;
        const select = async (_n: string, cs: unknown[]) => { confirmCalls++; return cs.map(() => true); };

        const first = await resolveSymlinkMountPlan({ projectRoot: root, sandboxName: 'sandbox-a', approvalsPath, select });
        expect(confirmCalls).toBe(1);
        expect(first.fileCopies).toEqual([{ source: join(root, '.env'), target }]);

        const second = await resolveSymlinkMountPlan({ projectRoot: root, sandboxName: 'sandbox-a', approvalsPath, select });
        expect(confirmCalls).toBe(1); // no second prompt
        expect(second.fileCopies).toEqual([{ source: join(root, '.env'), target }]);
      } finally {
        rmSync(approvalsPath, { force: true });
      }
    }));

  test('the checklist gets every pending candidate at once; only checked ones are approved', async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), 'symlink-mounts-outside-'));
    const root = mkdtempSync(join(tmpdir(), 'symlink-mounts-project-'));
    const approvalsPath = join(root, '..', `approvals-${Date.now()}.json`);
    try {
      const fileTargetPath = fileTarget(outsideDir);
      const dirTargetPath = dirTarget(outsideDir);
      symlinkSync(fileTargetPath, join(root, '.env'));
      symlinkSync(dirTargetPath, join(root, 'data'));
      const seen: { sources: string[]; kinds: string[] }[] = [];
      const plan = await resolveSymlinkMountPlan({
        projectRoot: root,
        sandboxName: 'sandbox-a',
        approvalsPath,
        select: async (_n, cs, kinds) => {
          seen.push({ sources: cs.map((c) => c.source), kinds });
          return cs.map((c) => c.source.endsWith('data'));
        },
      });
      expect(seen).toHaveLength(1);
      expect([...seen[0]!.sources].sort()).toEqual([join(root, '.env'), join(root, 'data')]);
      expect(plan.bindMountArgs).toEqual(['--bind-mount', dirTargetPath]);
      expect(plan.declined).toEqual([{ source: join(root, '.env'), target: fileTargetPath }]);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
      rmSync(approvalsPath, { force: true });
    }
  });

  test('Ctrl+C in the checklist is an error and approves nothing', () =>
    withProjectAndTarget(fileTarget, async (root) => {
      const approvalsPath = join(root, '..', `approvals-${Date.now()}.json`);
      try {
        const plan = await resolveSymlinkMountPlan({
          projectRoot: root,
          sandboxName: 'sandbox-a',
          approvalsPath,
          select: async () => null,
        });
        expect(plan.errors).toEqual(['symlink approval aborted (Ctrl+C)']);
        expect(plan.fileCopies).toEqual([]);
        expect(loadSymlinkApprovals(approvalsPath).store.data).toEqual({});
      } finally {
        rmSync(approvalsPath, { force: true });
      }
    }));
});
