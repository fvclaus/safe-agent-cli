import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSandboxHome } from './home.js';

// Mirrors the host's ~/.claude/skills into the sandbox's in-container
// ~/.claude/skills, following the same "host is authoritative only for what it
// owns" philosophy as the hooks merge (merge-settings.ts).
//
// Provenance marker: every skill this tool copies gets a MARKER file dropped
// inside its directory. That's what lets a later run tell host-synced skills
// apart from skills that are sandbox-local — created inside the sandbox or
// baked into the image. Only marked skills are eligible for pruning; anything
// without the marker is never touched. Per-skill (rather than a single
// top-level manifest) so each directory is self-describing and provenance
// survives even if the skills tree is edited by hand.
//
// Symlinks: skills on the host are commonly symlinks into a shared drive. A
// verbatim copy would leave the sandbox with a dangling link pointing at a
// host path it can't see, so every skill is staged with `cp -rL` (dereference)
// before it's pushed in — the sandbox always gets real file content.
//
// Batching: every skill to remove or replace is deleted in ONE `sbx exec rm
// -rf` call, and every upserted skill is staged locally then pushed in ONE
// `sbx cp <tmpDir>/. sandbox:<skillsDir>` (docker-cp's "copy directory
// CONTENTS into an existing destination" form) — 2 round-trips total instead
// of one rm+cp pair per skill. That contents-only form was verified against a
// real sandbox (probe-sbx-batch-cp-v2.sh): it merges flatly with no nesting
// and leaves unrelated siblings alone, but it also carries the LOCAL staging
// dir's own owner/mode onto the destination directory on extraction. Node's
// `mkdtempSync` defaults to 0700, which would lock the sandbox user out of
// paths it just created (confirmed — first probe run needed `sudo chown` to
// recover). `chmod -R 0777` on the staging dir before the cp neutralizes
// that: whatever owner UID lands on the container side, the mode bits alone
// guarantee the sandbox user can still read AND rm -rf these paths, this run
// and on the next one.

const MARKER = '.sbx-host-synced';
const MARKER_BODY =
  '# Managed by sbx-claude-code: this skill was copied from the host\n' +
  '# ~/.claude/skills. It is overwritten on the next run, and removed if the\n' +
  '# host no longer has it. Sandbox-local skills omit this marker.\n';

export interface SkillSyncPlan {
  /** Host skills to (re)copy — the host is authoritative for every skill it ships. */
  upsert: string[];
  /** Previously host-synced skills the host no longer has — safe to prune. */
  prune: string[];
}

export interface SkillSyncResult {
  synced: string[];
  pruned: string[];
  totalMs: number;
}

/**
 * Pure decision layer: given the skills the host currently has and the skills
 * in the sandbox that carry our provenance marker, decide what to copy and what
 * to prune. Kept free of I/O so it's unit-testable without a live sandbox.
 */
export function planSkillSync(hostSkills: string[], markedSandboxSkills: string[]): SkillSyncPlan {
  const hostSet = new Set(hostSkills);
  return {
    upsert: [...hostSkills],
    prune: markedSandboxSkills.filter((s) => !hostSet.has(s)),
  };
}

/** Immediate subdirectories of the host skills dir — one per skill. Dotfiles
 * (e.g. our own marker, stray hidden files) and dangling symlinks are skipped. */
