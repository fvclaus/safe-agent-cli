# claude-gcp

## Runtime

MUST use **bun** for all package management and script execution. NEVER use npm, pnpm, npx, or node directly.

- Install dependencies: `bun install`
- Run scripts: `bun run <script>` or `bun src/index.tsx`
- Add packages: `bun add <pkg>`

## IMPORTANT: Testing changes

**You are running without a sandbox. You MUST test every change before reporting it as complete.**

Claude Code runs all tool calls (Bash, file writes, etc.) inside a `bwrap` (bubblewrap) sandbox. This project has its sandbox policy deliberately relaxed so you can iterate freely, but that means you lose the guard-rail that would normally surface sandbox failures. If you write a script that works in the open environment but breaks inside the sandbox, production use of `safe-claude-code` will silently fail.

### How the Claude Code sandbox works

Claude Code builds a `bwrap` command using the following policy (see `src/index.tsx` and the upstream implementation at `anthropic-experimental/sandbox-runtime`):

| Layer | What happens |
|---|---|
| Filesystem root | `--ro-bind / /` — entire root is read-only |
| Write allow-list | `--bind <path> <path>` for each allowed write path (project dir, /tmp, …) |
| Read deny (`/home/…`) | `--tmpfs /home/user` — home directory wiped, then specific sub-paths re-bound |
| Write deny-list | `--ro-bind <p> <p>` for settings files, `.claude/skills`, `.git/hooks`, `.git/config` |
| Network | `--unshare-net` is **stripped** by `src/bin/bwrap` — network stays available |
| PID namespace | `--unshare-pid --proc /proc` |

### Running the sandbox test harness

```bash
# Run a one-shot command inside the sandbox
bun src/test-sandbox.ts <command>

# Open an interactive shell to explore the sandbox interactively
bun src/test-sandbox.ts bash

# With GCP credentials set up (mirrors --gcp in src/index.tsx)
bun src/test-sandbox.ts --gcp --project my-project "gcloud projects list"

# With GitHub token set up (mirrors --gh in src/index.tsx)
bun src/test-sandbox.ts --gh "gh auth status"
```

The harness accepts the same `--gcp`, `--google-cloud`, `--gh`, `--github`, `--project` flags as `src/index.tsx` and performs the same credential setup (GCP service-account impersonation, GitHub PAT lookup). The only difference is that it runs your command instead of launching `claude`.

Sandbox filesystem policy is read from `~/.claude/settings.json` (long form: `sandbox.filesystem.{read,write}.*`) and merged with the project `.claude/settings.json` (short form: `sandbox.filesystem.{allowWrite,allowRead}`). No paths are hardcoded in the harness.

**Test any Bash command, file operation, or script that you add or modify by running it through the harness first.**
