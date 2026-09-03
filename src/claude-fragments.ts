import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';
import { getOriginUrl, parseGithubOwner } from './git-remote.js';

// Fragments safe-agent-cli ships itself (e.g. how to use git-sandboxed),
// matched and rendered the same way as the user's own fragmentsDir but always
// appended last, after the user's own — see generateClaudeLocalMd.
const BUILTIN_FRAGMENTS_DIR = fileURLToPath(new URL('./fragments', import.meta.url));

// CLAUDE.local.md is generated from a personal library of markdown fragments,
// each optionally scoped to a repo org, isolation mode, whether --gh/--github
// is enabled, and/or whether GITHUB_TOKEN ends up masked by Claude Code's own
// sandbox, via YAML frontmatter. See the design discussion this implements:
// matching is AND across frontmatter keys, OR within a key's list, a missing
// key is a wildcard for that dimension, and no frontmatter at all means
// "always included". Any malformed fragment aborts generation — this feature
// never silently degrades, matching the rest of this tool's settings handling.

export type Isolation = 'proxy' | 'sbx';

export interface Fragment {
  /** Absolute path to the fragment file. */
  path: string;
  org?: string[];
  isolation?: string[];
  /** Whether `--gh`/`--github` must be enabled (true) or disabled (false) for this fragment to match. Absent = wildcard. */
  github?: boolean;
  /**
   * Whether GITHUB_TOKEN must be masked by Claude Code's own sandbox (true) or not (false)
   * for this fragment to match. Absent = wildcard. Only meaningful alongside `github: true`
   * — masking is irrelevant when github integration isn't enabled at all.
   */
  githubMasked?: boolean;
  /** Whether `--gcp`/`--google-cloud` must be enabled (true) or disabled (false) for this fragment to match. Absent = wildcard. */
  gcp?: boolean;
  body: string;
}

export interface MatchContext {
  /** Lowercased repo owner, or undefined when there's no org to match (e.g. no git remote). */
  org: string | undefined;
  isolation: Isolation;
  /** Whether `--gh`/`--github` is enabled for this launch. */
  github: boolean;
  /** Whether GITHUB_TOKEN is masked by Claude Code's own sandbox for this launch. */
  githubMasked: boolean;
  /** Whether `--gcp`/`--google-cloud` is enabled for this launch. */
  gcp: boolean;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const KNOWN_FRONTMATTER_KEYS = new Set(['org', 'isolation', 'github', 'githubMasked', 'gcp']);

function toStringList(value: unknown, key: string, path: string): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value) && value.every(v => typeof v === 'string')) return value as string[];
  throw new Error(`${path}: "${key}" must be a string or an array of strings, got ${JSON.stringify(value)}`);
}

function toBoolean(value: unknown, key: string, path: string): boolean {
  if (typeof value === 'boolean') return value;
  throw new Error(`${path}: "${key}" must be a boolean, got ${JSON.stringify(value)}`);
}

/** Parses a fragment's optional YAML frontmatter and body. Throws on any malformed frontmatter. */
export function parseFragment(content: string, path: string): Fragment {
  const match = content.match(FRONTMATTER_RE);
  if (!match) return { path, body: content };

  // Both groups are non-optional in FRONTMATTER_RE, so they're always present
  // when the overall match succeeds; `?? ''` only appeases noUncheckedIndexedAccess.
  const frontmatterYaml = match[1] ?? '';
  const body = match[2] ?? '';
  let raw: unknown;
  try {
    raw = loadYaml(frontmatterYaml);
  } catch (e) {
    throw new Error(`${path}: invalid frontmatter YAML: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (raw === undefined || raw === null) return { path, body };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${path}: frontmatter must be a YAML mapping`);
  }

  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!KNOWN_FRONTMATTER_KEYS.has(key)) {
      throw new Error(`${path}: unrecognized frontmatter key "${key}" (known keys: org, isolation, github, githubMasked, gcp)`);
    }
  }

  // exactOptionalPropertyTypes forbids assigning `org: undefined` — spread in
  // the key only when the frontmatter actually set it.
  const org = 'org' in obj ? { org: toStringList(obj['org'], 'org', path) } : {};
  const isolation = 'isolation' in obj ? { isolation: toStringList(obj['isolation'], 'isolation', path) } : {};
  const github = 'github' in obj ? { github: toBoolean(obj['github'], 'github', path) } : {};
  const githubMasked = 'githubMasked' in obj ? { githubMasked: toBoolean(obj['githubMasked'], 'githubMasked', path) } : {};
  const gcp = 'gcp' in obj ? { gcp: toBoolean(obj['gcp'], 'gcp', path) } : {};

  return { path, ...org, ...isolation, ...github, ...githubMasked, ...gcp, body };
}