function listHostSkills(hostSkillsDir: string): string[] {
  if (!existsSync(hostSkillsDir)) return [];
  const skills: string[] = [];
  for (const entry of readdirSync(hostSkillsDir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    let st;
    try {
      // statSync (not lstat) so a symlinked skill dir counts as a directory.
      st = statSync(join(hostSkillsDir, entry.name));
    } catch {
      continue; // dangling symlink — nothing real to copy
    }
    if (st.isDirectory()) skills.push(entry.name);
  }
  return skills;
}

export function runSbx(args: string[], what: string): void {
  const result = spawnSync('sbx', args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  if ((result.status ?? 1) !== 0) {
    throw new Error(`${what} failed: ${result.stderr || `exit code ${result.status}`}`);
  }
}

/** Basenames of skills in the sandbox that carry our provenance marker. */
function listMarkedSandboxSkills(sandboxName: string, skillsDir: string): string[] {
  // No `set -e`: the `[ -e ] && basename` idiom returns nonzero for every skill
  // that lacks the marker, which would abort the loop under errexit.
  const script =
    `d="${skillsDir}"; [ -d "$d" ] || exit 0; ` +
    `for s in "$d"/*/; do [ -e "$s${MARKER}" ] && basename "$s"; done; exit 0`;
  const result = spawnSync('sbx', ['exec', sandboxName, 'bash', '-c', script], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if ((result.status ?? 1) !== 0) {
    throw new Error(`could not list synced skills in sandbox '${sandboxName}': ${result.stderr}`);
  }
  return result.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Stage a dereferenced copy of one host skill (real files, not symlinks) plus its provenance marker. */
function stageSkill(hostSkillsDir: string, skill: string, tmpDir: string): void {
  const staged = join(tmpDir, skill);
  const cp = spawnSync('cp', ['-rL', join(hostSkillsDir, skill), staged], { encoding: 'utf8' });
  if (cp.error) throw cp.error;
  if ((cp.status ?? 1) !== 0) {
    throw new Error(`staging host skill '${skill}' failed: ${cp.stderr}`);
  }
  writeFileSync(join(staged, MARKER), MARKER_BODY, 'utf8');
}

/**
 * Mirror the host's ~/.claude/skills into the sandbox. Host-wins per skill;
 * sandbox-local skills (no marker) are preserved; host-synced skills the host
 * dropped are pruned. No-op if the host skills dir does not exist.
 */
export function syncSkillsIntoSandbox(sandboxName: string, hostSkillsDir: string): SkillSyncResult {
  const start = performance.now();
  if (!existsSync(hostSkillsDir)) {
    return { synced: [], pruned: [], totalMs: 0 };
  }

  const home = resolveSandboxHome(sandboxName);
  const skillsDir = `${home}/.claude/skills`;

  const hostSkills = listHostSkills(hostSkillsDir);
  const marked = listMarkedSandboxSkills(sandboxName, skillsDir);
  const plan = planSkillSync(hostSkills, marked);

  // Every path that needs to disappear before the batched copy: pruned
  // skills (host no longer has them) plus every upserted skill (so the
  // merge-copy below creates each one fresh rather than nesting under
  // docker-cp's "copy into an existing path" rule). One rm -rf call covers
  // all of them — bare argv, no shell, multiple paths in a single invocation.
  const removeTargets = [...plan.prune, ...plan.upsert].map((s) => `${skillsDir}/${s}`);
  if (removeTargets.length > 0) {
    runSbx(['exec', sandboxName, 'rm', '-rf', ...removeTargets], 'removing stale/pruned skill dirs');
  }

  if (plan.upsert.length > 0) {
    runSbx(['exec', sandboxName, 'mkdir', '-p', skillsDir], `creating ${skillsDir}`);
    const tmpDir = mkdtempSync(join(tmpdir(), 'sbx-claude-code-skills-'));
    try {
      for (const skill of plan.upsert) stageSkill(hostSkillsDir, skill, tmpDir);

      // chmod 0777 before handing the tree to `sbx cp`: the contents-only
      // merge-copy ('<tmpDir>/.') carries this directory's own owner/mode
      // onto the EXISTING destination on extraction (verified against a real
      // sandbox — see probe-sbx-batch-cp-v2.sh). mkdtempSync defaults to
      // 0700, which would otherwise lock the sandbox user out of paths we
      // just created — both this run and on the rm -rf above on the next one.
      const chmodRes = spawnSync('chmod', ['-R', '0777', tmpDir], { encoding: 'utf8' });
      if (chmodRes.error) throw chmodRes.error;
      if ((chmodRes.status ?? 1) !== 0) {
        throw new Error(`chmod of staging dir failed: ${chmodRes.stderr}`);
      }

      runSbx(['cp', `${tmpDir}/.`, `${sandboxName}:${skillsDir}`], 'copying staged skills into sandbox');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  return { synced: plan.upsert, pruned: plan.prune, totalMs: performance.now() - start };
}
