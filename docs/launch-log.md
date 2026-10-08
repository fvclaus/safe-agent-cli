# Launch log

## Problem

Claude Code's fullscreen renderer (`tui` setting, `CLAUDE_CODE_NO_FLICKER`) uses the alternate screen buffer. Everything
safe-agent-cli prints before launching Claude Code (`OK:`, `WARNING:`, ...) is hidden the moment it starts. The launcher
cannot reliably predict which renderer will be used, so it cannot simply print differently.

## Decisions

1. **Warnings that stop a launch become errors.** A warning is only worth interrupting the user for if the launch can
   continue past it. Everything else is an `ERROR:` that exits. Kept as warnings: a global `~/.claude/CLAUDE.md`, a slow
   symlink scan, and notices followed by an interactive prompt anyway. Became errors: missing `origin/HEAD`, failed RTK
   write-access check, GitHub enabled without fragments, unparsable or missing Claude settings files, unknown keys in
   the user settings, an undeterminable GitHub token, a failed Cloud Resource Manager enablement, and sbx symlinks whose
   target does not exist.
2. **stderr output stays as is.** A failed launch must remain readable in the terminal.
3. **The full log is also shown inside the Claude Code session** by a Claude Code mod (`src/launch-log-plugin/`),
   including the `OK:` lines. Needs Claude Code >= 2.1.287.
4. **The mod detects the renderer itself** (`isFullscreen` at render time). In the default renderer it does nothing,
   since scrollback already holds the output.
5. **Display policy.** With a warning, the pane takes focus and stays until dismissed (Esc). Without one, it takes no
   focus and closes after 30 seconds. If the terminal is too narrow for a pane, a one-line hint above the prompt stands
   in.
6. **Consume once.** After showing, the mod rewrites the file with `consumed: true`, because the mod API has no delete.
   A log is never shown twice. The launcher overwrites the old log on every launch.
7. **Relative sbx symlinks are resolved** against the symlink's directory instead of being rejected. Targets staying
   inside the project need nothing; targets leaving it are handled like absolute ones. A dangling target is an error.
   Known limitation: in `--clone` mode sbx does not mount paths at their host location, so such a link can still dangle.
   Not detected.

## How it works

- `src/launch-log.ts`: shared `log` writes to stderr and records entries, classified by prefix (`OK:`, `WARNING:`,
  `ERROR:`, `INFO:`, `SKIP:`, `>>`; unprefixed is info). File contract:
  `{"version":1,"consumed":false,"entries":[{"level","text"}]}`.
- **bwrap** (`src/adapters/claude-code.ts`): the launcher writes the log into a temp dir (cleaned up on exit) and sets
  `SAFE_AGENT_CLI_LAUNCH_LOG` plus `CLAUDE_CODE_PLUGIN_DIRS` in claude's environment.
- **sbx** (`src/sbx/launch-log.ts`): the plugin is copied into the container's
  `~/.claude/skills/safe-agent-cli-launch-log/` (auto-loaded) and the log to `~/.claude/safe-agent-cli/launch-log.json`,
  the mod's fallback when the env var is unset. This avoids merging env or settings inside the container.
- Output of the generic sbx script and the Ink prompt screens is not part of the log.

## Not verified

`claude plugin validate src/launch-log-plugin` and a real fullscreen session have not been run; `claude` cannot run in
the development sandbox. Unit tests cover the log, the classification and the mod's pure functions only.
