import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Cause, Effect, Layer } from 'effect';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';

import {
  listAuthProviderAccounts,
  type AuthProviderOperationInvocationError,
} from '@cli/host/auth-provider-operations.js';
import type {
  AideAuthAccount,
  AideAuthAccountDiscoveryRequest,
  AideAuthProviderCapability,
  AideAuthStatusRequest,
  AideDiscoveredCapability,
  AidePluginAuthStatus,
} from '@cli/host/plugin-descriptor.js';
import type { TrustedAuthDiscoveryServices } from '@cli/host/command-registry.js';
import {
  authIndexScopeName,
  authIndexSecretName,
  makeAuthIndexDocument,
  normalizeAuthStoreScope,
  serializeAuthIndexDocument,
  type AuthStoreScope,
  type NormalizedAuthStoreScope,
} from '@lib/auth-store.js';
import {
  KeyringService,
  type KeyringSecretName,
  type KeyringServiceShape,
} from '@lib/auth-keyring.js';
import {
  makeTestKeyring,
  type TestKeyring,
  type TestKeyringCall,
} from '@lib/auth-keyring.test-helper.js';
import {
  GitHubAuthCatalogDocumentError,
  GitHubAuthCatalogService,
  GitHubAuthCatalogUnavailableError,
  type GitHubAuthCatalogFailure,
  type GitHubAuthCatalogResult,
  type GitHubAuthCatalogServiceShape,
} from '@lib/github-auth-catalog.js';
import {
  restoreEnv,
  saveEnv,
  unavailableGitHubAuthProbe,
} from '@lib/test-helpers.js';
import { createGitHubPlugin } from './plugin.js';

const AUTH_ENV_VARS = [
  'AIDE_AUTH_INDEX_LOCK_ROOT',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'GH_HOST',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
];

const emptyCatalog = catalogResult([]);

type GitHubPlugin = ReturnType<typeof createGitHubPlugin>;
type GitHubProvider = NonNullable<
  NonNullable<GitHubPlugin['capabilities']>['authProvider']
>;

let store: Map<string, string>;
let keyring: TestKeyring;
let catalogCalls: number;
let catalogEffect: Effect.Effect<
  GitHubAuthCatalogResult,
  GitHubAuthCatalogFailure
>;
let discoveryLayer: Layer.Layer<TrustedAuthDiscoveryServices>;
let envSnapshot: Map<string, string | undefined>;
let temporaryDirectory: string;

function catalogResult(
  identities: readonly { readonly host: string; readonly account: string }[],
  hasUnhealthyActiveIdentity = false
): GitHubAuthCatalogResult {
  return Object.freeze({
    identities: Object.freeze(
      identities.map((identity) => Object.freeze({ ...identity }))
    ),
    hasUnhealthyActiveIdentity,
  });
}

function catalogLayer(): Layer.Layer<GitHubAuthCatalogService> {
  const service = Object.freeze({
    discover: Effect.suspend(() => {
      catalogCalls += 1;
      return catalogEffect;
    }),
  }) satisfies GitHubAuthCatalogServiceShape;
  return Layer.succeed(GitHubAuthCatalogService, service);
}

function normalized(scope: AuthStoreScope): NormalizedAuthStoreScope {
  const result = normalizeAuthStoreScope('github', scope);
  if (result === null) throw new Error('invalid GitHub test scope');
  return result;
}

function canonicalId(scope: AuthStoreScope): string {
  return authIndexScopeName(normalized(scope));
}

function seedIndex(scopes: readonly AuthStoreScope[]): void {
  store.set(
    `aide:${authIndexSecretName('github')}`,
    serializeAuthIndexDocument(
      makeAuthIndexDocument('github', scopes.map(normalized))
    )
  );
}

function seedScoped(
  scope: AuthStoreScope,
  value: string | Readonly<Record<string, unknown>>
): void {
  store.set(
    `aide:${canonicalId(scope)}`,
    typeof value === 'string' ? value : JSON.stringify(value)
  );
}

