import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applySchemaOverlay } from '../src/claude-settings-schema-overlay.js';
import { compileSettingsValidator } from '../src/claude-settings-validation.js';

const schema: object = JSON.parse(
  readFileSync(join(import.meta.dir, 'fixtures', 'claude-code-settings.schema.json'), 'utf8'),
);
const patched = compileSettingsValidator(applySchemaOverlay(schema));

const credentials = (c: object) => ({ sandbox: { credentials: c } });

// The examples from https://code.claude.com/docs/en/settings-reference.md#sandbox-credentials
const DOCUMENTED_EXAMPLES: Record<string, object> = {
  'envVars deny and mask with injectHosts': credentials({
    envVars: [
      { name: 'NPM_TOKEN', mode: 'deny' },
      { name: 'GITHUB_TOKEN', mode: 'mask', injectHosts: ['api.github.com'] },
    ],
  }),
  'envVars extract and decode': credentials({
    envVars: [
      { name: 'DATABASE_URL', mode: 'mask', extract: '://[^:]+:([^@]+)@', onExtractNoMatch: 'deny' },
      { name: 'SERVICE_JWT', mode: 'mask', decode: 'jwt', maskClaims: ['api_key'] },
    ],
  }),
  'files deny and mask': credentials({
    files: [
      { path: '~/.aws/credentials', mode: 'deny' },
      {
        path: '~/.config/gh/hosts.yml',
        mode: 'mask',
        extract: 'oauth_token:\\s*(\\S+)',
        maskDuplicates: true,
        onExtractNoMatch: 'deny',
        injectHosts: ['api.github.com'],
      },
    ],
  }),
  allowPlaintextInject: credentials({ allowPlaintextInject: true }),
  awsPairs: credentials({
    awsPairs: [{ accessKeyIdVar: 'MY_KEY_ID', secretAccessKeyVar: 'MY_SECRET_KEY', sessionTokenVar: 'MY_SESSION_TOKEN' }],
  }),
  sigv4: credentials({ sigv4: { streaming: 'passthrough' } }),
};

describe('settings schema overlay', () => {
  for (const [name, example] of Object.entries(DOCUMENTED_EXAMPLES)) {
    test(`accepts the documented ${name} example`, () => {
      expect(patched(example)).toBe(true);
    });
  }

  test('is still needed: the unpatched schema rejects at least one documented example', () => {
    // When this fails after refreshing the fixture, schemastore has caught up:
    // drop the sandbox.credentials entry from SCHEMA_OVERLAY.
    const unpatched = compileSettingsValidator(schema);
    expect(Object.values(DOCUMENTED_EXAMPLES).some((e) => !unpatched(e))).toBe(true);
  });

  test.each([
    ['a misspelled mode', { envVars: [{ name: 'GITHUB_TOKEN', mode: 'maks' }] }],
    ['injectHosts as a string', { envVars: [{ name: 'GITHUB_TOKEN', mode: 'mask', injectHosts: 'api.github.com' }] }],
    ['an unknown entry field', { envVars: [{ name: 'GITHUB_TOKEN', mode: 'mask', injectHost: ['api.github.com'] }] }],
    ['an invalid variable name', { envVars: [{ name: '1TOKEN', mode: 'deny' }] }],
    ['extract combined with decode', { envVars: [{ name: 'T', mode: 'mask', extract: '(x)', decode: 'jwt' }] }],
    ['maskClaims without decode', { envVars: [{ name: 'T', mode: 'mask', maskClaims: ['a'] }] }],
    ['an unknown sigv4 value', { sigv4: { streaming: 'allow' } }],
    ['an unknown credentials key', { envVar: [] }],
  ])('rejects %s', (_, c) => {
    expect(patched(credentials(c))).toBe(false);
  });

  test('leaves the rest of the schema untouched', () => {
    expect(patched({ sandbox: { enabeld: true } })).toBe(false);
    expect(patched({ sandbox: { enabled: true } })).toBe(true);
  });

  test('fails loudly when schemastore restructures the sandbox block', () => {
    expect(() => applySchemaOverlay({ properties: {} })).toThrow(/layout changed/);
  });
});
