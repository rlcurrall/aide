import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Cause, Deferred, Effect, Fiber, Layer } from 'effect';
import { inspect } from 'node:util';

import {
  AuthProviderOperationError,
  listAuthProviderAccounts,
} from '@cli/host/auth-provider-operations.js';
import type {
  AideAuthProviderCapability,
  AideAuthScope,
  AideDiscoveredCapability,
} from '@cli/host/plugin-descriptor.js';
import {
  AUTH_INDEX_VERSION,
  authIndexScopeName,
  authIndexSecretName,
  deleteAuthSecretEffect,
  makeAuthIndexDocument,
  normalizeAuthStoreScope,
  serializeAuthIndexDocument,
  writeAuthSecretEffect,
  type AuthProviderId,
  type AuthStoreScope,
  type NormalizedAuthStoreScope,
} from '@lib/auth-store.js';
import {
  makeTestKeyring,
  type TestKeyring,
  type TestKeyringCall,
} from '@lib/auth-keyring.test-helper.js';
import {
  KeyringService,
  type KeyringSecretName,
  type KeyringServiceShape,
} from '@lib/auth-keyring.js';
import {
  installMockSecrets,
  restoreEnv,
  saveEnv,
  type Store,
} from '@lib/test-helpers.js';
import { createAzureDevOpsPlugin } from './azure-devops/plugin.js';
import { createJiraPlugin } from './jira/plugin.js';

const AUTH_ENV_VARS = [
  'AIDE_AUTH_INDEX_LOCK_ROOT',
  'AZURE_DEVOPS_AUTH_METHOD',
  'AZURE_DEVOPS_DEFAULT_PROJECT',
  'AZURE_DEVOPS_ORG_URL',
  'AZURE_DEVOPS_PAT',
  'JIRA_API_TOKEN',
  'JIRA_DEFAULT_PROJECT',
  'JIRA_EMAIL',
  'JIRA_TOKEN',
  'JIRA_URL',
  'JIRA_USERNAME',
];

type DiscoveryProviderId = 'jira' | 'azure-devops';
type BuiltinPlugin = {
  readonly id: string;
  readonly capabilities?: {
    readonly authProvider?: AideAuthProviderCapability<
      KeyringService,
      KeyringService,
      KeyringService,
      KeyringService
    >;
  };
};

interface ProviderFixture {
  readonly providerId: DiscoveryProviderId;
  readonly createPlugin: () => BuiltinPlugin;
  readonly legacyStoreName: 'aide:jira' | 'aide:ado';
  readonly scopes: readonly [AuthStoreScope, AuthStoreScope, AuthStoreScope];
}

const fixtures: readonly ProviderFixture[] = [
  {
    providerId: 'jira',
    createPlugin: createJiraPlugin,
    legacyStoreName: 'aide:jira',
    scopes: [
      {
        providerId: 'jira',
        host: 'alpha.atlassian.net',
        account: 'alpha@example.com',
      },
      {
        providerId: 'jira',
        host: 'beta.atlassian.net',
        account: 'beta@example.com',
      },
      {
        providerId: 'jira',
        host: 'gamma.atlassian.net',
        account: 'gamma@example.com',
      },
    ],
  },
  {
    providerId: 'azure-devops',
    createPlugin: createAzureDevOpsPlugin,
    legacyStoreName: 'aide:ado',
    scopes: [
      { providerId: 'azure-devops', host: 'dev.azure.com', org: 'alpha' },
      { providerId: 'azure-devops', host: 'dev.azure.com', org: 'beta' },
      { providerId: 'azure-devops', host: 'dev.azure.com', org: 'gamma' },
    ],
  },
];

let store: Store;
let testKeyring: TestKeyring;

function normalizedScope(
  providerId: AuthProviderId,
  scope: AuthStoreScope
): NormalizedAuthStoreScope {
  const normalized = normalizeAuthStoreScope(providerId, scope);
  if (normalized === null) throw new Error('invalid test scope');
  return normalized;
}

function credential(
  fixture: ProviderFixture,
  scope: AuthStoreScope,
  secret: string,
  defaultProject?: string
): Record<string, string> {
  if (fixture.providerId === 'jira') {
    return {
      url: `https://${scope.host}`,
      email: scope.account ?? '',
      apiToken: secret,
      ...(defaultProject === undefined ? {} : { defaultProject }),
    };
  }
  return {
    orgUrl: `https://dev.azure.com/${scope.org ?? ''}`,
    pat: secret,
    authMethod: 'pat',
    ...(defaultProject === undefined ? {} : { defaultProject }),
  };
}

