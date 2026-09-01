import { spawnSync } from 'node:child_process';

// sbx (Docker Sandboxes) proxies GitHub credentials into the container itself
// — sbx-claude-code never runs its own setupGithubIntegration (see
// integrations/github.ts) here. All we need is whether a "github" service
// secret is configured, so the right github-scoped fragment (see
// fragments/github-sbx.md) can be selected. `sbx secret ls` has no JSON
// output, so presence is detected by text-matching its "No secrets found"
// message rather than parsing a table.
//
// A secret can be scoped globally or to one sandbox (`sbx secret set
// --sandbox`), and `sbx secret ls --sandbox X` does NOT fall back to global
// secrets when none is scoped to X — confirmed by testing. So availability
// for a given sandbox requires checking both scopes and OR-ing the result;
// checking only the plain `--service github` form would give a false
// positive from an unrelated sandbox's scoped secret.

const NOT_FOUND_MARKER = 'No secrets found';

function hasGithubSecret(scopeArgs: string[]): boolean {
  const result = spawnSync('sbx', ['secret', 'ls', '--service', 'github', ...scopeArgs], { encoding: 'utf8' });
  if (result.error) {
    throw new Error(`failed to run sbx secret ls: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`sbx secret ls --service github ${scopeArgs.join(' ')} exited with code ${result.status}: ${result.stderr}`);
  }
  return !result.stdout.includes(NOT_FOUND_MARKER);
}

/**
 * Whether a "github" service secret is configured for the given sandbox,
 * either globally or scoped to that sandbox specifically. Throws if `sbx
 * secret ls` itself fails to run — this never silently degrades to "not
 * configured", matching this codebase's general error-handling stance.
 */
export function isGithubConfigured(sandboxName: string): boolean {
  return hasGithubSecret(['--global']) || hasGithubSecret(['--sandbox', sandboxName]);
}
