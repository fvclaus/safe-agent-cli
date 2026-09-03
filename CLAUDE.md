# safe-agent-cli

## Runtime

MUST use **bun** for all package management and script execution. NEVER use npm, pnpm, npx, or node directly.

- Install dependencies: `bun install`
- Run scripts: `bun run <script>`
- Claude entrypoint: `bun src/commands/claude-code.tsx`
- Codex entrypoint: `bun src/commands/codex.tsx`
- Add packages: `bun add <pkg>`

## Architecture

- [src/launcher/safe-agent-cli.tsx](src/launcher/safe-agent-cli.tsx)
  Shared CLI parsing, prompting, integration composition, cleanup, and final process launch.
- [src/integrations/github.ts](src/integrations/github.ts)
  Owns GitHub CLI flags and GitHub credential setup.
- [src/integrations/gcp.ts](src/integrations/gcp.ts)
  Owns GCP CLI flags and GCP impersonation setup.
- [src/adapters/claude-code.ts](src/adapters/claude-code.ts)
  Owns Claude-specific behavior such as `.claude/settings*.json` handling, `bwrap` wiring, and Claude launch args.
- [src/claude-sandbox-setting.ts](src/claude-sandbox-setting.ts)
  Shared helper that forces `sandbox.enabled` in the project's (host-side) `.claude/settings.local.json`. Used
  with `true` by the bwrap adapter and `false` by `sbx-claude-code` — see the sbx adapter section below for why
  this is a host-side write, not a write into the sandbox container.
- [src/adapters/codex.ts](src/adapters/codex.ts)
  Owns Codex-specific launch args and config mapping.
- [src/commands/claude-code.tsx](src/commands/claude-code.tsx), [src/commands/codex.tsx](src/commands/codex.tsx)
  Thin public entrypoints.
- [bin/safe-claude-code](bin/safe-claude-code), [bin/safe-codex](bin/safe-codex)
  Shell wrappers intended for PATH-based local installation.
- [src/bin/git-sandboxed](src/bin/git-sandboxed) (symlinked at [bin/git-sandboxed](bin/git-sandboxed))
  GITHUB_TOKEN-authenticated `git` wrapper for use inside the sandbox — lives in `src/bin` alongside the `bwrap`
  shim so it rides the same PATH entry (see `buildSpawnEnv` in `src/adapters/claude-code.ts`); the `bin/` symlink
  makes it reachable the same way outside the sandbox, e.g. for local testing.

When refactoring, keep agent-specific logic out of the shared launcher whenever possible. Shared code should handle orchestration; adapters and integrations should own provider-specific behavior.

## Design principle: no hardcoded user/host-specific content

This tool runs for every user, on every machine — never hardcode a path, username,
or piece of config that's specific to one person's setup (e.g. a particular
person's notification hook wiring, a fixed host path under their home directory).
User-specific behavior belongs in files the user supplies themselves (e.g.
`~/.claude/settings.json`, or `~/.claude/settings-sbx.json` for sbx-specific
hooks); safe-agent-cli only reads and merges what's there — it never ships or
assumes the content. See the Sandbox Harness section below for the existing
precedent (`.claude/settings*.json`, no hardcoded paths beyond mandatory Git
safety denies).

## sbx adapter (`sbx-claude-code`)

Separate from `safe-claude-code`'s bwrap-based (`proxy`) isolation — long-term
merge intended, deferred until the shape of both is less fuzzy. Orchestrates a
user-supplied sandbox script (e.g. `claude-generic.sh`, passed via
`--generic-script`, no default) through `build` → generate `CLAUDE.local.md`
(isolation `sbx`) → merge `~/.claude/settings-sbx.json`'s `hooks` into the
sandbox's in-container `~/.claude/settings.json` (via `sbx cp`, preserving
every other key Claude Code itself already wrote there) → the launch command.
See `src/sbx/`.

Only `build` and `resolve-name` are part of the generic script's contract —
both are needed by the orchestrator itself. The final launch step is whatever
the caller passes after `--` (e.g. `-- run`), passed through verbatim, so no
command name is assumed to exist on the script. It's required: there is no
default launch command.

