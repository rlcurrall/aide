/**
 * Tests for secrets.ts
 *
 * Success-path tests run against the real OS keyring under a scoped service
 * name, so they verify the actual Bun.secrets integration rather than just a
 * local mock. Unavailable-error paths still use the mock (can't easily
 * simulate a missing secret service on a host that has one).
 */

import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from 'bun:test';

import {
  getSecret,
  setSecret,
  deleteSecret,
  KeyringUnavailableError,
} from './secrets.js';
import {
  installMockSecrets,
  isKeyringAvailable,
  uniqueTestService,
  cleanupTestService,
  type Store,
} from './test-helpers.js';

// ---------------------------------------------------------------------------
// Real-keyring integration tests
// ---------------------------------------------------------------------------

const keyringReady = await isKeyringAvailable();
const describeIfKeyring = keyringReady ? describe : describe.skip;

describeIfKeyring('secrets wrapper (real keyring)', () => {
  const service = uniqueTestService();
  const prevOverride = Bun.env.AIDE_SECRET_SERVICE_OVERRIDE;

  beforeAll(() => {
    Bun.env.AIDE_SECRET_SERVICE_OVERRIDE = service;
  });

  afterAll(async () => {
    await cleanupTestService(service, ['jira', 'ado', 'github']);
    if (prevOverride === undefined) {
      delete Bun.env.AIDE_SECRET_SERVICE_OVERRIDE;
    } else {
      Bun.env.AIDE_SECRET_SERVICE_OVERRIDE = prevOverride;
    }
  });

  beforeEach(async () => {
    // Each test starts from a clean slate for jira/ado/github within the scoped service
    await cleanupTestService(service, ['jira', 'ado', 'github']);
  });

  test('getSecret returns null when entry is missing', async () => {
    const result = await getSecret('jira');
    expect(result).toBeNull();
  });

  test('setSecret + getSecret round-trips the exact value', async () => {
    const payload = '{"url":"https://x.atlassian.net","email":"y","apiToken":"z"}';
    await setSecret('jira', payload);
    const result = await getSecret('jira');
    expect(result).toBe(payload);
  });

  test('deleteSecret removes an existing entry and returns true', async () => {
    await setSecret('github', '{"token":"gh"}');
    const removed = await deleteSecret('github');
    expect(removed).toBe(true);
    expect(await getSecret('github')).toBeNull();
  });

  test('deleteSecret returns false when there was nothing to remove', async () => {
    const removed = await deleteSecret('github');
    expect(removed).toBe(false);
  });

  test('setSecret overwrites an existing entry', async () => {
    await setSecret('ado', '{"orgUrl":"https://first","pat":"a","authMethod":"pat"}');
    await setSecret('ado', '{"orgUrl":"https://second","pat":"b","authMethod":"bearer"}');
    const result = await getSecret('ado');
    expect(result).toContain('second');
    expect(result).toContain('bearer');
  });
});

// ---------------------------------------------------------------------------
// Keyring-unavailable error translation (mock-only — can't easily simulate
// a real backend failure on a host where the keyring works).
// ---------------------------------------------------------------------------

describe('secrets wrapper (keyring unavailable)', () => {
  let store: Store;
  let restore: () => void;

  beforeEach(() => {
    store = new Map();
    delete Bun.env.AIDE_SECRET_SERVICE_OVERRIDE;
  });

  afterEach(() => {
    restore?.();
  });

  test('getSecret throws KeyringUnavailableError on backend failure', async () => {
    restore = installMockSecrets(store, 'get');
    await expect(getSecret('jira')).rejects.toBeInstanceOf(KeyringUnavailableError);
  });

  test('setSecret throws KeyringUnavailableError on backend failure', async () => {
    restore = installMockSecrets(store, 'set');
    await expect(setSecret('ado', 'x')).rejects.toBeInstanceOf(KeyringUnavailableError);
  });

  test('deleteSecret throws KeyringUnavailableError on backend failure', async () => {
    restore = installMockSecrets(store, 'delete');
    await expect(deleteSecret('github')).rejects.toBeInstanceOf(KeyringUnavailableError);
  });
});
