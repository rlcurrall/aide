/**
 * Shared test helpers for keyring-related tests.
 *
 * Two patterns are supported:
 *  1. Mock-mode: `installMockSecrets` swaps Bun.secrets with an in-memory map.
 *     Use this for tests that care about logic orchestration, or need to
 *     simulate KeyringUnavailableError.
 *  2. Real-keyring mode: `uniqueTestService` returns a scoped service name
 *     to set via AIDE_SECRET_SERVICE_OVERRIDE. Tests run against the real
 *     OS keyring under that scope. `cleanupTestService` removes any entries
 *     written. Use `isKeyringAvailable` to skip real-keyring tests when the
 *     OS backend is missing (Linux CI without gnome-keyring).
 */

import type { SecretName } from './secrets.js';

export type Store = Map<string, string>;

/**
 * Swap `Bun.secrets` with an in-memory map. Returns a restore function.
 *
 * When `throwOn` is set, the named operation throws a generic Error to
 * simulate a keyring backend failure (gets translated to
 * KeyringUnavailableError by the wrapper).
 */
export function installMockSecrets(
  store: Store,
  throwOn?: 'get' | 'set' | 'delete'
) {
  const original = (Bun as unknown as { secrets: unknown }).secrets;
  (Bun as unknown as { secrets: unknown }).secrets = {
    async get(opts: { service: string; name: string }) {
      if (throwOn === 'get') throw new Error('keyring unavailable');
      return store.get(`${opts.service}:${opts.name}`) ?? null;
    },
    async set(opts: { service: string; name: string; value: string }): Promise<void> {
      if (throwOn === 'set') throw new Error('keyring unavailable');
      store.set(`${opts.service}:${opts.name}`, opts.value);
    },
    async delete(opts: { service: string; name: string }) {
      if (throwOn === 'delete') throw new Error('keyring unavailable');
      return store.delete(`${opts.service}:${opts.name}`);
    },
  };
  return () => {
    (Bun as unknown as { secrets: unknown }).secrets = original;
  };
}

/**
 * Returns true if the real OS keyring is reachable (probe write + delete).
 * Use this to gate real-keyring tests so CI without a secret service skips
 * them instead of failing.
 */
export async function isKeyringAvailable(): Promise<boolean> {
  const service = 'aide-test-probe';
  const name = 'probe';
  try {
    await Bun.secrets.set({ service, name, value: 'x' });
    await Bun.secrets.delete({ service, name });
    return true;
  } catch {
    return false;
  }
}

/**
 * Generate a unique service name so parallel test files don't collide.
 */
export function uniqueTestService(): string {
  return `aide-test-${crypto.randomUUID()}`;
}

/**
 * Best-effort cleanup of any entries a test wrote under a scoped service.
 * Swallows individual failures since we're just cleaning up.
 */
export async function cleanupTestService(
  service: string,
  names: readonly SecretName[]
): Promise<void> {
  for (const name of names) {
    try {
      await Bun.secrets.delete({ service, name });
    } catch {
      // ignore
    }
  }
}
