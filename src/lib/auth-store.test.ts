import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Effect } from 'effect';

import {
  authSecretCandidates,
  authSecretTarget,
  deleteAuthSecret,
  legacyAuthSecretName,
  listAuthSecrets,
  normalizeAuthProviderId,
  normalizeAuthStoreScope,
  resolveAuthSecret,
  resolveAuthSecretPromise,
  scopedAuthSecretName,
  writeAuthSecret,
} from './auth-store.js';
import { KeyringUnavailableError } from './secrets.js';
import { installMockSecrets, type Store } from './test-helpers.js';

describe('auth-store key construction', () => {
  test('normalizes built-in provider ids and keeps custom ids stable', () => {
    expect(normalizeAuthProviderId(' jira ')).toBe('jira');
    expect(normalizeAuthProviderId('ADO')).toBe('azure-devops');
    expect(normalizeAuthProviderId('Azure-DevOps')).toBe('azure-devops');
    expect(normalizeAuthProviderId('GitHub')).toBe('github');
    expect(normalizeAuthProviderId('custom-provider')).toBe('custom-provider');
    expect(normalizeAuthProviderId('   ')).toBeUndefined();
  });

  test('maps built-in providers to legacy fallback secret names', () => {
    expect(legacyAuthSecretName('jira')).toBe('jira');
    expect(legacyAuthSecretName('azure-devops')).toBe('ado');
    expect(legacyAuthSecretName('ado')).toBe('ado');
    expect(legacyAuthSecretName('github')).toBe('github');
    expect(legacyAuthSecretName('custom-provider')).toBeNull();
  });

  test('selects legacy targets when no deterministic scope is available', () => {
    expect(authSecretTarget('jira', undefined)).toEqual({
      name: 'jira',
      kind: 'legacy',
      providerId: 'jira',
    });
    expect(authSecretTarget('azure-devops', undefined)).toEqual({
      name: 'ado',
      kind: 'legacy',
      providerId: 'azure-devops',
    });
    expect(authSecretTarget('github', undefined)).toEqual({
      name: 'github',
      kind: 'legacy',
      providerId: 'github',
    });
    expect(authSecretTarget('jira', { host: 'example.atlassian.net' })).toEqual(
      {
        name: 'jira',
        kind: 'legacy',
        providerId: 'jira',
      }
    );
  });

  test('uses exactly the legacy candidate when Azure DevOps scope is omitted', () => {
    expect(authSecretCandidates('azure-devops', undefined)).toEqual([
      {
        name: 'ado',
        kind: 'legacy',
        providerId: 'azure-devops',
      },
    ]);
  });

  test('uses scoped then legacy candidates for a valid Azure DevOps scope', () => {
    expect(
      authSecretCandidates('ado', {
        host: 'Acme.VisualStudio.com',
      })
    ).toEqual([
      {
        name: 'auth:azure-devops:host:dev.azure.com:org:acme',
        kind: 'scoped',
        providerId: 'azure-devops',
        scope: {
          providerId: 'azure-devops',
          host: 'dev.azure.com',
          org: 'acme',
        },
      },
      {
        name: 'ado',
        kind: 'legacy',
        providerId: 'azure-devops',
      },
    ]);
  });

  test('rejects explicit invalid or incomplete Azure DevOps scopes', () => {
    const invalidScopes = [
      { host: 'ado.example.com', org: 'acme' },
      { host: 'acme.visualstudio.com', org: 'other' },
      { host: 'dev.azure.com' },
      { id: 'dev.azure.com' },
      { host: '   ', org: 'acme' },
      {},
    ];

    for (const scope of invalidScopes) {
      expect(normalizeAuthStoreScope('ado', scope)).toBeNull();
      expect(authSecretCandidates('ado', scope)).toEqual([]);
      expect(authSecretTarget('ado', scope)).toBeNull();
    }
  });

  test('builds Jira host and account scoped keys', () => {
    expect(
      scopedAuthSecretName('jira', {
        host: 'example.atlassian.net',
        account: 'dev@example.com',
      })
    ).toBe('auth:jira:host:example.atlassian.net:account:dev%40example.com');
  });

  test('builds Azure DevOps host and org scoped keys', () => {
    expect(
      scopedAuthSecretName('azure-devops', {
        host: 'dev.azure.com',
        org: 'acme',
      })
    ).toBe('auth:azure-devops:host:dev.azure.com:org:acme');
  });

  test('canonicalizes Azure DevOps legacy hosts and mixed-case orgs', () => {
    const expected = 'auth:azure-devops:host:dev.azure.com:org:acme';

    expect(
      scopedAuthSecretName('azure-devops', {
        host: ' Acme.VisualStudio.com ',
      })
    ).toBe(expected);
    expect(
      scopedAuthSecretName('azure-devops', {
        host: 'DEV.AZURE.COM',
        org: ' AcMe ',
      })
    ).toBe(expected);
    expect(
      scopedAuthSecretName('azure-devops', {
        host: 'https://dev.azure.com/ACME',
      })
    ).toBe(expected);
    expect(
      scopedAuthSecretName('azure-devops', {
        host: 'ado.example.com',
        org: 'acme',
      })
    ).toBeNull();
    expect(
      scopedAuthSecretName('azure-devops', {
        host: 'acme.visualstudio.com',
        org: 'other',
      })
    ).toBeNull();
  });

  test('builds GitHub Enterprise host-only and host-account scoped keys', () => {
    expect(scopedAuthSecretName('github', { host: 'ghe.example.com' })).toBe(
      'auth:github:host:ghe.example.com'
    );
    expect(
      scopedAuthSecretName('github', {
        host: 'acme.ghe.com',
        account: 'octocat',
      })
    ).toBe('auth:github:host:acme.ghe.com:account:octocat');
  });

  test('normalizes scope fields and encodes unsafe key characters', () => {
    expect(
      normalizeAuthStoreScope('ADO', {
        host: ' HTTPS://DEV.AZURE.COM ',
        org: ' My Org/Team:One ',
      })
    ).toEqual({
      providerId: 'azure-devops',
      host: 'dev.azure.com',
      org: 'my org/team:one',
    });
    expect(
      scopedAuthSecretName('ADO', {
        host: ' HTTPS://DEV.AZURE.COM ',
        org: ' My Org/Team:One ',
      })
    ).toBe('auth:azure-devops:host:dev.azure.com:org:my%20org%2Fteam%3Aone');
  });

  test('orders scoped candidate before legacy fallback', () => {
    expect(
      authSecretCandidates('jira', {
        host: 'example.atlassian.net',
        account: 'dev@example.com',
      })
    ).toEqual([
      {
        name: 'auth:jira:host:example.atlassian.net:account:dev%40example.com',
        kind: 'scoped',
        providerId: 'jira',
        scope: {
          providerId: 'jira',
          host: 'example.atlassian.net',
          account: 'dev@example.com',
        },
      },
      {
        name: 'jira',
        kind: 'legacy',
        providerId: 'jira',
      },
    ]);
    expect(
      authSecretCandidates('jira', { host: 'example.atlassian.net' })
    ).toEqual([
      {
        name: 'jira',
        kind: 'legacy',
        providerId: 'jira',
      },
    ]);
  });
});

