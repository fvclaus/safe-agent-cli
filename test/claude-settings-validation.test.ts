import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateClaudeSettingsFiles, type SchemaFetcher } from '../src/claude-settings-validation.js';

// A copy of https://json.schemastore.org/claude-code-settings.json, checked in
// so these tests run offline against the real schema. Refresh it by hand.
const schema: unknown = JSON.parse(
  readFileSync(join(import.meta.dir, 'fixtures', 'claude-code-settings.schema.json'), 'utf8'),
);

describe('validateClaudeSettingsFiles', () => {
  function withFiles(files: Record<string, string>, run: (paths: string[]) => Promise<void>): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'settings-'));
    const paths = Object.entries(files).map(([name, content]) => {
      const path = join(dir, name);
      writeFileSync(path, content);
      return path;
    });
    return run(paths).finally(() => rmSync(dir, { recursive: true, force: true }));
  }

  function countingFetcher(): { fetchSchema: SchemaFetcher; calls: () => number } {
    let calls = 0;
    return {
      fetchSchema: async () => {
        calls++;
        return schema;
      },
      calls: () => calls,
    };
  }

  test('a valid settings file passes', () =>
    withFiles(
      { 'settings.json': JSON.stringify({ sandbox: { enabled: true }, permissions: { allow: ['Bash(ls:*)'] } }) },
      async (paths) => {
        expect(await validateClaudeSettingsFiles(paths, { skipSchema: false, fetchSchema: countingFetcher().fetchSchema })).toEqual([]);
      },
    ));

  test('reports an unknown nested key with its file and JSON path', () =>
    withFiles({ 'settings.json': JSON.stringify({ sandbox: { enabeld: true } }) }, async (paths) => {
      const errors = await validateClaudeSettingsFiles(paths, { skipSchema: false, fetchSchema: countingFetcher().fetchSchema });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain(paths[0]!);
      expect(errors[0]).toContain('/sandbox');
      expect(errors[0]).toContain('"enabeld"');
    }));

  test('reports a wrong value type', () =>
    withFiles({ 'settings.json': JSON.stringify({ sandbox: { enabled: 'yes' } }) }, async (paths) => {
      const errors = await validateClaudeSettingsFiles(paths, { skipSchema: false, fetchSchema: countingFetcher().fetchSchema });
      expect(errors.some(e => e.includes('/sandbox/enabled'))).toBe(true);
    }));

  test('a partial settings-sbx.json declaring only hooks passes', () =>
    withFiles(
      {
        'settings-sbx.json': JSON.stringify({
          hooks: { Stop: [{ hooks: [{ type: 'command', command: 'curl -s http://host.docker.internal:9999/' }] }] },
        }),
      },
      async (paths) => {
        expect(await validateClaudeSettingsFiles(paths, { skipSchema: false, fetchSchema: countingFetcher().fetchSchema })).toEqual([]);
      },
    ));

  test('reports invalid JSON without fetching the schema when every file is broken', () =>
    withFiles({ 'settings.json': '{ not json' }, async (paths) => {
      const fetcher = countingFetcher();
      const errors = await validateClaudeSettingsFiles(paths, { skipSchema: false, fetchSchema: fetcher.fetchSchema });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('invalid JSON');
      expect(fetcher.calls()).toBe(0);
    }));

  test('a failed schema fetch is an error', () =>
    withFiles({ 'settings.json': JSON.stringify({}) }, async (paths) => {
      const errors = await validateClaudeSettingsFiles(paths, {
        skipSchema: false,
        fetchSchema: async () => {
          throw new Error('Bad Gateway');
        },
      });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('could not fetch the settings schema');
      expect(errors[0]).toContain('--skip-settings-schema');
    }));

  test('skipSchema never fetches and ignores schema violations, but still checks syntax', () =>
    withFiles(
      { 'a.json': JSON.stringify({ sandbox: { enabeld: true } }), 'b.json': '{ not json' },
      async (paths) => {
        const fetcher = countingFetcher();
        const errors = await validateClaudeSettingsFiles(paths, { skipSchema: true, fetchSchema: fetcher.fetchSchema });
        expect(fetcher.calls()).toBe(0);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain('invalid JSON');
      },
    ));

  test('missing files are skipped and nothing is fetched', async () => {
    const fetcher = countingFetcher();
    const errors = await validateClaudeSettingsFiles([join(tmpdir(), 'does-not-exist', 'settings.json')], {
      skipSchema: false,
      fetchSchema: fetcher.fetchSchema,
    });
    expect(errors).toEqual([]);
    expect(fetcher.calls()).toBe(0);
  });
});
