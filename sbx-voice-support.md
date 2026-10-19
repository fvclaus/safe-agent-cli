# Voice dictation for Claude Code in the claude-sbx sandbox

Status: design in progress — round 1 questions open, nothing implemented.

Target: the shared sandbox image `infrastructure/sbx/Dockerfile`
(`da-default/sandbox:latest`) plus, likely, `infrastructure/sbx/claude-generic.ts`.

## Established facts

### Claude Code voice dictation

Source: https://code.claude.com/docs/en/voice-dictation.md, settings-reference.md,
keybindings.md, network-config.md.

- Input only (speech → prompt). No built-in TTS / spoken output.
- Requires a **claude.ai login**. Unavailable with `ANTHROPIC_API_KEY`,
  `ANTHROPIC_AUTH_TOKEN`, `apiKeyHelper`, Bedrock, Vertex, Foundry — any of those
  takes precedence and `/voice` becomes `Unknown command`.
- Linux capture: native module first, fallback to `arecord` (ALSA) or `rec`
  (SoX). Docs name `sox`, and `sox libsox-fmt-pulse` for WSLg (PulseAudio).
  `PULSE_SERVER` support is not documented (libpulse honours it, so SoX via
  `libsox-fmt-pulse` should too).
- Officially unsupported in SSH, cloud sessions, Dev Containers, Codespaces;
  "headless server or a container" is a named failure case.
- Audio streams to Anthropic over a **WebSocket**; the hostname is undocumented.
  Claude Code honours `HTTPS_PROXY` in general.
- Settings: `"voice": { "enabled": true, "mode": "hold" | "tap", "autoSubmit": bool }`
  (`voiceEnabled` is the legacy form). Language comes from top-level `language`.
- Push-to-talk: action `voice:pushToTalk`, context `Chat`, default `Space`,
  rebindable in `~/.claude/keybindings.json`.

### Docker Sandboxes (sbx)

Source: https://docs.docker.com/ai/sandboxes/ (architecture, security/isolation,
security/defaults, workflows/development, usage, credentials, agents/claude-code).

- Each sandbox is a **microVM** (KVM on Linux, Windows Hypervisor Platform on
  Windows, Apple silicon on macOS) — not a container.
- No documented passthrough for `/dev/snd` or host Unix sockets (a VM couldn't
  use a bind-mounted socket anyway). Only NVIDIA GPU passthrough on Linux.
- Host services are reachable at `host.docker.internal:<port>`; the proxy maps
  it to host `localhost`, allowed via `sbx policy allow network localhost:<port>`.
- All outbound TCP goes through the host proxy; **non-HTTP TCP is forwarded
  transparently** and policy-enforced. UDP is experimental and off by default.
- Env vars: `sbx run|create -e NAME[=VALUE]` / `--env-file` (sbx ≥ 0.39.0).
- Auth: API key or OAuth, both proxy-managed; the real token never enters the
  sandbox. The host's `anthropic` secret is **OAuth-configured** (`sbx secret ls`),
  so voice is not blocked by an API key.

### Current wrapper (`infrastructure/sbx/claude-generic.ts`)

- Image is built locally by `ensureTemplate` (`docker build` → `docker save` →
  `sbx template load`), rebuilt when the Dockerfile hash changes (:1624-1670).
  No CI publishes it.
- settings.json sync copies only `SETTINGS_PATCH_KEYS` (`enabledPlugins`,
  `extraKnownMarketplaces`, `model`, `effortLevel`, `statusLine`) on every attach
  (:792). **`voice` / `voiceEnabled` are not synced.**
- `keybindings.json` is copied wholesale on every attach (:910-923), so a
  `voice:pushToTalk` rebind already reaches the sandbox.
- Network allowlist `NETWORK_ALLOW` (:68-113) is applied **machine-wide** via
  `sbx policy allow network` on every run. It already contains `*.anthropic.com`,
  `*.claude.ai`, and bare `localhost` (:89).
