/**
 * Tests for secrets.ts
 *
 * We mock `Bun.secrets` so these tests exercise the wrapper's branching
 * without touching the real OS credential store. The wrapper exists so the
 * rest of the codebase has one place that translates raw Bun.secrets errors
 * into domain-typed errors (KeyringUnavailableError) and a null "not found"
 * return.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';

import {
  getSecret,
  setSecret,
  deleteSecret,
  KeyringUnavailableError,
  AIDE_SERVICE,
} from './secrets.js';

type Store = Map<string, string>;

function installMockSecrets(store: Store, throwOn?: 'get' | 'set' | 'delete') {
  const originalSecrets = (Bun as unknown as { secrets: unknown }).secrets;
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
    (Bun as unknown as { secrets: unknown }).secrets = originalSecrets;
  };
}

describe('secrets wrapper', () => {
  let store: Store;
  let restore: () => void;

  beforeEach(() => {
    store = new Map();
  });

  afterEach(() => {
    restore?.();
  });

  test('AIDE_SERVICE is the constant "aide"', () => {
    expect(AIDE_SERVICE).toBe('aide');
  });

  test('getSecret returns null when entry is missing', async () => {
    restore = installMockSecrets(store);
    const result = await getSecret('jira');
    expect(result).toBeNull();
  });

  test('getSecret returns stored string when present', async () => {
    restore = installMockSecrets(store);
    store.set('aide:jira', '{"url":"x","email":"y","apiToken":"z"}');
    const result = await getSecret('jira');
    expect(result).toBe('{"url":"x","email":"y","apiToken":"z"}');
  });

  test('getSecret throws KeyringUnavailableError on backend failure', async () => {
    restore = installMockSecrets(store, 'get');
    await expect(getSecret('jira')).rejects.toBeInstanceOf(
      KeyringUnavailableError
    );
  });

  test('setSecret writes the value', async () => {
    restore = installMockSecrets(store);
    await setSecret('ado', '{"orgUrl":"x","pat":"y"}');
    expect(store.get('aide:ado')).toBe('{"orgUrl":"x","pat":"y"}');
  });

  test('setSecret throws KeyringUnavailableError on backend failure', async () => {
    restore = installMockSecrets(store, 'set');
    await expect(setSecret('ado', 'x')).rejects.toBeInstanceOf(
      KeyringUnavailableError
    );
  });

  test('deleteSecret removes an existing entry and returns true', async () => {
    restore = installMockSecrets(store);
    store.set('aide:github', '{"token":"x"}');
    const removed = await deleteSecret('github');
    expect(removed).toBe(true);
    expect(store.has('aide:github')).toBe(false);
  });

  test('deleteSecret returns false when there was nothing to remove', async () => {
    restore = installMockSecrets(store);
    const removed = await deleteSecret('github');
    expect(removed).toBe(false);
  });

  test('deleteSecret throws KeyringUnavailableError on backend failure', async () => {
    restore = installMockSecrets(store, 'delete');
    await expect(deleteSecret('github')).rejects.toBeInstanceOf(
      KeyringUnavailableError
    );
  });
});
