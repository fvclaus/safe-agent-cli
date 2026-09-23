---
isolation: proxy
github: true
githubMasked: true
---
### Github / Git

GITHUB_TOKEN is masked by Claude Code's own sandbox here — `git-sandboxed` cannot
authenticate through it, so don't use it. Plain `git` runs unsandboxed with your
real credentials instead: this launch was only allowed to start because `git *`
(plus `rtk git *` when the rtk hook is installed) is in `excludedCommands`.

Two forms still run inside the sandbox, where remote operations fail with `Host key
verification failed`:

- `git -C <path> …` — `cd` into the repo in its own Bash call instead
- chains such as `cd <dir> && git …` or `git … | …` — every part of a compound
  command must match an exclusion

The `gh` CLI already picks up `GITHUB_TOKEN` from the environment automatically —
no `gh auth login` needed — and is unaffected by this, since it talks to
`api.github.com`, not the masked host. Use it directly for issues, PRs, workflow
runs, etc. (`gh pr create`, `gh issue list`, `gh run view`, ...).
