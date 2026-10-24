---
isolation: proxy
---
### Sandbox: modified `bwrap`

Bash commands run through a `bwrap` shim, not stock Claude Code sandboxing. Source:
`readlink -f "$(command -v bwrap)"` (transforms in `bwrap-transform.ts` next to it).

Suspect the shim when the effective sandbox doesn't match the reported config (`/sandbox`,
the session's sandbox description), e.g.:

- a path the config allows is `Read-only file system`, or a denied path is writable
- only some subdirectories of the project are read-only
- network or proxy errors (`407`, connection refused on the proxy port)
- git fails inside a worktree

To debug, put `BWRAP_WRAPPER_DEBUG=1` in a single command (e.g.
`BWRAP_WRAPPER_DEBUG=1 touch <path>`), then read `/tmp/bwrap-wrapper.log`: `argv:` is what
Claude Code passed, `exec:` what the shim ran, the lines between are its changes. Effective
mounts: `grep <path> /proc/self/mountinfo`. Report findings; don't edit the shim to get around
a restriction.