function matchesList(list: string[] | undefined, value: string | undefined, caseInsensitive: boolean): boolean {
  if (!list) return true; // key absent -> wildcard for this dimension
  if (value === undefined) return false;
  const needle = caseInsensitive ? value.toLowerCase() : value;
  return list.some(v => (caseInsensitive ? v.toLowerCase() : v) === needle);
}

/** AND across frontmatter keys, OR within a key's list, missing key = wildcard. */
export function fragmentMatches(fragment: Fragment, context: MatchContext): boolean {
  return (
    matchesList(fragment.org, context.org, true) &&
    matchesList(fragment.isolation, context.isolation, false) &&
    (fragment.github === undefined || fragment.github === context.github) &&
    (fragment.githubMasked === undefined || fragment.githubMasked === context.githubMasked) &&
    (fragment.gcp === undefined || fragment.gcp === context.gcp)
  );
}

export type RepoOwnerResult =
  | { kind: 'github'; owner: string }
  | { kind: 'no-remote' }
  | { kind: 'unsupported-remote'; url: string };

/** No remote at all is not an error — it just means no org-scoped fragment can match. A non-GitHub remote is. */
export function detectRepoOwner(): RepoOwnerResult {
  const url = getOriginUrl();
  if (!url) return { kind: 'no-remote' };
  const owner = parseGithubOwner(url);
  if (!owner) return { kind: 'unsupported-remote', url };
  return { kind: 'github', owner };
}

function renderHeader(fragmentsDir: string): string {
  return [
    '<!--',
    '  AUTO-GENERATED by safe-agent-cli. Do not edit this file directly — your',
    '  edits will be silently overwritten on the next launch.',
    '',
    `  Edit the source fragments instead, in: ${fragmentsDir}`,
    '-->',
    '',
  ].join('\n');
}

// Repeated at the end of the file so a reader (or agent) who lands mid-file
// and scrolls down still hits the warning before editing.
function renderFooter(fragmentsDir: string): string {
  return [
    '<!--',
    '  AUTO-GENERATED by safe-agent-cli — do not edit; edits are overwritten on',
    `  the next launch. Edit the source fragments instead, in: ${fragmentsDir}`,
    '-->',
    '',
  ].join('\n');
}

// The header already points at fragmentsDir's full path, so each fragment's
// provenance comment only needs its filename — repeating the full path per
// fragment would burn tokens on every launch for no added information.
function renderFragment(fragment: Fragment): string {
  return `<!-- fragment: ${basename(fragment.path)} -->\n${fragment.body.trim()}\n`;
}

// Files pushed in via `sbx cp` for a project symlink whose target is a host
// file (see symlink-copy.ts) are one-way, per-launch copies — edits made
// inside the sandbox are silently overwritten on the next launch. This tells
// the agent that up front rather than leaving it to discover the hard way.
function renderSymlinkCopyNotice(paths: string[]): string {
  return [
    '## Files copied into this sandbox',
    '',
    'These paths are outside the project dir on the host, referenced by a project ' +
      'symlink, and were copied in at launch. Edits made here are NOT synced back ' +
      'to the host, and are overwritten with fresh host content on the next launch:',
    '',
    ...paths.map((p) => `- ${p}`),
  ].join('\n');
}