describe('auth-store keyring helpers', () => {
  let store: Store;
  let restoreSecrets: () => void;
  let previousServiceOverride: string | undefined;

  beforeEach(() => {
    previousServiceOverride = Bun.env.AIDE_SECRET_SERVICE_OVERRIDE;
    Bun.env.AIDE_SECRET_SERVICE_OVERRIDE = 'aide';
    store = new Map();
    restoreSecrets = installMockSecrets(store);
  });

  afterEach(() => {
    restoreSecrets();
    if (previousServiceOverride === undefined) {
      delete Bun.env.AIDE_SECRET_SERVICE_OVERRIDE;
    } else {
      Bun.env.AIDE_SECRET_SERVICE_OVERRIDE = previousServiceOverride;
    }
  });

  function stored(name: string): string | undefined {
    return store.get(`aide:${name}`);
  }

  test('resolves scoped key before legacy fallback', async () => {
    store.set(
      'aide:auth:jira:host:example.atlassian.net:account:dev%40example.com',
      'scoped'
    );
    store.set('aide:jira', 'legacy');

    const resolved = await Effect.runPromise(
      resolveAuthSecret('jira', {
        host: 'example.atlassian.net',
        account: 'dev@example.com',
      })
    );

    expect(resolved).toMatchObject({
      name: 'auth:jira:host:example.atlassian.net:account:dev%40example.com',
      kind: 'scoped',
      value: 'scoped',
    });
  });

  test('falls back to legacy when scoped key is missing', async () => {
    store.set('aide:jira', 'legacy');

    const resolved = await Effect.runPromise(
      resolveAuthSecret('jira', {
        host: 'example.atlassian.net',
        account: 'dev@example.com',
      })
    );

    expect(resolved).toMatchObject({
      name: 'jira',
      kind: 'legacy',
      value: 'legacy',
    });
  });

  test('writes and resolves Azure DevOps credentials across legacy and canonical scope forms', async () => {
    await Effect.runPromise(
      writeAuthSecret('azure-devops', 'scoped', {
        host: 'Acme.VisualStudio.com',
      })
    );

    const resolved = await resolveAuthSecretPromise('azure-devops', {
      host: 'dev.azure.com',
      org: 'ACME',
    });

    expect(resolved).toMatchObject({
      name: 'auth:azure-devops:host:dev.azure.com:org:acme',
      kind: 'scoped',
      value: 'scoped',
    });
  });

  test('Promise auth resolution preserves typed keyring failures', async () => {
    const restoreFailure = installMockSecrets(store, 'get');
    try {
      await expect(
        resolveAuthSecretPromise('azure-devops', {
          host: 'dev.azure.com',
          org: 'acme',
        })
      ).rejects.toBeInstanceOf(KeyringUnavailableError);
    } finally {
      restoreFailure();
    }
  });

  test('invalid explicit Azure DevOps scopes cannot access or mutate the legacy secret', async () => {
    store.set('aide:ado', 'legacy');
    const invalidScopes = [
      { host: 'ado.example.com', org: 'acme' },
      { host: 'acme.visualstudio.com', org: 'other' },
      { host: 'dev.azure.com' },
      { id: 'dev.azure.com' },
      { host: '   ', org: 'acme' },
      {},
    ];

    for (const scope of invalidScopes) {
      expect(
        await Effect.runPromise(resolveAuthSecret('ado', scope))
      ).toBeNull();
      expect(await Effect.runPromise(listAuthSecrets('ado', scope))).toEqual(
        []
      );
      await expect(
        Effect.runPromise(writeAuthSecret('ado', 'replacement', scope))
      ).rejects.toThrow(/cannot build an auth secret key/i);
      await expect(
        Effect.runPromise(deleteAuthSecret('ado', scope))
      ).rejects.toThrow(/cannot build an auth secret key/i);
      expect(store.get('aide:ado')).toBe('legacy');
    }
  });

  test('uses legacy only when no deterministic scope can be built', async () => {
    store.set('aide:jira', 'legacy');

    const resolved = await Effect.runPromise(
      resolveAuthSecret('jira', { host: 'example.atlassian.net' })
    );

    expect(resolved).toMatchObject({
      name: 'jira',
      kind: 'legacy',
      value: 'legacy',
    });
    expect(store.has('aide:auth:jira:host:example.atlassian.net')).toBe(false);
  });

  test('writes scoped credentials to the exact expected secret name', async () => {
    const target = await Effect.runPromise(
      writeAuthSecret('github', 'token', {
        host: 'ghe.example.com',
        account: 'octocat',
      })
    );

    expect(target).toMatchObject({
      name: 'auth:github:host:ghe.example.com:account:octocat',
      kind: 'scoped',
      providerId: 'github',
    });
    expect(stored('auth:github:host:ghe.example.com:account:octocat')).toBe(
      'token'
    );
    expect(stored('github')).toBeUndefined();
  });

  test('writes legacy credentials when scope is absent', async () => {
    const target = await Effect.runPromise(writeAuthSecret('github', 'token'));

    expect(target).toEqual({
      name: 'github',
      kind: 'legacy',
      providerId: 'github',
    });
    expect(stored('github')).toBe('token');
  });

  test('deletes scoped credentials by exact expected secret name', async () => {
    store.set('aide:auth:azure-devops:host:dev.azure.com:org:acme', 'scoped');
    store.set('aide:ado', 'legacy');

    const removed = await Effect.runPromise(
      deleteAuthSecret('azure-devops', {
        host: 'Acme.VisualStudio.com',
      })
    );

    expect(removed).toBe(true);
    expect(
      stored('auth:azure-devops:host:dev.azure.com:org:acme')
    ).toBeUndefined();
    expect(stored('ado')).toBe('legacy');
  });
});
