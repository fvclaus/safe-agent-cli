# safe-agent-cli

## Runtime

MUST use **bun** for all package management and script execution. NEVER use npm, pnpm, npx, or node directly.

- Install dependencies: `bun install`
- Run scripts: `bun run <script>`
- Claude entrypoint: `bun src/commands/claude-code.tsx`
- Codex entrypoint: `bun src/commands/codex.tsx`
- Add packages: `bun add <pkg>`

## Architecture

- [src/launcher/safe-agent-cli.tsx](/home/fredo/workspace/safe-claude-code/src/launcher/safe-agent-cli.tsx)
  Shared CLI parsing, prompting, integration composition, cleanup, and final process launch.
- [src/integrations/github.ts](/home/fredo/workspace/safe-claude-code/src/integrations/github.ts)
  Owns GitHub CLI flags and GitHub credential setup.
- [src/integrations/gcp.ts](/home/fredo/workspace/safe-claude-code/src/integrations/gcp.ts)
  Owns GCP CLI flags and GCP impersonation setup.
- [src/adapters/claude-code.ts](/home/fredo/workspace/safe-claude-code/src/adapters/claude-code.ts)
  Owns Claude-specific behavior such as `.claude/settings*.json` handling, `bwrap` wiring, and Claude launch args.
- [src/adapters/codex.ts](/home/fredo/workspace/safe-claude-code/src/adapters/codex.ts)
  Owns Codex-specific launch args and config mapping.
- [src/commands/claude-code.tsx](/home/fredo/workspace/safe-claude-code/src/commands/claude-code.tsx), [src/commands/codex.tsx](/home/fredo/workspace/safe-claude-code/src/commands/codex.tsx)
  Thin public entrypoints.
- [bin/safe-claude-code](/home/fredo/workspace/safe-claude-code/bin/safe-claude-code), [bin/safe-codex](/home/fredo/workspace/safe-claude-code/bin/safe-codex)
  Shell wrappers intended for PATH-based local installation.

When refactoring, keep agent-specific logic out of the shared launcher whenever possible. Shared code should handle orchestration; adapters and integrations should own provider-specific behavior.

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

The harness in [scripts/test-sandbox.ts](/home/fredo/workspace/safe-claude-code/scripts/test-sandbox.ts) mirrors the shared launcher setup (GCP/GitHub env setup plus `bwrap` sandboxing) but runs an arbitrary command instead of launching Claude or Codex.

Examples:

```bash
bun scripts/test-sandbox.ts bash
bun scripts/test-sandbox.ts --gh "gh auth status"
bun scripts/test-sandbox.ts --gcp --project my-project "gcloud projects list"
```

The harness accepts the same integration flags as the shared launcher: `--gcp`, `--google-cloud`, `--gh`, `--github`, and `--project`.

Sandbox filesystem policy is read from `~/.claude/settings.json` and merged with project `.claude/settings.json` / `.claude/settings.local.json`. No paths are hardcoded in the harness beyond mandatory Git safety denies.

## CI

TypeScript checking runs in GitHub Actions via [.github/workflows/tsc.yml](/home/fredo/workspace/safe-claude-code/.github/workflows/tsc.yml).
