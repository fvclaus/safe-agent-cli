import { posix } from 'node:path';
import { runSbx } from './run-sbx.js';

// Copies a staged `.claude` tree into the sandbox's $HOME with ONE `sbx cp`.
//
// `sbx cp <dir> sandbox:<parent>` copies <dir> itself into <parent>, merging
// with an existing <parent>/<dir>: entries that are already there survive and
// new ones land beside them. The `<dir>/.` form does NOT copy the contents
// (as docker cp would); it nests <dir> one level deeper, where nothing looks
// for it. So the staged tree is always copied as a named directory.
//
// Merging applies the staged directories' own owner and mode to the existing
// destination directories, from the staging dir's `.claude` down to every
// staged directory that already existed in the sandbox. Those directories end
// up owned by the host uid. A follow-up `sudo chown` hands them back to the
// sandbox user: non-recursively for the merge-touched directories (a
// recursive chown of ~/.claude fails on the read-only host mounts below it),
// recursively for the trees this copy created.
//
// The same `sbx exec` then checks that every expected file landed where it
// should, so a copy that lands one level off fails the launch instead of
// silently doing nothing.

export interface HomeCopy {
  sandboxName: string;
  home: string;
  /** Directory holding `.claude/...`; its own owner/mode is never copied. */
  stagedRoot: string;
  /** Directories created by this copy, relative to $HOME; chowned recursively. */
  ownedTrees: string[];
  /** Files that must exist afterwards, relative to $HOME. */
  expectedFiles: string[];
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Every ancestor directory of the owned trees below $HOME, outermost first, without duplicates. */
export function mergedDirectories(ownedTrees: string[]): string[] {
  const dirs = new Set<string>();
  for (const tree of ownedTrees) {
    const parts = tree.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  return [...dirs].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
}

/** The shell script run in the sandbox after the copy: ownership fix-up, then the location check. */
export function postCopyScript(home: string, copy: Pick<HomeCopy, 'ownedTrees' | 'expectedFiles'>): string {
  const abs = (rel: string) => shQuote(posix.join(home, rel));
  const shallow = mergedDirectories(copy.ownedTrees).map(abs).join(' ');
  const deep = copy.ownedTrees.map(abs).join(' ');
  const lines = ['set -eu', 'u=$(id -u); g=$(id -g)'];
  if (shallow) lines.push(`sudo chown "$u:$g" ${shallow}`);
  if (deep) lines.push(`sudo chown -R "$u:$g" ${deep}`);
  for (const file of copy.expectedFiles) {
    lines.push(`[ -f ${abs(file)} ] || { echo "missing after copy: ${posix.join(home, file).replace(/["$`\\]/g, '\\$&')}" >&2; exit 1; }`);
  }
  return lines.join('\n');
}

export function copyStagedClaudeTreeIntoHome(copy: HomeCopy): void {
  runSbx(['cp', `${copy.stagedRoot}/.claude`, `${copy.sandboxName}:${copy.home}`], 'copying into sandbox');
  runSbx(
    ['exec', copy.sandboxName, 'bash', '-c', postCopyScript(copy.home, copy)],
    `verifying the copy in sandbox '${copy.sandboxName}'`,
  );
}
