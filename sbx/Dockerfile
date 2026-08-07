# syntax=docker/dockerfile:1
#
# Per-project sbx template for safe-agent-cli.
#
# claude-generic.sh auto-detects <git-root>/sbx/Dockerfile and, in "local" mode,
# builds a STANDALONE per-project template (da-local-<repo>/sandbox:latest) from
# it — it does not extend the shared da-default base. So this must be a complete,
# Claude-capable sandbox on its own, not just a tool layer: we start from
# Docker's official Claude Code sandbox template (Ubuntu, non-root `agent` user
# with sudo, Git + GitHub CLI + Node.js preinstalled, `claude` on PATH) and add
# the one tool this project needs on top — bun.
#
# Base image + extension pattern:
#   https://docs.docker.com/ai/sandboxes/customize/templates/
FROM docker/sandbox-templates:claude-code

# Pinned to package.json's "packageManager" so the sandbox matches CI
# (oven-sh/setup-bun) and local dev. Bump both together.
ARG BUN_VERSION=1.3.14

USER root

# `unzip` is required by bun's install script (curl is already in the base, but
# asserting it and ca-certificates is cheap). Installing with BUN_INSTALL set to
# /usr/local lands the binary at /usr/local/bin/bun — already on PATH for every
# user, so no shell-init or ENV PATH juggling is needed. Note BUN_INSTALL must
# be set on the `bash` that runs the script, not on `curl`, hence its placement.
RUN apt-get update \
    && apt-get install -y --no-install-recommends unzip ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash -s "bun-v${BUN_VERSION}" \
    && bun --version

# Drop back to the unprivileged user the sandbox runs Claude as.
USER agent