function seedIndex(
  fixture: ProviderFixture,
  scopes: readonly AuthStoreScope[]
): void {
  const normalized = scopes.map((scope) =>
    normalizedScope(fixture.providerId, scope)
  );
  store.set(
    `aide:${authIndexSecretName(fixture.providerId)}`,
    serializeAuthIndexDocument(
      makeAuthIndexDocument(fixture.providerId, normalized)
    )
  );
}

function seedScopedCredential(
  fixture: ProviderFixture,
  scope: AuthStoreScope,
  value: string | Record<string, string>
): void {
  const name = authIndexScopeName(normalizedScope(fixture.providerId, scope));
  store.set(
    `aide:${name}`,
    typeof value === 'string' ? value : JSON.stringify(value)
  );
}

function seedLegacyCredential(
  fixture: ProviderFixture,
  scope: AuthStoreScope,
  secret: string,
  defaultProject?: string
): void {
  store.set(
    fixture.legacyStoreName,
    JSON.stringify(credential(fixture, scope, secret, defaultProject))
  );
}

function setEnvironmentCredential(
  fixture: ProviderFixture,
  scope: AuthStoreScope,
  secret: string,
  defaultProject?: string
): void {
  if (fixture.providerId === 'jira') {
    Bun.env.JIRA_URL = `https://${scope.host}`;
    Bun.env.JIRA_EMAIL = scope.account;
    Bun.env.JIRA_API_TOKEN = secret;
    if (defaultProject !== undefined) {
      Bun.env.JIRA_DEFAULT_PROJECT = defaultProject;
    }
    return;
  }
  Bun.env.AZURE_DEVOPS_ORG_URL = `https://dev.azure.com/${scope.org}`;
  Bun.env.AZURE_DEVOPS_PAT = secret;
  Bun.env.AZURE_DEVOPS_AUTH_METHOD = 'bearer';
  if (defaultProject !== undefined) {
    Bun.env.AZURE_DEVOPS_DEFAULT_PROJECT = defaultProject;
  }
}

function providedAuthProvider(
  plugin: BuiltinPlugin
): AideAuthProviderCapability {
  const provider = plugin.capabilities?.authProvider;
  if (provider === undefined) throw new Error('missing auth provider');
  return {
    ...provider,
    status: (request) =>
      provider.status(request).pipe(Effect.provide(testKeyring.layer)),
    accounts:
      provider.accounts === undefined
        ? undefined
        : (request) =>
            provider.accounts!(request).pipe(Effect.provide(testKeyring.layer)),
    operations:
      provider.operations === undefined
        ? undefined
        : {
            login:
              provider.operations.login === undefined
                ? undefined
                : (request) =>
                    provider.operations!.login!(request).pipe(
                      Effect.provide(testKeyring.layer)
                    ),
            logout:
              provider.operations.logout === undefined
                ? undefined
                : (request) =>
                    provider.operations!.logout!(request).pipe(
                      Effect.provide(testKeyring.layer)
                    ),
          },
  };
}

function discoveredAuthProvider(
  plugin: BuiltinPlugin
): AideDiscoveredCapability<AideAuthProviderCapability> {
  return Object.freeze({
    pluginId: plugin.id,
    capability: providedAuthProvider(plugin),
  });
}

function canonicalIds(
  fixture: ProviderFixture,
  scopes: readonly AuthStoreScope[]
): string[] {
  return scopes
    .map((scope) =>
      authIndexScopeName(normalizedScope(fixture.providerId, scope))
    )
    .sort();
}

function exposedErrorText(error: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(error);
  } catch {
    json = '<unserializable>';
  }
  return [
    String(error),
    Cause.pretty(Cause.fail(error)),
    inspect(error, { showHidden: true }),
    json,
  ].join('\n');
}

type ReadObserver = (event: {
  readonly name: string;
  readonly occurrence: number;
  readonly phase: 'before' | 'after';
  readonly value?: string | null;
}) => Effect.Effect<void, never, never> | void;

function installObservedKeyring(observer: ReadObserver): TestKeyringCall[] {
  const calls: TestKeyringCall[] = [];
  const occurrences = new Map<string, number>();

  const service = {
    get: (name: KeyringSecretName) =>
      Effect.gen(function* () {
        calls.push({ operation: 'get', name });
        const occurrence = (occurrences.get(name) ?? 0) + 1;
        occurrences.set(name, occurrence);
        const before = observer({ name, occurrence, phase: 'before' });
        if (before !== undefined) yield* before;
        const value = store.get(`aide:${name}`) ?? null;
        const after = observer({ name, occurrence, phase: 'after', value });
        if (after !== undefined) yield* after;
        return value;
      }),
    set: (name: KeyringSecretName, value: string) =>
      Effect.sync(() => {
        calls.push({ operation: 'set', name, value });
        store.set(`aide:${name}`, value);
      }),
    delete: (name: KeyringSecretName) =>
      Effect.sync(() => {
        calls.push({ operation: 'delete', name });
        return store.delete(`aide:${name}`);
      }),
  } satisfies KeyringServiceShape;

  testKeyring = {
    store,
    layer: Layer.succeed(KeyringService, service),
    replace: () => calls,
  };
  return calls;
}

