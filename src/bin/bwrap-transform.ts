/**
 * Pure argument-transformation logic for the bwrap shim (src/bin/bwrap).
 *
 * Kept free of process/env/fs side effects so it can be unit-tested. The shim
 * itself is the thin I/O layer that reads argv/env, probes the filesystem, calls
 * these functions and execs the real bwrap.
 */
import { dirname, join } from 'node:path';

export const DEBUG_VAR = 'BWRAP_WRAPPER_DEBUG';
const DEBUG_ASSIGNMENT = new RegExp(`(?:^|[^\\w$])${DEBUG_VAR}=1(?![\\w])`);

/**
 * True when the sandboxed command itself sets `BWRAP_WRAPPER_DEBUG=1` (as a
 * prefix assignment or an `export`). The shim runs once per Bash command and
 * receives that command inside the args after the `--` separator, so an agent
 * can switch on debug logging for a single command without relaunching.
 */
export function commandRequestsDebug(args: readonly string[]): boolean {
  const sep = args.indexOf('--');
  if (sep === -1) return false;
  return args.slice(sep + 1).some((a) => DEBUG_ASSIGNMENT.test(a));
}

export const REDACTED = '<redacted>';
const SECRET_ENV_NAME = /PASSWORD|PASSWD|TOKEN|SECRET|CREDENTIAL|API_KEY|PRIVATE_KEY|PROXY_USER/i;
// `scheme://user:password@host` — the proxy URLs carry the session's proxy credentials.
const URL_USERINFO = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@'"]+@/gi;

/**
 * A copy of `args` safe to write to the debug log: the value of every
 * `--setenv` whose name looks secret is replaced, and so is the userinfo of
 * every URL in any arg (including the wrapped command string).
 */
export function redactArgsForLog(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--setenv' && i + 2 < args.length) {
      const name = args[i + 1]!;
      const value = SECRET_ENV_NAME.test(name) ? REDACTED : redactUrlUserinfo(args[i + 2]!);
      out.push(a, name, value);
      i += 2;
      continue;
    }
    out.push(redactUrlUserinfo(a));
  }
  return out;
}

function redactUrlUserinfo(value: string): string {
  return value.replace(URL_USERINFO, `$1${REDACTED}@`);
}

// Older Claude Code versions wrap each sandboxed command with a proxy-cleanup trap:
//     trap "kill %1 %2 2>/dev/null; exit" EXIT
// Under zsh a bare `exit` in a trap takes the status of the trap's last command
// (the `kill`), so the command's real exit code is lost — verified directly:
// `zsh -c 'trap "kill %1 %2 2>/dev/null; exit" EXIT; false'` reports 0, not 1.
// Rewrite it to capture $? first. Exactly one backslash before each `$` is what
// survives the `zsh -c '...'` / `bash -c '...'` layers the harness uses, so
// $?/$rc expand at trap-fire time rather than when the trap is installed —
// verified against both `zsh -c` and `bash -c` directly; the fix is
// shell-agnostic and a no-op risk-free under bash, which doesn't have this bug.
//
// Current Claude Code versions ship the fix themselves, single-quoted:
//     trap 'rc=$?; kill %1 %2 2>/dev/null; exit $rc' EXIT
// The match is therefore anchored on the whole double-quoted `trap "..." EXIT`
// form. Matching the bare `kill … ; exit` substring would also hit the fixed
// trap and turn it into `exit \$rc $rc` — inside single quotes `\$rc` stays
// literal, so zsh fails with "exit: too many arguments" and bash with
// "exit: $rc: numeric argument required" on every sandboxed command.
export const OLD_TRAP = 'trap "kill %1 %2 2>/dev/null; exit" EXIT';
export const NEW_TRAP = 'trap "rc=\\$?; kill %1 %2 2>/dev/null; exit \\$rc" EXIT';
/** The trap current Claude Code versions install themselves; left untouched. */
export const UPSTREAM_FIXED_TRAP = "trap 'rc=$?; kill %1 %2 2>/dev/null; exit $rc' EXIT";

/**
 * Step 1: drop `--unshare-net` (so the sandbox shares the host network
 * namespace) and rewrite the exit-code-eating trap in every argument. An
 * argument carrying the upstream-fixed trap is passed through unchanged.
 */
export function stripUnshareNetAndFixTrap(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (const a of argv) {
    if (a === '--unshare-net') continue;
    out.push(a.split(OLD_TRAP).join(NEW_TRAP));
  }
  return out;
}

