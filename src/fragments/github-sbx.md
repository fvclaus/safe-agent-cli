---
isolation: sbx
github: true
githubMasked: false
---
### Github / Git

GitHub access is proxy-managed here — a "github" secret is configured for
this sandbox (globally or sandbox-scoped), and the sandbox's network proxy
transparently authenticates any HTTPS request to GitHub on your behalf.

Both `gh` and plain `git` work directly with **no setup needed**: no
credential helper, no token wiring, no `git-sandboxed`-style wrapper. Use
them exactly as you normally would, e.g. `git push origin main`,
`gh pr create`.

`GH_TOKEN` is set in the environment but is a fixed placeholder value, not a
real token — don't read it or rely on its contents; the proxy does the actual
authentication regardless of what it holds.

SSH remotes (`git@github.com:...`) do **not** work here — no SSH agent or
key is configured, and the proxy only covers HTTPS. Always use the
`https://github.com/...` remote form.
