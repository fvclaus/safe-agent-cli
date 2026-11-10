import React, { useState } from 'react';
import { Box, Text, render, useApp, useInput, type Key } from 'ink';
import { homedir } from 'node:os';
import { relative, sep } from 'node:path';
import type { SymlinkMountCandidate } from './symlink-scan.js';
import type { SymlinkTargetKind } from './symlink-mounts.js';

// One checklist for every not-yet-approved symlink, instead of a [y/N]
// question per symlink. Everything starts unchecked, so an accidental Enter
// exposes nothing.

/** `path` relative to `dir` when it lies strictly inside it, otherwise undefined. */
function inside(dir: string, path: string): string | undefined {
  const rel = relative(dir, path);
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith(sep) ? rel : undefined;
}

/** `~/…` for a path inside the home dir. */
export function tildePath(path: string, home: string = homedir()): string {
  const inHome = inside(home, path);
  return inHome !== undefined ? `~/${inHome}` : path;
}

/** Shortens a path for display: relative to the project root inside it, `~/…` inside the home dir. */
export function displayPath(path: string, projectRoot: string, home: string = homedir()): string {
  return inside(projectRoot, path) ?? tildePath(path, home);
}

export interface ChecklistState {
  cursor: number;
  checked: boolean[];
}

/** `checked` per candidate on Enter/Esc; `null` on Ctrl+C (abort the launch). */
export type ChecklistOutcome = boolean[] | null;

export type ChecklistStep =
  | { kind: 'update'; state: ChecklistState }
  | { kind: 'done'; outcome: ChecklistOutcome };

export function initialChecklistState(count: number): ChecklistState {
  return { cursor: 0, checked: Array.from({ length: count }, () => false) };
}

/** Pure key handling, kept apart from Ink so it can be tested directly. */
export function checklistKey(state: ChecklistState, input: string, key: Partial<Key>): ChecklistStep {
  const count = state.checked.length;
  if (key.ctrl && input === 'c') return { kind: 'done', outcome: null };
  if (key.return) return { kind: 'done', outcome: state.checked };
  if (key.escape) return { kind: 'done', outcome: state.checked.map(() => false) };
  if (key.upArrow || input === 'k') {
    return { kind: 'update', state: { ...state, cursor: (state.cursor - 1 + count) % count } };
  }
  if (key.downArrow || input === 'j') {
    return { kind: 'update', state: { ...state, cursor: (state.cursor + 1) % count } };
  }
  if (input === ' ') {
    const checked = state.checked.map((c, i) => (i === state.cursor ? !c : c));
    return { kind: 'update', state: { ...state, checked } };
  }
  if (input === 'a') {
    const all = state.checked.every(Boolean);
    return { kind: 'update', state: { ...state, checked: state.checked.map(() => !all) } };
  }
  return { kind: 'update', state };
}

interface ChecklistProps {
  sandboxName: string;
  projectRoot: string;
  candidates: SymlinkMountCandidate[];
  kinds: SymlinkTargetKind[];
  onDone: (outcome: ChecklistOutcome) => void;
}

const SymlinkChecklist: React.FC<ChecklistProps> = ({ sandboxName, projectRoot, candidates, kinds, onDone }) => {
  const { exit } = useApp();
  const [state, setState] = useState(() => initialChecklistState(candidates.length));

  useInput((input, key) => {
    const step = checklistKey(state, input, key);
    if (step.kind === 'update') {
      setState(step.state);
      return;
    }
    onDone(step.outcome);
    exit();
  });

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold color="cyan">
        Sandbox '{sandboxName}': project symlinks pointing outside the project dir
      </Text>
      <Text dimColor>Project: {tildePath(projectRoot)}</Text>
      <Box flexDirection="column">
        {candidates.map((candidate, i) => (
          <Text key={candidate.source} {...(i === state.cursor && { color: 'cyan' })}>
            {i === state.cursor ? '›' : ' '} {state.checked[i] ? '[x]' : '[ ]'} {displayPath(candidate.source, projectRoot)} → {displayPath(candidate.target, projectRoot)}{' '}
            <Text dimColor>{kinds[i] === 'directory' ? '[dir · live mount]' : '[file · copied in]'}</Text>
          </Text>
        ))}
      </Box>
      <Text dimColor>
        Checked paths become visible inside the sandbox so the symlinks resolve. A directory is bind-mounted
        (edits sync both ways); a file is copied in at every launch (one-way, sandbox edits are overwritten).
      </Text>
      <Text dimColor>↑/↓ move · Space toggle · a all/none · Enter confirm · Esc decline all · Ctrl+C abort</Text>
    </Box>
  );
};

export async function promptSymlinkChecklist(
  sandboxName: string,
  projectRoot: string,
  candidates: SymlinkMountCandidate[],
  kinds: SymlinkTargetKind[],
): Promise<ChecklistOutcome> {
  let outcome: ChecklistOutcome = null;
  const { waitUntilExit } = render(
    <SymlinkChecklist
      sandboxName={sandboxName}
      projectRoot={projectRoot}
      candidates={candidates}
      kinds={kinds}
      onDone={(o) => { outcome = o; }}
    />,
    { exitOnCtrlC: false },
  );
  await waitUntilExit();
  return outcome;
}
