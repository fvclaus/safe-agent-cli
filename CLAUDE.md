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

```bash
sbx-claude-code --generic-script ~/workspace/infrastructure/sbx/claude-generic.sh -- run
```

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
