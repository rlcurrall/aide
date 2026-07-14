import { beforeEach, describe, expect, test } from 'bun:test';
import { chmod, lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect } from 'effect';

import {
  AUTH_INDEX_VERSION,
  AuthIndexConsistencyError,
  AuthIndexDocumentError,
  AuthIndexProviderError,
  AuthSecretReferenceError,
  AuthStoreValidationError,
  authIndexSecretName,
  authSecretCandidates,
  authSecretTarget,
  deleteAuthSecretEffect as deleteAuthSecretCore,
  isWellFormedUtf16,
  listAuthSecretsEffect as listAuthSecretsCore,
  listIndexedAuthScopesEffect as listIndexedAuthScopesCore,
  normalizeAuthStoreScope,
  readAuthSecretEffect as readAuthSecretCore,
  resolveAuthSecretEffect as resolveAuthSecretCore,
  resolveAuthSecretPromise as resolveAuthSecretLivePromise,
  scopedAuthSecretName,
  writeAuthSecretEffect as writeAuthSecretCore,
  type AuthProviderId,
} from './auth-store.js';
import { KeyringService, KeyringUnavailableError } from './auth-keyring.js';
import {
  makeTestKeyring,
  type TestKeyring,
  type TestKeyringCall as SecretCall,
  type TestKeyringOptions as MockSecretsOptions,
} from './auth-keyring.test-helper.js';
import {
  backendFailureSentinels,
  exportedErrorText,
  maliciousBackendFailure,
  type MaliciousFailureFixture,
} from './error-redaction.test-helper.js';

