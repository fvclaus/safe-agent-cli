#!/usr/bin/env bun
import { runSafeAgentCli } from '../launcher/safe-agent-cli.js';
import { claudeCodeAdapter } from '../adapters/claude-code.js';

runSafeAgentCli(claudeCodeAdapter).catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  process.stderr.write(`ERROR: ${msg}\n`);
  process.exit(1);
});
