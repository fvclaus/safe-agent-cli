# safe-agent-cli

Wrapper CLIs for launching Claude Code or Codex with scoped GitHub and GCP credentials.

## Commands

- `safe-claude-code` — launch Claude Code with scoped credentials under the bwrap-based sandbox setup
- `safe-codex` — launch Codex with scoped credentials
- `sbx-claude-code` — orchestrate a user-supplied sandbox script (`--generic-script`) and launch Claude Code inside that sandbox

## Setup

### Prerequisites

- [Bun](https://bun.sh) — used for all package management and script execution

The following are only required if you use the respective integration:

- **GitHub** (`--gh`): [gh](https://cli.github.com) (must be installed natively, **not** via snap) and a keychain tool for PAT storage:
  - **Linux**: `secret-tool` (part of GNOME Keyring / libsecret)
    ```bash
    sudo apt install libsecret-tools
    ```
  - **macOS**: `security` (built-in Keychain CLI, no installation required)
- **GCP** (`--gcp`): [Google Cloud CLI](https://cloud.google.com/sdk/docs/install) (must be installed natively, **not** via snap)

### Add to PATH

Add the repo-local `bin/` directory to your `PATH` so `safe-claude-code` and `safe-codex` are available globally:

```bash
export PATH="/path/to/safe-agent-cli/bin:$PATH"
```

Add this line to your `~/.bashrc` or `~/.zshrc` to make it permanent.

### Storing your GitHub PAT

The `--gh` flag looks up your PAT by name from the system keychain. Store it once, then use `--gh` or `--gh=<name>` to inject it.

**macOS** (Keychain):
```bash
security add-generic-password -U -s github.pat -a safe-agent-cli -w
```
(`-U` updates the entry if it already exists, so the same command works when you rotate the token.)

**Linux** (GNOME Keyring / libsecret):
```bash
secret-tool store --label="Github PAT safe-agent-cli" github.pat safe-agent-cli
```

The PAT name defaults to the current directory name. Use `--gh=<name>` to specify a different one.

### Agent instructions

Don't maintain launch-specific agent instructions (how to use the injected
GitHub/GCP credentials, sandbox git rules) in a global `~/.claude/CLAUDE.md`.
Use `claudeFragmentsDir` instead (see "CLAUDE.local.md generation" below): the
credential-usage instructions ship as built-in fragments and are composed into
`CLAUDE.local.md` only on launches where they apply. The launcher warns when a
global `~/.claude/CLAUDE.md` exists, since its content stays outside the
generated file.

## Features

- Shared CLI for:
  - `--gh` / `--github[=PAT_NAME]`
  - `--gcp` / `--google-cloud`
  - `--project <PROJECT_ID>`
- GitHub PAT lookup from the system keychain (`security` on macOS, `secret-tool` on Linux)
- GCP service-account impersonation and temporary ADC/gcloud config generation
- `CLAUDE.local.md` generation from a personal fragments library plus built-in fragments (see below)
- `git-sandboxed`, a `GITHUB_TOKEN`-authenticated git wrapper put on `PATH` inside the sandbox when `--gh` is enabled
- Claude-specific launch behavior through a Claude adapter
- Best-effort Codex launch behavior through a Codex adapter

## User settings

safe-agent-cli reads an optional settings file from
`$XDG_CONFIG_HOME/safe-agent-cli/settings.json` (default:
`~/.config/safe-agent-cli/settings.json`). Missing file means all defaults.

Parsing is strict: malformed JSON or a wrong type aborts the launch, and
unrecognized keys print a warning — an opt-in setting disabled by a typo would
otherwise fail silently, which is the exact failure mode this tool exists to
prevent.

| Setting | Type | Default | Effect |
|---------|------|---------|--------|
| `checkRtk` | boolean | `false` | Before launching Claude, verify [rtk](https://github.com/rtk-ai/rtk) is initialized: the `rtk` binary is on PATH and `~/.claude/settings.json` contains the `rtk hook claude` PreToolUse hook. Any failure aborts the launch with a hint to run `rtk init -g`. When `claudeFragmentsDir` is also set, `~/.claude/RTK.md` is read and appended to the generated `CLAUDE.local.md` (see below) — its existence is checked there instead, as part of generation. |
| `claudeFragmentsDir` | string | unset | Its presence is the on/off switch — when set, every `safe-claude-code` launch regenerates `CLAUDE.local.md` in the current repo from the markdown fragments in this directory (see "CLAUDE.local.md generation" below). Unset means the feature is entirely skipped. |

Example:

```json
{
  "checkRtk": true,
  "claudeFragmentsDir": "~/shared-work/claude/fragments"
}
```

## CLAUDE.local.md generation

When `claudeFragmentsDir` is set, `safe-claude-code` regenerates `CLAUDE.local.md`
in the current repo's root before every launch, composed from the `*.md`
fragments in that directory. Each fragment may carry YAML frontmatter scoping
it to a specific context:

```markdown
---
org: developer-akademie-gmbh
isolation: [proxy, sbx]
---
Rules that only apply in Developer-Akademie-GmbH repos.
```

- `org` matches the repo's GitHub owner (case-insensitive), parsed from the
  `origin` remote. A repo with no remote at all doesn't fail — org-scoped
  fragments simply don't match. A remote on a host other than `github.com`
  aborts generation (and the launch).
- `isolation` matches `proxy` (`safe-claude-code`'s bwrap-based launches) or
  `sbx` (`sbx-claude-code` launches).
- `org` and `isolation` accept a single string or a list (OR within a key).
- `github` (boolean) matches whether the launch has `--gh`/`--github` enabled.
- `githubMasked` (boolean) matches whether Claude Code's own sandbox masks
  `GITHUB_TOKEN` (`sandbox.credentials.envVars`) — only meaningful alongside
  `github: true`.
- `gcp` (boolean) matches whether the launch has `--gcp`/`--google-cloud`
  enabled.
- When a fragment sets more than one key, all of them must match (AND across
  keys). A key a fragment omits is a wildcard for that dimension; a fragment
  with no frontmatter at all always matches.

Matching fragments are concatenated in alphabetical filename order, each
preceded by a comment naming its source path, under a header noting the file
is auto-generated and pointing back at `claudeFragmentsDir` — so an agent
asked to change an instruction knows to edit the fragment, not the generated
file. safe-agent-cli's own built-in fragments in
[`src/fragments/`](src/fragments/) (e.g. how to use `git-sandboxed`, or the
GCP credential environment) go through the same matching and are appended
after the user's own fragments. Any problem (a missing fragments directory, malformed frontmatter, an
unsupported git remote) aborts the launch outright; this feature never
silently degrades.

When `checkRtk` is also enabled, `~/.claude/RTK.md` is read and appended last,
unconditionally (treated like a fragment with no frontmatter) — this replaces
a hand-maintained `@RTK.md` import in `CLAUDE.md`. A missing `RTK.md` aborts
the launch here rather than in `checkRtk`'s own verification. Note this makes
RTK.md's inclusion depend on `claudeFragmentsDir` being set: with `checkRtk`
enabled but `claudeFragmentsDir` unset, RTK.md's content isn't included
anywhere by this tool.

## The bwrap shim

Claude Code sandboxes every Bash command with `bwrap` (bubblewrap), building the
argument list itself. Some of those defaults are hardcoded in the harness and
cannot be changed through settings. This repo ships a shim at
[`src/bin/bwrap`](src/bin/bwrap) — placed on `PATH` ahead of the real `bwrap` by
the Claude adapter (with `REAL_BWRAP` pointing at the genuine one) — that
rewrites the arguments on the way through to fix four problems. The pure
rewriting logic lives in [`src/bin/bwrap-transform.ts`](src/bin/bwrap-transform.ts)
and is covered by unit tests.

1. **Sandboxed processes are unreachable from the host.** Claude Code passes
   `--unshare-net`, giving the sandbox its own network namespace, so a dev
   server, database, or preview the agent starts can't be reached from your
   machine. The shim strips `--unshare-net` so the sandbox shares your **host
   network namespace** and everything binds on the same `localhost` you use.

2. **Command exit codes are lost under zsh.** Claude Code wraps each command with
   a proxy-cleanup trap, `trap "kill %1 %2 2>/dev/null; exit" EXIT`. Under zsh a
   bare `exit` in a trap returns the status of the trap's last command (the
   `kill`), so a passing command can report failure — or a failing one success —
   depending on whether the network-proxy relays are still alive. The shim
   rewrites the trap to capture `$?` first and re-exit with it, preserving the
   command's real exit code. This is a no-op under bash, which doesn't have the
   bug.

3. **git fails inside worktrees.** In a git worktree, `.git` is a *file*
   containing `gitdir: <path>` that points into the main repo's
   `.git/worktrees/<name>/`. Claude Code binds only the pointer file, not its
   target, so git commands fail in the sandbox. The shim detects the pointer,
   reads the target, and injects the missing read-write binds for both the main
   git dir (`refs`, `objects`, `packed-refs`) and the worktree metadata dir
   (`HEAD`, `MERGE_HEAD`, lock files).

4. **`.claude/` can't be made writable through settings.** Claude Code binds the
   project root read-write, then layers a hardcoded wall of `--ro-bind` mounts on
   top that mask `.claude/settings.json`, `.claude/{hooks,skills,commands,agents,workflows,routines,output-styles}`,
   `.claude/.cc-writes`, `.mcp.json`, `.git/config`, the dotfiles, and more —
   regardless of what `sandbox.filesystem.allowWrite` requests. The shim reads
   the merged Claude settings (`~/.claude/settings.json`, then the project's
   `.claude/settings.json` and `.claude/settings.local.json`) and, for any path
   **explicitly** listed in `allowWrite`, makes it writable in two ways. Because
   `bwrap` applies binds in order (last wins), it (a) drops any deny `--ro-bind`
   whose target falls *inside* the whitelisted path — letting the earlier
   read-write bind show through — and (b) re-binds the whitelisted path
   read-write *after* the deny wall, so it also wins when it is nested under a
   denied parent (e.g. `allowWrite: [".claude/hooks/.venv"]` while the harness
   denies the whole `.claude/hooks`: the harness binds `.venv` rw but too early,
   so its own parent deny shadows it — re-binding last fixes the ordering, and
   the rest of `.claude/hooks` stays read-only). A `denyWrite` entry re-protects a
   subtree.

   The bare project root (`.`) is ignored on purpose — it is already the default
   read-write mount, and honoring it would blanket-undeny `.git/config`,
   `.mcp.json`, and the dotfiles too. To make the project's `.claude/` writable,
   whitelist it explicitly:

   ```json
   // .claude/settings.local.json
   {
     "sandbox": {
       "filesystem": { "allowWrite": [".", ".claude"] }
     }
   }
   ```

   > ⚠️ **Security note:** Claude Code hooks run on the *host*, outside the
   > sandbox. Making `.claude/` writable lets an agent modify `.claude/hooks/` or
   > the `hooks` block in `.claude/settings.json`, which then execute on the host
   > on the next launch — a sandbox-escape vector. Whitelist only the paths you
   > actually need writable, and use `denyWrite` to re-protect sensitive subtrees.

### Debugging the shim

Set `BWRAP_WRAPPER_DEBUG=1` before launching to append every rewritten `bwrap`
invocation — plus each `.claude` deny it removes (`undeny:`) and each whitelisted
path it re-binds (`rebind:`) — to `/tmp/bwrap-wrapper.log`.

## Architecture

- `src/launcher/safe-agent-cli.tsx` — Shared CLI parsing, prompting, integration composition, cleanup, and final process launch.
- `src/integrations/github.ts` — GitHub flags and credential setup.
- `src/integrations/gcp.ts` — GCP flags and impersonation setup.
- `src/adapters/claude-code.ts` — Claude-specific settings handling, env injection, and launch args.
- `src/adapters/codex.ts` — Codex-specific config/env mapping and launch args.
- `src/commands/claude-code.tsx`, `src/commands/codex.tsx` — Thin public entrypoints.
- `src/commands/sbx-claude-code.ts`, `src/sbx/` — Orchestration of a user-supplied sandbox script (build, hook injection, launch).
- `src/claude-fragments.ts`, `src/fragments/` — CLAUDE.local.md generation and the built-in fragments.
- `src/user-settings.ts` — Strict parsing of `~/.config/safe-agent-cli/settings.json`.
- `src/bin/git-sandboxed` — `GITHUB_TOKEN`-authenticated git wrapper for use inside the sandbox (symlinked at `bin/git-sandboxed` for local testing outside it).

## Development

Use Bun for all package management and scripts.

```bash
bun install
bun run typecheck
bun test
bun src/commands/claude-code.tsx --help
bun src/commands/codex.tsx --help
```

The bwrap shim's argument-rewriting logic is unit-tested in
[`test/bwrap-transform.test.ts`](test/bwrap-transform.test.ts); run it with
`bun test`.

There is also a sandbox test harness:

```bash
bun scripts/test-sandbox.ts bash
bun scripts/test-sandbox.ts --gh "gh auth status"
bun scripts/test-sandbox.ts --gcp --project my-project "gcloud projects list"
```

## CI

On every push and pull request, GitHub Actions runs:

- TypeScript checking via [`.github/workflows/tsc.yml`](.github/workflows/tsc.yml)
- The unit test suite via [`.github/workflows/test.yml`](.github/workflows/test.yml)