// Inside the sandbox Claude Code exposes its proxy on fixed ports: each sandboxed
// command starts `socat TCP-LISTEN:3128` / `TCP-LISTEN:1080` relays to the
// session's /tmp/claude-http-<hash>.sock, and points every proxy variable at
// localhost:3128 / localhost:1080. That only works in a private network
// namespace. With --unshare-net stripped, all sandboxed commands of all sessions
// share the host namespace: the first relay to bind 3128 wins, the others fail
// silently, and their requests reach another session's proxy backend, which
// rejects the credential with 407.
//
// The session's backend already listens on the host loopback, and Claude Code
// passes its ports as CLAUDE_CODE_HOST_HTTP_PROXY_PORT / _SOCKS_PROXY_PORT.
// Pointing the proxy variables straight at those ports gives every session its
// own endpoint and makes the relays unnecessary.
export const SANDBOX_HTTP_PROXY_PORT = '3128';
export const SANDBOX_SOCKS_PROXY_PORT = '1080';
export const HOST_HTTP_PROXY_PORT_VAR = 'CLAUDE_CODE_HOST_HTTP_PROXY_PORT';
export const HOST_SOCKS_PROXY_PORT_VAR = 'CLAUDE_CODE_HOST_SOCKS_PROXY_PORT';

// `socat TCP-LISTEN:3128,fork,reuseaddr UNIX-CONNECT:/tmp/claude-http-<hash>.sock >/dev/null 2>&1 &`
const SANDBOX_RELAY = /socat TCP-LISTEN:(?:3128|1080),\S* UNIX-CONNECT:\S+ >\/dev\/null 2>&1 &[ \t]*/g;
// Exported into GIT_CONFIG_PARAMETERS by the command string so git never asks a
// credential helper for the proxy's own credentials.
const GIT_PROXY_CREDENTIAL_KEY = 'credential.http://localhost:3128.helper';

interface HostProxyPorts {
  http: string;
  socks: string;
}

/** Read the host backend ports from `--setenv` args first, then the inherited env. */
export function findHostProxyPorts(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): HostProxyPorts | null {
  const lookup = (name: string): string | undefined => {
    for (let i = 0; i + 2 < args.length; i++) {
      if (args[i] === '--setenv' && args[i + 1] === name) return args[i + 2];
    }
    return env[name];
  };
  const isPort = (p: string | undefined): p is string => p !== undefined && /^\d+$/.test(p);
  const http = lookup(HOST_HTTP_PROXY_PORT_VAR);
  if (!isPort(http)) return null;
  const socks = lookup(HOST_SOCKS_PROXY_PORT_VAR);
  return { http, socks: isPort(socks) ? socks : http };
}

function repointProxyValue(value: string, ports: HostProxyPorts): string {
  return value
    .replace(/localhost:3128\b/g, `localhost:${ports.http}`)
    .replace(/localhost:1080\b/g, `localhost:${ports.socks}`)
    .replace(/proxyport=3128\b/g, `proxyport=${ports.http}`);
}

function repointEnvValue(name: string, value: string, ports: HostProxyPorts): string {
  if (name === 'CLOUDSDK_PROXY_PORT' && value === SANDBOX_HTTP_PROXY_PORT) return ports.http;
  return repointProxyValue(value, ports);
}

/**
 * Step 2b: point the sandbox's proxy configuration at the session's own host
 * backend instead of the shared fixed ports, and drop the now-unused relays.
 * Rewrites `--setenv` values, proxy variables the sandbox inherits from `env`
 * (re-set via `--setenv` before the `--` separator), and the wrapped command
 * string. Without a host port to route to, the args are returned unchanged.
 */
export function routeProxyToHostBackend(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  const ports = findHostProxyPorts(args, env);
  if (!ports) return [...args];

  const out: string[] = [];
  const setByArgs = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--setenv' && i + 2 < args.length) {
      const name = args[i + 1]!;
      setByArgs.add(name);
      out.push(a, name, repointEnvValue(name, args[i + 2]!, ports));
      i += 2;
      continue;
    }
    // The command string also embeds the user's command, so only the harness's own
    // proxy references are rewritten — never a bare localhost:3128 the user typed.
    out.push(
      a
        .replace(SANDBOX_RELAY, '')
        .split(GIT_PROXY_CREDENTIAL_KEY)
        .join(`credential.http://localhost:${ports.http}.helper`),
    );
  }

  const inherited: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || setByArgs.has(name)) continue;
    const repointed = repointEnvValue(name, value, ports);
    if (repointed !== value) inherited.push('--setenv', name, repointed);
  }
  if (inherited.length === 0) return out;

  const sep = out.indexOf('--');
  if (sep === -1) return out;
  return [...out.slice(0, sep), ...inherited, ...out.slice(sep)];
}

