import { describe, expect, test } from 'bun:test';
import { checklistKey, displayPath, initialChecklistState, tildePath, type ChecklistState } from '../src/sbx/symlink-approval-prompt.js';

function press(state: ChecklistState, input: string, key: Parameters<typeof checklistKey>[2] = {}): ChecklistState {
  const step = checklistKey(state, input, key);
  if (step.kind !== 'update') throw new Error('expected the checklist to stay open');
  return step.state;
}

describe('checklistKey', () => {
  test('starts with nothing checked', () => {
    expect(initialChecklistState(3)).toEqual({ cursor: 0, checked: [false, false, false] });
  });

  test('Enter right away approves nothing', () => {
    expect(checklistKey(initialChecklistState(2), '', { return: true })).toEqual({ kind: 'done', outcome: [false, false] });
  });

  test('arrows and j/k move the cursor and wrap', () => {
    let s = initialChecklistState(3);
    s = press(s, '', { upArrow: true });
    expect(s.cursor).toBe(2);
    s = press(s, 'j');
    expect(s.cursor).toBe(0);
    s = press(s, '', { downArrow: true });
    s = press(s, 'k');
    expect(s.cursor).toBe(0);
  });

  test('Space toggles the current row', () => {
    let s = press(initialChecklistState(2), 'j');
    s = press(s, ' ');
    expect(s.checked).toEqual([false, true]);
    s = press(s, ' ');
    expect(s.checked).toEqual([false, false]);
  });

  test('a checks all, then unchecks all', () => {
    let s = press(press(initialChecklistState(3), ' '), 'a');
    expect(s.checked).toEqual([true, true, true]);
    s = press(s, 'a');
    expect(s.checked).toEqual([false, false, false]);
  });

  test('Enter confirms the checked rows', () => {
    const s = press(press(initialChecklistState(2), 'a'), ' ');
    expect(checklistKey(s, '', { return: true })).toEqual({ kind: 'done', outcome: [false, true] });
  });

  test('Esc declines all, even checked rows', () => {
    const s = press(initialChecklistState(2), 'a');
    expect(checklistKey(s, '', { escape: true })).toEqual({ kind: 'done', outcome: [false, false] });
  });

  test('Ctrl+C aborts', () => {
    expect(checklistKey(initialChecklistState(1), 'c', { ctrl: true })).toEqual({ kind: 'done', outcome: null });
  });
});

describe('displayPath', () => {
  test('a path inside the project is shown relative to it', () => {
    expect(displayPath('/home/u/work/proj/config/.env', '/home/u/work/proj', '/home/u')).toBe('config/.env');
  });

  test('a path inside the home dir gets ~', () => {
    expect(displayPath('/home/u/.secrets/env', '/home/u/work/proj', '/home/u')).toBe('~/.secrets/env');
  });

  test('a sibling dir sharing the project prefix is not treated as inside it', () => {
    expect(displayPath('/home/u/work/proj-other/x', '/home/u/work/proj', '/home/u')).toBe('~/work/proj-other/x');
  });

  test('anything else stays absolute', () => {
    expect(displayPath('/etc/hosts', '/home/u/work/proj', '/home/u')).toBe('/etc/hosts');
    expect(tildePath('/home/u', '/home/u')).toBe('/home/u');
  });
});