Switches after the launch command name are forwarded to `build` and
`resolve-name` too, because a switch can change *which* sandbox is meant — e.g.
`claude-generic.sh`'s `--clone` changes the sandbox name, so without forwarding
we'd build and inject hooks into one sandbox and launch another, silently. This
means mode must be expressed as a switch: `-- run --clone`, not `-- clone`
(a bare command name doesn't propagate).

`~/.claude/settings-sbx.json` is user-authored and required (hard error if
missing/malformed) — safe-agent-cli never ships or assumes its content, per
the design principle above.

Before `build` runs, the project dir is scanned for symlinks whose target
lives outside it (e.g. `.env` -> a real secrets file under `$HOME`) — sbx only
mounts the project dir, so such a symlink would otherwise dangle. Only
absolute-target symlinks are handled (relative ones are only warned about —
resolution would depend on the sandbox's mount layout matching the host's).
Each not-yet-approved (sandbox, source, target) triple prompts once;
approval lives in `~/.config/safe-agent-cli/sbx-symlink-approvals.json` and
is invalidated if the target changes. `sbx create` only accepts directory
workspaces, so approved targets are routed by kind: a directory is passed to
`build` as `--bind-mount <path>` (live, two-way); a file is pushed in via
`sbx cp` once the sandbox exists (one-way, redone every launch, listed in
CLAUDE.local.md) rather than bind-mounting its parent dir, which would leak
every sibling in it. See `src/sbx/symlink-scan.ts`,
`src/sbx/symlink-approvals.ts`, `src/sbx/symlink-mounts.ts`,
`src/sbx/symlink-copy.ts`. Default excludes (`node_modules`, `.git`, `dist`,
`build`, `.next`, `target`, `vendor`) extend via `sbxSymlinkScanExcludeDirs`
in `~/.config/safe-agent-cli/settings.json`.

```bash
sbx-claude-code --generic-script ~/workspace/infrastructure/sbx/claude-generic.sh -- run
```

Every launch path (bwrap and sbx alike) forces `sandbox.enabled` in the project's (host-side)
`.claude/settings.local.json` on start, via the shared `ensureClaudeSandboxSetting` helper — `true`
for the bwrap adapter, `false` for `sbx-claude-code`, since Claude Code's own bwrap sandbox running
again inside the already-isolated sbx container is redundant and can conflict. This is a host-side
file, bind-mounted into the sandbox by the generic script, not a file that needs reconstructing
inside the container.

## IMPORTANT: Testing changes

**You are running without the real agent sandbox. You MUST test every change before reporting it as complete.**

Minimum checks for normal refactors:

- `bun run typecheck`
- `bun src/commands/claude-code.tsx --help`
- `bun src/commands/codex.tsx --help`

If you touch the PATH wrappers, also run:

- `./bin/safe-claude-code --help`
- `./bin/safe-codex --help`

If you touch sandbox behavior, run the harness as well.

## Sandbox Harness

The harness in [scripts/test-sandbox.ts](scripts/test-sandbox.ts) mirrors the shared launcher setup (GCP/GitHub env setup plus `bwrap` sandboxing) but runs an arbitrary command instead of launching Claude or Codex.

Running this nested inside a session safe-agent-cli itself launched can make `which bwrap` find this repo's own shim (already ahead on PATH) instead of the real binary, pointing `REAL_BWRAP` at the shim itself. `src/real-bwrap.ts` guards against that, and `src/bin/bwrap` independently refuses to exec into itself if `REAL_BWRAP` ever does resolve to it anyway — both would otherwise recurse into themselves, growing their argument list without bound until memory is exhausted and the host crashes. Still **never** add this (or any `bwrap`-invoking command) to a Claude Code `excludedCommands` entry — that runs it unsandboxed, a separate, still-real risk independent of the above.

Examples:

```bash
bun scripts/test-sandbox.ts bash
bun scripts/test-sandbox.ts --gh "gh auth status"
bun scripts/test-sandbox.ts --gcp --project my-project "gcloud projects list"
```

The harness accepts the same integration flags as the shared launcher: `--gcp`, `--google-cloud`, `--gh`, `--github`, and `--project`.

Sandbox filesystem policy is read from `~/.claude/settings.json` and merged with project `.claude/settings.json` / `.claude/settings.local.json`. No paths are hardcoded in the harness beyond mandatory Git safety denies.

## CI

TypeScript checking runs in GitHub Actions via [.github/workflows/tsc.yml](.github/workflows/tsc.yml).