describe('built-in Jira and Azure DevOps account discovery', () => {
  let restoreSecrets: () => void;
  let envSnap: Map<string, string | undefined>;

  beforeEach(() => {
    envSnap = saveEnv(AUTH_ENV_VARS);
    store = new Map();
    testKeyring = makeTestKeyring(store);
    Bun.env.AIDE_SECRET_SERVICE_OVERRIDE = 'aide';
    restoreSecrets = installMockSecrets(store);
  });

  afterEach(() => {
    restoreSecrets();
    restoreEnv(envSnap);
  });

  for (const fixture of fixtures) {
    test(`${fixture.providerId}: omitted-scope accounts enumerate every indexed scope with canonical IDs and deterministic order`, async () => {
      const [alpha, beta] = fixture.scopes;
      seedIndex(fixture, [beta, alpha]);
      seedScopedCredential(
        fixture,
        beta,
        credential(fixture, beta, `${fixture.providerId}-beta`)
      );
      seedScopedCredential(
        fixture,
        alpha,
        credential(fixture, alpha, `${fixture.providerId}-alpha`)
      );

      const accounts = await Effect.runPromise(
        listAuthProviderAccounts(discoveredAuthProvider(fixture.createPlugin()))
      );

      expect(accounts.map((account) => account.id)).toEqual(
        canonicalIds(fixture, [alpha, beta])
      );
      expect(
        accounts.map((account) => ({
          providerId: account.providerId,
          sourceKind: account.sourceKind,
          sources: account.metadata?.sources,
          storageKinds: account.metadata?.storageKinds,
          scopeId: account.scope?.id,
        }))
      ).toEqual(
        canonicalIds(fixture, [alpha, beta]).map((id) => ({
          providerId: fixture.providerId,
          sourceKind: 'keyring',
          sources: 'keyring',
          storageKinds: 'scoped',
          scopeId: id,
        }))
      );
      expect(Object.isFrozen(accounts)).toBe(true);
      expect(accounts.every((account) => Object.isFrozen(account))).toBe(true);
      expect(accounts.every((account) => Object.isFrozen(account.scope))).toBe(
        true
      );
    });

    test(`${fixture.providerId}: exact-scope accounts and status never enumerate or fall back to another indexed scope or legacy key`, async () => {
      const [requested, other] = fixture.scopes;
      seedIndex(fixture, [requested, other]);
      seedScopedCredential(fixture, requested, '{malformed-exact');
      seedScopedCredential(
        fixture,
        other,
        credential(fixture, other, `${fixture.providerId}-other`)
      );
      seedLegacyCredential(fixture, other, `${fixture.providerId}-legacy`);
      const requestedName = authIndexScopeName(
        normalizedScope(fixture.providerId, requested)
      );
      const calls = testKeyring.replace();
      const provider = providedAuthProvider(fixture.createPlugin());

      const status = await Effect.runPromise(
        provider.status({ scope: requested as AideAuthScope })
      );
      const accounts = await Effect.runPromise(
        provider.accounts!({ scope: requested as AideAuthScope })
      );

      expect(status.state).toBe('misconfigured');
      expect(accounts).toEqual([]);
      expect(calls).toEqual([
        { operation: 'get', name: requestedName },
        { operation: 'get', name: requestedName },
      ]);
    });

    test(`${fixture.providerId}: validated legacy and indexed credentials coexist and dedupe by canonical scope`, async () => {
      const [scope] = fixture.scopes;
      seedIndex(fixture, [scope]);
      seedScopedCredential(
        fixture,
        scope,
        credential(fixture, scope, `${fixture.providerId}-scoped`, 'SCOPED')
      );
      seedLegacyCredential(
        fixture,
        scope,
        `${fixture.providerId}-legacy`,
        'LEGACY'
      );

      const accounts = await Effect.runPromise(
        listAuthProviderAccounts(discoveredAuthProvider(fixture.createPlugin()))
      );

      expect(accounts).toHaveLength(1);
      expect(accounts[0]).toMatchObject({
        id: canonicalIds(fixture, [scope])[0],
        providerId: fixture.providerId,
        sourceKind: 'keyring',
        metadata: {
          sources: 'keyring',
          storageKinds: 'legacy,scoped',
        },
        scope: { id: canonicalIds(fixture, [scope])[0] },
      });
      const rawIndex = store.get(
        `aide:${authIndexSecretName(fixture.providerId)}`
      );
      expect(rawIndex).not.toContain('legacy');
    });

    test(`${fixture.providerId}: scoped-only credentials make omitted-scope status configured`, async () => {
      const [scope] = fixture.scopes;
      seedIndex(fixture, [scope]);
      seedScopedCredential(
        fixture,
        scope,
        credential(fixture, scope, `${fixture.providerId}-scoped`)
      );

      const status = await Effect.runPromise(
        providedAuthProvider(fixture.createPlugin()).status()
      );

      expect(status.state).toBe('configured');
    });

    test(`${fixture.providerId}: malformed credential payloads are never advertised and determine aggregate status only when no usable account remains`, async () => {
      const [malformed, usable] = fixture.scopes;
      const rawSecret = `RAW-${fixture.providerId}-CREDENTIAL-SENTINEL`;
      seedIndex(fixture, [malformed]);
      seedScopedCredential(fixture, malformed, `{"apiToken":"${rawSecret}"}`);
      let provider = discoveredAuthProvider(fixture.createPlugin());

      let accounts = await Effect.runPromise(
        listAuthProviderAccounts(provider)
      );
      let status = await Effect.runPromise(provider.capability.status());

      expect(accounts).toEqual([]);
      expect(status.state).toBe('misconfigured');
      expect(exposedErrorText(status)).not.toContain(rawSecret);

      seedIndex(fixture, [malformed, usable]);
      seedScopedCredential(
        fixture,
        usable,
        credential(fixture, usable, `${fixture.providerId}-usable`)
      );
      provider = discoveredAuthProvider(fixture.createPlugin());
      accounts = await Effect.runPromise(listAuthProviderAccounts(provider));
      status = await Effect.runPromise(provider.capability.status());

      expect(accounts.map((account) => account.id)).toEqual(
        canonicalIds(fixture, [usable])
      );
      expect(status.state).toBe('configured');
      expect(exposedErrorText(accounts)).not.toContain(rawSecret);
    });

    test(`${fixture.providerId}: malformed, future, and noncanonical indexes fail closed for accounts and make aggregate status misconfigured`, async () => {
      const [scope] = fixture.scopes;
      const rawIndexSentinel = `RAW-${fixture.providerId}-INDEX-SENTINEL`;
      const malformedIndexes = [
        `{"${rawIndexSentinel}":`,
        JSON.stringify({
          version: AUTH_INDEX_VERSION + 1,
          providerId: fixture.providerId,
          scopes: [],
        }),
        JSON.stringify({
          version: AUTH_INDEX_VERSION,
          providerId: fixture.providerId,
          scopes: [
            {
              ...scope,
              host:
                fixture.providerId === 'jira'
                  ? 'ALPHA.ATLASSIAN.NET'
                  : 'DEV.AZURE.COM',
            },
          ],
        }),
      ];

      for (const rawIndex of malformedIndexes) {
        store.clear();
        store.set(`aide:${authIndexSecretName(fixture.providerId)}`, rawIndex);
        const provider = discoveredAuthProvider(fixture.createPlugin());
        const accountResult = await Effect.runPromise(
          Effect.either(listAuthProviderAccounts(provider))
        );
        const status = await Effect.runPromise(provider.capability.status());

        expect(accountResult._tag).toBe('Left');
        expect(status.state).toBe('misconfigured');
        if (accountResult._tag === 'Left') {
          expect(accountResult.left).toBeInstanceOf(AuthProviderOperationError);
          expect(exposedErrorText(accountResult.left)).not.toContain(
            rawIndexSentinel
          );
          expect(exposedErrorText(accountResult.left)).not.toContain(rawIndex);
        }
      }
    });

    test(`${fixture.providerId}: unavailable keyrings fail accounts closed and make aggregate status unavailable without an env source`, async () => {
      const backendSentinel = `RAW-${fixture.providerId}-BACKEND-SENTINEL`;
      testKeyring.replace({
        rejection: new Error(backendSentinel),
        fail: () => true,
      });
      const provider = discoveredAuthProvider(fixture.createPlugin());

      const accountResult = await Effect.runPromise(
        Effect.either(listAuthProviderAccounts(provider))
      );
      const status = await Effect.runPromise(provider.capability.status());

      expect(accountResult._tag).toBe('Left');
      expect(status.state).toBe('unavailable');
      if (accountResult._tag === 'Left') {
        expect(accountResult.left).toBeInstanceOf(AuthProviderOperationError);
        expect(exposedErrorText(accountResult.left)).not.toContain(
          backendSentinel
        );
      }
    });

    test(`${fixture.providerId}: a usable env source keeps aggregate status configured during index or keyring failure while accounts still fail closed`, async () => {
      const [scope] = fixture.scopes;
      setEnvironmentCredential(
        fixture,
        scope,
        `${fixture.providerId}-env`,
        'ENV-PROJECT'
      );

      for (const failure of [
        'malformed-index',
        'unavailable-keyring',
      ] as const) {
        const calls = testKeyring.replace(
          failure === 'unavailable-keyring' ? { fail: () => true } : undefined
        );
        if (failure === 'malformed-index') {
          store.set(
            `aide:${authIndexSecretName(fixture.providerId)}`,
            '{malformed-index'
          );
        } else {
          store.delete(`aide:${authIndexSecretName(fixture.providerId)}`);
        }
        const provider = discoveredAuthProvider(fixture.createPlugin());

        const status = await Effect.runPromise(provider.capability.status());
        expect(calls).toEqual([]);
        const accountResult = await Effect.runPromise(
          Effect.either(listAuthProviderAccounts(provider))
        );

        expect(status.state).toBe('configured');
        expect(accountResult._tag).toBe('Left');
      }
    });

    test(`${fixture.providerId}: usable legacy cannot hide malformed, future, or noncanonical catalog state`, async () => {
      const [scope] = fixture.scopes;
      seedLegacyCredential(
        fixture,
        scope,
        `${fixture.providerId}-usable-legacy`
      );

      const malformedIndexes = [
        '{malformed-index',
        JSON.stringify({
          version: AUTH_INDEX_VERSION + 1,
          providerId: fixture.providerId,
          scopes: [],
        }),
        JSON.stringify({
          version: AUTH_INDEX_VERSION,
          providerId: fixture.providerId,
          scopes: [
            {
              ...scope,
              host:
                fixture.providerId === 'jira'
                  ? 'ALPHA.ATLASSIAN.NET'
                  : 'DEV.AZURE.COM',
            },
          ],
        }),
      ];

      for (const rawIndex of malformedIndexes) {
        store.set(`aide:${authIndexSecretName(fixture.providerId)}`, rawIndex);
        const calls = testKeyring.replace();
        const provider = discoveredAuthProvider(fixture.createPlugin());

        const status = await Effect.runPromise(provider.capability.status());
        const accountResult = await Effect.runPromise(
          Effect.either(listAuthProviderAccounts(provider))
        );

        expect(status.state).toBe('misconfigured');
        expect(accountResult._tag).toBe('Left');
        expect(
          calls.some(
            (call) =>
              call.operation === 'get' &&
              call.name === authIndexSecretName(fixture.providerId)
          )
        ).toBe(true);
      }
    });

    test(`${fixture.providerId}: usable legacy cannot hide unavailable index, keyring, or lock state`, async () => {
      const [scope] = fixture.scopes;
      seedLegacyCredential(
        fixture,
        scope,
        `${fixture.providerId}-usable-legacy`
      );

      const calls = testKeyring.replace({
        fail: (call) => call.name === authIndexSecretName(fixture.providerId),
      });
      let provider = discoveredAuthProvider(fixture.createPlugin());
      let status = await Effect.runPromise(provider.capability.status());
      let accountResult = await Effect.runPromise(
        Effect.either(listAuthProviderAccounts(provider))
      );

      expect(status.state).toBe('unavailable');
      expect(accountResult._tag).toBe('Left');
      expect(
        calls.some(
          (call) =>
            call.operation === 'get' &&
            call.name === authIndexSecretName(fixture.providerId)
        )
      ).toBe(true);

      testKeyring.replace();
      Bun.env.AIDE_AUTH_INDEX_LOCK_ROOT = 'relative-lock-root';
      provider = discoveredAuthProvider(fixture.createPlugin());
      status = await Effect.runPromise(provider.capability.status());
      accountResult = await Effect.runPromise(
        Effect.either(listAuthProviderAccounts(provider))
      );

      expect(status.state).toBe('unavailable');
      expect(accountResult._tag).toBe('Left');
      delete Bun.env.AIDE_AUTH_INDEX_LOCK_ROOT;
    });

    test(`${fixture.providerId}: stale indexed targets are omitted and repaired through complete discovery`, async () => {
      const [stale, live] = fixture.scopes;
      seedIndex(fixture, [stale, live]);
      seedScopedCredential(
        fixture,
        live,
        credential(fixture, live, `${fixture.providerId}-live`)
      );

      const accounts = await Effect.runPromise(
        listAuthProviderAccounts(discoveredAuthProvider(fixture.createPlugin()))
      );

      expect(accounts.map((account) => account.id)).toEqual(
        canonicalIds(fixture, [live])
      );
      expect(store.get(`aide:${authIndexSecretName(fixture.providerId)}`)).toBe(
        serializeAuthIndexDocument(
          makeAuthIndexDocument(fixture.providerId, [
            normalizedScope(fixture.providerId, live),
          ])
        )
      );
    });

    test(`${fixture.providerId}: only missing or stale stored credentials repair to a stable not-configured catalog`, async () => {
      const [stale] = fixture.scopes;
      seedIndex(fixture, [stale]);
      const provider = discoveredAuthProvider(fixture.createPlugin());

      const accounts = await Effect.runPromise(
        listAuthProviderAccounts(provider)
      );
      const status = await Effect.runPromise(provider.capability.status());

      expect(accounts).toEqual([]);
      expect(status.state).toBe('not-configured');
      expect(store.get(`aide:${authIndexSecretName(fixture.providerId)}`)).toBe(
        serializeAuthIndexDocument(
          makeAuthIndexDocument(fixture.providerId, [])
        )
      );
    });

    test(`${fixture.providerId}: one usable scoped credential cannot hide selective legacy or sibling unavailability`, async () => {
      const [usable, unavailable] = fixture.scopes;
      seedIndex(fixture, [usable, unavailable]);
      seedScopedCredential(
        fixture,
        usable,
        credential(fixture, usable, `${fixture.providerId}-usable`)
      );
      seedScopedCredential(
        fixture,
        unavailable,
        credential(fixture, unavailable, `${fixture.providerId}-unavailable`)
      );
      const unavailableName = authIndexScopeName(
        normalizedScope(fixture.providerId, unavailable)
      );

      testKeyring.replace({
        fail: (call, occurrence) =>
          call.name === unavailableName && occurrence === 1,
      });
      let provider = discoveredAuthProvider(fixture.createPlugin());
      let status = await Effect.runPromise(provider.capability.status());
      expect(status.state).toBe('unavailable');

      testKeyring.replace({
        fail: (call, occurrence) =>
          call.name === unavailableName && occurrence === 1,
      });
      provider = discoveredAuthProvider(fixture.createPlugin());
      let accountResult = await Effect.runPromise(
        Effect.either(listAuthProviderAccounts(provider))
      );
      expect(accountResult._tag).toBe('Left');

      testKeyring.replace({
        fail: (call) =>
          call.name === fixture.legacyStoreName.slice('aide:'.length),
      });
      provider = discoveredAuthProvider(fixture.createPlugin());
      status = await Effect.runPromise(provider.capability.status());
      accountResult = await Effect.runPromise(
        Effect.either(listAuthProviderAccounts(provider))
      );
      expect(status.state).toBe('unavailable');
      expect(accountResult._tag).toBe('Left');
    });

    test(`${fixture.providerId}: delete/reinsert ABA at one canonical target yields one captured omission and consistent stale repair`, async () => {
      const [scope] = fixture.scopes;
      seedIndex(fixture, [scope]);
      const raw = JSON.stringify(
        credential(fixture, scope, `${fixture.providerId}-aba`)
      );
      seedScopedCredential(fixture, scope, raw);
      const targetName = authIndexScopeName(
        normalizedScope(fixture.providerId, scope)
      );
      const indexName = authIndexSecretName(fixture.providerId);
      const calls = installObservedKeyring((event) => {
        if (event.name !== targetName || event.occurrence !== 1) return;
        if (event.phase === 'before') store.delete(`aide:${targetName}`);
        if (event.phase === 'after') store.set(`aide:${targetName}`, raw);
      });

      const accounts = await Effect.runPromise(
        listAuthProviderAccounts(discoveredAuthProvider(fixture.createPlugin()))
      );

      expect(accounts).toEqual([]);
      expect(store.get(`aide:${indexName}`)).toBe(
        serializeAuthIndexDocument(
          makeAuthIndexDocument(fixture.providerId, [])
        )
      );
      expect(
        calls.filter(
          (call) => call.operation === 'get' && call.name === indexName
        )
      ).toHaveLength(1);
    });

    test(`${fixture.providerId}: usable-to-malformed same-scope payload change uses the captured usable value`, async () => {
      const [scope] = fixture.scopes;
      seedIndex(fixture, [scope]);
      seedScopedCredential(
        fixture,
        scope,
        credential(fixture, scope, `${fixture.providerId}-captured-usable`)
      );
      const targetName = authIndexScopeName(
        normalizedScope(fixture.providerId, scope)
      );
      installObservedKeyring((event) => {
        if (
          event.name === targetName &&
          event.occurrence === 1 &&
          event.phase === 'after'
        ) {
          store.set(`aide:${targetName}`, '{malformed-after-capture');
        }
      });

      const accounts = await Effect.runPromise(
        listAuthProviderAccounts(discoveredAuthProvider(fixture.createPlugin()))
      );

      expect(accounts.map((account) => account.id)).toEqual(
        canonicalIds(fixture, [scope])
      );
    });

    test(`${fixture.providerId}: malformed-to-usable same-scope payload change excludes the captured malformed value`, async () => {
      const [scope] = fixture.scopes;
      seedIndex(fixture, [scope]);
      seedScopedCredential(fixture, scope, '{malformed-at-capture');
      const targetName = authIndexScopeName(
        normalizedScope(fixture.providerId, scope)
      );
      installObservedKeyring((event) => {
        if (
          event.name === targetName &&
          event.occurrence === 1 &&
          event.phase === 'after'
        ) {
          seedScopedCredential(
            fixture,
            scope,
            credential(fixture, scope, `${fixture.providerId}-usable-later`)
          );
        }
      });

      const accounts = await Effect.runPromise(
        listAuthProviderAccounts(discoveredAuthProvider(fixture.createPlugin()))
      );

      expect(accounts).toEqual([]);
    });

    test(`${fixture.providerId}: legacy insertion, removal, and change during acquisition use the separately captured legacy value`, async () => {
      const [indexed, legacyBefore, legacyAfter] = fixture.scopes;
      const scenarios = [
        {
          name: 'insertion',
          before: undefined,
          after: legacyAfter,
          expected: [indexed, legacyAfter],
        },
        {
          name: 'removal',
          before: legacyBefore,
          after: undefined,
          expected: [indexed],
        },
        {
          name: 'change',
          before: legacyBefore,
          after: legacyAfter,
          expected: [indexed, legacyAfter],
        },
      ] as const;

      for (const scenario of scenarios) {
        store.clear();
        seedIndex(fixture, [indexed]);
        seedScopedCredential(
          fixture,
          indexed,
          credential(
            fixture,
            indexed,
            `${fixture.providerId}-${scenario.name}-indexed`
          )
        );
        if (scenario.before !== undefined) {
          seedLegacyCredential(
            fixture,
            scenario.before,
            `${fixture.providerId}-${scenario.name}-before`
          );
        }
        const targetName = authIndexScopeName(
          normalizedScope(fixture.providerId, indexed)
        );
        installObservedKeyring((event) => {
          if (
            event.name !== targetName ||
            event.occurrence !== 1 ||
            event.phase !== 'after'
          ) {
            return;
          }
          if (scenario.after === undefined) {
            store.delete(fixture.legacyStoreName);
          } else {
            seedLegacyCredential(
              fixture,
              scenario.after,
              `${fixture.providerId}-${scenario.name}-after`
            );
          }
        });

        const accounts = await Effect.runPromise(
          listAuthProviderAccounts(
            discoveredAuthProvider(fixture.createPlugin())
          )
        );

        expect(accounts.map((account) => account.id)).toEqual(
          canonicalIds(fixture, scenario.expected)
        );
      }
    });

    test(`${fixture.providerId}: Aide-managed scoped write and delete wait for discovery's catalog lease and affect only later calls`, async () => {
      const [existing, inserted] = fixture.scopes;

      for (const operation of ['write', 'delete'] as const) {
        store.clear();
        seedIndex(fixture, [existing]);
        seedScopedCredential(
          fixture,
          existing,
          credential(
            fixture,
            existing,
            `${fixture.providerId}-${operation}-existing`
          )
        );
        const started = await Effect.runPromise(Deferred.make<void>());
        const release = await Effect.runPromise(Deferred.make<void>());
        const legacyName = fixture.legacyStoreName.slice('aide:'.length);
        installObservedKeyring((event) => {
          if (
            event.name !== legacyName ||
            event.occurrence !== 1 ||
            event.phase !== 'before'
          ) {
            return;
          }
          return Effect.zipRight(
            Effect.asVoid(Deferred.succeed(started, undefined)),
            Deferred.await(release)
          );
        });
        const layer = testKeyring.layer;
        const discoveryFiber = Effect.runFork(
          listAuthProviderAccounts(
            discoveredAuthProvider(fixture.createPlugin())
          )
        );
        await Effect.runPromise(Deferred.await(started));

        let writerCompleted = false;
        const writer: Effect.Effect<void, unknown, KeyringService> =
          operation === 'write'
            ? Effect.asVoid(
                writeAuthSecretEffect(
                  fixture.providerId,
                  JSON.stringify(
                    credential(
                      fixture,
                      inserted,
                      `${fixture.providerId}-inserted`
                    )
                  ),
                  inserted
                )
              )
            : Effect.asVoid(
                deleteAuthSecretEffect(fixture.providerId, existing)
              );
        const writerFiber = Effect.runFork(
          writer.pipe(
            Effect.provide(layer),
            Effect.tap(() =>
              Effect.sync(() => {
                writerCompleted = true;
              })
            )
          )
        );
        await Bun.sleep(75);
        const completedBeforeRelease = writerCompleted;
        await Effect.runPromise(Deferred.succeed(release, undefined));
        const accounts = await Effect.runPromise(Fiber.join(discoveryFiber));
        await Effect.runPromise(Fiber.join(writerFiber));

        expect(completedBeforeRelease).toBe(false);
        expect(accounts.map((account) => account.id)).toEqual(
          canonicalIds(fixture, [existing])
        );
        expect(writerCompleted).toBe(true);
        expect(
          store.get(`aide:${authIndexSecretName(fixture.providerId)}`)
        ).toBe(
          serializeAuthIndexDocument(
            makeAuthIndexDocument(
              fixture.providerId,
              (operation === 'write' ? [existing, inserted] : []).map((scope) =>
                normalizedScope(fixture.providerId, scope)
              )
            )
          )
        );
      }
    }, 10_000);

    test(`${fixture.providerId}: provider candidates use the committed assembly helper for deterministic env/keyring metadata, dedupe, and order`, async () => {
      const [environmentAndScoped, legacyAndScoped, scopedOnly] =
        fixture.scopes;
      setEnvironmentCredential(
        fixture,
        environmentAndScoped,
        `${fixture.providerId}-env`,
        'ENV-PROJECT'
      );
      seedLegacyCredential(
        fixture,
        legacyAndScoped,
        `${fixture.providerId}-legacy`,
        'LEGACY-PROJECT'
      );
      seedIndex(fixture, [scopedOnly, legacyAndScoped, environmentAndScoped]);
      seedScopedCredential(
        fixture,
        environmentAndScoped,
        credential(
          fixture,
          environmentAndScoped,
          `${fixture.providerId}-env-scoped`,
          'SCOPED-STALE'
        )
      );
      seedScopedCredential(
        fixture,
        legacyAndScoped,
        credential(
          fixture,
          legacyAndScoped,
          `${fixture.providerId}-legacy-scoped`,
          'SCOPED-PROJECT'
        )
      );
      seedScopedCredential(
        fixture,
        scopedOnly,
        credential(
          fixture,
          scopedOnly,
          `${fixture.providerId}-scoped-only`,
          'ONLY-PROJECT'
        )
      );

      const accounts = await Effect.runPromise(
        listAuthProviderAccounts(discoveredAuthProvider(fixture.createPlugin()))
      );
      const byId = new Map(accounts.map((account) => [account.id, account]));
      const [environmentId, legacyId, scopedId] = canonicalIds(fixture, [
        environmentAndScoped,
        legacyAndScoped,
        scopedOnly,
      ]);
      if (
        environmentId === undefined ||
        legacyId === undefined ||
        scopedId === undefined
      ) {
        throw new Error('expected three canonical account IDs');
      }

      expect(accounts.map((account) => account.id)).toEqual([
        environmentId,
        legacyId,
        scopedId,
      ]);
      expect(byId.get(environmentId)).toMatchObject({
        sourceKind: 'env',
        metadata: {
          sources: 'environment,keyring',
          storageKinds: 'scoped',
          defaultProject: 'ENV-PROJECT',
        },
      });
      expect(byId.get(legacyId)).toMatchObject({
        sourceKind: 'keyring',
        metadata: {
          sources: 'keyring',
          storageKinds: 'legacy,scoped',
        },
      });
      expect(byId.get(scopedId)).toMatchObject({
        sourceKind: 'keyring',
        metadata: {
          sources: 'keyring',
          storageKinds: 'scoped',
        },
      });
      if (fixture.providerId === 'azure-devops') {
        expect(byId.get(environmentId)?.metadata?.authMethod).toBe('bearer');
        expect(byId.get(legacyId)?.metadata?.authMethod).toBe('pat');
      }
    });
  }

  test('jira: omitted discovery preserves multiple accounts on one canonical host', async () => {
    const fixture = fixtures[0];
    if (fixture?.providerId !== 'jira') throw new Error('missing Jira fixture');
    const scopes = [
      {
        providerId: 'jira',
        host: 'shared.atlassian.net',
        account: 'alpha@example.com',
      },
      {
        providerId: 'jira',
        host: 'shared.atlassian.net',
        account: 'beta@example.com',
      },
    ] as const satisfies readonly AuthStoreScope[];
    seedIndex(fixture, scopes);
    for (const scope of scopes) {
      seedScopedCredential(
        fixture,
        scope,
        credential(fixture, scope, `jira-${scope.account}`)
      );
    }

    const accounts = await Effect.runPromise(
      listAuthProviderAccounts(discoveredAuthProvider(fixture.createPlugin()))
    );

    expect(accounts.map((account) => account.id)).toEqual(
      canonicalIds(fixture, scopes)
    );
    expect(accounts.map((account) => account.scope?.host)).toEqual([
      'shared.atlassian.net',
      'shared.atlassian.net',
    ]);
    expect(accounts.map((account) => account.scope?.account)).toEqual([
      'alpha@example.com',
      'beta@example.com',
    ]);
  });
});
