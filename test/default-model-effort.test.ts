import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureDefaultModelEffortLevels } from '../src/default-model-effort.js';

describe('ensureDefaultModelEffortLevels', () => {
  function withHomeAndProject(
    globalSettings: string | undefined,
    projectSettings: string | undefined,
    run: (home: string, project: string) => void,
  ): void {
    const home = mkdtempSync(join(tmpdir(), 'home-'));
    const project = mkdtempSync(join(tmpdir(), 'project-'));
    try {
      if (globalSettings !== undefined) {
        mkdirSync(join(home, '.claude'));
        writeFileSync(join(home, '.claude', 'settings.json'), globalSettings);
      }
      if (projectSettings !== undefined) {
        mkdirSync(join(project, '.claude'));
        writeFileSync(join(project, '.claude', 'settings.local.json'), projectSettings);
      }
      run(home, project);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  }

  function readProjectSettings(project: string): Record<string, unknown> {
    return JSON.parse(readFileSync(join(project, '.claude', 'settings.local.json'), 'utf8'));
  }

  test('defaults models missing an effortLevel to "medium"', () => {
    const global = JSON.stringify({
      modelSettings: { 'claude-opus-5-5': { effortLevel: 'xhigh' }, 'claude-opus-4-8': { effortLevel: 'medium' } },
    });
    withHomeAndProject(global, undefined, (home, project) => {
      ensureDefaultModelEffortLevels(() => {}, home, project);
      const settings = readProjectSettings(project);
      expect(settings['modelSettings']).toEqual({
        'claude-opus-5-5': { effortLevel: 'medium' },
        'claude-opus-4-8': { effortLevel: 'medium' },
      });
    });
  });

  test('leaves a model untouched if the project already set an effortLevel for it', () => {
    const global = JSON.stringify({
      modelSettings: { 'claude-opus-5-5': { effortLevel: 'xhigh' }, 'claude-opus-4-8': { effortLevel: 'medium' } },
    });
    const project = JSON.stringify({ modelSettings: { 'claude-opus-4-8': { effortLevel: 'xhigh' } } });
    withHomeAndProject(global, project, (home, projectDir) => {
      ensureDefaultModelEffortLevels(() => {}, home, projectDir);
      const settings = readProjectSettings(projectDir);
      expect(settings['modelSettings']).toEqual({
        'claude-opus-5-5': { effortLevel: 'medium' },
        'claude-opus-4-8': { effortLevel: 'xhigh' },
      });
    });
  });

  test('preserves other keys already in the project settings file', () => {
    const global = JSON.stringify({ modelSettings: { 'claude-opus-5-5': { effortLevel: 'xhigh' } } });
    const project = JSON.stringify({ sandbox: { enabled: true } });
    withHomeAndProject(global, project, (home, projectDir) => {
      ensureDefaultModelEffortLevels(() => {}, home, projectDir);
      const settings = readProjectSettings(projectDir);
      expect(settings['sandbox']).toEqual({ enabled: true });
      expect(settings['modelSettings']).toEqual({ 'claude-opus-5-5': { effortLevel: 'medium' } });
    });
  });

  test('no-op when ~/.claude/settings.json is missing', () => {
    withHomeAndProject(undefined, undefined, (home, projectDir) => {
      ensureDefaultModelEffortLevels(() => {}, home, projectDir);
      expect(() => readProjectSettings(projectDir)).toThrow();
    });
  });

  test('no-op when modelSettings is absent or empty', () => {
    withHomeAndProject(JSON.stringify({}), undefined, (home, projectDir) => {
      ensureDefaultModelEffortLevels(() => {}, home, projectDir);
      expect(() => readProjectSettings(projectDir)).toThrow();
    });
    withHomeAndProject(JSON.stringify({ modelSettings: {} }), undefined, (home, projectDir) => {
      ensureDefaultModelEffortLevels(() => {}, home, projectDir);
      expect(() => readProjectSettings(projectDir)).toThrow();
    });
  });

  test('does not rewrite the file when every model already has an effortLevel', () => {
    const global = JSON.stringify({ modelSettings: { 'claude-opus-5-5': { effortLevel: 'xhigh' } } });
    const project = JSON.stringify(
      {
        $schema: 'https://json.schemastore.org/claude-code-settings.json',
        modelSettings: { 'claude-opus-5-5': { effortLevel: 'xhigh' } },
      },
      null,
      2,
    ) + '\n';
    withHomeAndProject(global, project, (home, projectDir) => {
      const before = readFileSync(join(projectDir, '.claude', 'settings.local.json'), 'utf8');
      ensureDefaultModelEffortLevels(() => {}, home, projectDir);
      const after = readFileSync(join(projectDir, '.claude', 'settings.local.json'), 'utf8');
      expect(after).toBe(before);
    });
  });
});