/** Expands a leading `~` or `~/...` against `home`. Leaves other paths untouched. */
export function expandHome(path: string, home: string): string {
  if (path === '~') return home;
  if (path.startsWith('~/')) return join(home, path.slice(2));
  return path;
}

export interface GenerateResult {
  outputPath: string;
  matchedCount: number;
  totalCount: number;
  rtkAppended: boolean;
}

/**
 * Reads every `*.md` fragment in `fragmentsDir`, keeps the ones whose
 * frontmatter matches the current repo and the given `launch` dimensions
 * (isolation/github/gcp — the `org` dimension is detected here from the git
 * remote), and writes the concatenated result to `CLAUDE.local.md` in
 * `repoRoot`. Fragments are ordered alphabetically by filename.
 * safe-agent-cli's own built-in fragments (BUILTIN_FRAGMENTS_DIR, e.g. how to
 * use git-sandboxed) go through the same matching, appended after the user's
 * own fragments. When `rtkMdPath` is given, its content is read and appended
 * last of all, unconditionally, exactly like a fragment with no frontmatter —
 * this is how `checkRtk` users get RTK.md into context now, instead of a
 * hand-maintained `@RTK.md` import in CLAUDE.md. When `copiedSymlinkPaths` is
 * non-empty, a notice listing them (see renderSymlinkCopyNotice) is appended
 * last of all. Throws on any failure (missing fragments directory, malformed
 * fragment, unsupported git remote, missing rtkMdPath) — the caller is
 * expected to treat that as fatal.
 */
export function generateClaudeLocalMd(
  fragmentsDir: string,
  repoRoot: string,
  launch: Omit<MatchContext, 'org'>,
  rtkMdPath?: string,
  copiedSymlinkPaths?: string[],
): GenerateResult {
  if (!existsSync(fragmentsDir)) {
    throw new Error(`claudeFragmentsDir does not exist: ${fragmentsDir}`);
  }

  const ownerResult = detectRepoOwner();
  if (ownerResult.kind === 'unsupported-remote') {
    throw new Error(
      `origin remote is not a GitHub remote (${ownerResult.url}) — cannot evaluate org-scoped fragments`,
    );
  }
  const org = ownerResult.kind === 'github' ? ownerResult.owner : undefined;
  const context: MatchContext = { org, ...launch };

  const readFragmentsDir = (dir: string) =>
    readdirSync(dir).filter(f => f.endsWith('.md')).sort().map(f => {
      const path = join(dir, f);
      return parseFragment(readFileSync(path, 'utf8'), path);
    });

  const fragments = readFragmentsDir(fragmentsDir);
  const builtinFragments = readFragmentsDir(BUILTIN_FRAGMENTS_DIR);

  const matched = fragments.filter(f => fragmentMatches(f, context));
  const matchedBuiltin = builtinFragments.filter(f => fragmentMatches(f, context));
  const sections = [...matched, ...matchedBuiltin].map(renderFragment);

  const rtkAppended = rtkMdPath !== undefined;
  if (rtkMdPath !== undefined) {
    if (!existsSync(rtkMdPath)) {
      throw new Error(`checkRtk is enabled but ${rtkMdPath} does not exist — run: rtk init -g`);
    }
    sections.push(renderFragment({ path: rtkMdPath, body: readFileSync(rtkMdPath, 'utf8') }));
  }

  if (copiedSymlinkPaths && copiedSymlinkPaths.length > 0) {
    sections.push(
      renderFragment({ path: 'sbx-symlink-copies.md', body: renderSymlinkCopyNotice(copiedSymlinkPaths) }),
    );
  }

  const content = [renderHeader(fragmentsDir), ...sections, renderFooter(fragmentsDir)].join('\n');
  const outputPath = join(repoRoot, 'CLAUDE.local.md');
  writeFileSync(outputPath, content, 'utf8');

  return {
    outputPath,
    matchedCount: matched.length + matchedBuiltin.length,
    totalCount: fragments.length + builtinFragments.length,
    rtkAppended,
  };
}
