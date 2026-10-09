import { describe, expect, test } from 'bun:test';
import {
  AUTO_CLOSE_MS,
  buildView,
  consumedText,
  levelStyle,
  paneHeader,
  paneOpenArgs,
  parseLaunchLog,
  placementFor,
  resolveLogPath,
  shouldAct,
} from '../src/launch-log-plugin/hooks/launch-log.js';

const log = (entries: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ version: 1, consumed: false, entries, ...extra });

describe('resolveLogPath', () => {
  test('prefers the override', () => {
    expect(resolveLogPath('/tmp/x.json', '/home/u')).toBe('/tmp/x.json');
  });

  test('falls back under HOME when the override is unset or empty', () => {
    const expected = '/home/u/.claude/safe-agent-cli/launch-log.json';
    expect(resolveLogPath(undefined, '/home/u')).toBe(expected);
    expect(resolveLogPath('', '/home/u/')).toBe(expected);
  });

  test('is undefined without override and HOME', () => {
    expect(resolveLogPath(undefined, undefined)).toBeUndefined();
  });
});

describe('parseLaunchLog', () => {
  test('accepts a fresh version 1 log', () => {
    const parsed = parseLaunchLog(log([{ level: 'ok', text: 'fine' }]));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.entries).toEqual([{ level: 'ok', text: 'fine' }]);
  });

  test('rejects unparsable content', () => {
    expect(parseLaunchLog('{nope')).toEqual({ ok: false, reason: 'unparsable' });
    expect(parseLaunchLog('[]')).toEqual({ ok: false, reason: 'unparsable' });
    expect(parseLaunchLog('null')).toEqual({ ok: false, reason: 'unparsable' });
  });

  test('rejects another version', () => {
    const text = JSON.stringify({ version: 2, consumed: false, entries: [{ level: 'ok', text: 'a' }] });
    expect(parseLaunchLog(text)).toEqual({ ok: false, reason: 'version' });
  });

  test('rejects a consumed log', () => {
    const text = log([{ level: 'ok', text: 'a' }], { consumed: true });
    expect(parseLaunchLog(text)).toEqual({ ok: false, reason: 'consumed' });
  });

  test('drops malformed entries and rejects a log left with none', () => {
    const mixed = parseLaunchLog(log([{ level: 'bogus', text: 'a' }, { level: 'info' }, 5, { level: 'info', text: 'kept' }]));
    expect(mixed.ok && mixed.entries).toEqual([{ level: 'info', text: 'kept' }]);
    expect(parseLaunchLog(log([{ level: 'bogus', text: 'a' }]))).toEqual({ ok: false, reason: 'empty' });
  });
});

describe('consumedText', () => {
  test('writes the same JSON with consumed true', () => {
    const parsed = parseLaunchLog(log([{ level: 'warning', text: 'w' }], { extra: 1 }));
    if (!parsed.ok) throw new Error('expected a parsed log');
    const written = consumedText(parsed.raw);
    expect(JSON.parse(written)).toEqual({
      version: 1,
      consumed: true,
      entries: [{ level: 'warning', text: 'w' }],
      extra: 1,
    });
    expect(parseLaunchLog(written)).toEqual({ ok: false, reason: 'consumed' });
  });
});

describe('buildView', () => {
  test('without warnings: no focus, auto close after 30 seconds', () => {
    const view = buildView([
      { level: 'ok', text: 'a' },
      { level: 'info', text: 'b' },
    ]);
    expect(view.hasWarnings).toBe(false);
    expect(view.autoCloseMs).toBe(AUTO_CLOSE_MS);
    expect(AUTO_CLOSE_MS).toBe(30_000);
    expect(view.hint).toBe('Launch log: 2 entries');
    expect(paneOpenArgs(view)).toEqual({ id: 'launch-log', title: 'Launch log', rows: 3 });
  });

  test('with a warning: focus, Esc closes, stays open, warnings first', () => {
    const view = buildView([
      { level: 'ok', text: 'fine' },
      { level: 'warning', text: 'careful' },
      { level: 'error', text: 'broken' },
      { level: 'skip', text: 'skipped' },
    ]);
    expect(view.hasWarnings).toBe(true);
    expect(view.autoCloseMs).toBeNull();
    expect(view.header).toBe('1 error, 1 warning — press Esc to dismiss');
    expect(view.hint).toBe('Launch log: 1 error, 1 warning');
    expect(view.lines.map(line => line.level)).toEqual(['error', 'warning', 'ok', 'skip']);
    expect(paneOpenArgs(view)).toEqual({
      id: 'launch-log',
      title: 'Launch log',
      focus: true,
      closeOnEscape: true,
      rows: 5,
    });
  });

  test('pluralizes the warning count', () => {
    const view = buildView([
      { level: 'warning', text: 'a' },
      { level: 'warning', text: 'b' },
    ]);
    expect(view.header).toBe('2 warnings — press Esc to dismiss');
    expect(buildView([{ level: 'warning', text: 'a' }]).hint).toBe('Launch log: 1 warning');
  });

  test('asks for the rows the wrapped log takes inline', () => {
    // Each line is the 6-cell level prefix plus the text: 6 + 30 = 36 cells,
    // two rows at 24 body columns (28 terminal columns less the frame's 4).
    const view = buildView([
      { level: 'ok', text: 'x'.repeat(30) },
      { level: 'ok', text: 'short' },
    ]);
    expect(paneOpenArgs(view, 28).rows).toBe(1 + 2 + 1);
  });

  test('the header names the rows a short body cuts off', () => {
    const view = buildView([
      { level: 'ok', text: 'a' },
      { level: 'ok', text: 'b' },
      { level: 'ok', text: 'c' },
    ]);
    expect(paneHeader(view, 80, 4)).toBe(view.header);
    expect(paneHeader(view, 80, 3)).toBe(`${view.header} — 1 more row below, scroll to see them`);
    expect(paneHeader(view, 80, 2)).toBe(`${view.header} — 2 more rows below, scroll to see them`);
  });

  test('line text is one line per entry', () => {
    const view = buildView([{ level: 'ok', text: 'done' }]);
    expect(view.lines).toHaveLength(1);
    expect(view.lines[0]?.text.endsWith('done')).toBe(true);
  });
});

describe('levelStyle', () => {
  test('colors ok, warning and error; dims the rest', () => {
    expect(levelStyle('ok')).toEqual({ color: 'success' });
    expect(levelStyle('warning')).toEqual({ color: 'warning' });
    expect(levelStyle('error')).toEqual({ color: 'error' });
    for (const level of ['info', 'skip', 'progress'] as const) {
      expect(levelStyle(level)).toEqual({ dimColor: true });
    }
  });
});

describe('shouldAct', () => {
  test('acts only when the renderer reports fullscreen', () => {
    expect(shouldAct({ isFullscreen: true })).toBe(true);
    expect(shouldAct({ isFullscreen: false })).toBe(false);
    expect(shouldAct({})).toBe(false);
    expect(shouldAct(undefined)).toBe(false);
  });
});

describe('placementFor', () => {
  test('wide terminal: the pane is seated', () => {
    expect(placementFor({ isPlaced: true })).toBe('pane');
  });

  test('narrow terminal: the pane waits, so the hint shows', () => {
    expect(placementFor({ isPlaced: false })).toBe('hint');
  });
});