function scopedCredential(
  scope: AuthStoreScope,
  token: string
): Readonly<Record<string, unknown>> {
  return {
    token,
    identity: {
      host: scope.host,
      ...(scope.account === undefined ? {} : { account: scope.account }),
    },
  };
}

function provider(
  options: Parameters<typeof createGitHubPlugin>[0] = {
    ghAuthProbe: unavailableGitHubAuthProbe,
  }
): GitHubProvider {
  const capability = createGitHubPlugin(options).capabilities?.authProvider;
  if (capability === undefined) throw new Error('missing GitHub auth provider');
  return capability;
}

function discovered(
  capability: GitHubProvider
): AideDiscoveredCapability<GitHubProvider> & {
  readonly provenance: 'trusted';
} {
  return Object.freeze({
    provenance: 'trusted' as const,
    pluginId: 'github',
    capability,
  });
}

function runStatus(
  capability: GitHubProvider,
  request?: AideAuthStatusRequest,
  layer = discoveryLayer
): Promise<AidePluginAuthStatus> {
  return Effect.runPromise(
    capability.status(request).pipe(Effect.provide(layer))
  );
}

function runAccounts(
  capability: GitHubProvider,
  request?: AideAuthAccountDiscoveryRequest,
  layer = discoveryLayer
): Promise<readonly AideAuthAccount[]> {
  if (capability.accounts === undefined) {
    throw new Error('missing GitHub account discovery');
  }
  return Effect.runPromise(
    capability.accounts(request).pipe(Effect.provide(layer))
  );
}

function runValidatedAccounts(
  capability: GitHubProvider,
  request?: AideAuthAccountDiscoveryRequest,
  layer = discoveryLayer
): Promise<readonly AideAuthAccount[]> {
  return Effect.runPromise(
    listAuthProviderAccounts(discovered(capability), request).pipe(
      Effect.provide(layer)
    )
  );
}

function runAccountEither(
  capability: GitHubProvider,
  layer = discoveryLayer
): Promise<
  | {
      readonly _tag: 'Left';
      readonly left: AuthProviderOperationInvocationError;
    }
  | { readonly _tag: 'Right'; readonly right: readonly AideAuthAccount[] }
> {
  return Effect.runPromise(
    Effect.either(
      listAuthProviderAccounts(discovered(capability)).pipe(
        Effect.provide(layer)
      )
    )
  );
}

function exposed(value: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    json = '<unserializable>';
  }
  return [
    String(value),
    inspect(value, { depth: 8, showHidden: true }),
    Cause.pretty(Cause.fail(value)),
    json,
  ].join('\n');
}

function expectDeeplyFrozen(accounts: readonly AideAuthAccount[]): void {
  expect(Object.isFrozen(accounts)).toBe(true);
  for (const account of accounts) {
    expect(Object.isFrozen(account)).toBe(true);
    expect(Object.isFrozen(account.scope)).toBe(true);
    expect(Object.isFrozen(account.metadata)).toBe(true);
    expect(account.scope?.metadata).toEqual(account.metadata);
  }
}

beforeEach(async () => {
  envSnapshot = saveEnv(AUTH_ENV_VARS);
  for (const name of AUTH_ENV_VARS) delete Bun.env[name];
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'aide-github-discovery-'));
  await chmod(temporaryDirectory, 0o700);
  Bun.env.AIDE_AUTH_INDEX_LOCK_ROOT = join(temporaryDirectory, 'locks');

  store = new Map();
  keyring = makeTestKeyring(store);
  catalogCalls = 0;
  catalogEffect = Effect.succeed(emptyCatalog);
  discoveryLayer = Layer.merge(keyring.layer, catalogLayer());
});

afterEach(async () => {
  restoreEnv(envSnapshot);
  await rm(temporaryDirectory, { force: true, recursive: true });
});

