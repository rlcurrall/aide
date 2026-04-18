import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { logout } from './logout.js';
import { installMockSecrets, type Store } from '@lib/test-helpers.js';

describe('logout', () => {
  let store: Store;
  let restore: () => void;

  beforeEach(() => {
    store = new Map();
    Bun.env.AIDE_SECRET_SERVICE_OVERRIDE = 'aide';
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

  test('logout propagates KeyringUnavailableError when deleteSecret fails', async () => {
    restore();
    const localRestore = installMockSecrets(store, 'delete');
    try {
      await expect(logout('jira')).rejects.toMatchObject({ name: 'KeyringUnavailableError' });
    } finally {
      localRestore();
    }
  });
});
