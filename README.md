# safe-agent-cli

Wrapper CLIs for launching Claude Code or Codex with scoped GitHub and GCP credentials.

## Commands

- `safe-claude-code`
- `safe-codex`

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
security add-generic-password -s github.pat -a safe-agent-cli -w
```

**Linux** (GNOME Keyring / libsecret):
```bash
secret-tool store --label="Github PAT safe-agent-cli" github.pat safe-agent-cli
```

The PAT name defaults to the current directory name. Use `--gh=<name>` to specify a different one.

### Configure ~/.claude/CLAUDE.md

When launching with `--gh`, Claude is told via `--append-system-prompt` that `GITHUB_TOKEN` is set and which PAT scopes are active. However, `--append-system-prompt` has no effect for background agents. To ensure Claude knows how to use the token in all contexts, add the following to your `~/.claude/CLAUDE.md`:

```markdown
## GCP

Interaction with GCP resources MUST be done through terraform. DO NOT use the gcloud cli to update resources. If terraform ist not setup in this project, ask and then proceed.

Only apply the following rules if `GOOGLE_OAUTH_ACCESS_TOKEN` is set in the environment. If it is not set, GCP is not available for this session.


Credentials are pre-configured in `CLOUDSDK_CONFIG`, so `gcloud` commands work directly. Terraform and other Google client libraries authenticate via `GOOGLE_OAUTH_ACCESS_TOKEN`. The token expires after 1 hour. If a command fails, check if the token has expired and ask for a new one.

If a GCP operation fails due to missing IAM permissions, STOP and ask the user to grant the required role to the service account. NEVER provide gcloud commands for the user to run on your behalf — request the permission and wait for the user to grant it before continuing.

Exception: when requesting permissions for the service account you are currently authenticated as, you MUST provide the full gcloud command so the user can grant it.


### Github / Git

You MUST not push empty commits to trigger pipeline. Change them to `workflow_dispatch` and use `gh` to start them.

Only apply the following rules if `GITHUB_TOKEN` is set in the environment. If it is not, `gh` is not available for this session.

#### Polling for CI completion

**`gh run view` does NOT output the word "completed"** — it outputs `✓` or `✗` symbols. The word "completed" only appears in `gh run list` output.

Wrong pattern (loop never exits):
```bash
until gh run view <run-id> --repo ... | grep -q "completed"; do sleep 30; done
```

Correct pattern:
```bash
until gh run list --repo <owner>/<repo> --branch <branch> --limit 1 | grep -qE "^completed"; do sleep 30; done
```

Push using the URL rewrite flag to avoid modifying git config (which may be read-only in the sandbox):

```
git -c "url.https://${GITHUB_TOKEN}@github.com/.insteadOf=git@github.com:" push origin main
```

**Never use `-u` / `--set-upstream` when pushing in the sandbox.** The `-u` flag writes upstream tracking entries (`branch.<name>.remote`, `branch.<name>.merge`) to `.git/config`, which the sandbox blocks. The push itself succeeds but produces a harmless config-write error. Omit `-u` — `gh pr create` does not need upstream tracking.

**If I ask you to push on the default branch (e.g. `main`/`master`), ask me first** rather than deciding on your own. Confirm with me before pushing directly to the default branch.

Commit messages should contain my name and email as author and email as per the current git config. You MUST put your name as coauthor to the commit message.
```

## Features

- Shared CLI for:
  - `--gh` / `--github[=PAT_NAME]`
  - `--gcp` / `--google-cloud`
  - `--project <PROJECT_ID>`
- GitHub PAT lookup through `secret-tool`
- GCP service-account impersonation and temporary ADC/gcloud config generation
- Claude-specific launch behavior through a Claude adapter
- Best-effort Codex launch behavior through a Codex adapter

## Networking & the bwrap shim

Claude Code sandboxes every Bash command with `bwrap` (bubblewrap). This repo
ships a shim at [`src/bin/bwrap`](src/bin/bwrap), placed on `PATH` by the Claude
adapter, that strips `--unshare-net` so the sandbox shares your **host network
namespace** — letting processes the agent starts (a dev server, database, etc.)
bind on the same `localhost` you reach from your machine. (It also injects the
git-dir binds Claude Code omits for worktrees.)

## Architecture

- `src/launcher/safe-agent-cli.tsx` — Shared CLI parsing, prompting, integration composition, cleanup, and final process launch.
- `src/integrations/github.ts` — GitHub flags and credential setup.
- `src/integrations/gcp.ts` — GCP flags and impersonation setup.
- `src/adapters/claude-code.ts` — Claude-specific settings handling, env injection, and launch args.
- `src/adapters/codex.ts` — Codex-specific config/env mapping and launch args.
- `src/commands/claude-code.tsx`, `src/commands/codex.tsx` — Thin public entrypoints.

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

GitHub Actions runs TypeScript checking on push and pull request via `.github/workflows/tsc.yml`.
