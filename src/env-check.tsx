import chalk from 'chalk';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import React, { useState } from 'react';
import { Box, Text, render, useApp, useInput } from 'ink';

const ALLOWLIST_PATH = join(homedir(), '.safe-agent-cli', 'allowed-env-vars.json');

// Well-known credential variable names
const SENSITIVE_EXACT = new Set([
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'OPENAI_ORG_ID',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_API_KEY',
  'GOOGLE_OAUTH_ACCESS_TOKEN',
  'AZURE_CLIENT_SECRET',
  'AZURE_TENANT_ID',
  'AZURE_SUBSCRIPTION_ID',
  'PGPASSWORD',
  'MYSQL_PASSWORD',
  'MYSQL_ROOT_PASSWORD',
  'DATABASE_URL',
  'DATABASE_PASSWORD',
  'DB_PASSWORD',
  'NPM_TOKEN',
  'PYPI_TOKEN',
  'TWINE_PASSWORD',
  'DOCKER_PASSWORD',
  'DOCKER_TOKEN',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'GITLAB_TOKEN',
  'SLACK_BOT_TOKEN',
  'SLACK_SIGNING_SECRET',
  'STRIPE_SECRET_KEY',
  'TWILIO_AUTH_TOKEN',
  'SENDGRID_API_KEY',
  'HEROKU_API_KEY',
  'DATADOG_API_KEY',
  'NEW_RELIC_LICENSE_KEY',
  'SENTRY_AUTH_TOKEN',
  'CLOUDFLARE_API_TOKEN',
  'VAULT_TOKEN',
  'CONSUL_HTTP_TOKEN',
]);

// Suffix-based detection — var names ending with these are treated as sensitive
const SENSITIVE_SUFFIXES = [
  '_API_KEY',
  '_SECRET_KEY',
  '_SECRET',
  '_TOKEN',
  '_PASSWORD',
  '_PRIVATE_KEY',
  '_ACCESS_KEY',
];

function isSensitive(name: string): boolean {
  if (SENSITIVE_EXACT.has(name)) return true;
  const upper = name.toUpperCase();
  for (const suffix of SENSITIVE_SUFFIXES) {
    if (upper.endsWith(suffix)) return true;
  }
  return false;
}

function loadAllowlist(): Set<string> {
  if (!existsSync(ALLOWLIST_PATH)) return new Set();
  try {
    const parsed: unknown = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8'));
    if (Array.isArray(parsed)) return new Set(parsed as string[]);
  } catch {
    // corrupted file — treat as empty
  }
  return new Set();
}

function saveToAllowlist(vars: string[]): void {
  const existing = loadAllowlist();
  for (const v of vars) existing.add(v);
  mkdirSync(join(homedir(), '.safe-agent-cli'), { recursive: true });
  writeFileSync(
    ALLOWLIST_PATH,
    JSON.stringify([...existing].sort(), null, 2) + '\n',
    'utf8',
  );
}

export function findSensitiveVars(credentialEnv: Record<string, string>): string[] {
  const allowlist = loadAllowlist();
  return Object.keys(process.env)
    .filter(name => !Object.prototype.hasOwnProperty.call(credentialEnv, name))
    .filter(name => !allowlist.has(name))
    .filter(isSensitive)
    .sort();
}

interface SensitiveEnvPromptProps {
  vars: string[];
  onDone: (whitelisted: string[] | null) => void;
}

const SensitiveEnvPrompt: React.FC<SensitiveEnvPromptProps> = ({ vars, onDone }) => {
  const { exit } = useApp();
  const [step, setStep] = useState<'warning' | 'select'>('warning');
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState(new Set<string>());

  useInput((input, key) => {
    if (step === 'warning') {
      if (input === 'y' || input === 'Y') { onDone([]); exit(); return; }
      if (input === 'w' || input === 'W') { setStep('select'); return; }
      if (input === 'n' || input === 'N' || key.escape) { onDone(null); exit(); return; }
      return;
    }

    // select step
    if (key.upArrow) { setCursor(c => Math.max(0, c - 1)); return; }
    if (key.downArrow) { setCursor(c => Math.min(vars.length - 1, c + 1)); return; }
    if (input === ' ') {
      const v = vars[cursor];
      if (v !== undefined) {
        setSelected(s => {
          const next = new Set(s);
          if (next.has(v)) next.delete(v); else next.add(v);
          return next;
        });
      }
      return;
    }
    if (key.return) { onDone([...selected]); exit(); return; }
    if (key.escape) { setStep('warning'); return; }
  });

  if (step === 'warning') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold color="yellow">Sensitive environment variables will be passed to the agent:</Text>
        <Box flexDirection="column">
          {vars.map(v => (
            <Box key={v} gap={1}>
              <Text dimColor>•</Text>
              <Text bold>{v}</Text>
            </Box>
          ))}
        </Box>
        <Text dimColor>
          These variables are set in your shell and will be accessible to the agent subprocess.
        </Text>
        <Box gap={3}>
          <Text><Text color="green" bold>[y]</Text> Continue once</Text>
          <Text><Text color="cyan" bold>[w]</Text> Whitelist {'&'} continue</Text>
          <Text><Text color="red" bold>[n]</Text> Abort (default)</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>Select variables to whitelist for future runs:</Text>
      <Box flexDirection="column">
        {vars.map((v, i) => (
          <Box key={v} gap={1}>
            <Text color="cyan">{i === cursor ? '›' : ' '}</Text>
            <Text color={selected.has(v) ? 'green' : 'gray'}>{selected.has(v) ? '✓' : '○'}</Text>
            <Text bold={i === cursor}>{v}</Text>
          </Box>
        ))}
      </Box>
      <Text dimColor>↑↓ navigate · Space toggle · Enter confirm · Esc back</Text>
      <Text dimColor>Saved to {ALLOWLIST_PATH}</Text>
    </Box>
  );
};

export async function checkSensitiveEnv(
  credentialEnv: Record<string, string>,
  log: (msg: string) => void,
): Promise<void> {
  const sensitive = findSensitiveVars(credentialEnv);
  if (sensitive.length === 0) return;

  if (!process.stdin.isTTY) {
    log(chalk.bold.yellow('WARNING:') + ' Sensitive environment variables will be passed to the agent:');
    for (const v of sensitive) log(`  • ${v}`);
    log('Running in non-interactive mode — proceeding. To suppress this warning, add variables to ' + ALLOWLIST_PATH);
    return;
  }

  // Use an object so TypeScript can track the property assignment across the async boundary
  const state: { whitelisted: string[] | null } = { whitelisted: null };

  const { waitUntilExit } = render(
    <SensitiveEnvPrompt
      vars={sensitive}
      onDone={w => { state.whitelisted = w; }}
    />,
  );
  await waitUntilExit();

  if (state.whitelisted === null) {
    log(chalk.bold.red('Aborted.'));
    process.exit(1);
  }

  if (state.whitelisted.length > 0) {
    saveToAllowlist(state.whitelisted);
    log(
      chalk.bold.green('OK:') +
      ` Whitelisted ${state.whitelisted.length} variable(s) in ${ALLOWLIST_PATH}`,
    );
  }
}
