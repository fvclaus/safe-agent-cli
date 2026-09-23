import { describe, expect, test } from 'bun:test';
import { missingGitExcludedCommands } from '../src/adapters/claude-code.js';

describe('missingGitExcludedCommands', () => {
  test('requires only git * without the rtk hook', () => {
    expect(missingGitExcludedCommands([], false)).toEqual(['git *']);
    expect(missingGitExcludedCommands([{ sandbox: { excludedCommands: ['git *'] } }], false)).toEqual([]);
  });

  test('also requires rtk git * when the rtk hook is installed', () => {
    expect(missingGitExcludedCommands([{ sandbox: { excludedCommands: ['git *'] } }], true)).toEqual(['rtk git *']);
  });

  test('entries may come from different settings files', () => {
    const files = [{ sandbox: { excludedCommands: ['git *'] } }, {}, { sandbox: { excludedCommands: ['rtk git *'] } }];
    expect(missingGitExcludedCommands(files, true)).toEqual([]);
  });

  test('an absolute-path git exclusion alone is not enough', () => {
    expect(missingGitExcludedCommands([{ sandbox: { excludedCommands: ['/usr/bin/git *'] } }], false)).toEqual(['git *']);
  });
});
