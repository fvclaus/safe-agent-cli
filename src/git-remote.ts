import { spawnSync } from 'node:child_process';

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
