#!/usr/bin/env bun
import { runSafeAgentCli } from '../launcher/safe-agent-cli.js';
import { codexAdapter } from '../adapters/codex.js';

runSafeAgentCli(codexAdapter).catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  process.stderr.write(`ERROR: ${msg}\n`);
  process.exit(1);
});
