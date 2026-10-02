import { spawnSync } from 'node:child_process';

/** Whether the current working directory is inside a git repository (worktrees and submodules included). */
export function isGitRepo(): boolean {
  return spawnSync('git', ['rev-parse', '--git-dir'], { encoding: 'utf8' }).status === 0;
}

/** Whether GitHub integration must be on: it's a git repo and GitHub integration isn't enabled. */
export function missingMandatoryGithub(githubEnabled: boolean, gitRepo: boolean): boolean {
  return gitRepo && !githubEnabled;
}

/** The `origin` remote URL of the repo rooted at the current working directory, or undefined if there is none. */
export function getOriginUrl(): string | undefined {
  const result = spawnSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' });
  if (result.status !== 0) return undefined;
  const url = result.stdout.trim();
  return url.length > 0 ? url : undefined;
}

/** Matches both https://github.com/ORG/repo and git@github.com:ORG/repo. */
export function parseGithubOwner(url: string): string | undefined {
  const match = url.match(/github\.com[/:]([\w.-]+)\//);
  return match?.[1];
}
