# `claude-generic.sh`: `--bind-mount` support for `build`

Status: implemented.

## Problem

sbx only mounts the project dir. A project symlink pointing outside it (e.g.
`.env` -> `~/.secrets/env`) dangles in the sandbox. `sbx-claude-code`
discovers and gets user approval for such symlinks on the host, before
`build` runs.

## Contract

`sbx-claude-code` only ever sends `--bind-mount <absolute-host-path>` for
**directory** targets (repeated flag, one path each, only on `build`, never
`resolve-name`). `build` must bind-mount each given path at the identical
absolute path inside the sandbox — live, two-way — so the project's existing
symlink resolves without rewriting. Re-applied on every `build`.

File targets are **not** sent as `--bind-mount`: `sbx create` only accepts
directory workspaces, and mounting a file's parent directory would expose
every sibling in it beyond what was approved. Instead `sbx-claude-code`
pushes the file's content in itself via `sbx cp` once the sandbox exists —
`claude-generic.sh` doesn't need to do anything for this case.

No confirmation needed on your end: everything reaching `--bind-mount` was
already approved interactively on the host.

## Reference

`safe-agent-cli`'s `CLAUDE.md` (sbx adapter section), `src/sbx/symlink-mounts.ts`,
`src/sbx/symlink-copy.ts`, `src/commands/sbx-claude-code.ts --help`.
