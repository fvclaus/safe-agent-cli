---
isolation: proxy
github: true
githubMasked: true
---
### Github / Git

GITHUB_TOKEN is masked by Claude Code's own sandbox here — `git-sandboxed` cannot
authenticate through it, so don't use it. This launch was only allowed to start
because an absolute-path git exclusion is in `excludedCommands`, which means git
invoked by that absolute path runs unsandboxed, with your real credentials.

**Never invoke bare `git`.** Claude Code's `excludedCommands` matcher treats the
literal token `git` unreliably — the same command can run unsandboxed one call and
sandboxed (failing to authenticate) the next, with no visible difference in what you
typed. Resolve the absolute path once with `command -v git`, then always invoke git
through that absolute path for the rest of this session:

```bash
command -v git
# -> e.g. /usr/bin/git — use that exact path below, not "git"

/usr/bin/git -C /absolute/path/to/repo push origin main
/usr/bin/git -C /absolute/path/to/repo fetch origin
/usr/bin/git -C /absolute/path/to/repo clone https://github.com/owner/repo.git
```

`cd <dir> && <absolute-path-to-git> push ...` also works — the absolute path is what
matters, not whether the command is wrapped in `cd &&`. `-C <path>` is still the
simpler default; reach for `cd &&` only when you already need the shell in that
directory for something else in the same command.

The `gh` CLI already picks up `GITHUB_TOKEN` from the environment automatically —
no `gh auth login` needed — and is unaffected by this, since it talks to
`api.github.com`, not the masked host. Use it directly for issues, PRs, workflow
runs, etc. (`gh pr create`, `gh issue list`, `gh run view`, ...).
