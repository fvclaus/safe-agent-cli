import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, posix } from 'node:path';

// sbx shares skills with sandboxes through its own machine-wide skill store,
// filled by `sbx skills import`. safe-agent-cli never writes into that store
// (it is shared by every sandbox on the machine); it only compares it with the
// host's ~/.claude/skills and says how to bring it up to date.
//
// The comparison follows what `sbx skills import` copies: every directory
// directly under ~/.claude/skills (a top-level symlink followed), hidden
// entries skipped, symlinks inside a skill skipped, every other file
// byte-for-byte. A skill that ~/.agents/skills also has is not compared:
// import takes that copy instead, as ~/.agents/skills comes first. Store
// entries the host does not have are not reported either: they come from
// `sbx skills add`, another agent's skills directory or a kit.

export const SKILL_STORE_UPDATE_COMMAND = 'sbx skills import --force';

export interface SkillStoreDrift {
  /** Host skills the store does not have. */
  missing: string[];
  /** Host skills whose store copy has other files or other content. */
  changed: string[];
}

/** Directory names directly under `dir` that import would take, top-level symlinks followed. */
export function listSkillDirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const names: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.')) continue;
    try {
      if (statSync(join(dir, entry)).isDirectory()) names.push(entry);
    } catch {
      // A dangling symlink: nothing to import.
    }
  }
  return names.sort();
}

/** Every regular file below `root`, as a posix path relative to it; symlinks below the root are skipped. */
function listFiles(root: string, rel = ''): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(join(root, rel))) {
    const relPath = rel ? posix.join(rel, entry) : entry;
    const st = lstatSync(join(root, relPath));
    if (st.isDirectory()) files.push(...listFiles(root, relPath));
    else if (st.isFile()) files.push(relPath);
  }
  return files;
}

/** Whether two skill directories hold the same files with the same content. */
export function sameSkillContent(hostSkill: string, storeSkill: string): boolean {
  const hostFiles = listFiles(hostSkill).sort();
  const storeFiles = listFiles(storeSkill).sort();
  if (hostFiles.length !== storeFiles.length) return false;
  return hostFiles.every((file, i) => {
    if (file !== storeFiles[i]) return false;
    const a = join(hostSkill, file);
    const b = join(storeSkill, file);
    return statSync(a).size === statSync(b).size && readFileSync(a).equals(readFileSync(b));
  });
}

export function compareSkillStore(hostSkillsDir: string, storeDir: string, precedingSkillsDirs: string[]): SkillStoreDrift {
  const shadowed = new Set(precedingSkillsDirs.flatMap(listSkillDirs));
  const stored = new Set(listSkillDirs(storeDir));
  const drift: SkillStoreDrift = { missing: [], changed: [] };
  for (const skill of listSkillDirs(hostSkillsDir)) {
    if (shadowed.has(skill)) continue;
    if (!stored.has(skill)) drift.missing.push(skill);
    else if (!sameSkillContent(join(hostSkillsDir, skill), join(storeDir, skill))) drift.changed.push(skill);
  }
  return drift;
}

/** The store's directory as `sbx skills ls --json` reports it. */
export function parseSkillStoreListing(stdout: string): string {
  const parsed: unknown = JSON.parse(stdout);
  const store = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>)['store'] : undefined;
  if (typeof store !== 'string' || store === '') {
    throw new Error(`'sbx skills ls --json' printed no "store" path`);
  }
  return store;
}

export function resolveSkillStoreDir(): string {
  const result = spawnSync('sbx', ['skills', 'ls', '--json'], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if ((result.status ?? 1) !== 0) {
    throw new Error(`'sbx skills ls --json' failed: ${result.stderr.trim() || `exit code ${result.status}`}`);
  }
  return parseSkillStoreListing(result.stdout);
}

/**
 * The warnings about the skill store for this launch: drift against
 * ~/.claude/skills, and a copy of the launch-log mod that an earlier version
 * of this tool put into the sandbox's skills directory, which now loads beside
 * the one in the sandbox's own plugin folder. A failure to compare is a
 * warning too: the launch does not need the store.
 */
export function skillStoreWarnings(hostHome: string, launchLogPluginName: string): string[] {
  let storeDir: string;
  let drift: SkillStoreDrift;
  try {
    storeDir = resolveSkillStoreDir();
    drift = compareSkillStore(join(hostHome, '.claude', 'skills'), storeDir, [join(hostHome, '.agents', 'skills')]);
  } catch (e) {
    return [`could not compare the sbx skill store with ~/.claude/skills: ${e instanceof Error ? e.message : String(e)}`];
  }
  const warnings: string[] = [];
  const driftLine = describeSkillStoreDrift(drift, storeDir);
  if (driftLine) warnings.push(driftLine);
  if (listSkillDirs(storeDir).includes(launchLogPluginName)) {
    warnings.push(
      `the sbx skill store holds an old copy of the launch-log mod, which loads in every sandbox. ` +
        `Remove it with 'sbx skills rm ${launchLogPluginName}'.`,
    );
  }
  return warnings;
}

/** One line naming what differs, or null when the store is in sync. */
export function describeSkillStoreDrift(drift: SkillStoreDrift, storeDir: string): string | null {
  const parts: string[] = [];
  if (drift.missing.length > 0) parts.push(`missing: ${drift.missing.join(', ')}`);
  if (drift.changed.length > 0) parts.push(`differs: ${drift.changed.join(', ')}`);
  if (parts.length === 0) return null;
  return (
    `the sbx skill store (${storeDir}) is out of sync with ~/.claude/skills (${parts.join('; ')}). ` +
    `Update it with '${SKILL_STORE_UPDATE_COMMAND}'; a running sandbox sees new skills after its next start.`
  );
}
