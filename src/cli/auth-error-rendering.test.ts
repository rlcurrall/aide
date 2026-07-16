import { afterEach, describe, expect, test } from 'bun:test';

import { renderTopLevelError } from './index.js';
import { AuthProviderOperationError } from './host/auth-provider-operations.js';
import { setSecret } from '../lib/secrets.js';
import {
  backendFailureSentinels,
  maliciousBackendFailure,
} from '../lib/error-redaction.test-helper.js';

describe('CLI auth error rendering', () => {
  const originalSecrets = (Bun as unknown as { secrets: unknown }).secrets;

  afterEach(() => {
    (Bun as unknown as { secrets: unknown }).secrets = originalSecrets;
  });

  test('keeps ordinary own-data Error UX while rejecting accessors and Error Proxies', () => {
    expect(renderTopLevelError(new Error('ordinary internal failure'))).toBe(
      'Error: ordinary internal failure'
    );
    expect(renderTopLevelError('primitive failure')).toBe(
      'Error: primitive failure'
    );

    const long = 'x'.repeat(20_000);
    const bounded = renderTopLevelError(long);
    expect(bounded.length).toBe('Error: '.length + 16_384);
    expect(bounded.endsWith('...')).toBe(true);

    let reads = 0;
    const accessor = new Error('discarded');
    Object.defineProperty(accessor, 'message', {
      get() {
        reads += 1;
        return 'SECRET-ACCESSOR';
      },
    });
    const proxied = new Proxy(new Error('SECRET-PROXY'), {
      get() {
        reads += 1;
        throw new Error('SECRET-GET');
      },
      getOwnPropertyDescriptor() {
        reads += 1;
        throw new Error('SECRET-DESCRIPTOR');
      },
      getPrototypeOf() {
        reads += 1;
        throw new Error('SECRET-PROTOTYPE');
      },
    });
    expect(renderTopLevelError(accessor)).toBe('Error: Unknown error occurred');
    expect(renderTopLevelError(proxied)).toBe('Error: Unknown error occurred');
    expect(reads).toBe(0);
  });

  test('top-level rendering exposes only fixed keyring diagnostics', async () => {
    const credential = 'CLI_RAW_CREDENTIAL_VALUE_55e1';
    const rawName = 'CLI_RAW_KEY_NAME_247b';
    const rawIndex = '{"secret":"CLI_RAW_INDEX_VALUE_3a9c"}';
    const fixture = maliciousBackendFailure([credential, rawName, rawIndex]);
    (Bun as unknown as { secrets: unknown }).secrets = {
      async get() {
        return null;
      },
      async set() {
        throw fixture.failure;
      },
      async delete() {
        return false;
      },
    };
    const keyringError = await setSecret('jira', credential).catch(
      (error: unknown) => error
    );
    const rendered = renderTopLevelError(
      new AuthProviderOperationError({
        pluginId: 'aide-jira',
        providerId: 'jira',
        operation: 'login',
        cause: keyringError,
      })
    );
    expect(rendered).toContain("Couldn't access the system keyring");
    for (const secret of [
      ...backendFailureSentinels,
      credential,
      rawName,
      rawIndex,
    ]) {
      expect(rendered).not.toContain(secret);
    }
    expect(fixture.getterReads()).toBe(0);
  });
});