- Precedent for a host bridge: the (uncommitted, branch `feat-sbx-notifications`)
  notification relay listens on host `127.0.0.1:8765`, reached from the sandbox
  as `host.docker.internal:8765`.
- No mechanism exists for devices, Unix sockets, or port publishing. `add-env`
  appends to `/etc/sandbox-persistent.sh` (lost on recreate).
- No README in `sbx/`; docs live in `usage()` (:1740-1914) and Dockerfile comments.

## Candidate mechanism (Linux host)

PulseAudio protocol over TCP from the microVM to the host's audio server:

1. Host: PipeWire `pipewire-pulse` listens on `tcp:127.0.0.1:4713`
   (`pulse.properties.server.address` drop-in), or PulseAudio
   `pactl load-module module-native-protocol-tcp listen=127.0.0.1 …`.
2. Image: `sox libsox-fmt-pulse` (+ `pulseaudio-utils` for `parecord`/`pactl`
   debugging).
3. Sandbox env: `PULSE_SERVER=tcp:host.docker.internal:4713`.
4. Policy: `localhost:4713` allowed.

Other hosts: macOS via Homebrew `pulseaudio` + TCP module (mic capture
unproven). Windows: WSLg's server is a Unix socket (unusable from the sbx VM);
would need native PulseAudio-for-Windows with TCP (unproven).

## Open questions — round 1 (awaiting answers)

**Q1 — Scope of "voice support".** (a) built-in dictation only; (b) plus
TTS of replies via hook; (c) other.
➡️ Recommended: (a).

**Q2 — Host OSes for v1.** (a) Linux only; (b) Linux + Windows; (c) all three.
➡️ Recommended: (a), with voice cleanly unavailable (clear message, no failure)
elsewhere.

**Q3 — Change boundary.** (a) Dockerfile only; (b) Dockerfile +
`claude-generic.ts` + host-setup docs; (c) (b) and the wrapper auto-configures
the host audio server.
➡️ Recommended: (b).

**Q4 — Mic-access risk and gating.** Any process in the sandbox (incl. a
prompt-injected agent or a malicious package) can record while the bridge is
open. (a) always on; (b) opt-in per launch, e.g. `--voice`; (c) not acceptable.
➡️ Recommended: (b).

## Pending for round 2 (depends on round 1)

- **Gating mechanism.** Because the sbx network policy is machine-wide, a
  `--voice` flag can't scope mic access to one sandbox via policy. Gating would
  have to be host-side (open the TCP listener on launch, close on exit) — and
  whether the wrapper does that automatically is part of Q3(c).
- **Bare `localhost` in `NETWORK_ALLOW`.** If sbx treats a host without port as
  "all ports", every sandbox can already reach every host localhost service,
  including a mic port the moment it opens. Unverified whether bare host means
  all ports or 80/443 only. Decide whether to tighten to explicit ports.
- PipeWire vs PulseAudio support on the host; auth (IP ACL / anonymous /
  cookie via `PULSE_COOKIE`).
- How `voice.enabled` reaches the sandbox: add `voice` to `SETTINGS_PATCH_KEYS`,
  or set it only when `--voice` is passed.
- Whether `language` should be synced too.
- Where host-setup docs live (`usage()` text vs. new README).
- Branching: current branch `feat-sbx-notifications` has uncommitted wrapper
  changes; voice work likely belongs on its own branch off `main`.

## Unverified — needs a hands-on spike

- Raw PulseAudio TCP through the sbx proxy to host `localhost:4713`.
- Whether PipeWire's "restricted" network clients may record (may need
  `client.access = "unrestricted"`).
- Whether voice accepts the proxy's sentinel OAuth credentials as a claude.ai
  login.
- The voice WebSocket hostname and whether it's covered by `*.anthropic.com` /
  `*.claude.ai` and the proxy.
- Whether the built-in sbx `claude` agent sets `ANTHROPIC_API_KEY` or
  `apiKeyHelper` inside the sandbox (presence check only).
