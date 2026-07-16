/**
 * Tests for the live Bun keyring adapter and its Promise compatibility surface.
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
import {
  backendFailureSentinels,
  exportedErrorText,
  maliciousBackendFailure,
} from './error-redaction.test-helper.js';

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
    const payload =
      '{"url":"https://x.atlassian.net","email":"y","apiToken":"z"}';
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
    await setSecret(
      'ado',
      '{"orgUrl":"https://first","pat":"a","authMethod":"pat"}'
    );
    await setSecret(
      'ado',
      '{"orgUrl":"https://second","pat":"b","authMethod":"bearer"}'
    );
    const result = await getSecret('ado');
    expect(result).toContain('second');
    expect(result).toContain('bearer');
  });
});

// ---------------------------------------------------------------------------
// Keyring-unavailable error translation (mock-only — can't easily simulate
// a real backend failure on a host where the keyring works).
// ---------------------------------------------------------------------------

describe('live Bun keyring adapter (keyring unavailable)', () => {
  let store: Store;
  let restore: () => void;

  beforeEach(() => {
    store = new Map();
    Bun.env.AIDE_SECRET_SERVICE_OVERRIDE = 'aide';
  });

  afterEach(() => {
    restore?.();
  });

  test('getSecret throws KeyringUnavailableError on backend failure', async () => {
    restore = installMockSecrets(store, 'get');
    await expect(getSecret('jira')).rejects.toBeInstanceOf(
      KeyringUnavailableError
    );
  });

  test('setSecret throws KeyringUnavailableError on backend failure', async () => {
    restore = installMockSecrets(store, 'set');
    await expect(setSecret('ado', 'x')).rejects.toBeInstanceOf(
      KeyringUnavailableError
    );
  });

  test('deleteSecret throws KeyringUnavailableError on backend failure', async () => {
    restore = installMockSecrets(store, 'delete');
    await expect(deleteSecret('github')).rejects.toBeInstanceOf(
      KeyringUnavailableError
    );
  });

  test('redacts arbitrary backend failures for get, set, and delete', async () => {
    const rawName = 'auth:github:host:raw-name.invalid:account:raw-account';
    const rawCredential = 'RAW_CREDENTIAL_VALUE_8af9';
    const rawIndex =
      '{"version":1,"providerId":"github","scopes":[{"account":"RAW_INDEX_VALUE_b762"}]}';

    for (const operation of ['get', 'set', 'delete'] as const) {
      restore?.();
      const fixture = maliciousBackendFailure([
        rawName,
        rawCredential,
        rawIndex,
      ]);
      const original = (Bun as unknown as { secrets: unknown }).secrets;
      (Bun as unknown as { secrets: unknown }).secrets = {
        async get() {
          throw fixture.failure;
        },
        async set() {
          throw fixture.failure;
        },
        async delete() {
          throw fixture.failure;
        },
      };
      restore = () => {
        (Bun as unknown as { secrets: unknown }).secrets = original;
      };

      const result = await (
        operation === 'get'
          ? getSecret('github')
          : operation === 'set'
            ? setSecret('github', rawCredential)
            : deleteSecret('github')
      ).catch((error: unknown) => error);

      expect(result).toBeInstanceOf(KeyringUnavailableError);
      const error = result as KeyringUnavailableError;
      expect(error).toMatchObject({ operation, classification: 'unavailable' });
      expect(Object.getOwnPropertyDescriptor(error, 'cause')).toBeUndefined();
      const rendered = exportedErrorText(error);
      for (const secret of [
        ...backendFailureSentinels,
        rawName,
        rawCredential,
        rawIndex,
      ]) {
        expect(rendered).not.toContain(secret);
      }
      expect(fixture.getterReads()).toBe(0);
    }
  });

  test('does not inspect or retain a hostile proxy rejection', async () => {
    let trapCalls = 0;
    const raw = new Proxy(Object.create(null) as object, {
      get() {
        trapCalls += 1;
        throw new Error('proxy get trap must not run');
      },
      getOwnPropertyDescriptor() {
        trapCalls += 1;
        throw new Error('proxy descriptor trap must not run');
      },
      getPrototypeOf() {
        trapCalls += 1;
        throw new Error('proxy prototype trap must not run');
      },
      ownKeys() {
        trapCalls += 1;
        throw new Error('proxy keys trap must not run');
      },
    });
    const original = (Bun as unknown as { secrets: unknown }).secrets;
    (Bun as unknown as { secrets: unknown }).secrets = {
      async get() {
        throw raw;
      },
      async set() {},
      async delete() {
        return false;
      },
    };
    restore = () => {
      (Bun as unknown as { secrets: unknown }).secrets = original;
    };

    const result = await getSecret('jira').catch((error: unknown) => error);
    expect(result).toBeInstanceOf(KeyringUnavailableError);
    expect(trapCalls).toBe(0);
    expect(
      Reflect.ownKeys(result as object).some(
        (key) =>
          Object.getOwnPropertyDescriptor(result as object, key)?.value === raw
      )
    ).toBe(false);
    expect(trapCalls).toBe(0);

    const compatibilityError = new KeyringUnavailableError(raw);
    expect(compatibilityError.operation).toBe('unknown');
    expect(
      Reflect.ownKeys(compatibilityError).some(
        (key) =>
          Object.getOwnPropertyDescriptor(compatibilityError, key)?.value ===
          raw
      )
    ).toBe(false);
    expect(trapCalls).toBe(0);
  });
});
