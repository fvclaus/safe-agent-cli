import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import chalk from 'chalk';
import {
  entriesFromMessage,
  launchLogEntries,
  levelOfLine,
  log,
  resetLaunchLog,
  serializeLaunchLog,
  writeLaunchLogFile,
} from '../src/launch-log.js';

describe('levelOfLine', () => {
  test.each([
    ['OK: rtk is initialized', 'ok'],
    ['WARNING: ~/.claude/CLAUDE.md exists', 'warning'],
    ['ERROR: nope', 'error'],
    ['INFO: To deploy to Cloud Run, grant run.admin:', 'info'],
    ['SKIP: not exposing a -> b (declined)', 'skip'],
    ['>> script build', 'progress'],
    ['Fetching GCP project list…', 'info'],
    ['  Scopes: repo', 'info'],
  ] as const)('%s -> %s', (line, level) => {
    expect(levelOfLine(line)).toBe(level);
  });

  test('colored prefixes are recognised', () => {
    expect(levelOfLine(chalk.bold.yellow('WARNING:') + ' something')).toBe('warning');
    expect(levelOfLine(chalk.bold.green('OK:') + ' fine')).toBe('ok');
  });
});

describe('entriesFromMessage', () => {
  test('splits lines, drops blank ones and strips colors', () => {
    const entries = entriesFromMessage(chalk.bold.green('OK:') + ' first\n\nsecond line\n');
    expect(entries).toEqual([
      { level: 'ok', text: 'OK: first' },
      { level: 'info', text: 'second line' },
    ]);
  });
});

describe('log', () => {
  afterEach(() => resetLaunchLog());

  test('still writes to stderr and keeps a copy', () => {
    const write = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      log(chalk.bold.yellow('WARNING:') + ' careful');
      log('plain');
      expect(write).toHaveBeenCalledTimes(2);
      expect(write.mock.calls[0]?.[0]).toBe(chalk.bold.yellow('WARNING:') + ' careful\n');
    } finally {
      write.mockRestore();
    }
    expect(launchLogEntries()).toEqual([
      { level: 'warning', text: 'WARNING: careful' },
      { level: 'info', text: 'plain' },
    ]);
  });

  test('serializes to the contract the mod reads', () => {
    const write = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      log('OK: done');
    } finally {
      write.mockRestore();
    }
    expect(JSON.parse(serializeLaunchLog())).toEqual({
      version: 1,
      consumed: false,
      entries: [{ level: 'ok', text: 'OK: done' }],
    });
  });

  test('writeLaunchLogFile creates the directory and writes the log', () => {
    const write = spyOn(process.stderr, 'write').mockImplementation(() => true);
    const dir = mkdtempSync(join(tmpdir(), 'launch-log-test-'));
    try {
      log('OK: done');
      const path = join(dir, 'nested', 'launch-log.json');
      writeLaunchLogFile(path);
      expect(JSON.parse(readFileSync(path, 'utf8')).entries).toHaveLength(1);
    } finally {
      write.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
