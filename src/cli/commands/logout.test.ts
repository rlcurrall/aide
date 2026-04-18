import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { logout } from './logout.js';

type Store = Map<string, string>;

function installMockSecrets(store: Store) {
  const original = (Bun as unknown as { secrets: unknown }).secrets;
  (Bun as unknown as { secrets: unknown }).secrets = {
    async get(opts: { service: string; name: string }) {
      return store.get(`${opts.service}:${opts.name}`) ?? null;
    },
    async set() {},
    async delete(opts: { service: string; name: string }) {
      return store.delete(`${opts.service}:${opts.name}`);
    },
  };
  return () => {
    (Bun as unknown as { secrets: unknown }).secrets = original;
  };
}

describe('logout', () => {
  let store: Store;
  let restore: () => void;

  beforeEach(() => {
    store = new Map();
    restore = installMockSecrets(store);
  });

  afterEach(() => restore());

  test('removes an existing entry', async () => {
    store.set('aide:jira', '{"url":"x","email":"y","apiToken":"z"}');
    const result = await logout('jira');
    expect(result).toBe('removed');
    expect(store.has('aide:jira')).toBe(false);
  });

  test('reports not-found when nothing was stored', async () => {
    const result = await logout('jira');
    expect(result).toBe('not-found');
  });
});