/** Extract the target path from a git worktree `.git` pointer file's contents. */
export function parseGitdir(pointerContents: string): string | null {
  const line = pointerContents.split('\n').find((l) => l.startsWith('gitdir:'));
  if (!line) return null;
  return line.slice('gitdir:'.length).trim().replace(/\r$/, '');
}

export interface WorktreeProbe {
  /** True when `src` is a git worktree pointer file (exists, is a file, ends in /.git). */
  isPointerFile(src: string): boolean;
  /** Read the pointer file's contents. Only called when isPointerFile(src) is true. */
  readPointer(src: string): string;
}

/**
 * Step 3: when the project is a git worktree, `.git` is a pointer file rather than
 * a directory. Claude Code binds only the pointer, not its target, so git fails
 * inside the sandbox. Inject the missing gitdir binds before the `--` separator.
 */
export function injectWorktreeBinds(args: readonly string[], probe: WorktreeProbe): string[] {
  const extra: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--ro-bind' && args[i] !== '--bind') continue;
    const src = args[i + 1];
    if (!src || !src.endsWith('/.git') || !probe.isPointerFile(src)) continue;

    const gitdir = parseGitdir(probe.readPointer(src));
    if (!gitdir) continue;

    // .git/worktrees/<name> -> .git (main repo git dir).
    // mainGitDir (.git) holds refs/heads, objects, packed-refs;
    // gitdir (.git/worktrees/<name>) holds HEAD, MERGE_HEAD, lock files.
    const mainGitDir = dirname(dirname(gitdir));
    extra.push('--bind', mainGitDir, mainGitDir, '--bind', gitdir, gitdir);
  }

  if (extra.length === 0) return [...args];

  const out: string[] = [];
  for (const a of args) {
    if (a === '--') out.push(...extra);
    out.push(a);
  }
  return out;
}

const SETTINGS_SUFFIX = '/.claude/settings.json';

/**
 * Discover the project root from the bwrap args. Claude Code always masks
 * <root>/.claude/settings.json, so its DEST reveals the root. Falls back to `cwd`.
 */
export function discoverProjectRoot(args: readonly string[], cwd: string): string {
  for (const a of args) {
    if (a.endsWith(SETTINGS_SUFFIX)) return a.slice(0, -SETTINGS_SUFFIX.length);
  }
  return cwd;
}

/**
 * Expand an allowWrite/denyWrite settings entry to an absolute path, or null to
 * skip it. The bare project root (`.` or the root itself) is skipped on purpose:
 * it is already the default rw mount, and honoring it would blanket-undeny
 * .git/config, .mcp.json and the dotfiles too. Env-var forms are unsupported.
 */
export function resolveSettingsPath(
  p: string,
  projectRoot: string,
  home: string,
): string | null {
  if (p === '.' || p === projectRoot) return null;
  if (p.startsWith('$')) return null;
  const s = p.replace(/\/$/, '');
  if (s.startsWith('/')) return s;
  if (s.startsWith('~/')) return join(home, s.slice(2));
  if (s.startsWith('./')) return join(projectRoot, s.slice(2));
  return join(projectRoot, s);
}

/** True when `dest` equals or is nested under any of `prefixes`. */
export function isWithin(dest: string, prefixes: readonly string[]): boolean {
  const d = dest.replace(/\/$/, '');
  return prefixes.some((w) => d === w || d.startsWith(w + '/'));
}

/**
 * Step 4a: reverse the harness's hardcoded deny wall for whitelisted paths whose
 * whole subtree is covered. Drop any `--ro-bind SRC DEST` triple whose DEST falls
 * inside an allowWrite prefix (and not inside a denyWrite prefix). bwrap applies
 * binds in order (last wins), so removing the later deny lets the earlier
 * read-write bind show through.
 *
 * This alone does NOT cover a whitelisted path *nested under* a denied parent
 * (e.g. allowWrite ".claude/hooks/.venv" while the harness denies ".claude/hooks"
 * as a whole): the parent's deny DEST is not inside the write prefix, so it is
 * kept, and — being mounted after the child's rw bind — it shadows the child.
 * appendWritableRebinds handles that case.
 *
 * `onUndeny` is invoked with each removed DEST for optional debug logging.
 */
export function stripDenyWall(
  args: readonly string[],
  writePrefixes: readonly string[],
  denyPrefixes: readonly string[],
  onUndeny?: (dest: string) => void,
): string[] {
  if (writePrefixes.length === 0) return [...args];

  const kept: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if ((a === '--ro-bind' || a === '--ro-bind-try') && i + 2 < args.length) {
      const dest = args[i + 2]!;
      if (isWithin(dest, writePrefixes) && !isWithin(dest, denyPrefixes)) {
        onUndeny?.(dest);
        i += 2; // skip the SRC and DEST that follow
        continue;
      }
    }
    kept.push(a);
  }
  return kept;
}

