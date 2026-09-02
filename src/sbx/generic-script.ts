import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// The sandbox-creation script (e.g. claude-generic.sh) is intentionally
// pluggable — sbx-claude-code must work for every user, and different users
// may point it at different scripts, so nothing about its location or its
// sandbox-naming convention is assumed. It's supplied per invocation via
// --generic-script, and only two subcommands are part of its contract:
// `build` (provision the sandbox, don't start Claude) and `resolve-name`
// (print the sandbox name and nothing else) — both needed by the orchestrator
// itself. The final launch step is NOT part of the contract: it's whatever the
// caller passes after `--`, so no particular command name (like `run`) is
// assumed to exist.
//
// Any switches the caller puts after the launch command name are forwarded to
// `build` and `resolve-name` as well, because a switch can change WHICH sandbox
// is meant — e.g. claude-generic.sh's `--clone` changes the sandbox name. If
// they weren't forwarded, we'd build and inject hooks into one sandbox and then
// launch a different one, with nothing to signal the mismatch.
//
// The script is executed directly (not via `bash <script>`), so its own
// shebang decides the interpreter — a bash wrapper and a bun/TS script (e.g.
// claude-generic.ts, run straight from a local checkout) both work as long as
// the file is executable.

export function requireGenericScript(path: string | undefined): string {
  if (!path) {
    throw new Error(
      '--generic-script <path> is required.\n' +
      'sbx-claude-code needs a script that knows how to build and name the sandbox ' +
      '(e.g. claude-generic.sh, supporting the `build` and `resolve-name` subcommands). ' +
      'There is no default — pass it explicitly.',
    );
  }
  if (!existsSync(path)) {
    throw new Error(`--generic-script ${path} does not exist.`);
  }
  return path;
}

/**
 * Runs `<script> <args...>` with inherited stdio (interactive: may prompt,
 * e.g. on template drift). Takes arbitrary args rather than a fixed command
 * so the final launch step isn't locked to assuming the script defines a
 * `run` subcommand — see runFinalCommand. Executed directly (relying on its
 * shebang) so the script isn't required to be a bash script.
 */
export function runGenericScript(scriptPath: string, args: string[]): void {
  const result = spawnSync(scriptPath, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  const status = result.status ?? 1;
  if (status !== 0) {
    throw new Error(`${scriptPath} ${args.join(' ')} exited with code ${status}`);
  }
}

/**
 * Runs `<script> resolve-name` and returns its trimmed stdout (expected to be
 * exactly the sandbox name).
 *
 * Why ask the script instead of matching `sbx ls --json`'s `workspaces` against
 * our own cwd: a `--clone` sandbox and its bind-mount sibling share the same
 * workspace path (claude-generic.sh passes $PROJECT_ROOT for both), so a
 * workspace lookup can't tell them apart — and would silently merge hooks into
 * the wrong one. It would also mean re-deriving the workspace root the same way
 * the script does (walk up for .git, fall back to $PWD), duplicating logic that
 * is the pluggable script's business, and `workspaces` is a list anyway once a
 * script mounts extra read-only paths.
 */
export function resolveSandboxName(scriptPath: string, switches: string[] = []): string {
  const result = spawnSync(scriptPath, ['resolve-name', ...switches], { encoding: 'utf8' });
  if (result.error) throw result.error;
  const status = result.status ?? 1;
  if (status !== 0) {
    throw new Error(`${scriptPath} resolve-name exited with code ${status}: ${result.stderr}`);
  }
  // Scripts that delegate to a project-specific wrapper may print a
  // diagnostic line to stdout before the name (e.g. "delegating to it...").
  // The contract only guarantees the name is the last thing printed, so take
  // the last non-empty line rather than the whole trimmed output.
  const lines = result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  const name = lines.at(-1);
  if (!name) throw new Error(`${scriptPath} resolve-name printed no output`);
  return name;
}
