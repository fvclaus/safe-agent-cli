---
isolation: proxy
rtk: true
---
### rtk rewrites and `excludedCommands`

The rtk PreToolUse hook rewrites many Bash commands before they run — e.g.
`git status` → `rtk git status`, `docker ps` → `rtk docker ps`, `terraform plan`
→ `rtk terraform plan`. `excludedCommands` is matched against the rewritten
command, so an entry like `docker *` no longer covers `docker ps`, and the command
silently runs inside the sandbox.

If a command covered by `excludedCommands` still fails the way sandboxed commands
do (`permission denied` on a socket, `Host key verification failed`, files under
`~` missing), check whether rtk rewrites that exact command before looking for any
other cause — rtk decides per subcommand:

```bash
echo '{"tool_name":"Bash","tool_input":{"command":"docker ps"}}' | rtk hook claude
```

Output with an `updatedInput.command` means rtk rewrites it: the exclusion needs a
matching `rtk …` entry (e.g. `rtk docker *`) — ask the user to add it. No output
means rtk leaves the command alone, so the cause is something else (wrapping,
chains, `git -C`).