describe('provider-scoped auth index', () => {
  let store: Map<string, string>;
  let keyring: TestKeyring;

  beforeEach(() => {
    store = new Map();
    keyring = makeTestKeyring(store);
  });

  function provideKeyring<A, E>(
    effect: Effect.Effect<A, E, KeyringService>
  ): Effect.Effect<A, E> {
    return effect.pipe(Effect.provide(keyring.layer));
  }

  const deleteAuthSecret = (...args: Parameters<typeof deleteAuthSecretCore>) =>
    provideKeyring(deleteAuthSecretCore(...args));
  const listAuthSecrets = (...args: Parameters<typeof listAuthSecretsCore>) =>
    provideKeyring(listAuthSecretsCore(...args));
  const listIndexedAuthScopes = (
    ...args: Parameters<typeof listIndexedAuthScopesCore>
  ) => provideKeyring(listIndexedAuthScopesCore(...args));
  const readAuthSecret = (...args: Parameters<typeof readAuthSecretCore>) =>
    provideKeyring(readAuthSecretCore(...args));
  const resolveAuthSecret = (
    ...args: Parameters<typeof resolveAuthSecretCore>
  ) => provideKeyring(resolveAuthSecretCore(...args));
  const writeAuthSecret = (...args: Parameters<typeof writeAuthSecretCore>) =>
    provideKeyring(writeAuthSecretCore(...args));
  const listIndexedAuthScopesPromise = async (
    ...args: Parameters<typeof listIndexedAuthScopesCore>
  ) => {
    const result = await Effect.runPromise(
      Effect.either(listIndexedAuthScopes(...args))
    );
    if (result._tag === 'Left') throw result.left;
    return result.right;
  };

  function stored(name: string): string | undefined {
    return store.get(`aide:${name}`);
  }

  function indexDocument(providerId: string): Record<string, unknown> {
    const raw = stored(authIndexSecretName(providerId));
    if (raw === undefined) throw new Error('expected an index document');
    return JSON.parse(raw) as Record<string, unknown>;
  }

  function indexValue(
    providerId: string,
    scopes: readonly Record<string, string>[]
  ): string {
    return JSON.stringify({
      version: AUTH_INDEX_VERSION,
      providerId,
      scopes,
    });
  }

  function replaceSecrets(options: MockSecretsOptions): SecretCall[] {
    return keyring.replace(options);
  }

  function expectSafeExportedError(
    error: Error,
    fixture: MaliciousFailureFixture,
    additionalSecrets: readonly string[]
  ): void {
    const rendered = exportedErrorText(error);
    for (const secret of [...backendFailureSentinels, ...additionalSecrets]) {
      expect(rendered).not.toContain(secret);
    }
    expect(fixture.getterReads()).toBe(0);
  }

  test('uses one deterministic versioned document per canonical provider alias', () => {
    expect(AUTH_INDEX_VERSION).toBe(1);
    expect(authIndexSecretName('ado')).toBe(
      'auth-index:v1:provider:azure-devops'
    );
    expect(authIndexSecretName('Azure-DevOps')).toBe(
      authIndexSecretName('ado')
    );
    expect(authIndexSecretName('GitHub')).toBe('auth-index:v1:provider:github');
    expect(() => authIndexSecretName('   ')).toThrow(/provider/i);
  });

  test('rejects invalid runtime provider ids before keyring or lock I/O', async () => {
    const calls = replaceSecrets({});
    const lockParent = await mkdtemp(join(tmpdir(), 'aide-invalid-provider-'));
    await chmod(lockParent, 0o700);
    const lockRoot = join(lockParent, 'locks');
    const previousLockRoot = Bun.env.AIDE_AUTH_INDEX_LOCK_ROOT;
    Bun.env.AIDE_AUTH_INDEX_LOCK_ROOT = lockRoot;
    const invalidValues: readonly unknown[] = [
      'constructor',
      '__proto__',
      'toString',
      'valueOf',
      'hasOwnProperty',
      'prototype',
      '../provider',
      'provider/name',
      'provider:name',
      'provider\nname',
      'p'.repeat(65),
      undefined,
      null,
      17,
      false,
      {},
      [],
      Symbol('provider'),
      'K',
      'githubK',
      'Ｇithub',
      '\u00a0github',
    ];

    try {
      for (const value of invalidValues) {
        const providerId = value as AuthProviderId;
        expect(
          authSecretTarget(providerId, { host: 'auth.example.com' })
        ).toBeNull();
        expect(() => authIndexSecretName(providerId)).toThrow(
          AuthIndexProviderError
        );

        const effects: readonly Effect.Effect<unknown, unknown, never>[] = [
          listIndexedAuthScopes(providerId),
          listAuthSecrets(providerId),
          readAuthSecret({
            name: 'github',
            kind: 'legacy',
            providerId,
          }),
          resolveAuthSecret(providerId),
          writeAuthSecret(providerId, 'MUST_NOT_WRITE', {
            host: 'auth.example.com',
          }),
          deleteAuthSecret(providerId, { host: 'auth.example.com' }),
        ];
        for (const effect of effects) {
          const result = await Effect.runPromise(Effect.either(effect));
          expect(result._tag).toBe('Left');
          if (result._tag === 'Right') throw new Error('expected invalid id');
          expect(result.left).toBeInstanceOf(AuthIndexProviderError);
        }
      }

      expect(calls).toEqual([]);
      await expect(lstat(lockRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      if (previousLockRoot === undefined) {
        delete Bun.env.AIDE_AUTH_INDEX_LOCK_ROOT;
      } else {
        Bun.env.AIDE_AUTH_INDEX_LOCK_ROOT = previousLockRoot;
      }
      await rm(lockParent, { force: true, recursive: true });
    }
  });

  test('rejects malformed runtime UTF-16 scopes through validation channels before keyring or lock I/O', async () => {
    const calls = replaceSecrets({});
    const lockParent = await mkdtemp(join(tmpdir(), 'aide-invalid-scope-'));
    await chmod(lockParent, 0o700);
    const lockRoot = join(lockParent, 'locks');
    const previousLockRoot = Bun.env.AIDE_AUTH_INDEX_LOCK_ROOT;
    Bun.env.AIDE_AUTH_INDEX_LOCK_ROOT = lockRoot;
    const malformedValues = [
      '\ud800value',
      'val\ud800ue',
      'value\ud800',
      '\udc00value',
      'val\udc00ue',
      'value\udc00',
    ] as const;
    const cases: Array<{
      readonly providerId: AuthProviderId;
      readonly scope: { host?: string; org?: string; account?: string };
    }> = [];

    for (const malformed of malformedValues) {
      cases.push(
        {
          providerId: 'external-auth',
          scope: { host: malformed, org: 'tenant', account: 'person' },
        },
        {
          providerId: 'external-auth',
          scope: {
            host: 'login.example.com',
            org: malformed,
            account: 'person',
          },
        },
        {
          providerId: 'external-auth',
          scope: {
            host: 'login.example.com',
            org: 'tenant',
            account: malformed,
          },
        },
        {
          providerId: 'github',
          scope: { host: `git${malformed}hub.com` },
        },
        {
          providerId: 'github',
          scope: { host: 'github.com', account: malformed },
        },
        {
          providerId: 'jira',
          scope: { host: `jira${malformed}.example.com`, account: 'person' },
        },
        {
          providerId: 'jira',
          scope: { host: 'jira.example.com', account: malformed },
        },
        {
          providerId: 'azure-devops',
          scope: { host: `dev${malformed}.azure.com`, org: 'acme' },
        },
        {
          providerId: 'azure-devops',
          scope: { host: 'dev.azure.com', org: malformed },
        },
        {
          providerId: 'azure-devops',
          scope: {
            host: 'dev.azure.com',
            org: 'acme',
            account: malformed,
          },
        }
      );
    }

    store.set('aide:github', 'LEGACY_MUST_REMAIN');
    store.set(
      'aide:auth-index:v1:provider:github',
      '{"version":1,"providerId":"github","scopes":[]}'
    );
    const originalStore = new Map(store);

    try {
      for (const { providerId, scope } of cases) {
        expect(
          Object.values(scope).some((value) => !isWellFormedUtf16(value))
        ).toBe(true);
        expect(() => normalizeAuthStoreScope(providerId, scope)).not.toThrow();
        expect(normalizeAuthStoreScope(providerId, scope)).toBeNull();
        expect(() => scopedAuthSecretName(providerId, scope)).not.toThrow();
        expect(scopedAuthSecretName(providerId, scope)).toBeNull();
        expect(() => authSecretCandidates(providerId, scope)).not.toThrow();
        expect(authSecretCandidates(providerId, scope)).toEqual([]);
        expect(() => authSecretTarget(providerId, scope)).not.toThrow();
        expect(authSecretTarget(providerId, scope)).toBeNull();

        const constructors = [
          () => resolveAuthSecret(providerId, scope),
          () => listAuthSecrets(providerId, scope),
          () => writeAuthSecret(providerId, 'MUST_NOT_WRITE', scope),
          () => deleteAuthSecret(providerId, scope),
        ] as const;
        for (const construct of constructors) {
          expect(construct).not.toThrow();
          const effect = construct() as Effect.Effect<unknown, unknown, never>;
          const result = await Effect.runPromise(Effect.either(effect));
          expect(result._tag).toBe('Left');
          if (result._tag === 'Right') {
            throw new Error('expected malformed runtime scope rejection');
          }
          expect(result.left).toBeInstanceOf(AuthStoreValidationError);
          expect(result.left).toMatchObject({
            _tag: 'AuthStoreValidationError',
            code: 'invalid-target',
            providerId: providerId === 'ado' ? 'azure-devops' : providerId,
          });
        }
      }

      const compatibilityError = await resolveAuthSecretLivePromise('github', {
        host: 'github.com',
        account: 'octo\ud800cat',
      }).catch((error: unknown) => error);
      expect(compatibilityError).toBeInstanceOf(AuthStoreValidationError);
      expect(compatibilityError).toMatchObject({
        _tag: 'AuthStoreValidationError',
        code: 'invalid-target',
        providerId: 'github',
      });

      expect(calls).toEqual([]);
      expect(store).toEqual(originalStore);
      await expect(lstat(lockRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      if (previousLockRoot === undefined) {
        delete Bun.env.AIDE_AUTH_INDEX_LOCK_ROOT;
      } else {
        Bun.env.AIDE_AUTH_INDEX_LOCK_ROOT = previousLockRoot;
      }
      await rm(lockParent, { force: true, recursive: true });
    }
  });

  test('rejects forged auth secret references before keyring I/O', async () => {
    const calls = replaceSecrets({});
    const invalidProviderIds: readonly unknown[] = [
      undefined,
      null,
      17,
      {},
      'constructor',
      '__proto__',
      'toString',
      'K',
      'githubK',
    ];

    for (const providerId of invalidProviderIds) {
      const result = await Effect.runPromise(
        Effect.either(
          readAuthSecret({
            name: 'github',
            kind: 'legacy',
            providerId,
          } as never)
        )
      );
      expect(result._tag).toBe('Left');
      if (result._tag === 'Right') throw new Error('expected invalid provider');
      expect(result.left).toBeInstanceOf(AuthIndexProviderError);
    }

    const inheritedProvider = Object.assign(
      Object.create({ providerId: 'github' }) as Record<string, unknown>,
      { name: 'github', kind: 'legacy' }
    );
    const forgedReferences: readonly unknown[] = [
      inheritedProvider,
      { providerId: 'github', name: 'jira', kind: 'legacy' },
      { providerId: 'jira', name: 'github', kind: 'legacy' },
      { providerId: 'github', name: 17, kind: 'legacy' },
      { providerId: 'github', name: 'github', kind: 'scoped' },
      {
        providerId: 'github',
        name: 'auth:github:host:evil.example',
        kind: 'scoped',
        scope: { providerId: 'github', host: 'github.com' },
      },
      {
        providerId: 'github',
        name: 'auth:github:host:github.com',
        kind: 'scoped',
        scope: { providerId: 'jira', host: 'github.com' },
      },
    ];

    for (const reference of forgedReferences) {
      const result = await Effect.runPromise(
        Effect.either(readAuthSecret(reference as never))
      );
      expect(result._tag).toBe('Left');
      if (result._tag === 'Right') throw new Error('expected forged reference');
      expect(result.left).toBeInstanceOf(AuthSecretReferenceError);
    }

    expect(calls).toEqual([]);
  });

  test('canonicalizes valid legacy, scoped, alias, and external references', async () => {
    const calls = replaceSecrets({});
    store.set('aide:ado', 'LEGACY');
    store.set(
      'aide:auth:azure-devops:host:dev.azure.com:org:acme',
      'ADO_SCOPED'
    );
    store.set('aide:auth:acme.auth_v2:host:auth.example.com', 'EXTERNAL');

    await expect(
      Effect.runPromise(
        readAuthSecret({
          name: 'ado',
          kind: 'legacy',
          providerId: ' ADO ',
        })
      )
    ).resolves.toEqual({
      name: 'ado',
      kind: 'legacy',
      providerId: 'azure-devops',
      value: 'LEGACY',
    });

    await expect(
      Effect.runPromise(
        readAuthSecret({
          name: 'auth:azure-devops:host:dev.azure.com:org:acme',
          kind: 'scoped',
          providerId: 'aDo',
          scope: { host: 'Acme.VisualStudio.com', providerId: 'ADO' },
        })
      )
    ).resolves.toMatchObject({
      name: 'auth:azure-devops:host:dev.azure.com:org:acme',
      kind: 'scoped',
      providerId: 'azure-devops',
      scope: {
        providerId: 'azure-devops',
        host: 'dev.azure.com',
        org: 'acme',
      },
      value: 'ADO_SCOPED',
    });

    await expect(
      Effect.runPromise(
        readAuthSecret({
          name: 'auth:acme.auth_v2:host:auth.example.com',
          kind: 'scoped',
          providerId: ' Acme.Auth_v2 ',
          scope: {
            providerId: 'Acme.Auth_v2',
            host: 'AUTH.EXAMPLE.COM',
          },
        })
      )
    ).resolves.toMatchObject({
      name: 'auth:acme.auth_v2:host:auth.example.com',
      kind: 'scoped',
      providerId: 'acme.auth_v2',
      value: 'EXTERNAL',
    });

    expect(calls).toEqual([
      { operation: 'get', name: 'ado' },
      {
        operation: 'get',
        name: 'auth:azure-devops:host:dev.azure.com:org:acme',
      },
      {
        operation: 'get',
        name: 'auth:acme.auth_v2:host:auth.example.com',
      },
    ]);
  });

  test('indexes multiple same-host GitHub accounts and GHES hosts in deterministic order', async () => {
    await Effect.runPromise(
      writeAuthSecret('github', 'TOKEN_ZED', {
        host: 'github.com',
        account: 'zed',
      })
    );
    await Effect.runPromise(
      writeAuthSecret('github', 'TOKEN_OCTO', {
        host: 'GitHub.com',
        account: 'OctoCat',
      })
    );
    await Effect.runPromise(
      writeAuthSecret('github', 'TOKEN_GHES', {
        host: 'HTTPS://GHE.Example.com/team/repo',
        account: 'EnterpriseUser',
      })
    );

    const scopes = await listIndexedAuthScopesPromise('GitHub');

    expect(scopes).toEqual([
      {
        providerId: 'github',
        host: 'ghe.example.com',
        account: 'enterpriseuser',
      },
      { providerId: 'github', host: 'github.com', account: 'octocat' },
      { providerId: 'github', host: 'github.com', account: 'zed' },
    ]);
    expect(Object.isFrozen(scopes)).toBe(true);
    for (const scope of scopes) {
      expect(Object.isFrozen(scope)).toBe(true);
      expect(Object.getPrototypeOf(scope)).toBeNull();
    }

    const rawIndex = stored(authIndexSecretName('github'))!;
    expect(rawIndex).not.toContain('TOKEN_');
    expect(rawIndex).not.toContain('secret');
    expect(rawIndex).not.toContain('token');
    expect(rawIndex).not.toContain('credential');
    expect(rawIndex).toBe(
      '{"version":1,"providerId":"github","scopes":[{"providerId":"github","host":"ghe.example.com","account":"enterpriseuser"},{"providerId":"github","host":"github.com","account":"octocat"},{"providerId":"github","host":"github.com","account":"zed"}]}'
    );
    expect(indexDocument('github')).toEqual({
      version: 1,
      providerId: 'github',
      scopes,
    });
  });

  test('returns fresh immutable snapshots rather than mutable internal state', async () => {
    await Effect.runPromise(
      writeAuthSecret('github', 'TOKEN', {
        host: 'github.com',
        account: 'octocat',
      })
    );

    const first = await Effect.runPromise(listIndexedAuthScopes('github'));
    const second = await Effect.runPromise(listIndexedAuthScopes('github'));

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first[0]).not.toBe(second[0]);
    expect(() =>
      (first as Array<unknown>).push({ providerId: 'attacker' })
    ).toThrow();
    expect(() => {
      (first[0] as { host: string }).host = 'attacker.example';
    }).toThrow();
    expect((await listIndexedAuthScopesPromise('github'))[0]?.host).toBe(
      'github.com'
    );
  });

  test('canonicalizes Jira host+account and stores only the identity allowlist', async () => {
    const input = {
      providerId: 'JIRA',
      host: 'HTTPS://Example.Atlassian.Net/some/path',
      account: ' Dev@Example.COM ',
      id: 'prompt-supplied-id',
      label: 'must not persist',
      metadata: { apiToken: 'MUST_NOT_PERSIST' },
    };

    await Effect.runPromise(writeAuthSecret('jira', 'API_TOKEN', input));

    expect(await listIndexedAuthScopesPromise('jira')).toEqual([
      {
        providerId: 'jira',
        host: 'example.atlassian.net',
        account: 'dev@example.com',
      },
    ]);
    const rawIndex = stored(authIndexSecretName('jira'))!;
    expect(rawIndex).not.toContain('prompt-supplied-id');
    expect(rawIndex).not.toContain('must not persist');
    expect(rawIndex).not.toContain('MUST_NOT_PERSIST');
    expect(rawIndex).not.toContain('API_TOKEN');
    const scopes = indexDocument('jira').scopes as ReadonlyArray<
      Record<string, unknown>
    >;
    expect(Object.keys(scopes[0]!)).toEqual(['providerId', 'host', 'account']);
  });

  test('canonicalizes ADO aliases, hosts, and orgs while omitting inert account metadata', async () => {
    await Effect.runPromise(
      writeAuthSecret('ADO', 'PAT', {
        providerId: 'azure-devops',
        host: 'Acme.VisualStudio.com',
        account: ' Build Agent ',
      })
    );

    expect(await listIndexedAuthScopesPromise('azure-devops')).toEqual([
      {
        providerId: 'azure-devops',
        host: 'dev.azure.com',
        org: 'acme',
      },
    ]);
    await expect(
      Effect.runPromise(
        resolveAuthSecret('azure-devops', {
          host: 'dev.azure.com',
          org: 'ACME',
        })
      )
    ).resolves.toMatchObject({
      name: 'auth:azure-devops:host:dev.azure.com:org:acme',
      value: 'PAT',
      scope: {
        providerId: 'azure-devops',
        host: 'dev.azure.com',
        org: 'acme',
      },
    });
    expect(stored(authIndexSecretName('ado'))).toBe(
      stored(authIndexSecretName('azure-devops'))
    );
    expect(stored(authIndexSecretName('ado'))).not.toContain('Build Agent');
  });

  test('deduplicates repeated writes of the exact canonical scope', async () => {
    const scope = { host: 'GitHub.com', account: 'OctoCat' };
    await Effect.runPromise(writeAuthSecret('github', 'OLD', scope));
    await Effect.runPromise(
      writeAuthSecret('GitHub', 'NEW', {
        host: 'https://github.com/org/repo',
        account: 'octocat',
      })
    );

    expect(await listIndexedAuthScopesPromise('github')).toHaveLength(1);
    expect(
      (indexDocument('github').scopes as ReadonlyArray<unknown>).length
    ).toBe(1);
    expect(stored('auth:github:host:github.com:account:octocat')).toBe('NEW');
  });

  test('deletes exactly one indexed scope without disturbing peers', async () => {
    await Effect.runPromise(
      writeAuthSecret('github', 'A', {
        host: 'github.com',
        account: 'alpha',
      })
    );
    await Effect.runPromise(
      writeAuthSecret('github', 'B', {
        host: 'github.com',
        account: 'beta',
      })
    );

    expect(
      await Effect.runPromise(
        deleteAuthSecret('github', {
          host: 'GitHub.com',
          account: 'ALPHA',
        })
      )
    ).toBe(true);

    expect(await listIndexedAuthScopesPromise('github')).toEqual([
      { providerId: 'github', host: 'github.com', account: 'beta' },
    ]);
    expect(stored('auth:github:host:github.com:account:alpha')).toBeUndefined();
    expect(stored('auth:github:host:github.com:account:beta')).toBe('B');
  });

  test('prunes stale entries by checking the reconstructed credential target', async () => {
    const scope = {
      host: 'jira.example.com',
      account: 'dev@example.com',
    };
    await Effect.runPromise(writeAuthSecret('jira', 'TOKEN', scope));
    store.delete(
      'aide:auth:jira:host:jira.example.com:account:dev%40example.com'
    );

    expect(await listIndexedAuthScopesPromise('jira')).toEqual([]);
    expect(indexDocument('jira')).toEqual({
      version: AUTH_INDEX_VERSION,
      providerId: 'jira',
      scopes: [],
    });
  });

  test('removes a stale exact entry even when the credential is already missing', async () => {
    const scope = { host: 'github.com', account: 'ghost' };
    await Effect.runPromise(writeAuthSecret('github', 'TOKEN', scope));
    store.delete('aide:auth:github:host:github.com:account:ghost');

    expect(await Effect.runPromise(deleteAuthSecret('github', scope))).toBe(
      false
    );
    expect(await listIndexedAuthScopesPromise('github')).toEqual([]);
  });

  test('treats an empty credential as live and deletable', async () => {
    const scope = { host: 'github.com', account: 'empty' };
    const credentialName = 'auth:github:host:github.com:account:empty' as const;
    await Effect.runPromise(writeAuthSecret('github', '', scope));

    expect(await listIndexedAuthScopesPromise('github')).toEqual([
      { providerId: 'github', host: 'github.com', account: 'empty' },
    ]);
    expect(stored(credentialName)).toBe('');
    await expect(
      Effect.runPromise(deleteAuthSecret('github', scope))
    ).resolves.toBe(true);
    expect(stored(credentialName)).toBeUndefined();
    expect(indexDocument('github').scopes).toEqual([]);
  });

  test('treats an empty index value as malformed rather than absent', async () => {
    const indexName = authIndexSecretName('github');
    store.set(`aide:${indexName}`, '');

    const result = await Effect.runPromise(
      Effect.either(listIndexedAuthScopes('github'))
    );

    expect(result._tag).toBe('Left');
    if (result._tag === 'Right') throw new Error('expected malformed index');
    expect(result.left).toBeInstanceOf(AuthIndexDocumentError);
    expect(result.left).toMatchObject({
      code: 'malformed-json',
      providerId: 'github',
    });
    expect(stored(indexName)).toBe('');
  });

  test('strictly rejects malformed, foreign, duplicate, and noncanonical documents', async () => {
    const indexName = authIndexSecretName('github');
    const validScope = {
      providerId: 'github',
      host: 'github.com',
      account: 'octocat',
    };
    const malformedDocuments = [
      {
        raw: '{not json TOKEN_SHOULD_NOT_LEAK',
        code: 'malformed-json',
      },
      {
        raw: JSON.stringify({ version: 2, providerId: 'github', scopes: [] }),
        code: 'unsupported-version',
      },
      {
        raw: JSON.stringify({
          version: 1,
          providerId: 'jira',
          scopes: [],
        }),
        code: 'provider-mismatch',
      },
      {
        raw: JSON.stringify({
          version: 1,
          providerId: 'github',
          scopes: [],
          token: 'TOKEN_SHOULD_NOT_LEAK',
        }),
        code: 'invalid-document',
      },
      {
        raw: JSON.stringify({
          version: 1,
          providerId: 'github',
          scopes: [{ ...validScope, secretName: 'attacker-selected-name' }],
        }),
        code: 'invalid-scope',
      },
      {
        raw: JSON.stringify({
          version: 1,
          providerId: 'github',
          scopes: [validScope, validScope],
        }),
        code: 'duplicate-scope',
      },
      {
        raw: JSON.stringify({
          version: 1,
          providerId: 'github',
          scopes: [{ ...validScope, host: 'GitHub.com' }],
        }),
        code: 'noncanonical-scope',
      },
      {
        raw: '{"version":1,"providerId":"github","scopes":[],"__proto__":{}}',
        code: 'invalid-document',
      },
    ];

    for (const { raw, code } of malformedDocuments) {
      store.set(`aide:${indexName}`, raw);
      const result = await Effect.runPromise(
        Effect.either(listIndexedAuthScopes('github'))
      );
      expect(result._tag).toBe('Left');
      if (result._tag === 'Right') throw new Error('expected malformed index');
      expect(result.left).toBeInstanceOf(AuthIndexDocumentError);
      expect(result.left).toMatchObject({ code, providerId: 'github' });
      expect(String(result.left)).not.toContain('TOKEN_SHOULD_NOT_LEAK');
      expect(String(result.left)).not.toContain('attacker-selected-name');
    }
  });

  test('rejects equal and conflicting duplicate members at every object level', async () => {
    const indexName = authIndexSecretName('github');
    const credentialName =
      'auth:github:host:github.com:account:octocat' as const;
    store.set(`aide:${credentialName}`, 'TOKEN');
    const duplicateDocuments = [
      '{"version":1,"version":1,"providerId":"github","scopes":[]}',
      '{"version":2,"version":1,"providerId":"github","scopes":[]}',
      '{"vers\\u0069on":2,"version":1,"providerId":"github","scopes":[]}',
      '{"version":1,"providerId":"github","providerId":"github","scopes":[]}',
      '{"version":1,"providerId":"jira","providerId":"github","scopes":[]}',
      '{"version":1,"providerId":"github","scopes":[],"scopes":[]}',
      '{"version":1,"providerId":"github","scopes":[{"providerId":"github","host":"github.com","account":"octocat"}],"scopes":[]}',
      '{"version":1,"providerId":"github","scopes":[{"providerId":"github","providerId":"github","host":"github.com","account":"octocat"}]}',
      '{"version":1,"providerId":"github","scopes":[{"providerId":"jira","providerId":"github","host":"github.com","account":"octocat"}]}',
      '{"version":1,"providerId":"github","scopes":[{"providerId":"github","host":"github.com","host":"github.com","account":"octocat"}]}',
      '{"version":1,"providerId":"github","scopes":[{"providerId":"github","host":"evil.example","host":"github.com","account":"octocat"}]}',
      '{"version":1,"providerId":"github","scopes":[{"providerId":"github","h\\u006fst":"evil.example","host":"github.com","account":"octocat"}]}',
      '{"version":1,"providerId":"github","scopes":[{"providerId":"github","host":"github.com","account":"octocat","account":"octocat"}]}',
      '{"version":1,"providerId":"github","scopes":[{"providerId":"github","host":"github.com","account":"attacker","account":"octocat"}]}',
    ];

    for (const raw of duplicateDocuments) {
      store.set(`aide:${indexName}`, raw);
      const result = await Effect.runPromise(
        Effect.either(listIndexedAuthScopes('github'))
      );
      expect(result._tag).toBe('Left');
      if (result._tag === 'Right')
        throw new Error('expected duplicate rejection');
      expect(result.left).toBeInstanceOf(AuthIndexDocumentError);
      expect(result.left).toMatchObject({
        code: 'noncanonical-document',
        providerId: 'github',
      });
      expect(stored(indexName)).toBe(raw);
    }
  });

  test('rejects noncanonical ADO index scopes containing inert account metadata', async () => {
    const indexName = authIndexSecretName('azure-devops');
    const raw = indexValue('azure-devops', [
      {
        providerId: 'azure-devops',
        host: 'dev.azure.com',
        org: 'acme',
        account: 'first',
      },
      {
        providerId: 'azure-devops',
        host: 'dev.azure.com',
        org: 'acme',
        account: 'second',
      },
    ]);
    store.set(`aide:${indexName}`, raw);

    const result = await Effect.runPromise(
      Effect.either(listIndexedAuthScopes('azure-devops'))
    );

    expect(result._tag).toBe('Left');
    if (result._tag === 'Right') throw new Error('expected noncanonical scope');
    expect(result.left).toMatchObject({
      code: 'noncanonical-scope',
      providerId: 'azure-devops',
    });
    expect(stored(indexName)).toBe(raw);
  });

  test('rejects equivalent noncanonical JSON byte representations', async () => {
    const indexName = authIndexSecretName('github');
    const credentialNames = [
      'auth:github:host:github.com:account:alpha',
      'auth:github:host:github.com:account:beta',
    ] as const;
    for (const credentialName of credentialNames) {
      store.set(`aide:${credentialName}`, 'TOKEN');
    }
    const scopeAlpha =
      '{"providerId":"github","host":"github.com","account":"alpha"}';
    const scopeBeta =
      '{"providerId":"github","host":"github.com","account":"beta"}';
    const noncanonicalDocuments = [
      '{ "version": 1, "providerId": "github", "scopes": [] }',
      '{"providerId":"github","version":1,"scopes":[]}',
      '{"version":1.0,"providerId":"github","scopes":[]}',
      '{"version":1,"providerId":"git\\u0068ub","scopes":[]}',
      '{"version":1,"providerId":"github","scopes":[]}\n',
      `{"version":1,"providerId":"github","scopes":[${scopeBeta},${scopeAlpha}]}`,
      '{"version":1,"providerId":"github","scopes":[{"host":"github.com","providerId":"github","account":"alpha"}]}',
    ];

    for (const raw of noncanonicalDocuments) {
      store.set(`aide:${indexName}`, raw);
      const result = await Effect.runPromise(
        Effect.either(listIndexedAuthScopes('github'))
      );
      expect(result._tag).toBe('Left');
      if (result._tag === 'Right') {
        throw new Error('expected noncanonical document rejection');
      }
      expect(result.left).toMatchObject({
        code: 'noncanonical-document',
        providerId: 'github',
      });
      expect(stored(indexName)).toBe(raw);
    }
  });

  test('invalid bytes stop list, write, and delete after only the index read', async () => {
    const indexName = authIndexSecretName('github');
    const credentialName =
      'auth:github:host:github.com:account:octocat' as const;
    const raw =
      '{"version":1,"providerId":"RAW_DOCUMENT_SECRET_98af","providerId":"github","scopes":[]}';
    const actions: ReadonlyArray<() => Effect.Effect<unknown, unknown, never>> =
      [
        () => listIndexedAuthScopes('github'),
        () =>
          writeAuthSecret('github', 'NEW_SECRET_VALUE_47cc', {
            host: 'github.com',
            account: 'octocat',
          }),
        () =>
          deleteAuthSecret('github', {
            host: 'github.com',
            account: 'octocat',
          }),
      ];

    for (const action of actions) {
      store.set(`aide:${indexName}`, raw);
      store.set(`aide:${credentialName}`, 'OLD_SECRET_VALUE_f107');
      const calls = replaceSecrets({});

      const result = await Effect.runPromise(Effect.either(action()));

      expect(result._tag).toBe('Left');
      if (result._tag === 'Right') throw new Error('expected corrupt index');
      expect(result.left).toMatchObject({
        code: 'noncanonical-document',
        providerId: 'github',
      });
      expect(exportedErrorText(result.left as Error)).not.toContain(
        'RAW_DOCUMENT_SECRET_98af'
      );
      expect(calls).toEqual([{ operation: 'get', name: indexName }]);
      expect(stored(indexName)).toBe(raw);
      expect(stored(credentialName)).toBe('OLD_SECRET_VALUE_f107');
    }
  });

  test('rejects ill-formed UTF-16 scope text with a bounded error before target reconstruction', async () => {
    const malformedCases = [
      {
        providerId: 'acme.auth_v2',
        scope: {
          providerId: 'acme.auth_v2',
          host: '\ud800login.example.com',
          org: 'tenant',
          account: 'person',
        },
        targetScope: {
          host: 'login.example.com',
          org: 'tenant',
          account: 'person',
        },
        credentialName:
          'auth:acme.auth_v2:host:login.example.com:org:tenant:account:person',
      },
      {
        providerId: 'acme.auth_v2',
        scope: {
          providerId: 'acme.auth_v2',
          host: 'login.example.com\ud800',
          org: 'tenant',
          account: 'person',
        },
        targetScope: {
          host: 'login.example.com',
          org: 'tenant',
          account: 'person',
        },
        credentialName:
          'auth:acme.auth_v2:host:login.example.com:org:tenant:account:person',
      },
      {
        providerId: 'acme.auth_v2',
        scope: {
          providerId: 'acme.auth_v2',
          host: 'login.example.com',
          org: '\udc00RAW_ORG_VALUE_5f23',
          account: 'person',
        },
        targetScope: {
          host: 'login.example.com',
          org: 'tenant',
          account: 'person',
        },
        credentialName:
          'auth:acme.auth_v2:host:login.example.com:org:tenant:account:person',
      },
      {
        providerId: 'acme.auth_v2',
        scope: {
          providerId: 'acme.auth_v2',
          host: 'login.example.com',
          org: 'RAW_ORG_VALUE_5f23\udc00',
          account: 'person',
        },
        targetScope: {
          host: 'login.example.com',
          org: 'tenant',
          account: 'person',
        },
        credentialName:
          'auth:acme.auth_v2:host:login.example.com:org:tenant:account:person',
      },
      {
        providerId: 'acme.auth_v2',
        scope: {
          providerId: 'acme.auth_v2',
          host: 'login.example.com',
          org: 'tenant',
          account: '\ud800RAW_ACCOUNT_VALUE_a41d',
        },
        targetScope: {
          host: 'login.example.com',
          org: 'tenant',
          account: 'person',
        },
        credentialName:
          'auth:acme.auth_v2:host:login.example.com:org:tenant:account:person',
      },
      {
        providerId: 'acme.auth_v2',
        scope: {
          providerId: 'acme.auth_v2',
          host: 'login.example.com',
          org: 'tenant',
          account: 'RAW_ACCOUNT_VALUE_a41d\udc00',
        },
        targetScope: {
          host: 'login.example.com',
          org: 'tenant',
          account: 'person',
        },
        credentialName:
          'auth:acme.auth_v2:host:login.example.com:org:tenant:account:person',
      },
      {
        providerId: 'github',
        scope: {
          providerId: 'github',
          host: 'github.com',
          account: 'octocat\ud800',
        },
        targetScope: { host: 'github.com', account: 'octocat' },
        credentialName: 'auth:github:host:github.com:account:octocat',
      },
      {
        providerId: 'jira',
        scope: {
          providerId: 'jira',
          host: 'jira.example.com',
          account: '\udc00dev@example.com',
        },
        targetScope: {
          host: 'jira.example.com',
          account: 'dev@example.com',
        },
        credentialName:
          'auth:jira:host:jira.example.com:account:dev%40example.com',
      },
      {
        providerId: 'azure-devops',
        scope: {
          providerId: 'azure-devops',
          host: 'dev.azure.com',
          org: 'acme\ud800',
        },
        targetScope: { host: 'dev.azure.com', org: 'acme' },
        credentialName: 'auth:azure-devops:host:dev.azure.com:org:acme',
      },
      {
        providerId: 'github',
        scope: {
          providerId: 'github',
          host: 'git\udc00hub.com',
          account: 'octocat',
        },
        targetScope: { host: 'github.com', account: 'octocat' },
        credentialName: 'auth:github:host:github.com:account:octocat',
      },
    ] as const;

    for (const malformed of malformedCases) {
      const indexName = authIndexSecretName(malformed.providerId);
      const raw = indexValue(malformed.providerId, [malformed.scope]);
      expect(raw).toMatch(/\\u(?:d[89ab][0-9a-f]{2}|d[c-f][0-9a-f]{2})/i);
      const actions: ReadonlyArray<
        () => Effect.Effect<unknown, unknown, never>
      > = [
        () => listIndexedAuthScopes(malformed.providerId),
        () =>
          writeAuthSecret(
            malformed.providerId,
            'NEW_CREDENTIAL_VALUE_22b8',
            malformed.targetScope
          ),
        () => deleteAuthSecret(malformed.providerId, malformed.targetScope),
      ];

      for (const action of actions) {
        store.set(`aide:${indexName}`, raw);
        store.set(
          `aide:${malformed.credentialName}`,
          'OLD_CREDENTIAL_VALUE_8ed1'
        );
        const calls = replaceSecrets({});

        const result = await Effect.runPromise(Effect.either(action()));

        expect(result._tag).toBe('Left');
        if (result._tag === 'Right') {
          throw new Error('expected ill-formed UTF-16 rejection');
        }
        expect(result.left).toBeInstanceOf(AuthIndexDocumentError);
        expect(result.left).toMatchObject({
          code: 'invalid-scope',
          providerId: malformed.providerId,
        });
        expect(exportedErrorText(result.left as Error)).not.toContain(
          'RAW_ORG_VALUE_5f23'
        );
        expect(exportedErrorText(result.left as Error)).not.toContain(
          'RAW_ACCOUNT_VALUE_a41d'
        );
        expect(calls).toEqual([{ operation: 'get', name: indexName }]);
        expect(stored(indexName)).toBe(raw);
        expect(stored(malformed.credentialName)).toBe(
          'OLD_CREDENTIAL_VALUE_8ed1'
        );
      }
    }
  });

  test('accepts a valid surrogate pair in external-provider scope text', async () => {
    const scope = {
      host: 'login.example.com',
      org: 'tenant',
      account: 'person\ud83d\ude00',
    };

    expect(isWellFormedUtf16(scope.account)).toBe(true);

    await Effect.runPromise(
      writeAuthSecret('acme.auth_v2', 'CREDENTIAL', scope)
    );

    expect(await listIndexedAuthScopesPromise('acme.auth_v2')).toEqual([
      { providerId: 'acme.auth_v2', ...scope },
    ]);
    expect(
      stored(
        'auth:acme.auth_v2:host:login.example.com:org:tenant:account:person%F0%9F%98%80'
      )
    ).toBe('CREDENTIAL');
  });

  test('fails closed on malformed input before scoped credential mutation', async () => {
    const indexName = authIndexSecretName('github');
    store.set(`aide:${indexName}`, '{bad');
    store.set('aide:auth:github:host:github.com:account:octocat', 'OLD');

    const writeResult = await Effect.runPromise(
      Effect.either(
        writeAuthSecret('github', 'NEW', {
          host: 'github.com',
          account: 'octocat',
        })
      )
    );
    const deleteResult = await Effect.runPromise(
      Effect.either(
        deleteAuthSecret('github', {
          host: 'github.com',
          account: 'octocat',
        })
      )
    );

    expect(writeResult._tag).toBe('Left');
    expect(deleteResult._tag).toBe('Left');
    if (writeResult._tag === 'Right' || deleteResult._tag === 'Right') {
      throw new Error('expected malformed index failures');
    }
    expect(writeResult.left).toBeInstanceOf(AuthIndexDocumentError);
    expect(deleteResult.left).toBeInstanceOf(AuthIndexDocumentError);

    expect(stored('auth:github:host:github.com:account:octocat')).toBe('OLD');
    expect(stored(indexName)).toBe('{bad');
  });

  test('redacts initial backend failures through Effect and provided service adapters', async () => {
    const secrets = [
      'auth-index:v1:provider:RAW_KEY_NAME_40c1',
      'RAW_CREDENTIAL_VALUE_b594',
      '{"providerId":"RAW_INDEX_DOCUMENT_765b"}',
    ] as const;
    const fixture = maliciousBackendFailure(secrets);
    replaceSecrets({ fail: () => true, rejection: fixture.failure });

    const effectResult = await Effect.runPromise(
      Effect.either(listIndexedAuthScopes('github'))
    );
    expect(effectResult._tag).toBe('Left');
    if (effectResult._tag === 'Right') throw new Error('expected Effect error');
    expect(effectResult.left).toBeInstanceOf(KeyringUnavailableError);
    expect(effectResult.left).toMatchObject({
      operation: 'get',
      classification: 'unavailable',
    });
    expectSafeExportedError(effectResult.left as Error, fixture, secrets);

    const promiseError = await listIndexedAuthScopesPromise('github').catch(
      (error: unknown) => error
    );
    expect(promiseError).toBeInstanceOf(KeyringUnavailableError);
    expectSafeExportedError(promiseError as Error, fixture, secrets);
  });

  test('does not inspect a backend failure when forward verification proves write and delete mutations', async () => {
    const scope = { host: 'github.com', account: 'octocat' };
    const indexName = authIndexSecretName('github');
    const credentialName =
      'auth:github:host:github.com:account:octocat' as const;
    const fixture = maliciousBackendFailure([
      indexName,
      credentialName,
      'FORWARD_CREDENTIAL_VALUE_0942',
    ]);
    replaceSecrets({
      rejection: fixture.failure,
      fail: ({ operation, name }, occurrence) =>
        operation === 'set' && name === indexName && occurrence === 1
          ? 'after'
          : false,
    });

    await expect(
      Effect.runPromise(
        writeAuthSecret('github', 'FORWARD_CREDENTIAL_VALUE_0942', scope)
      )
    ).resolves.toMatchObject({ name: credentialName });

    replaceSecrets({
      rejection: fixture.failure,
      fail: ({ operation, name }, occurrence) =>
        operation === 'delete' && name === credentialName && occurrence === 1
          ? 'after'
          : false,
    });
    await expect(
      Effect.runPromise(deleteAuthSecret('github', scope))
    ).resolves.toBe(true);
    expect(fixture.getterReads()).toBe(0);
  });

  test('redacts consistency failures after failed mutation verification', async () => {
    const indexName = authIndexSecretName('github');
    const credentialName =
      'auth:github:host:github.com:account:octocat' as const;
    const credentialValue = 'CONSISTENCY_CREDENTIAL_VALUE_79d5';
    const indexValueWithSecret =
      '{"version":1,"providerId":"github","secret":"RAW_INDEX_VALUE_d08f"}';
    const secrets = [
      indexName,
      credentialName,
      credentialValue,
      indexValueWithSecret,
    ] as const;
    const fixture = maliciousBackendFailure(secrets);
    replaceSecrets({
      rejection: fixture.failure,
      fail: ({ operation, name }, occurrence) =>
        (operation === 'set' && name === credentialName) ||
        (operation === 'get' && name === credentialName && occurrence === 2),
    });

    const result = await Effect.runPromise(
      Effect.either(
        writeAuthSecret('github', credentialValue, {
          host: 'github.com',
          account: 'octocat',
        })
      )
    );
    expect(result._tag).toBe('Left');
    if (result._tag === 'Right') throw new Error('expected consistency error');
    expect(result.left).toBeInstanceOf(AuthIndexConsistencyError);
    expect(result.left).toMatchObject({
      operation: 'write',
      phase: 'credential-write',
      providerId: 'github',
      rollback: 'succeeded',
      residualState: 'none',
      failure: 'keyring-unavailable',
    });
    expect(
      Object.getOwnPropertyDescriptor(result.left, 'cause')
    ).toBeUndefined();
    expectSafeExportedError(result.left as Error, fixture, secrets);

    const directlyConstructed = new AuthIndexConsistencyError({
      operation: 'write',
      phase: 'credential-write',
      providerId: 'github',
      rollback: 'failed',
      residualState: 'unknown',
      cause: fixture.failure,
    });
    expect(Object.getOwnPropertyDescriptor(directlyConstructed, 'cause')).toBe(
      undefined
    );
    expectSafeExportedError(directlyConstructed, fixture, secrets);
  });

  test('redacts delete consistency failures and never exposes credential or index snapshots', async () => {
    const scope = { host: 'github.com', account: 'octocat' };
    const indexName = authIndexSecretName('github');
    const credentialName =
      'auth:github:host:github.com:account:octocat' as const;
    const credentialValue = 'DELETE_CREDENTIAL_VALUE_1654';
    const rawIndex = indexValue('github', [
      { providerId: 'github', host: 'github.com', account: 'octocat' },
    ]);
    store.set(`aide:${credentialName}`, credentialValue);
    store.set(`aide:${indexName}`, rawIndex);
    const secrets = [indexName, credentialName, credentialValue, rawIndex];
    const fixture = maliciousBackendFailure(secrets);
    replaceSecrets({
      rejection: fixture.failure,
      fail: ({ operation, name }) => operation === 'set' && name === indexName,
    });

    const result = await Effect.runPromise(
      Effect.either(deleteAuthSecret('github', scope))
    );
    expect(result._tag).toBe('Left');
    if (result._tag === 'Right') throw new Error('expected consistency error');
    expect(result.left).toMatchObject({
      operation: 'delete',
      phase: 'index-cleanup',
      failure: 'keyring-unavailable',
    });
    expectSafeExportedError(result.left as Error, fixture, secrets);
  });

  test('redacts rollback, verification, and stale-repair failures', async () => {
    const indexName = authIndexSecretName('github');
    const credentialName =
      'auth:github:host:github.com:account:octocat' as const;
    const secrets = [
      indexName,
      credentialName,
      'ROLLBACK_VALUE_2e19',
      'ROLLBACK_INDEX_VALUE_145f',
    ] as const;
    const rollbackFixture = maliciousBackendFailure(secrets);
    replaceSecrets({
      rejection: rollbackFixture.failure,
      fail: ({ operation, name }, occurrence) =>
        (operation === 'set' && name === credentialName) ||
        (operation === 'get' && name === credentialName && occurrence === 2) ||
        (operation === 'delete' && name === indexName) ||
        (operation === 'get' && name === indexName && occurrence === 2),
    });

    const rollbackResult = await Effect.runPromise(
      Effect.either(
        writeAuthSecret('github', 'ROLLBACK_VALUE_2e19', {
          host: 'github.com',
          account: 'octocat',
        })
      )
    );
    expect(rollbackResult._tag).toBe('Left');
    if (rollbackResult._tag === 'Right') {
      throw new Error('expected rollback error');
    }
    expect(rollbackResult.left).toMatchObject({
      rollback: 'failed',
      residualState: 'unknown',
      failure: 'keyring-unavailable',
    });
    expectSafeExportedError(
      rollbackResult.left as Error,
      rollbackFixture,
      secrets
    );

    store.clear();
    const staleScope = {
      providerId: 'github',
      host: 'github.com',
      account: 'ghost',
    } as const;
    const staleIndex = indexValue('github', [staleScope]);
    store.set(`aide:${indexName}`, staleIndex);
    const repairSecrets = [indexName, staleIndex, 'REPAIR_VALUE_3f6e'];
    const repairFixture = maliciousBackendFailure(repairSecrets);
    replaceSecrets({
      rejection: repairFixture.failure,
      fail: ({ operation, name }, occurrence) =>
        (operation === 'set' && name === indexName) ||
        (operation === 'get' && name === indexName && occurrence === 2),
    });
    const repairResult = await Effect.runPromise(
      Effect.either(listIndexedAuthScopes('github'))
    );
    expect(repairResult._tag).toBe('Left');
    if (repairResult._tag === 'Right') throw new Error('expected repair error');
    expect(repairResult.left).toMatchObject({
      operation: 'repair',
      phase: 'index-cleanup',
      rollback: 'not-needed',
      residualState: 'unknown',
      failure: 'keyring-unavailable',
    });
    expectSafeExportedError(
      repairResult.left as Error,
      repairFixture,
      repairSecrets
    );
  });

  test('rolls back an index update when a new credential write fails', async () => {
    const indexName = authIndexSecretName('github');
    replaceSecrets({
      fail: ({ operation, name }) =>
        operation === 'set' &&
        name === 'auth:github:host:github.com:account:octocat',
    });

    const result = await Effect.runPromise(
      Effect.either(
        writeAuthSecret('github', 'TOKEN', {
          host: 'github.com',
          account: 'octocat',
        })
      )
    );

    expect(result._tag).toBe('Left');
    if (result._tag === 'Right') throw new Error('expected write failure');
    expect(result.left).toBeInstanceOf(AuthIndexConsistencyError);
    expect(result.left).toMatchObject({
      operation: 'write',
      phase: 'credential-write',
      rollback: 'succeeded',
      residualState: 'none',
    });
    expect(stored(indexName)).toBeUndefined();
    expect(
      stored('auth:github:host:github.com:account:octocat')
    ).toBeUndefined();
  });

  test('restores an existing credential when its subsequent index update fails', async () => {
    const credentialName =
      'auth:github:host:github.com:account:octocat' as const;
    store.set(`aide:${credentialName}`, 'OLD');
    replaceSecrets({
      fail: ({ operation, name }) =>
        operation === 'set' && name === authIndexSecretName('github'),
    });

    const result = await Effect.runPromise(
      Effect.either(
        writeAuthSecret('github', 'NEW', {
          host: 'github.com',
          account: 'octocat',
        })
      )
    );

    expect(result._tag).toBe('Left');
    if (result._tag === 'Right') throw new Error('expected index failure');
    expect(result.left).toBeInstanceOf(AuthIndexConsistencyError);
    expect(result.left).toMatchObject({
      operation: 'write',
      phase: 'index-update',
      rollback: 'succeeded',
      residualState: 'none',
    });
    expect(stored(credentialName)).toBe('OLD');
    expect(stored(authIndexSecretName('github'))).toBeUndefined();
  });

  test('restores a deleted credential when index cleanup fails', async () => {
    const scope = { host: 'github.com', account: 'octocat' };
    const credentialName =
      'auth:github:host:github.com:account:octocat' as const;
    await Effect.runPromise(writeAuthSecret('github', 'TOKEN', scope));
    replaceSecrets({
      fail: ({ operation, name }, occurrence) =>
        operation === 'set' &&
        name === authIndexSecretName('github') &&
        occurrence === 1,
    });

    const result = await Effect.runPromise(
      Effect.either(deleteAuthSecret('github', scope))
    );

    expect(result._tag).toBe('Left');
    if (result._tag === 'Right') throw new Error('expected cleanup failure');
    expect(result.left).toBeInstanceOf(AuthIndexConsistencyError);
    expect(result.left).toMatchObject({
      operation: 'delete',
      phase: 'index-cleanup',
      rollback: 'succeeded',
      residualState: 'none',
    });
    expect(stored(credentialName)).toBe('TOKEN');
    expect(await listIndexedAuthScopesPromise('github')).toEqual([
      { providerId: 'github', host: 'github.com', account: 'octocat' },
    ]);
  });

  test('reports an explicit unknown residual when delete rollback also fails', async () => {
    const scope = { host: 'github.com', account: 'octocat' };
    const credentialName =
      'auth:github:host:github.com:account:octocat' as const;
    await Effect.runPromise(writeAuthSecret('github', 'TOKEN', scope));
    replaceSecrets({
      fail: ({ operation, name }, occurrence) =>
        (operation === 'set' &&
          name === authIndexSecretName('github') &&
          occurrence === 1) ||
        (operation === 'set' && name === credentialName),
    });

    const result = await Effect.runPromise(
      Effect.either(deleteAuthSecret('github', scope))
    );

    expect(result._tag).toBe('Left');
    if (result._tag === 'Right') throw new Error('expected rollback failure');
    expect(result.left).toMatchObject({
      operation: 'delete',
      phase: 'index-cleanup',
      rollback: 'failed',
      residualState: 'unknown',
    });
    expect(stored(credentialName)).toBeUndefined();

    replaceSecrets({});
    expect(await listIndexedAuthScopesPromise('github')).toEqual([]);
  });

  test('preserves a keyring failure when stale repair is verified unchanged', async () => {
    const scope = { host: 'github.com', account: 'ghost' };
    await Effect.runPromise(writeAuthSecret('github', 'TOKEN', scope));
    store.delete('aide:auth:github:host:github.com:account:ghost');
    replaceSecrets({
      fail: ({ operation, name }) =>
        operation === 'set' && name === authIndexSecretName('github'),
    });

    const result = await Effect.runPromise(
      Effect.either(listIndexedAuthScopes('github'))
    );

    expect(result._tag).toBe('Left');
    if (result._tag === 'Right') throw new Error('expected repair failure');
    expect(result.left).toBeInstanceOf(KeyringUnavailableError);
    expect(indexDocument('github').scopes).toHaveLength(1);
  });

  test('does not retry an unknown stale-delete cleanup or hide a visible credential insertion', async () => {
    const scope = { host: 'github.com', account: 'ghost' };
    const indexName = authIndexSecretName('github');
    const credentialName = 'auth:github:host:github.com:account:ghost' as const;
    const repairedIndex = indexValue('github', []);
    const thirdIndex = indexValue('github', [
      {
        providerId: 'github',
        host: 'github.com',
        account: 'third',
      },
    ]);

    for (const verificationOutcome of ['read-failure', 'third'] as const) {
      store.clear();
      replaceSecrets({});
      await Effect.runPromise(writeAuthSecret('github', 'TOKEN', scope));
      store.delete(`aide:${credentialName}`);
      const calls = replaceSecrets({
        fail: (call, occurrence) => {
          if (call.operation === 'set' && call.name === indexName) {
            return 'after';
          }
          if (
            call.operation === 'get' &&
            call.name === indexName &&
            occurrence === 2
          ) {
            store.set(`aide:${credentialName}`, 'DIRECT');
            if (verificationOutcome === 'read-failure') return 'before';
            store.set(`aide:${indexName}`, thirdIndex);
          }
          return false;
        },
      });

      const result = await Effect.runPromise(
        Effect.either(deleteAuthSecret('github', scope))
      );

      expect(result._tag).toBe('Left');
      if (result._tag === 'Right') {
        throw new Error('expected unknown stale cleanup');
      }
      expect(result.left).toBeInstanceOf(AuthIndexConsistencyError);
      expect(result.left).toMatchObject({
        operation: 'delete',
        phase: 'index-cleanup',
        rollback: 'not-needed',
        residualState: 'unknown',
      });
      expect(
        calls.filter(
          ({ operation, name }) => operation === 'set' && name === indexName
        )
      ).toEqual([{ operation: 'set', name: indexName, value: repairedIndex }]);
      expect(stored(credentialName)).toBe('DIRECT');
      expect(stored(indexName)).toBe(
        verificationOutcome === 'read-failure' ? repairedIndex : thirdIndex
      );
    }
  });

  test('accepts an initial index creation that applies before rejecting', async () => {
    const indexName = authIndexSecretName('github');
    const credentialName =
      'auth:github:host:github.com:account:octocat' as const;
    const indexValue = JSON.stringify({
      version: AUTH_INDEX_VERSION,
      providerId: 'github',
      scopes: [
        {
          providerId: 'github',
          host: 'github.com',
          account: 'octocat',
        },
      ],
    });
    const calls = replaceSecrets({
      fail: (call) =>
        call.operation === 'set' && call.name === indexName ? 'after' : false,
    });

    await expect(
      Effect.runPromise(
        writeAuthSecret('github', 'TOKEN', {
          host: 'github.com',
          account: 'octocat',
        })
      )
    ).resolves.toMatchObject({ name: credentialName });

    expect(calls).toEqual([
      { operation: 'get', name: indexName },
      { operation: 'get', name: credentialName },
      { operation: 'set', name: indexName, value: indexValue },
      { operation: 'get', name: indexName },
      { operation: 'set', name: credentialName, value: 'TOKEN' },
    ]);
    expect(stored(indexName)).toBe(indexValue);
    expect(stored(credentialName)).toBe('TOKEN');
  });

  test('accepts new credential creation that applies before rejecting', async () => {
    const indexName = authIndexSecretName('github');
    const credentialName =
      'auth:github:host:github.com:account:octocat' as const;
    const calls = replaceSecrets({
      fail: (call) =>
        call.operation === 'set' && call.name === credentialName
          ? 'after'
          : false,
    });

    await Effect.runPromise(
      writeAuthSecret('github', 'TOKEN', {
        host: 'github.com',
        account: 'octocat',
      })
    );

    expect(calls.map(({ operation, name }) => ({ operation, name }))).toEqual([
      { operation: 'get', name: indexName },
      { operation: 'get', name: credentialName },
      { operation: 'set', name: indexName },
      { operation: 'set', name: credentialName },
      { operation: 'get', name: credentialName },
    ]);
    expect(stored(credentialName)).toBe('TOKEN');
    expect(indexDocument('github').scopes).toHaveLength(1);
  });

  test('accepts an indexed credential replacement that applies before rejecting', async () => {
    const scope = { host: 'github.com', account: 'octocat' };
    const indexName = authIndexSecretName('github');
    const credentialName =
      'auth:github:host:github.com:account:octocat' as const;
    await Effect.runPromise(writeAuthSecret('github', 'OLD', scope));
    const calls = replaceSecrets({
      fail: (call) =>
        call.operation === 'set' && call.name === credentialName
          ? 'after'
          : false,
    });

    await Effect.runPromise(writeAuthSecret('github', 'NEW', scope));

    expect(calls).toEqual([
      { operation: 'get', name: indexName },
      { operation: 'get', name: credentialName },
      { operation: 'set', name: credentialName, value: 'NEW' },
      { operation: 'get', name: credentialName },
    ]);
    expect(stored(credentialName)).toBe('NEW');
    expect(indexDocument('github').scopes).toHaveLength(1);
  });

  test('preserves the stale starting pair when an indexed missing credential write is verified unchanged', async () => {
    const indexName = authIndexSecretName('github');
    const credentialName =
      'auth:github:host:github.com:account:octocat' as const;
    const staleIndex = indexValue('github', [
      {
        providerId: 'github',
        host: 'github.com',
        account: 'octocat',
      },
    ]);
    store.set(`aide:${indexName}`, staleIndex);
    const calls = replaceSecrets({
      fail: (call) =>
        call.operation === 'set' && call.name === credentialName
          ? 'before'
          : false,
    });

    const result = await Effect.runPromise(
      Effect.either(
        writeAuthSecret('github', 'TOKEN', {
          host: 'github.com',
          account: 'octocat',
        })
      )
    );

    expect(result._tag).toBe('Left');
    if (result._tag === 'Right') throw new Error('expected write failure');
    expect(result.left).toBeInstanceOf(KeyringUnavailableError);
    expect(result.left).not.toBeInstanceOf(AuthIndexConsistencyError);
    expect(calls).toEqual([
      { operation: 'get', name: indexName },
      { operation: 'get', name: credentialName },
      { operation: 'set', name: credentialName, value: 'TOKEN' },
      { operation: 'get', name: credentialName },
    ]);
    expect(stored(credentialName)).toBeUndefined();
    expect(stored(indexName)).toBe(staleIndex);
  });

  test('repairs a stale indexed creation after its credential verification read fails', async () => {
    const indexName = authIndexSecretName('github');
    const credentialName =
      'auth:github:host:github.com:account:octocat' as const;
    const staleIndex = indexValue('github', [
      {
        providerId: 'github',
        host: 'github.com',
        account: 'octocat',
      },
    ]);
    const repairedIndex = indexValue('github', []);
    store.set(`aide:${indexName}`, staleIndex);
    const calls = replaceSecrets({
      fail: (call, occurrence) => {
        if (call.operation === 'set' && call.name === credentialName) {
          return 'after';
        }
        if (
          call.operation === 'get' &&
          call.name === credentialName &&
          occurrence === 2
        ) {
          return 'before';
        }
        return false;
      },
    });

    const result = await Effect.runPromise(
      Effect.either(
        writeAuthSecret('github', 'TOKEN', {
          host: 'github.com',
          account: 'octocat',
        })
      )
    );

    expect(result._tag).toBe('Left');
    if (result._tag === 'Right') throw new Error('expected consistency error');
    expect(result.left).toBeInstanceOf(AuthIndexConsistencyError);
    expect(result.left).toMatchObject({
      operation: 'write',
      phase: 'credential-write',
      rollback: 'succeeded',
      residualState: 'none',
    });
    expect(calls).toEqual([
      { operation: 'get', name: indexName },
      { operation: 'get', name: credentialName },
      { operation: 'set', name: credentialName, value: 'TOKEN' },
      { operation: 'get', name: credentialName },
      { operation: 'delete', name: credentialName },
      { operation: 'set', name: indexName, value: repairedIndex },
      { operation: 'get', name: credentialName },
      { operation: 'get', name: indexName },
    ]);
    expect(stored(credentialName)).toBeUndefined();
    expect(stored(indexName)).toBe(repairedIndex);
  });

  test('repairs a stale indexed creation after observing a third credential value', async () => {
    const indexName = authIndexSecretName('github');
    const credentialName =
      'auth:github:host:github.com:account:octocat' as const;
    const staleIndex = indexValue('github', [
      {
        providerId: 'github',
        host: 'github.com',
        account: 'octocat',
      },
    ]);
    const repairedIndex = indexValue('github', []);
    store.set(`aide:${indexName}`, staleIndex);
    replaceSecrets({
      fail: (call, occurrence) => {
        if (call.operation === 'set' && call.name === credentialName) {
          return 'after';
        }
        if (
          call.operation === 'get' &&
          call.name === credentialName &&
          occurrence === 2
        ) {
          store.set(`aide:${credentialName}`, 'THIRD');
        }
        return false;
      },
    });

    const result = await Effect.runPromise(
      Effect.either(
        writeAuthSecret('github', 'TOKEN', {
          host: 'github.com',
          account: 'octocat',
        })
      )
    );

    expect(result._tag).toBe('Left');
    if (result._tag === 'Right') throw new Error('expected consistency error');
    expect(result.left).toMatchObject({
      operation: 'write',
      phase: 'credential-write',
      rollback: 'succeeded',
      residualState: 'none',
    });
    expect(stored(credentialName)).toBeUndefined();
    expect(stored(indexName)).toBe(repairedIndex);
  });

  test('reports unknown when either stale indexed creation rollback read fails', async () => {
    const indexName = authIndexSecretName('github');
    const credentialName =
      'auth:github:host:github.com:account:octocat' as const;
    const staleIndex = indexValue('github', [
      {
        providerId: 'github',
        host: 'github.com',
        account: 'octocat',
      },
    ]);
    const repairedIndex = indexValue('github', []);

    for (const failedFinalRead of [credentialName, indexName]) {
      store.clear();
      store.set(`aide:${indexName}`, staleIndex);
      const calls = replaceSecrets({
        fail: (call, occurrence) => {
          if (call.operation === 'set' && call.name === credentialName) {
            return 'after';
          }
          if (
            call.operation === 'get' &&
            call.name === credentialName &&
            occurrence === 2
          ) {
            store.set(`aide:${credentialName}`, 'THIRD');
          }
          if (
            call.operation === 'get' &&
            call.name === failedFinalRead &&
            occurrence === 3
          ) {
            return 'before';
          }
          if (
            call.operation === 'get' &&
            call.name === indexName &&
            failedFinalRead === indexName &&
            occurrence === 2
          ) {
            return 'before';
          }
          return false;
        },
      });

      const result = await Effect.runPromise(
        Effect.either(
          writeAuthSecret('github', 'TOKEN', {
            host: 'github.com',
            account: 'octocat',
          })
        )
      );

      expect(result._tag).toBe('Left');
      if (result._tag === 'Right') {
        throw new Error('expected unknown rollback');
      }
      expect(result.left).toMatchObject({
        operation: 'write',
        phase: 'credential-write',
        rollback: 'failed',
        residualState: 'unknown',
      });
      expect(calls).toContainEqual({
        operation: 'set',
        name: indexName,
        value: repairedIndex,
      });
      expect(stored(credentialName)).toBeUndefined();
      expect(stored(indexName)).toBe(repairedIndex);
    }
  });

  test('continues stale indexed creation compensation after the first compensation rejects', async () => {
    const indexName = authIndexSecretName('github');
    const credentialName =
      'auth:github:host:github.com:account:octocat' as const;
    const staleIndex = indexValue('github', [
      {
        providerId: 'github',
        host: 'github.com',
        account: 'octocat',
      },
    ]);
    const repairedIndex = indexValue('github', []);
    store.set(`aide:${indexName}`, staleIndex);
    const calls = replaceSecrets({
      fail: (call, occurrence) => {
        if (call.operation === 'set' && call.name === credentialName) {
          return 'after';
        }
        if (
          call.operation === 'get' &&
          call.name === credentialName &&
          occurrence === 2
        ) {
          store.set(`aide:${credentialName}`, 'THIRD');
        }
        if (call.operation === 'delete' && call.name === credentialName) {
          return 'after';
        }
        return false;
      },
    });

    const result = await Effect.runPromise(
      Effect.either(
        writeAuthSecret('github', 'TOKEN', {
          host: 'github.com',
          account: 'octocat',
        })
      )
    );

    expect(result._tag).toBe('Left');
    if (result._tag === 'Right') throw new Error('expected consistency error');
    expect(result.left).toMatchObject({
      rollback: 'succeeded',
      residualState: 'none',
    });
    expect(calls).toEqual([
      { operation: 'get', name: indexName },
      { operation: 'get', name: credentialName },
      { operation: 'set', name: credentialName, value: 'TOKEN' },
      { operation: 'get', name: credentialName },
      { operation: 'delete', name: credentialName },
      { operation: 'set', name: indexName, value: repairedIndex },
      { operation: 'get', name: credentialName },
      { operation: 'get', name: indexName },
    ]);
    expect(stored(credentialName)).toBeUndefined();
    expect(stored(indexName)).toBe(repairedIndex);
  });

  test('accepts an unindexed credential replacement that applies before rejecting', async () => {
    const indexName = authIndexSecretName('github');
    const credentialName =
      'auth:github:host:github.com:account:octocat' as const;
    store.set(`aide:${credentialName}`, 'OLD');
    const calls = replaceSecrets({
      fail: (call) =>
        call.operation === 'set' && call.name === credentialName
          ? 'after'
          : false,
    });

    await Effect.runPromise(
      writeAuthSecret('github', 'NEW', {
        host: 'github.com',
        account: 'octocat',
      })
    );

    expect(calls.map(({ operation, name }) => ({ operation, name }))).toEqual([
      { operation: 'get', name: indexName },
      { operation: 'get', name: credentialName },
      { operation: 'set', name: credentialName },
      { operation: 'get', name: credentialName },
      { operation: 'set', name: indexName },
    ]);
    expect(stored(credentialName)).toBe('NEW');
    expect(indexDocument('github').scopes).toHaveLength(1);
  });

  test('accepts a credential deletion that applies before rejecting', async () => {
    const scope = { host: 'github.com', account: 'octocat' };
    const indexName = authIndexSecretName('github');
    const credentialName =
      'auth:github:host:github.com:account:octocat' as const;
    await Effect.runPromise(writeAuthSecret('github', 'TOKEN', scope));
    const calls = replaceSecrets({
      fail: (call) =>
        call.operation === 'delete' && call.name === credentialName
          ? 'after'
          : false,
    });

    await expect(
      Effect.runPromise(deleteAuthSecret('github', scope))
    ).resolves.toBe(true);

    expect(calls.map(({ operation, name }) => ({ operation, name }))).toEqual([
      { operation: 'get', name: indexName },
      { operation: 'get', name: credentialName },
      { operation: 'delete', name: credentialName },
      { operation: 'get', name: credentialName },
      { operation: 'set', name: indexName },
    ]);
    expect(stored(credentialName)).toBeUndefined();
    expect(indexDocument('github').scopes).toEqual([]);
  });

  test('accepts index cleanup after deletion when it applies before rejecting', async () => {
    const scope = { host: 'github.com', account: 'octocat' };
    const indexName = authIndexSecretName('github');
    const credentialName =
      'auth:github:host:github.com:account:octocat' as const;
    await Effect.runPromise(writeAuthSecret('github', 'TOKEN', scope));
    const calls = replaceSecrets({
      fail: (call) =>
        call.operation === 'set' && call.name === indexName ? 'after' : false,
    });

    await expect(
      Effect.runPromise(deleteAuthSecret('github', scope))
    ).resolves.toBe(true);

    expect(calls.map(({ operation, name }) => ({ operation, name }))).toEqual([
      { operation: 'get', name: indexName },
      { operation: 'get', name: credentialName },
      { operation: 'delete', name: credentialName },
      { operation: 'set', name: indexName },
      { operation: 'get', name: indexName },
    ]);
    expect(stored(credentialName)).toBeUndefined();
    expect(indexDocument('github').scopes).toEqual([]);
  });

  test('accepts stale index repair when it applies before rejecting', async () => {
    const scope = { host: 'github.com', account: 'ghost' };
    const indexName = authIndexSecretName('github');
    const credentialName = 'auth:github:host:github.com:account:ghost';
    await Effect.runPromise(writeAuthSecret('github', 'TOKEN', scope));
    store.delete(`aide:${credentialName}`);
    const calls = replaceSecrets({
      fail: (call) =>
        call.operation === 'set' && call.name === indexName ? 'after' : false,
    });

    await expect(listIndexedAuthScopesPromise('github')).resolves.toEqual([]);

    expect(calls.map(({ operation, name }) => ({ operation, name }))).toEqual([
      { operation: 'get', name: indexName },
      { operation: 'get', name: credentialName },
      { operation: 'set', name: indexName },
      { operation: 'get', name: indexName },
    ]);
    expect(indexDocument('github').scopes).toEqual([]);
  });

  test('preserves a plain keyring error when initial index creation is verified unchanged', async () => {
    const indexName = authIndexSecretName('github');
    const credentialName =
      'auth:github:host:github.com:account:octocat' as const;
    const calls = replaceSecrets({
      fail: (call) =>
        call.operation === 'set' && call.name === indexName ? 'before' : false,
    });

    const result = await Effect.runPromise(
      Effect.either(
        writeAuthSecret('github', 'TOKEN', {
          host: 'github.com',
          account: 'octocat',
        })
      )
    );

    expect(result._tag).toBe('Left');
    if (result._tag === 'Right') throw new Error('expected index failure');
    expect(result.left).toBeInstanceOf(KeyringUnavailableError);
    expect(result.left).not.toBeInstanceOf(AuthIndexConsistencyError);
    expect(calls.map(({ operation, name }) => ({ operation, name }))).toEqual([
      { operation: 'get', name: indexName },
      { operation: 'get', name: credentialName },
      { operation: 'set', name: indexName },
      { operation: 'get', name: indexName },
    ]);
    expect(stored(indexName)).toBeUndefined();
    expect(stored(credentialName)).toBeUndefined();
  });

  test('preserves plain keyring errors for verified-unchanged credential replacements', async () => {
    const indexName = authIndexSecretName('github');
    const credentialName =
      'auth:github:host:github.com:account:octocat' as const;
    const scope = { host: 'github.com', account: 'octocat' };

    for (const indexed of [false, true]) {
      store.clear();
      if (indexed) {
        replaceSecrets({});
        await Effect.runPromise(writeAuthSecret('github', 'OLD', scope));
      } else {
        store.set(`aide:${credentialName}`, 'OLD');
      }
      const calls = replaceSecrets({
        fail: (call) =>
          call.operation === 'set' && call.name === credentialName
            ? 'before'
            : false,
      });

      const result = await Effect.runPromise(
        Effect.either(writeAuthSecret('github', 'NEW', scope))
      );

      expect(result._tag).toBe('Left');
      if (result._tag === 'Right') {
        throw new Error('expected credential failure');
      }
      expect(result.left).toBeInstanceOf(KeyringUnavailableError);
      expect(result.left).not.toBeInstanceOf(AuthIndexConsistencyError);
      expect(calls).toEqual([
        { operation: 'get', name: indexName },
        { operation: 'get', name: credentialName },
        { operation: 'set', name: credentialName, value: 'NEW' },
        { operation: 'get', name: credentialName },
      ]);
      expect(stored(credentialName)).toBe('OLD');
      expect(stored(indexName) === undefined).toBe(!indexed);
    }
  });

  test('preserves a plain keyring error when credential deletion is verified unchanged', async () => {
    const scope = { host: 'github.com', account: 'octocat' };
    const indexName = authIndexSecretName('github');
    const credentialName =
      'auth:github:host:github.com:account:octocat' as const;
    await Effect.runPromise(writeAuthSecret('github', 'TOKEN', scope));
    const originalIndex = stored(indexName);
    const calls = replaceSecrets({
      fail: (call) =>
        call.operation === 'delete' && call.name === credentialName
          ? 'before'
          : false,
    });

    const result = await Effect.runPromise(
      Effect.either(deleteAuthSecret('github', scope))
    );

    expect(result._tag).toBe('Left');
    if (result._tag === 'Right') throw new Error('expected delete failure');
    expect(result.left).toBeInstanceOf(KeyringUnavailableError);
    expect(result.left).not.toBeInstanceOf(AuthIndexConsistencyError);
    expect(calls).toEqual([
      { operation: 'get', name: indexName },
      { operation: 'get', name: credentialName },
      { operation: 'delete', name: credentialName },
      { operation: 'get', name: credentialName },
    ]);
    expect(stored(credentialName)).toBe('TOKEN');
    expect(stored(indexName)).toBe(originalIndex);
  });

  test('verifies an apply-then-reject index deletion during compensation', async () => {
    const indexName = authIndexSecretName('github');
    const credentialName =
      'auth:github:host:github.com:account:octocat' as const;
    const calls = replaceSecrets({
      fail: (call) => {
        if (call.operation === 'set' && call.name === credentialName) {
          return 'before';
        }
        if (call.operation === 'delete' && call.name === indexName) {
          return 'after';
        }
        return false;
      },
    });

    const result = await Effect.runPromise(
      Effect.either(
        writeAuthSecret('github', 'TOKEN', {
          host: 'github.com',
          account: 'octocat',
        })
      )
    );

    expect(result._tag).toBe('Left');
    if (result._tag === 'Right') throw new Error('expected write failure');
    expect(result.left).toMatchObject({
      operation: 'write',
      phase: 'credential-write',
      rollback: 'succeeded',
      residualState: 'none',
    });
    expect(calls.map(({ operation, name }) => ({ operation, name }))).toEqual([
      { operation: 'get', name: indexName },
      { operation: 'get', name: credentialName },
      { operation: 'set', name: indexName },
      { operation: 'set', name: credentialName },
      { operation: 'get', name: credentialName },
      { operation: 'delete', name: indexName },
      { operation: 'get', name: credentialName },
      { operation: 'get', name: indexName },
    ]);
    expect(stored(indexName)).toBeUndefined();
    expect(stored(credentialName)).toBeUndefined();
  });

  test('verifies an apply-then-reject credential restoration during compensation', async () => {
    const indexName = authIndexSecretName('github');
    const credentialName =
      'auth:github:host:github.com:account:octocat' as const;
    store.set(`aide:${credentialName}`, 'OLD');
    const calls = replaceSecrets({
      fail: (call, occurrence) => {
        if (call.operation === 'set' && call.name === indexName) {
          return 'before';
        }
        if (
          call.operation === 'set' &&
          call.name === credentialName &&
          occurrence === 2
        ) {
          return 'after';
        }
        return false;
      },
    });

    const result = await Effect.runPromise(
      Effect.either(
        writeAuthSecret('github', 'NEW', {
          host: 'github.com',
          account: 'octocat',
        })
      )
    );

    expect(result._tag).toBe('Left');
    if (result._tag === 'Right') throw new Error('expected index failure');
    expect(result.left).toMatchObject({
      operation: 'write',
      phase: 'index-update',
      rollback: 'succeeded',
      residualState: 'none',
    });
    expect(calls.map(({ operation, name }) => ({ operation, name }))).toEqual([
      { operation: 'get', name: indexName },
      { operation: 'get', name: credentialName },
      { operation: 'set', name: credentialName },
      { operation: 'set', name: indexName },
      { operation: 'get', name: indexName },
      { operation: 'set', name: credentialName },
      { operation: 'get', name: credentialName },
      { operation: 'get', name: indexName },
    ]);
    expect(stored(credentialName)).toBe('OLD');
    expect(stored(indexName)).toBeUndefined();
  });

  test('verifies an apply-then-reject index restoration during compensation', async () => {
    await Effect.runPromise(
      writeAuthSecret('github', 'PEER', {
        host: 'github.com',
        account: 'peer',
      })
    );
    const indexName = authIndexSecretName('github');
    const originalIndex = stored(indexName);
    const credentialName =
      'auth:github:host:github.com:account:octocat' as const;
    store.set(`aide:${credentialName}`, 'OLD');
    const calls = replaceSecrets({
      fail: (call, occurrence) => {
        if (call.operation === 'set' && call.name === indexName) return 'after';
        if (
          call.operation === 'get' &&
          call.name === indexName &&
          occurrence === 2
        ) {
          return 'before';
        }
        return false;
      },
    });

    const result = await Effect.runPromise(
      Effect.either(
        writeAuthSecret('github', 'NEW', {
          host: 'github.com',
          account: 'octocat',
        })
      )
    );

    expect(result._tag).toBe('Left');
    if (result._tag === 'Right') throw new Error('expected unknown write');
    expect(result.left).toMatchObject({
      operation: 'write',
      phase: 'index-update',
      rollback: 'succeeded',
      residualState: 'none',
    });
    expect(calls.map(({ operation, name }) => ({ operation, name }))).toEqual([
      { operation: 'get', name: indexName },
      { operation: 'get', name: credentialName },
      { operation: 'set', name: credentialName },
      { operation: 'set', name: indexName },
      { operation: 'get', name: indexName },
      { operation: 'set', name: credentialName },
      { operation: 'set', name: indexName },
      { operation: 'get', name: credentialName },
      { operation: 'get', name: indexName },
    ]);
    expect(stored(credentialName)).toBe('OLD');
    expect(stored(indexName)).toBe(originalIndex);
  });

  test('attempts the index restoration with its exact value after credential restoration rejects', async () => {
    await Effect.runPromise(
      writeAuthSecret('github', 'PEER', {
        host: 'github.com',
        account: 'peer',
      })
    );
    const indexName = authIndexSecretName('github');
    const credentialName =
      'auth:github:host:github.com:account:octocat' as const;
    const originalIndex = indexValue('github', [
      {
        providerId: 'github',
        host: 'github.com',
        account: 'peer',
      },
    ]);
    const forwardIndex = indexValue('github', [
      {
        providerId: 'github',
        host: 'github.com',
        account: 'octocat',
      },
      {
        providerId: 'github',
        host: 'github.com',
        account: 'peer',
      },
    ]);
    expect(stored(indexName)).toBe(originalIndex);
    store.set(`aide:${credentialName}`, 'OLD');
    const calls = replaceSecrets({
      fail: (call, occurrence) => {
        if (
          call.operation === 'set' &&
          call.name === indexName &&
          occurrence === 1
        ) {
          return 'after';
        }
        if (
          call.operation === 'get' &&
          call.name === indexName &&
          occurrence === 2
        ) {
          return 'before';
        }
        if (
          call.operation === 'set' &&
          call.name === credentialName &&
          occurrence === 2
        ) {
          return 'before';
        }
        return false;
      },
    });

    const result = await Effect.runPromise(
      Effect.either(
        writeAuthSecret('github', 'NEW', {
          host: 'github.com',
          account: 'octocat',
        })
      )
    );

    expect(result._tag).toBe('Left');
    if (result._tag === 'Right') throw new Error('expected rollback failure');
    expect(result.left).toMatchObject({
      operation: 'write',
      phase: 'index-update',
      rollback: 'failed',
      residualState: 'unknown',
    });
    expect(calls).toEqual([
      { operation: 'get', name: indexName },
      { operation: 'get', name: credentialName },
      { operation: 'set', name: credentialName, value: 'NEW' },
      { operation: 'set', name: indexName, value: forwardIndex },
      { operation: 'get', name: indexName },
      { operation: 'set', name: credentialName, value: 'OLD' },
      { operation: 'set', name: indexName, value: originalIndex },
      { operation: 'get', name: credentialName },
      { operation: 'get', name: indexName },
    ]);
    expect(stored(credentialName)).toBe('NEW');
    expect(stored(indexName)).toBe(originalIndex);
  });

  test('verifies apply-then-reject credential restoration after delete cleanup fails', async () => {
    const scope = { host: 'github.com', account: 'octocat' };
    const indexName = authIndexSecretName('github');
    const credentialName =
      'auth:github:host:github.com:account:octocat' as const;
    await Effect.runPromise(writeAuthSecret('github', 'TOKEN', scope));
    const calls = replaceSecrets({
      fail: (call) => {
        if (call.operation === 'set' && call.name === indexName) {
          return 'before';
        }
        if (call.operation === 'set' && call.name === credentialName) {
          return 'after';
        }
        return false;
      },
    });

    const result = await Effect.runPromise(
      Effect.either(deleteAuthSecret('github', scope))
    );

    expect(result._tag).toBe('Left');
    if (result._tag === 'Right') throw new Error('expected cleanup failure');
    expect(result.left).toMatchObject({
      operation: 'delete',
      phase: 'index-cleanup',
      rollback: 'succeeded',
      residualState: 'none',
    });
    expect(calls.map(({ operation, name }) => ({ operation, name }))).toEqual([
      { operation: 'get', name: indexName },
      { operation: 'get', name: credentialName },
      { operation: 'delete', name: credentialName },
      { operation: 'set', name: indexName },
      { operation: 'get', name: indexName },
      { operation: 'set', name: credentialName },
      { operation: 'get', name: credentialName },
      { operation: 'get', name: indexName },
    ]);
    expect(stored(credentialName)).toBe('TOKEN');
    expect(indexDocument('github').scopes).toHaveLength(1);
  });

  test('does not report residual none when compensation verification fails', async () => {
    const indexName = authIndexSecretName('github');
    const credentialName =
      'auth:github:host:github.com:account:octocat' as const;
    const calls = replaceSecrets({
      fail: (call, occurrence) => {
        if (call.operation === 'set' && call.name === credentialName) {
          return 'before';
        }
        if (call.operation === 'delete' && call.name === indexName) {
          return 'after';
        }
        if (
          call.operation === 'get' &&
          call.name === indexName &&
          occurrence === 2
        ) {
          return 'before';
        }
        return false;
      },
    });

    const result = await Effect.runPromise(
      Effect.either(
        writeAuthSecret('github', 'TOKEN', {
          host: 'github.com',
          account: 'octocat',
        })
      )
    );

    expect(result._tag).toBe('Left');
    if (result._tag === 'Right') throw new Error('expected unknown residual');
    expect(result.left).toBeInstanceOf(AuthIndexConsistencyError);
    expect(result.left).toMatchObject({
      rollback: 'failed',
      residualState: 'unknown',
    });
    expect(result.left).not.toBeInstanceOf(KeyringUnavailableError);
    expect(calls.at(-1)).toEqual({ operation: 'get', name: indexName });
    expect(stored(indexName)).toBeUndefined();
    expect(stored(credentialName)).toBeUndefined();
  });

  test('turns a third observed credential state into typed consistency failure', async () => {
    const scope = { host: 'github.com', account: 'octocat' };
    const indexName = authIndexSecretName('github');
    const credentialName =
      'auth:github:host:github.com:account:octocat' as const;
    await Effect.runPromise(writeAuthSecret('github', 'OLD', scope));
    const calls = replaceSecrets({
      fail: (call, occurrence) => {
        if (call.operation === 'set' && call.name === credentialName) {
          return 'after';
        }
        if (
          call.operation === 'get' &&
          call.name === credentialName &&
          occurrence === 2
        ) {
          store.set(`aide:${credentialName}`, 'THIRD');
        }
        return false;
      },
    });

    const result = await Effect.runPromise(
      Effect.either(writeAuthSecret('github', 'NEW', scope))
    );

    expect(result._tag).toBe('Left');
    if (result._tag === 'Right') throw new Error('expected consistency error');
    expect(result.left).toBeInstanceOf(AuthIndexConsistencyError);
    expect(result.left).toMatchObject({
      operation: 'write',
      phase: 'credential-write',
      rollback: 'succeeded',
      residualState: 'none',
    });
    expect(result.left).not.toBeInstanceOf(KeyringUnavailableError);
    expect(calls.map(({ operation, name }) => ({ operation, name }))).toEqual([
      { operation: 'get', name: indexName },
      { operation: 'get', name: credentialName },
      { operation: 'set', name: credentialName },
      { operation: 'get', name: credentialName },
      { operation: 'set', name: credentialName },
      { operation: 'get', name: credentialName },
      { operation: 'get', name: indexName },
    ]);
    expect(stored(credentialName)).toBe('OLD');
    expect(indexDocument('github').scopes).toHaveLength(1);
  });

  test('does not retry an unknown enumeration repair or hide a visible credential insertion', async () => {
    const scope = { host: 'github.com', account: 'ghost' };
    const indexName = authIndexSecretName('github');
    const credentialName = 'auth:github:host:github.com:account:ghost' as const;
    const repairedIndex = indexValue('github', []);
    const thirdIndex = indexValue('github', [
      {
        providerId: 'github',
        host: 'github.com',
        account: 'third',
      },
    ]);

    for (const verificationOutcome of ['read-failure', 'third'] as const) {
      store.clear();
      replaceSecrets({});
      await Effect.runPromise(writeAuthSecret('github', 'TOKEN', scope));
      store.delete(`aide:${credentialName}`);
      const calls = replaceSecrets({
        fail: (call, occurrence) => {
          if (call.operation === 'set' && call.name === indexName) {
            return 'after';
          }
          if (
            call.operation === 'get' &&
            call.name === indexName &&
            occurrence === 2
          ) {
            store.set(`aide:${credentialName}`, 'DIRECT');
            if (verificationOutcome === 'read-failure') return 'before';
            store.set(`aide:${indexName}`, thirdIndex);
          }
          return false;
        },
      });

      const result = await Effect.runPromise(
        Effect.either(listIndexedAuthScopes('github'))
      );

      expect(result._tag).toBe('Left');
      if (result._tag === 'Right') {
        throw new Error('expected unknown enumeration repair');
      }
      expect(result.left).toBeInstanceOf(AuthIndexConsistencyError);
      expect(result.left).toMatchObject({
        operation: 'repair',
        phase: 'index-cleanup',
        rollback: 'not-needed',
        residualState: 'unknown',
      });
      expect(
        calls.filter(
          ({ operation, name }) => operation === 'set' && name === indexName
        )
      ).toEqual([{ operation: 'set', name: indexName, value: repairedIndex }]);
      expect(stored(credentialName)).toBe('DIRECT');
      expect(stored(indexName)).toBe(
        verificationOutcome === 'read-failure' ? repairedIndex : thirdIndex
      );
    }
  });

  test('preserves typed keyring-unavailable failures for initial reads', async () => {
    replaceSecrets({ fail: () => true });

    await expect(listIndexedAuthScopesPromise('github')).rejects.toBeInstanceOf(
      KeyringUnavailableError
    );
    const writeResult = await Effect.runPromise(
      Effect.either(
        writeAuthSecret('github', 'TOKEN', {
          host: 'github.com',
          account: 'octocat',
        })
      )
    );
    const deleteResult = await Effect.runPromise(
      Effect.either(
        deleteAuthSecret('github', {
          host: 'github.com',
          account: 'octocat',
        })
      )
    );
    expect(writeResult._tag).toBe('Left');
    expect(deleteResult._tag).toBe('Left');
    if (writeResult._tag === 'Right' || deleteResult._tag === 'Right') {
      throw new Error('expected keyring failures');
    }
    expect(writeResult.left).toBeInstanceOf(KeyringUnavailableError);
    expect(deleteResult.left).toBeInstanceOf(KeyringUnavailableError);
  });

  test('legacy and invalid-scope writes and deletes never touch an index', async () => {
    const calls = replaceSecrets({});
    await Effect.runPromise(writeAuthSecret('github', 'LEGACY'));
    store.set('aide:jira', 'LEGACY_JIRA');
    store.set('aide:ado', 'LEGACY_ADO');

    const invalidCases = [
      { providerId: 'github', scope: { host: 'not a host' } },
      { providerId: 'jira', scope: { host: 'example.atlassian.net' } },
      { providerId: 'ado', scope: { host: 'dev.azure.com' } },
    ] as const;
    for (const { providerId, scope } of invalidCases) {
      await expect(
        Effect.runPromise(writeAuthSecret(providerId, 'NOPE', scope))
      ).rejects.toThrow(/cannot build an auth secret key/i);
      await expect(
        Effect.runPromise(deleteAuthSecret(providerId, scope))
      ).rejects.toThrow(/cannot build an auth secret key/i);
    }

    expect(stored('github')).toBe('LEGACY');
    expect(stored('jira')).toBe('LEGACY_JIRA');
    expect(stored('ado')).toBe('LEGACY_ADO');
    expect(stored(authIndexSecretName('github'))).toBeUndefined();
    expect(calls.some((call) => call.name.startsWith('auth-index:'))).toBe(
      false
    );
  });

  test('does not synthesize a legacy credential into an indexed account', async () => {
    store.set('aide:github', 'LEGACY');

    const scopes = await listIndexedAuthScopesPromise('github');

    expect(scopes).toEqual([]);
    expect(Object.isFrozen(scopes)).toBe(true);
    expect(stored(authIndexSecretName('github'))).toBeUndefined();
    expect(stored('github')).toBe('LEGACY');
  });

  test('serializes concurrent provider updates to avoid in-process lost entries', async () => {
    replaceSecrets({ delay: true });

    await Promise.all(
      ['charlie', 'alpha', 'bravo'].map((account) =>
        Effect.runPromise(
          writeAuthSecret('github', account.toUpperCase(), {
            host: 'github.com',
            account,
          })
        )
      )
    );

    expect(await listIndexedAuthScopesPromise('github')).toEqual([
      { providerId: 'github', host: 'github.com', account: 'alpha' },
      { providerId: 'github', host: 'github.com', account: 'bravo' },
      { providerId: 'github', host: 'github.com', account: 'charlie' },
    ]);
  });

  test('supports provider-owned indexes for future external providers', async () => {
    await Effect.runPromise(
      writeAuthSecret('Acme.Auth_v2', 'CREDENTIAL', {
        host: 'Login.Example.com',
        org: ' Tenant ',
        account: ' Person ',
      })
    );

    expect(await listIndexedAuthScopesPromise('acme.auth_v2')).toEqual([
      {
        providerId: 'acme.auth_v2',
        host: 'login.example.com',
        org: 'Tenant',
        account: 'Person',
      },
    ]);
    expect(stored(authIndexSecretName('acme.auth_v2'))).not.toContain(
      'CREDENTIAL'
    );
  });
});
