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

  test('maps built-in providers to legacy secret names', () => {
    expect(legacyAuthSecretName('jira')).toBe('jira');
    expect(legacyAuthSecretName('azure-devops')).toBe('ado');
    expect(legacyAuthSecretName('ado')).toBe('ado');
    expect(legacyAuthSecretName('github')).toBe('github');
    expect(legacyAuthSecretName('custom-provider')).toBeNull();
  });

  test('selects legacy targets when scope is omitted', () => {
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
  });

  test('uses exactly the legacy candidate for omitted Jira and GitHub scopes', () => {
    expect(authSecretCandidates('jira', undefined)).toEqual([
      { name: 'jira', kind: 'legacy', providerId: 'jira' },
    ]);
    expect(authSecretCandidates('github', undefined)).toEqual([
      { name: 'github', kind: 'legacy', providerId: 'github' },
    ]);
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

  test('uses only the scoped candidate for a valid Azure DevOps scope', () => {
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

  test('rejects explicit invalid or incomplete Jira scopes', () => {
    const invalidScopes = [
      { host: 'example.atlassian.net' },
      { account: 'dev@example.com' },
      { host: '   ', account: 'dev@example.com' },
      { host: 'example.atlassian.net', account: '   ' },
      {},
    ];

    for (const scope of invalidScopes) {
      expect(normalizeAuthStoreScope('jira', scope)).toBeNull();
      expect(authSecretCandidates('jira', scope)).toEqual([]);
      expect(authSecretTarget('jira', scope)).toBeNull();
    }
  });

  test('rejects explicit invalid or incomplete GitHub scopes', () => {
    const invalidScopes = [
      { host: 'not a host' },
      { host: 'https://' },
      { host: '   ' },
      {},
    ];

    for (const scope of invalidScopes) {
      expect(normalizeAuthStoreScope('github', scope)).toBeNull();
      expect(authSecretCandidates('github', scope)).toEqual([]);
      expect(authSecretTarget('github', scope)).toBeNull();
    }
  });

  test('rejects mismatched provider tags while retaining canonical aliases and generic external scopes', () => {
    const jiraScope = {
      providerId: 'github',
      host: 'example.atlassian.net',
      account: 'dev@example.com',
    };
    expect(normalizeAuthStoreScope('jira', jiraScope)).toBeNull();
    expect(authSecretCandidates('jira', jiraScope)).toEqual([]);
    expect(authSecretTarget('jira', jiraScope)).toBeNull();

    expect(
      normalizeAuthStoreScope('azure-devops', {
        providerId: 'ADO',
        host: 'dev.azure.com',
        org: 'acme',
      })
    ).toMatchObject({ providerId: 'azure-devops', org: 'acme' });

    const externalScope = {
      providerId: 'external-auth',
      host: 'auth.example.com',
    };
    expect(authSecretTarget('external-auth', externalScope)).toMatchObject({
      name: 'auth:external-auth:host:auth.example.com',
      kind: 'scoped',
    });
    expect(
      authSecretTarget('external-auth', {
        ...externalScope,
        providerId: 'other-auth',
      })
    ).toBeNull();
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

  test('builds GitHub custom-domain host-only and host-account scoped keys', () => {
    expect(scopedAuthSecretName('github', { host: 'github.example.com' })).toBe(
      'auth:github:host:github.example.com'
    );
    expect(scopedAuthSecretName('github', { host: 'ssh.github.com' })).toBe(
      'auth:github:host:github.com'
    );
    expect(scopedAuthSecretName('github', { host: 'ssh.acme.ghe.com' })).toBe(
      'auth:github:host:acme.ghe.com'
    );
    expect(scopedAuthSecretName('github', { host: 'ssh.corp.example' })).toBe(
      'auth:github:host:ssh.corp.example'
    );
    expect(scopedAuthSecretName('github', { host: 'ssh.github.com:443' })).toBe(
      'auth:github:host:ssh.github.com%3A443'
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

  test('uses only the scoped candidate for a valid Jira scope', () => {
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
    ]);
    expect(
      authSecretCandidates('jira', { host: 'example.atlassian.net' })
    ).toEqual([]);
    expect(
      authSecretTarget('jira', {
        host: 'example.atlassian.net',
        account: 'dev@example.com',
      })
    ).toMatchObject({
      name: 'auth:jira:host:example.atlassian.net:account:dev%40example.com',
      kind: 'scoped',
    });
  });

  test('uses only the scoped candidate for a valid custom-domain GitHub scope', () => {
    const candidates = authSecretCandidates('GitHub', {
      host: 'HTTPS://GITHUB.EXAMPLE.COM/team/repo',
    });

    expect(candidates).toEqual([
      {
        name: 'auth:github:host:github.example.com',
        kind: 'scoped',
        providerId: 'github',
        scope: { providerId: 'github', host: 'github.example.com' },
      },
    ]);
    expect(authSecretTarget('GitHub', { host: 'github.example.com' })).toEqual(
      candidates[0]!
    );
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

  test('resolves the exact scoped key when legacy is also populated', async () => {
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

  test('missing explicit Jira, ADO, and GitHub scoped secrets never resolve populated legacy secrets', async () => {
    store.set('aide:jira', 'legacy-jira');
    store.set('aide:ado', 'legacy-ado');
    store.set('aide:github', 'legacy-github');

    const cases = [
      {
        providerId: 'jira' as const,
        scope: {
          host: 'example.atlassian.net',
          account: 'dev@example.com',
        },
      },
      {
        providerId: 'ado' as const,
        scope: { host: 'dev.azure.com', org: 'acme' },
      },
      {
        providerId: 'github' as const,
        scope: { host: 'github.example.com' },
      },
    ] as const;

    for (const { providerId, scope } of cases) {
      expect(
        await Effect.runPromise(resolveAuthSecret(providerId, scope))
      ).toBeNull();
      expect(
        await Effect.runPromise(listAuthSecrets(providerId, scope))
      ).toEqual([]);
    }
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

  test('invalid explicit Jira and GitHub scopes cannot access or mutate legacy secrets', async () => {
    store.set('aide:jira', 'legacy-jira');
    store.set('aide:github', 'legacy-github');

    const cases = [
      {
        providerId: 'jira' as const,
        scope: { host: 'example.atlassian.net' },
        legacyName: 'jira',
        legacyValue: 'legacy-jira',
      },
      {
        providerId: 'github' as const,
        scope: { host: 'not a host' },
        legacyName: 'github',
        legacyValue: 'legacy-github',
      },
    ];

    for (const { providerId, scope, legacyName, legacyValue } of cases) {
      expect(
        await Effect.runPromise(resolveAuthSecret(providerId, scope))
      ).toBeNull();
      expect(
        await Effect.runPromise(listAuthSecrets(providerId, scope))
      ).toEqual([]);
      await expect(
        Effect.runPromise(writeAuthSecret(providerId, 'replacement', scope))
      ).rejects.toThrow(/cannot build an auth secret key/i);
      await expect(
        Effect.runPromise(deleteAuthSecret(providerId, scope))
      ).rejects.toThrow(/cannot build an auth secret key/i);
      expect(stored(legacyName)).toBe(legacyValue);
    }
  });

  test('writes scoped credentials to the exact expected secret name', async () => {
    const target = await Effect.runPromise(
      writeAuthSecret('github', 'token', {
        host: 'github.example.com',
        account: 'octocat',
      })
    );

    expect(target).toMatchObject({
      name: 'auth:github:host:github.example.com:account:octocat',
      kind: 'scoped',
      providerId: 'github',
    });
    expect(stored('auth:github:host:github.example.com:account:octocat')).toBe(
      'token'
    );
    expect(stored('github')).toBeUndefined();
  });

  test('GitHub custom ssh hosts and deliberate ports retain distinct read/write/delete identities', async () => {
    const cases = [
      {
        scope: { host: 'ssh.corp.example' },
        name: 'auth:github:host:ssh.corp.example',
        value: 'ssh-custom',
      },
      {
        scope: { host: 'corp.example' },
        name: 'auth:github:host:corp.example',
        value: 'custom',
      },
      {
        scope: { host: 'ssh.github.com:443' },
        name: 'auth:github:host:ssh.github.com%3A443',
        value: 'ssh-port',
      },
      {
        scope: { host: 'github.com:443' },
        name: 'auth:github:host:github.com%3A443',
        value: 'port',
      },
    ] as const;

    for (const testCase of cases) {
      const target = await Effect.runPromise(
        writeAuthSecret('github', testCase.value, testCase.scope)
      );
      expect(target.name).toBe(testCase.name);
      expect(
        await Effect.runPromise(resolveAuthSecret('github', testCase.scope))
      ).toMatchObject({ name: testCase.name, value: testCase.value });
    }

    expect(
      await Effect.runPromise(deleteAuthSecret('github', cases[0]!.scope))
    ).toBe(true);
    expect(stored(cases[0]!.name)).toBeUndefined();
    expect(stored(cases[1]!.name)).toBe('custom');

    expect(
      await Effect.runPromise(deleteAuthSecret('github', cases[2]!.scope))
    ).toBe(true);
    expect(stored(cases[2]!.name)).toBeUndefined();
    expect(stored(cases[3]!.name)).toBe('port');
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