describe('GitHub auth-provider omitted-scope discovery', () => {
  test('enumerates gh, public and enterprise env, legacy, and every indexed identity through canonical assembly once', async () => {
    const publicHost = {
      providerId: 'github',
      host: 'github.com',
    } as const;
    const publicAccount = {
      providerId: 'github',
      host: 'github.com',
      account: 'octocat',
    } as const;
    const enterpriseHost = {
      providerId: 'github',
      host: 'ghe.example.com',
    } as const;
    const scopedOnly = {
      providerId: 'github',
      host: 'zeta.example.com',
      account: 'build-bot',
    } as const;
    const sentinels = [
      'TODO146-PUBLIC-PRIMARY-TOKEN',
      'TODO146-PUBLIC-FALLBACK-TOKEN',
      'TODO146-ENTERPRISE-PRIMARY-TOKEN',
      'TODO146-ENTERPRISE-FALLBACK-TOKEN',
      'TODO146-LEGACY-TOKEN',
      'TODO146-PUBLIC-SCOPED-TOKEN',
      'TODO146-ACCOUNT-SCOPED-TOKEN',
      'TODO146-ENTERPRISE-SCOPED-TOKEN',
      'TODO146-ONLY-SCOPED-TOKEN',
    ];
    Bun.env.GITHUB_TOKEN = sentinels[0];
    Bun.env.GH_TOKEN = sentinels[1];
    Bun.env.GH_HOST = ' GHE.EXAMPLE.COM ';
    Bun.env.GH_ENTERPRISE_TOKEN = sentinels[2];
    Bun.env.GITHUB_ENTERPRISE_TOKEN = sentinels[3];
    store.set('aide:github', JSON.stringify({ token: sentinels[4] }));
    seedIndex([scopedOnly, publicAccount, enterpriseHost, publicHost]);
    seedScoped(publicHost, scopedCredential(publicHost, sentinels[5]!));
    seedScoped(publicAccount, scopedCredential(publicAccount, sentinels[6]!));
    seedScoped(enterpriseHost, scopedCredential(enterpriseHost, sentinels[7]!));
    seedScoped(scopedOnly, scopedCredential(scopedOnly, sentinels[8]!));
    catalogEffect = Effect.succeed(
      catalogResult([
        { host: 'github.com', account: 'octocat' },
        { host: 'alpha.example.com', account: 'alice' },
      ])
    );
    const calls = keyring.replace();

    const accounts = await runValidatedAccounts(provider());

    expect(accounts.map((account) => account.id)).toEqual([
      'auth:github:host:alpha.example.com:account:alice',
      'auth:github:host:ghe.example.com',
      'auth:github:host:github.com',
      'auth:github:host:github.com:account:octocat',
      'auth:github:host:zeta.example.com:account:build-bot',
    ]);
    const byId = new Map(accounts.map((account) => [account.id, account]));
    expect(
      byId.get('auth:github:host:alpha.example.com:account:alice')
    ).toMatchObject({
      sourceKind: 'external',
      metadata: { sources: 'gh-cli', active: true },
    });
    expect(byId.get(canonicalId(enterpriseHost))).toMatchObject({
      sourceKind: 'env',
      metadata: {
        sources: 'environment,keyring',
        storageKinds: 'scoped',
      },
    });
    expect(byId.get(canonicalId(publicHost))).toMatchObject({
      sourceKind: 'env',
      metadata: {
        sources: 'environment,keyring',
        storageKinds: 'legacy,scoped',
      },
    });
    expect(byId.get(canonicalId(publicAccount))).toMatchObject({
      sourceKind: 'external',
      metadata: {
        sources: 'gh-cli,keyring',
        storageKinds: 'scoped',
        active: true,
      },
    });
    expect(byId.get(canonicalId(scopedOnly))).toMatchObject({
      sourceKind: 'keyring',
      metadata: { sources: 'keyring', storageKinds: 'scoped' },
    });
    for (const account of accounts) {
      expect(
        Object.keys(account.metadata ?? {}).every((key) =>
          ['sources', 'storageKinds', 'active'].includes(key)
        )
      ).toBe(true);
    }
    expectDeeplyFrozen(accounts);
    expect(catalogCalls).toBe(1);
    expect(
      calls.filter(
        (call) =>
          call.operation === 'get' &&
          call.name === authIndexSecretName('github')
      )
    ).toHaveLength(1);
    expect(
      calls.filter((call) => call.operation === 'get' && call.name === 'github')
    ).toHaveLength(1);
    for (const scope of [
      publicHost,
      publicAccount,
      enterpriseHost,
      scopedOnly,
    ]) {
      expect(
        calls.filter(
          (call) => call.operation === 'get' && call.name === canonicalId(scope)
        )
      ).toHaveLength(1);
    }
    const rendered = exposed(accounts);
    for (const sentinel of sentinels) expect(rendered).not.toContain(sentinel);
  });

  test('snapshots the environment before catalog reads and never mixes bindings from a later mutation', async () => {
    Bun.env.GITHUB_TOKEN = 'TODO146-SNAPSHOT-PUBLIC';
    Bun.env.GH_HOST = 'first.example.com';
    Bun.env.GH_ENTERPRISE_TOKEN = 'TODO146-SNAPSHOT-ENTERPRISE';
    let reads = 0;
    const service: KeyringServiceShape = Object.freeze({
      get: (name: KeyringSecretName) =>
        Effect.sync(() => {
          reads += 1;
          if (reads === 1) {
            delete Bun.env.GITHUB_TOKEN;
            Bun.env.GH_HOST = 'second.example.com';
            Bun.env.GH_ENTERPRISE_TOKEN = 'TODO146-LATER-ENTERPRISE';
          }
          return store.get(`aide:${name}`) ?? null;
        }),
      set: (name: KeyringSecretName, value: string) =>
        Effect.sync(() => {
          store.set(`aide:${name}`, value);
        }),
      delete: (name: KeyringSecretName) =>
        Effect.sync(() => store.delete(`aide:${name}`)),
    });
    const layer = Layer.merge(
      Layer.succeed(KeyringService, service),
      catalogLayer()
    );

    const accounts = await runAccounts(provider(), undefined, layer);

    expect(accounts.map((account) => account.id)).toEqual([
      'auth:github:host:first.example.com',
      'auth:github:host:github.com',
    ]);
    expect(exposed(accounts)).not.toContain('TODO146');
    expect(catalogCalls).toBe(1);
  });

  test('omits malformed stored payloads and lets a usable scoped or gh sibling win status', async () => {
    const malformed = {
      providerId: 'github',
      host: 'malformed.example.com',
    } as const;
    const usable = {
      providerId: 'github',
      host: 'usable.example.com',
      account: 'service',
    } as const;
    const rawSecret = 'TODO146-MALFORMED-STORED-PAYLOAD';
    seedIndex([malformed, usable]);
    seedScoped(
      malformed,
      JSON.stringify({
        token: rawSecret,
        identity: { host: 'different.example.com' },
      })
    );
    seedScoped(usable, scopedCredential(usable, 'TODO146-USABLE-TOKEN'));
    catalogEffect = Effect.succeed(catalogResult([], true));

    let accounts = await runAccounts(provider());
    let status = await runStatus(provider());

    expect(accounts.map((account) => account.id)).toEqual([
      canonicalId(usable),
    ]);
    expect(status.state).toBe('configured');
    expect(exposed(accounts)).not.toContain(rawSecret);
    expect(exposed(status)).not.toContain(rawSecret);

    seedIndex([malformed]);
    store.delete(`aide:${canonicalId(usable)}`);
    catalogEffect = Effect.succeed(
      catalogResult([{ host: 'github.com', account: 'gh-sibling' }])
    );
    accounts = await runAccounts(provider());
    status = await runStatus(provider());
    expect(accounts.map((account) => account.id)).toEqual([
      'auth:github:host:github.com:account:gh-sibling',
    ]);
    expect(status).toEqual({
      state: 'configured',
      detail: 'authenticated via gh CLI',
    });
    expect(exposed(accounts)).not.toContain(rawSecret);
    expect(exposed(status)).not.toContain(rawSecret);

    catalogEffect = Effect.succeed(catalogResult([], true));
    accounts = await runAccounts(provider());
    status = await runStatus(provider());
    expect(accounts).toEqual([]);
    expect(status.state).toBe('misconfigured');
    expect(exposed(status)).not.toContain(rawSecret);
  });

  test('treats an enterprise token with an invalid or public GH_HOST binding as malformed without advertising it', async () => {
    const invalidHosts = [
      undefined,
      'github.com',
      'https://enterprise.example.com',
      'enterprise.example.com/path',
      'not a host',
    ];

    for (const host of invalidHosts) {
      if (host === undefined) delete Bun.env.GH_HOST;
      else Bun.env.GH_HOST = host;
      Bun.env.GH_ENTERPRISE_TOKEN = 'TODO146-INVALID-HOST-TOKEN';
      catalogCalls = 0;

      const accounts = await runAccounts(provider());
      const status = await runStatus(provider());

      expect(accounts).toEqual([]);
      expect(status.state).toBe('misconfigured');
      expect(exposed(accounts)).not.toContain('TODO146-INVALID-HOST-TOKEN');
      expect(exposed(status)).not.toContain('TODO146-INVALID-HOST-TOKEN');
      expect(catalogCalls).toBe(2);
    }
  });

  test('uses a valid environment identity as the sole zero-catalog-read status fast path', async () => {
    Bun.env.GITHUB_TOKEN = 'TODO146-FAST-PATH-TOKEN';
    store.set(
      `aide:${authIndexSecretName('github')}`,
      '{"TODO146-FAST-PATH-INDEX":'
    );
    catalogEffect = Effect.fail(
      new GitHubAuthCatalogUnavailableError('timeout')
    );
    const calls = keyring.replace({ fail: () => true });

    const status = await runStatus(provider());

    expect(status).toEqual({
      state: 'configured',
      detail: 'configured via environment token',
    });
    expect(calls).toEqual([]);
    expect(catalogCalls).toBe(0);
    expect(exposed(status)).not.toContain('TODO146');
  });

  test('applies stored then gh failure priority and complete-catalog status rules', async () => {
    const scoped = {
      providerId: 'github',
      host: 'stored.example.com',
      account: 'service',
    } as const;
    const rawIndex = '{"TODO146-STATUS-INDEX":';
    store.set(`aide:${authIndexSecretName('github')}`, rawIndex);
    catalogEffect = Effect.succeed(
      catalogResult([{ host: 'github.com', account: 'healthy' }])
    );
    let status = await runStatus(provider());
    expect(status.state).toBe('misconfigured');
    expect(catalogCalls).toBe(0);
    expect(exposed(status)).not.toContain('TODO146-STATUS-INDEX');

    store.clear();
    catalogCalls = 0;
    keyring.replace({
      fail: (call) => call.name === authIndexSecretName('github'),
    });
    status = await runStatus(provider());
    expect(status.state).toBe('unavailable');
    expect(catalogCalls).toBe(0);

    keyring.replace();
    catalogCalls = 0;
    catalogEffect = Effect.fail(new GitHubAuthCatalogDocumentError());
    status = await runStatus(provider());
    expect(status.state).toBe('misconfigured');
    expect(catalogCalls).toBe(1);

    catalogCalls = 0;
    catalogEffect = Effect.fail(
      new GitHubAuthCatalogUnavailableError('command-failed')
    );
    status = await runStatus(provider());
    expect(status.state).toBe('unavailable');
    expect(catalogCalls).toBe(1);

    seedIndex([scoped]);
    seedScoped(scoped, scopedCredential(scoped, 'TODO146-SCOPED-STATUS'));
    catalogCalls = 0;
    const calls = keyring.replace();
    catalogEffect = Effect.succeed(catalogResult([], true));
    status = await runStatus(provider());
    expect(status.state).toBe('configured');
    expect(catalogCalls).toBe(1);
    expect(
      calls.filter(
        (call) =>
          call.operation === 'get' &&
          call.name === authIndexSecretName('github')
      )
    ).toHaveLength(1);
    expect(
      calls.filter((call) => call.operation === 'get' && call.name === 'github')
    ).toHaveLength(1);

    store.clear();
    catalogCalls = 0;
    catalogEffect = Effect.succeed(catalogResult([], true));
    status = await runStatus(provider());
    expect(status.state).toBe('misconfigured');

    catalogCalls = 0;
    catalogEffect = Effect.succeed(emptyCatalog);
    status = await runStatus(provider());
    expect(status).toEqual({
      state: 'not-configured',
      detail: "run 'aide login github' or authenticate with gh CLI",
    });
  });

  test('fails accounts closed for either stored-catalog or gh-catalog failure even when env is usable', async () => {
    Bun.env.GITHUB_TOKEN = 'TODO146-PARTIAL-ENV-TOKEN';
    const rawIndex = '{"TODO146-PARTIAL-INDEX":';
    store.set(`aide:${authIndexSecretName('github')}`, rawIndex);

    let result = await runAccountEither(provider());
    expect(result._tag).toBe('Left');
    expect(catalogCalls).toBe(0);
    if (result._tag === 'Left') {
      const rendered = exposed(result.left);
      expect(rendered).not.toContain('TODO146-PARTIAL-ENV-TOKEN');
      expect(rendered).not.toContain('TODO146-PARTIAL-INDEX');
    }

    store.clear();
    catalogCalls = 0;
    catalogEffect = Effect.fail(
      new GitHubAuthCatalogUnavailableError('spawn-failed')
    );
    result = await runAccountEither(provider());
    expect(result._tag).toBe('Left');
    expect(catalogCalls).toBe(1);
    if (result._tag === 'Left') {
      expect(exposed(result.left)).not.toContain('TODO146-PARTIAL-ENV-TOKEN');
    }

    catalogCalls = 0;
    catalogEffect = Effect.fail(new GitHubAuthCatalogDocumentError());
    result = await runAccountEither(provider());
    expect(result._tag).toBe('Left');
    expect(catalogCalls).toBe(1);
  });

  test('keeps exact-scope status and accounts on the exact resolver with zero catalog or broad key reads', async () => {
    const requested = {
      id: 'caller-id',
      providerId: 'github',
      host: 'requested.example.com',
    } as const;
    const other = {
      providerId: 'github',
      host: 'other.example.com',
    } as const;
    seedIndex([other]);
    seedScoped(other, scopedCredential(other, 'TODO146-OTHER-TOKEN'));
    store.set(
      'aide:github',
      JSON.stringify({ token: 'TODO146-LEGACY-BROADENING-TOKEN' })
    );
    catalogEffect = Effect.die(
      new Error('TODO146-CATALOG-MUST-NOT-RUN-FOR-EXACT-SCOPE')
    );
    const calls = keyring.replace();
    const capability = provider();

    const status = await runStatus(capability, { scope: requested });
    const accounts = await runAccounts(capability, { scope: requested });

    expect(status.state).toBe('not-configured');
    expect(accounts).toEqual([]);
    expect(catalogCalls).toBe(0);
    expect(calls).toEqual([
      { operation: 'get', name: canonicalId(requested) },
      { operation: 'get', name: canonicalId(requested) },
    ] satisfies readonly TestKeyringCall[]);
    expect(exposed([status, accounts])).not.toContain('TODO146');
  });

  test('retains custom probeConfig omitted-scope single-probe compatibility without catalog services', async () => {
    let probeCalls = 0;
    const capability = provider({
      probeConfig: async () => {
        probeCalls += 1;
        return { kind: 'env', value: { source: 'gh-cli' } } as const;
      },
    });
    catalogEffect = Effect.die(
      new Error('TODO146-CUSTOM-PROBE-CATALOG-MUST-NOT-RUN')
    );

    const status = await runStatus(capability);
    const accounts = await runAccounts(capability);

    expect(status).toEqual({
      state: 'configured',
      detail: 'authenticated via gh CLI',
    });
    expect(accounts).toEqual([
      {
        id: 'github.com:gh-cli',
        providerId: 'github',
        label: 'GitHub',
        detail: 'github.com configured via gh CLI',
        sourceKind: 'external',
        metadata: { authSource: 'gh-cli' },
        scope: {
          id: 'github.com',
          providerId: 'github',
          host: 'github.com',
          label: 'github.com',
          sourceKind: 'external',
          metadata: { authSource: 'gh-cli' },
        },
      },
    ]);
    expect(probeCalls).toBe(2);
    expect(catalogCalls).toBe(0);
  });

  test('keeps top-level auth, Prime, PR auth, login, and logout on keyring-only callbacks', async () => {
    store.set(
      'aide:github',
      JSON.stringify({ token: 'TODO146-LEGACY-CALLBACK-TOKEN' })
    );
    catalogEffect = Effect.die(
      new Error('TODO146-NON-PROVIDER-CATALOG-MUST-NOT-RUN')
    );
    const plugin = createGitHubPlugin({
      ghAuthProbe: unavailableGitHubAuthProbe,
    });
    const topLevel = plugin.capabilities?.auth;
    const prime = plugin.capabilities?.primeContribution?.status?.[0];
    const pullRequest = plugin.capabilities?.pullRequestProvider;
    const capability = plugin.capabilities?.authProvider;
    if (
      topLevel === undefined ||
      prime === undefined ||
      pullRequest === undefined ||
      capability?.operations?.login === undefined ||
      capability.operations.logout === undefined
    ) {
      throw new Error('missing GitHub compatibility callback');
    }

    const [topLevelStatus, primeStatus, pullRequestStatus] = await Promise.all([
      Effect.runPromise(topLevel.status().pipe(Effect.provide(keyring.layer))),
      Effect.runPromise(prime.status().pipe(Effect.provide(keyring.layer))),
      Effect.runPromise(
        pullRequest.authStatus().pipe(Effect.provide(keyring.layer))
      ),
    ]);
    const login = await Effect.runPromise(
      capability.operations
        .login({ values: { token: 'TODO146-NEW-LOGIN-TOKEN' } })
        .pipe(Effect.provide(keyring.layer))
    );
    const logout = await Effect.runPromise(
      capability.operations.logout().pipe(Effect.provide(keyring.layer))
    );

    expect(topLevelStatus).toEqual({
      state: 'configured',
      detail: 'configured via keyring token',
    });
    expect(primeStatus).toEqual(topLevelStatus);
    expect(pullRequestStatus).toEqual(topLevelStatus);
    expect(login).toEqual({
      status: 'stored',
      messages: ['Saved credentials for github.'],
    });
    expect(logout).toEqual({
      status: 'removed',
      messages: ['Removed stored credentials for github.'],
    });
    expect(catalogCalls).toBe(0);
    expect(
      exposed([topLevelStatus, primeStatus, pullRequestStatus])
    ).not.toContain('TODO146');
  });
});

// Compile-time proof that the real provider can retain the trusted combined
// environment for status/accounts while login/logout stay keyring-only.
function acceptsGitHubProvider(
  _provider: AideAuthProviderCapability<
    TrustedAuthDiscoveryServices,
    TrustedAuthDiscoveryServices,
    KeyringService,
    KeyringService
  >
): void {}

acceptsGitHubProvider(
  createGitHubPlugin({
    probeConfig: async () => ({ kind: 'missing' as const }),
  }).capabilities!.authProvider!
);
