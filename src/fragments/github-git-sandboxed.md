---
isolation: proxy
github: true
githubMasked: false
---
### Github / Git

The `gh` CLI already picks up `GITHUB_TOKEN` from the environment automatically
— no `gh auth login` needed. Use it directly for issues, PRs, workflow runs,
etc. (`gh pr create`, `gh issue list`, `gh run view`, ...).

`git` itself does not read `GITHUB_TOKEN` — it has no way to know it should
use it for a `git@github.com:`/`https://github.com/` remote. Use
`git-sandboxed` instead of `git` for any git operation that needs the
GitHub credentials this launch set up (e.g. `push`, `fetch`, `clone` against a
private repo). It transparently rewrites the remote URL to authenticate with
`GITHUB_TOKEN` and forwards everything else to the real `git` unchanged:

```bash
git-sandboxed push origin main
```

Don't hand-roll the equivalent yourself with
`git -c "url.https://${GITHUB_TOKEN}@github.com/.insteadOf=git@github.com:" push ...`
— that trick has two real problems `git-sandboxed` avoids:

- A Claude Code git-safety hook (e.g. one set up via the
  `git-guardrails-claude-code` skill) may detect the `-c url.*.insteadOf=` pattern itself 
  as malicious credential rewrite.
- The shell expands `${GITHUB_TOKEN}` before exec, leaking the raw token into
  the process's argv (`ps`, the transcript). `git-sandboxed` reads it from its
  own environment instead, so it never appears on the command line.

Never pass `-u`/`--set-upstream` to `git-sandboxed push` — it writes
upstream-tracking entries to `.git/config`, which the sandbox blocks.
`git-sandboxed` rejects the flag outright with an error rather than letting
the write fail silently after the push already succeeded. Omit `-u` —
`gh pr create` does not need upstream tracking.
