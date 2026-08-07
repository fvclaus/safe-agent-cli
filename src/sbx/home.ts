import { spawnSync } from 'node:child_process';

// Resolving $HOME inside the sandbox (rather than assuming /home/<user> or
// /root) is shared by everything that writes into the sandbox's ~/.claude:
// the hooks merge (merge-settings.ts) and the skills sync (copy-skills.ts).
export function resolveSandboxHome(sandboxName: string): string {
  const result = spawnSync('sbx', ['exec', sandboxName, 'bash', '-c', 'printf %s "$HOME"'], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if ((result.status ?? 1) !== 0) {
    throw new Error(`could not resolve $HOME inside sandbox '${sandboxName}': ${result.stderr}`);
  }
  const home = result.stdout.trim();
  if (!home) throw new Error(`sandbox '${sandboxName}' returned an empty $HOME`);
  return home;
}
