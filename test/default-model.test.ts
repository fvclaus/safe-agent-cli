import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureDefaultModel } from '../src/default-model.js';

describe('ensureDefaultModel', () => {
  function withProject(
    files: { local?: string; shared?: string },
    run: (project: string) => void,
  ): void {
    const project = mkdtempSync(join(tmpdir(), 'project-'));
    try {
      if (files.local !== undefined || files.shared !== undefined) mkdirSync(join(project, '.claude'));
      if (files.local !== undefined) writeFileSync(join(project, '.claude', 'settings.local.json'), files.local);
      if (files.shared !== undefined) writeFileSync(join(project, '.claude', 'settings.json'), files.shared);
      run(project);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  }

  const localPath = (project: string): string => join(project, '.claude', 'settings.local.json');

  function readLocal(project: string): Record<string, unknown> {
    return JSON.parse(readFileSync(localPath(project), 'utf8'));
  }

  test('writes the default model when the project has no settings.local.json', () => {
    withProject({}, (project) => {
      const logged: string[] = [];
      ensureDefaultModel('opus', (msg) => logged.push(msg), project);
      expect(readLocal(project)['model']).toBe('opus');
      expect(logged).toHaveLength(1);
      expect(logged[0]).toContain('defaulted model to "opus"');
      expect(logged[0]).toContain(localPath(project));
    });
  });

  test('writes the value verbatim, alias or full id', () => {
    withProject({}, (project) => {
      ensureDefaultModel('claude-opus-5-5[1m]', () => {}, project);
      expect(readLocal(project)['model']).toBe('claude-opus-5-5[1m]');
    });
  });

  test('adds the model next to the keys already in the file', () => {
    const local = JSON.stringify({
      sandbox: { enabled: true },
      modelSettings: { 'claude-opus-5-5': { effortLevel: 'medium' } },
    });
    withProject({ local }, (project) => {
      ensureDefaultModel('opus', () => {}, project);
      expect(readLocal(project)).toEqual({
        $schema: 'https://json.schemastore.org/claude-code-settings.json',
        sandbox: { enabled: true },
        modelSettings: { 'claude-opus-5-5': { effortLevel: 'medium' } },
        model: 'opus',
      });
    });
  });

  test('leaves a model already in settings.local.json untouched', () => {
    const local = JSON.stringify(
      { $schema: 'https://json.schemastore.org/claude-code-settings.json', model: 'sonnet' },
      null,
      4,
    );
    withProject({ local }, (project) => {
      const logged: string[] = [];
      ensureDefaultModel('opus', (msg) => logged.push(msg), project);
      expect(readFileSync(localPath(project), 'utf8')).toBe(local);
      expect(logged).toEqual([]);
    });
  });

  test('a later change of the default does not reach a project seeded before', () => {
    withProject({}, (project) => {
      ensureDefaultModel('opus', () => {}, project);
      ensureDefaultModel('sonnet', () => {}, project);
      expect(readLocal(project)['model']).toBe('opus');
    });
  });

  test('writes the default even when the checked-in settings.json names a model', () => {
    withProject({ shared: JSON.stringify({ model: 'sonnet' }) }, (project) => {
      ensureDefaultModel('opus', () => {}, project);
      expect(readLocal(project)['model']).toBe('opus');
      expect(JSON.parse(readFileSync(join(project, '.claude', 'settings.json'), 'utf8'))).toEqual({ model: 'sonnet' });
    });
  });

  test('no-op without a default model', () => {
    withProject({}, (project) => {
      ensureDefaultModel(undefined, () => {}, project);
      expect(() => readLocal(project)).toThrow();
    });
    const local = '{"sandbox":{"enabled":true}}';
    withProject({ local }, (project) => {
      ensureDefaultModel(undefined, () => {}, project);
      expect(readFileSync(localPath(project), 'utf8')).toBe(local);
    });
  });
});
