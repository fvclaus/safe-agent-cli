import { accessSync, constants, existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, sep } from 'node:path';

// safe-chain (@aikidosec/safe-chain) installs shell shims (functions for
// npm/npx/pip/python3/… plus PATH wrappers in ~/.safe-chain/bin) that route
// package-manager calls through the `safe-chain` binary for supply-chain malware
// scanning. Each shim runs `command -v safe-chain` and, if the binary can't be
// found, prints:
//
//   Warning: safe-chain is not available to protect you from installing malware.
//   <cmd> will run without it.
//
// and runs the tool unprotected.
//
// Inside the agent's bwrap sandbox the binary is on PATH (the env is inherited)
// but the *directory* holding it is not bind-mounted unless it's in the sandbox
// read allowlist. With the default `allowRead: ['.']` the sandbox can't see
// ~/.nvm (or wherever safe-chain lives), so `command -v safe-chain` fails and the
// warning fires on every npm/pip/python3 call. This module computes the host
// directories that must be granted read access so the binary resolves inside the
// sandbox — which is the actual fix, applied to the generated .claude settings.

function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Replicate `command -v <name>`: first executable match across PATH dirs. */
function resolveOnPath(name: string, pathEnv: string): string | null {
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

/**
 * Host directories the sandbox must be able to read so the `safe-chain` binary
 * resolves and runs inside it. Returns [] when safe-chain isn't installed (so we
 * don't widen the sandbox for nothing).
 *
 * For a typical nvm install the binary at
 *   ~/.nvm/versions/node/<v>/bin/safe-chain
 * is a symlink into
 *   ~/.nvm/versions/node/<v>/lib/node_modules/@aikidosec/safe-chain/...
 * and runs via `node` in the same bin dir. Granting the install prefix (the
 * parent of bin/) covers node, the symlink, and the package source in one path.
 */
export function safeChainReadPaths(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string[] {
  const paths = new Set<string>();

  // PATH wrappers used for non-interactive shells live here.
  const shimDir = join(home, '.safe-chain');
  if (existsSync(shimDir)) paths.add(shimDir);

  const bin = resolveOnPath('safe-chain', env['PATH'] ?? '');
  if (bin) {
    const binDir = dirname(bin);
    // Install prefix (parent of bin/): covers the node runtime, the safe-chain
    // launcher, and lib/node_modules/@aikidosec/safe-chain.
    paths.add(dirname(binDir));
    // Defensive: if the binary symlinks outside that prefix, grant the target's
    // directory too so the symlink can be followed inside the sandbox.
    try {
      paths.add(dirname(realpathSync(bin)));
    } catch {
      /* binary vanished between resolve and realpath — ignore */
    }
  }

  // Drop any path already covered by an ancestor in the set (e.g. the symlink
  // target dir nested under the install prefix) to keep the allowlist minimal.
  const all = [...paths];
  return all.filter(p => !all.some(other => other !== p && isAncestor(other, p)));
}

export function isAncestor(dir: string, child: string): boolean {
  const base = dir.endsWith(sep) ? dir : dir + sep;
  return child.startsWith(base);
}

/**
 * Merge `additions` (absolute paths) into an existing sandbox `allowRead` array,
 * skipping any path already granted by an exact match or an ancestor entry.
 * Paths under `home` are emitted in ~/ form to match the conventional style of
 * the user settings file. Returns the new array, or null when nothing changed
 * (so callers can avoid rewriting the file needlessly).
 */
export function mergeReadPaths(
  existing: string[],
  additions: string[],
  home: string,
): string[] | null {
  const expand = (p: string): string => (p.startsWith('~/') ? join(home, p.slice(2)) : p);
  const isCovered = (target: string): boolean =>
    existing.some(entry => {
      const e = expand(entry).replace(/[/\\]+$/, '');
      return e === target || isAncestor(e, target);
    });
  const toTilde = (p: string): string =>
    p === home ? '~/' : isAncestor(home, p) ? '~/' + p.slice(home.length + 1) : p;

  const toAdd = additions.filter(p => !isCovered(p)).map(toTilde);
  if (toAdd.length === 0) return null;
  return [...existing, ...toAdd];
}
