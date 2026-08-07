import { describe, expect, test } from 'bun:test';
import { planSkillSync } from '../src/sbx/copy-skills.js';

describe('planSkillSync', () => {
  test('upserts every host skill', () => {
    const plan = planSkillSync(['a', 'b'], []);
    expect(plan.upsert).toEqual(['a', 'b']);
    expect(plan.prune).toEqual([]);
  });

  test('prunes marked skills the host no longer has', () => {
    const plan = planSkillSync(['a'], ['a', 'b']);
    expect(plan.upsert).toEqual(['a']);
    expect(plan.prune).toEqual(['b']); // 'b' was host-synced before, now gone
  });

  test('never prunes an unmarked (sandbox-local) skill', () => {
    // 'local' is not in the marked set, so it can never appear in prune.
    const plan = planSkillSync(['a'], ['a']);
    expect(plan.prune).toEqual([]);
  });

  test('re-upserts a host skill even if already marked (host wins)', () => {
    const plan = planSkillSync(['a'], ['a']);
    expect(plan.upsert).toEqual(['a']);
    expect(plan.prune).toEqual([]);
  });

  test('empty host with marked skills prunes them all', () => {
    const plan = planSkillSync([], ['a', 'b']);
    expect(plan.upsert).toEqual([]);
    expect(plan.prune).toEqual(['a', 'b']);
  });

  test('empty everything is a no-op plan', () => {
    const plan = planSkillSync([], []);
    expect(plan.upsert).toEqual([]);
    expect(plan.prune).toEqual([]);
  });
});
