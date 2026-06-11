# safe-agent-cli

Wrapper CLIs for launching Claude Code or Codex with scoped GitHub and GCP credentials.

## Commands

- `safe-claude-code`
- `safe-codex`

Both commands are available from the repo-local [bin](/home/fredo/workspace/safe-claude-code/bin) directory:

```bash
export PATH="/home/fredo/workspace/safe-claude-code/bin:$PATH"
```

The wrappers invoke `bun` against the repo entrypoints, so they work without package-manager bin linking.

## Features

- Shared CLI for:
  - `--gh` / `--github[=PAT_NAME]`
  - `--gcp` / `--google-cloud`
  - `--project <PROJECT_ID>`
- GitHub PAT lookup through `secret-tool`
- GCP service-account impersonation and temporary ADC/gcloud config generation
- Claude-specific launch behavior through a Claude adapter
- Best-effort Codex launch behavior through a Codex adapter

## Architecture

- [src/launcher/safe-agent-cli.tsx](/home/fredo/workspace/safe-claude-code/src/launcher/safe-agent-cli.tsx)
  Shared CLI parsing, prompting, integration composition, cleanup, and final process launch.
- [src/integrations/github.ts](/home/fredo/workspace/safe-claude-code/src/integrations/github.ts)
  GitHub flags and credential setup.
- [src/integrations/gcp.ts](/home/fredo/workspace/safe-claude-code/src/integrations/gcp.ts)
  GCP flags and impersonation setup.
- [src/adapters/claude-code.ts](/home/fredo/workspace/safe-claude-code/src/adapters/claude-code.ts)
  Claude-specific settings handling, env injection, and launch args.
- [src/adapters/codex.ts](/home/fredo/workspace/safe-claude-code/src/adapters/codex.ts)
  Codex-specific config/env mapping and launch args.
- [src/commands/claude-code.tsx](/home/fredo/workspace/safe-claude-code/src/commands/claude-code.tsx), [src/commands/codex.tsx](/home/fredo/workspace/safe-claude-code/src/commands/codex.tsx)
  Thin public entrypoints.

## Development

Use Bun for all package management and scripts.

```bash
bun install
bun run typecheck
bun src/commands/claude-code.tsx --help
bun src/commands/codex.tsx --help
```

There is also a sandbox test harness:

```bash
bun scripts/test-sandbox.ts bash
bun scripts/test-sandbox.ts --gh "gh auth status"
bun scripts/test-sandbox.ts --gcp --project my-project "gcloud projects list"
```

## CI

GitHub Actions runs TypeScript checking on push and pull request via [.github/workflows/tsc.yml](/home/fredo/workspace/safe-claude-code/.github/workflows/tsc.yml).
