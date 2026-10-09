// The schemastore schema lags behind Claude Code's own settings reference.
// Where it does, the documented shape is defined here and replaces the
// fetched schema's subtree before validation — validation is never loosened
// or skipped to work around the lag. Each subtree is written from
// https://code.claude.com/docs/en/settings-reference.md; the test in
// test/claude-settings-schema-overlay.test.ts fails once the checked-in
// schemastore copy accepts the documented examples on its own, which is the
// signal to drop the subtree from here.

const DOCS = 'https://code.claude.com/docs/en/settings-reference';

const stringArray = { type: 'array', items: { type: 'string' } };

const injectHosts = {
  ...stringArray,
  description: 'Hosts the sandbox proxy substitutes the real value on.',
};

const onExtractNoMatch = { type: 'string', enum: ['warn', 'deny', 'error'] };

// Mask fields shared by envVars and files entries; Claude Code accepts but
// ignores them on a `deny` entry, so they aren't restricted by mode here.
const sharedMaskFields = {
  extract: { type: 'string', description: 'Regular expression; group 1 of each match is masked.' },
  onExtractNoMatch,
  decode: { type: 'string', enum: ['jwt'] },
  maskClaims: { ...stringArray, minItems: 1 },
  injectHosts,
};

const mode = { type: 'string', enum: ['deny', 'mask'] };

const credentials = {
  type: 'object',
  additionalProperties: false,
  description: `Credential files and environment variables to protect from sandboxed commands. See ${DOCS}#sandbox-credentials`,
  properties: {
    envVars: {
      type: 'array',
      description: `See ${DOCS}#sandbox-credentials-envvars`,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'mode'],
        properties: {
          name: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]*$' },
          mode,
          ...sharedMaskFields,
        },
        dependencies: { maskClaims: ['decode'] },
        not: { required: ['extract', 'decode'] },
      },
    },
    files: {
      type: 'array',
      description: `See ${DOCS}#sandbox-credentials-files`,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'mode'],
        properties: {
          path: { type: 'string' },
          mode,
          ...sharedMaskFields,
          maskDuplicates: { type: 'boolean' },
        },
        dependencies: { maskClaims: ['decode'] },
      },
    },
    allowPlaintextInject: {
      type: 'boolean',
      description: `See ${DOCS}#sandbox-credentials-allowplaintextinject`,
    },
    awsPairs: {
      type: 'array',
      description: `See ${DOCS}#sandbox-credentials-awspairs`,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['accessKeyIdVar', 'secretAccessKeyVar'],
        properties: {
          accessKeyIdVar: { type: 'string' },
          secretAccessKeyVar: { type: 'string' },
          sessionTokenVar: { type: 'string' },
        },
      },
    },
    sigv4: {
      type: 'object',
      additionalProperties: false,
      description: `See ${DOCS}#sandbox-credentials-sigv4`,
      properties: {
        streaming: { type: 'string', enum: ['deny', 'passthrough'] },
        presigned: { type: 'string', enum: ['deny', 'passthrough'] },
        sigv4a: { type: 'string', enum: ['deny', 'passthrough'] },
      },
    },
  },
};

/** Documented settings whose schemastore definition lags, keyed by property path. */
export const SCHEMA_OVERLAY: ReadonlyArray<{ path: readonly string[]; schema: object }> = [
  { path: ['sandbox', 'credentials'], schema: credentials },
];

/**
 * Returns a copy of `schema` with each overlay subtree swapped in under
 * `properties.<path[0]>.properties.<path[1]>…`. Throws if the fetched schema
 * no longer has the parent objects, so a schemastore restructure surfaces
 * as an error rather than silently skipping the overlay.
 */
export function applySchemaOverlay(schema: unknown): object {
  const patched = structuredClone(schema) as Record<string, unknown>;
  for (const { path, schema: subtree } of SCHEMA_OVERLAY) {
    let node = patched;
    for (const key of path.slice(0, -1)) {
      const props = node['properties'] as Record<string, unknown> | undefined;
      const child = props?.[key];
      if (typeof child !== 'object' || child === null) {
        throw new Error(`settings schema overlay: no "${path.join('.')}" parent at "${key}" — schemastore's layout changed`);
      }
      node = child as Record<string, unknown>;
    }
    const props = node['properties'];
    if (typeof props !== 'object' || props === null) {
      throw new Error(`settings schema overlay: no properties to patch for "${path.join('.')}" — schemastore's layout changed`);
    }
    (props as Record<string, unknown>)[path[path.length - 1]!] = subtree;
  }
  return patched;
}