/**
 * Step 4b: guarantee each whitelisted path is writable by re-binding it
 * read-write *after* the deny wall, just before the `--` separator. bwrap applies
 * binds in order (last wins), so this overrides any ancestor `--ro-bind` the
 * harness layered on top — the case stripDenyWall can't reach (a whitelisted
 * subdir nested under a denied parent, e.g. ".claude/hooks/.venv" under a denied
 * ".claude/hooks"). The harness itself binds such paths rw, but too early, so its
 * own parent deny shadows them; re-binding last fixes the ordering.
 *
 * `prefixes` should already be filtered to paths that exist on disk (bwrap fails
 * to bind a missing source) and are not re-denied by denyWrite. Re-binding a path
 * that is already writable is a harmless idempotent mount.
 *
 * `onRebind` is invoked with each re-bound path for optional debug logging.
 */
export function appendWritableRebinds(
  args: readonly string[],
  prefixes: readonly string[],
  onRebind?: (path: string) => void,
): string[] {
  if (prefixes.length === 0) return [...args];

  const binds: string[] = [];
  for (const p of prefixes) {
    onRebind?.(p);
    binds.push('--bind', p, p);
  }

  const sep = args.indexOf('--');
  if (sep === -1) return [...args]; // no bwrap separator — not a sandbox invocation
  return [...args.slice(0, sep), ...binds, ...args.slice(sep)];
}

/**
 * Step 4c: keep the project root writable when the harness stacks a read-only
 * layer over it. The root is a default rw mount, so steps 4a and 4b skip it on
 * purpose (see resolveSettingsPath). A `denyWrite` that covers the project, e.g.
 * `~/` while the project lives under the home directory, makes the harness add
 * `--ro-bind X <root>` (or one for an ancestor of the root) after the rw bind,
 * and the whole project turns read-only.
 *
 * A plain `--bind <root> <root>` after that layer would undo it, but it would
 * also hide the masks the harness placed inside the project (`.git/config`,
 * `.mcp.json`, `.claude/settings*.json`, the dotfile stubs). So the root is
 * re-bound read-write and every mask inside it (`--ro-bind`, `--ro-bind-try`,
 * `--tmpfs`) is replayed in its original order afterwards. The binds land
 * before the `--` separator, ahead of whatever appendWritableRebinds adds.
 *
 * An ancestor of the root only counts when it is not `/` itself: the base
 * `--ro-bind / /` is how every sandbox starts and is not a deny.
 *
 * `onRestore` is invoked with the root once the layer is undone.
 */
export function restoreProjectRootWritable(
  args: readonly string[],
  projectRoot: string,
  onRestore?: (root: string) => void,
): string[] {
  const root = projectRoot.replace(/\/$/, '');
  const sep = args.indexOf('--');
  if (root === '' || sep === -1) return [...args];

  let rootCovered = false;
  const masks: Array<{ dest: string; mount: string[] }> = [];
  // A read-write bind mounts over everything below its DEST, so masks mounted
  // there earlier are dead. Replaying them would resurrect read-only layers the
  // harness itself had already lifted (e.g. subdirectory binds that precede its
  // `--bind <root> <root>`).
  const dropMasksUnder = (dest: string) => {
    for (let m = masks.length - 1; m >= 0; m--) {
      if (isWithin(masks[m]!.dest, [dest])) masks.splice(m, 1);
    }
  };
  for (let i = 0; i < sep; i++) {
    const a = args[i]!;
    if ((a === '--ro-bind' || a === '--ro-bind-try') && i + 2 < sep) {
      const dest = args[i + 2]!.replace(/\/$/, '');
      if (dest !== '' && isWithin(root, [dest])) rootCovered = true;
      else if (isWithin(dest, [root])) masks.push({ dest, mount: [a, args[i + 1]!, args[i + 2]!] });
      i += 2;
    } else if (a === '--bind' && i + 2 < sep) {
      dropMasksUnder(args[i + 2]!.replace(/\/$/, ''));
      i += 2;
    } else if (a === '--tmpfs' && i + 1 < sep) {
      const dest = args[i + 1]!.replace(/\/$/, '');
      if (isWithin(dest, [root]) && dest !== root) masks.push({ dest, mount: [a, args[i + 1]!] });
      i += 1;
    }
  }
  if (!rootCovered) return [...args];

  onRestore?.(root);
  return [
    ...args.slice(0, sep),
    '--bind', root, root,
    ...masks.flatMap((m) => m.mount),
    ...args.slice(sep),
  ];
}
