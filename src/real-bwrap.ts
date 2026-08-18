import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const OWN_SHIM_PATH = fileURLToPath(new URL('./bin/bwrap', import.meta.url));

/**
 * Finds the genuine bubblewrap binary on PATH, skipping any match that resolves to
 * this repo's own bwrap shim (src/bin/bwrap). `which bwrap` alone is unreliable once
 * this repo's src/bin is already on PATH ahead of the real binary — e.g. when this
 * runs nested inside a session safe-agent-cli itself launched — which otherwise makes
 * the shim treat itself as "the real bwrap" (REAL_BWRAP pointing at itself) and exec
 * into itself repeatedly, growing its argument list without bound on every recursive
 * pass until it exhausts memory or hits the OS argv-length limit.
 */
export function resolveRealBwrap(): string {
  const out = spawnSync('which', ['-a', 'bwrap'], { encoding: 'utf8' }).stdout;
  const candidates = out.split('\n').map(l => l.trim()).filter(Boolean);
  for (const c of candidates) {
    try {
      if (realpathSync(c) !== OWN_SHIM_PATH) return c;
    } catch {
      continue;
    }
  }
  return '/usr/bin/bwrap';
}
