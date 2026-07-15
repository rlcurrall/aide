import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Cause, Effect, Exit, Fiber, Layer, Option } from 'effect';
import yargs from 'yargs';

import type { AidePublicPluginDescriptor } from '@aide/plugin-api';
import {
  defineAidePlugin,
  type AideAuthProviderCapability,
  type AidePluginAuthStatus,
} from './plugin-descriptor.js';
import {
  runAuthProviderLoginWithLayer,
  runDynamicAuthProviderAccounts,
  runDynamicAuthProviderLogin,
  runDynamicAuthProviderLogout,
  runDynamicAuthProviderStatus,
} from '@cli/commands/auth-provider-command-utils.js';
import * as authEffectBridge from '@cli/commands/effect-bridge.js';
import {
  createKeyringCommandRegistry,
  type KeyringCommandRegistry,
  type TrustedAuthDiscoveryServices,
} from './command-registry.js';
import { registerCommands } from './yargs-adapter.js';
import { createAideInternalHostServices } from './runtime-context.js';
import { legacyAuthPlugin } from '@cli/plugins/legacy-auth/plugin.js';
import { createJiraPlugin } from '@cli/plugins/jira/plugin.js';
import { createGitHubPlugin } from '@cli/plugins/github/plugin.js';
import { createAzureDevOpsPlugin } from '@cli/plugins/azure-devops/plugin.js';
import { makeTestKeyring } from '@lib/auth-keyring.test-helper.js';
import {
  KeyringService,
  type KeyringSecretName,
  type KeyringServiceShape,
} from '@lib/auth-keyring.js';
import {
  GitHubAuthCatalogService,
  githubAuthCatalog,
  type GitHubAuthCatalogServiceShape,
} from '@lib/github-auth-catalog.js';
import { testGitHubAuthCatalogLayer } from '@lib/github-auth-catalog.test-helper.js';
import { unavailableGitHubAuthProbe } from '@lib/test-helpers.js';
import {
  getAuthProviderStatus,
  loginWithAuthProvider,
  logoutWithAuthProvider,
} from './auth-provider-operations.js';

const emptyCatalog = Object.freeze({
  identities: Object.freeze([]),
  hasUnhealthyActiveIdentity: false,
});

const spies: Array<{ mockRestore: () => void }> = [];

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

function jiraProvider() {
  const plugin = createJiraPlugin();
  const capability = plugin.capabilities?.authProvider;
  if (capability === undefined) throw new Error('missing Jira auth provider');
  return Object.freeze({
    provenance: 'trusted' as const,
    pluginId: plugin.id,
    capability,
  });
}

interface ProviderPlugin {
  readonly id: string;
  readonly capabilities?: {
    readonly authProvider?: AideAuthProviderCapability<
      TrustedAuthDiscoveryServices,
      TrustedAuthDiscoveryServices,
      KeyringService,
      KeyringService
    >;
  };
}

function authProvider(plugin: ProviderPlugin) {
  const capability = plugin.capabilities?.authProvider;
  if (capability === undefined) throw new Error('missing auth provider');
  return Object.freeze({
    provenance: 'trusted' as const,
    pluginId: plugin.id,
    capability,
  });
}

function authOnlyBuiltinRegistry(): KeyringCommandRegistry {
  return createKeyringCommandRegistry()
    .registerPlugin(createJiraPlugin())
    .registerPlugin(
      createGitHubPlugin({ ghAuthProbe: unavailableGitHubAuthProbe })
    )
    .registerPlugin(createAzureDevOpsPlugin())
    .registerPlugin(legacyAuthPlugin);
}

function inertKeyringService(): KeyringServiceShape {
  return Object.freeze({
    get: () => Effect.succeed(null),
    set: () => Effect.void,
    delete: () => Effect.succeed(false),
  });
}

function trustedCompositionRegistry(options: {
  readonly status: () => Effect.Effect<
    AidePluginAuthStatus,
    unknown,
    TrustedAuthDiscoveryServices
  >;
  readonly accounts?: () => Effect.Effect<
    readonly [],
    unknown,
    TrustedAuthDiscoveryServices
  >;
  readonly login?: () => Effect.Effect<
    { readonly status: 'stored' },
    unknown,
    KeyringService
  >;
  readonly logout?: () => Effect.Effect<
    { readonly status: 'removed' },
    unknown,
    KeyringService
  >;
}): KeyringCommandRegistry {
  return createKeyringCommandRegistry().registerPlugin(
    defineAidePlugin<
      KeyringService,
      TrustedAuthDiscoveryServices,
      TrustedAuthDiscoveryServices,
      KeyringService,
      KeyringService,
      KeyringService,
      KeyringService
    >({
      id: 'trusted-composition-probe',
      summary: 'Trusted auth discovery composition probe',
      commands: [],
      capabilities: {
        authProvider: {
          providerId: 'trusted-composition-probe',
          label: 'Trusted Composition Probe',
          login: {},
          logout: {},
          status: options.status,
          accounts: options.accounts ?? (() => Effect.succeed([])),
          operations: {
            login:
              options.login ?? (() => Effect.succeed({ status: 'stored' })),
            logout:
              options.logout ?? (() => Effect.succeed({ status: 'removed' })),
          },
        },
      },
    })
  );
}

function trustedProviderFrom(
  services: ReturnType<typeof createAideInternalHostServices>
) {
  const provider = services.authProviderRegistrations()[0];
  if (provider === undefined || provider.provenance !== 'trusted') {
    throw new Error('missing trusted composition provider');
  }
  return provider;
}

function countedCompositionHarness(
  statusBody: () => Effect.Effect<AidePluginAuthStatus, unknown>
) {
  const counts = {
    keyringConstructions: 0,
    keyringAcquisitions: 0,
    keyringReleases: 0,
    catalogConstructions: 0,
    catalogAcquisitions: 0,
    catalogReleases: 0,
  };
  const keyringService = inertKeyringService();
  const catalogService: GitHubAuthCatalogServiceShape = Object.freeze({
    discover: Effect.succeed(emptyCatalog),
  });
  const keyringLayer = Layer.scoped(
    KeyringService,
    Effect.gen(function* () {
      counts.keyringConstructions += 1;
      return yield* Effect.acquireRelease(
        Effect.sync(() => {
          counts.keyringAcquisitions += 1;
          return keyringService;
        }),
        () =>
          Effect.sync(() => {
            counts.keyringReleases += 1;
          })
      );
    })
  );
  const catalogLayer = Layer.scoped(
    GitHubAuthCatalogService,
    Effect.gen(function* () {
      counts.catalogConstructions += 1;
      return yield* Effect.acquireRelease(
        Effect.sync(() => {
          counts.catalogAcquisitions += 1;
          return catalogService;
        }),
        () =>
          Effect.sync(() => {
            counts.catalogReleases += 1;
          })
      );
    })
  );
  const registry = trustedCompositionRegistry({
    status: () =>
      Effect.zipRight(
        Effect.all([KeyringService, GitHubAuthCatalogService]),
        statusBody()
      ),
  });
  const services = createAideInternalHostServices(
    registry,
    keyringLayer,
    catalogLayer
  );
  return {
    counts,
    provider: trustedProviderFrom(services),
    services,
  };
}

function expectOneCombinedLifecycle(
  counts: ReturnType<typeof countedCompositionHarness>['counts']
): void {
  expect(counts).toEqual({
    keyringConstructions: 1,
    keyringAcquisitions: 1,
    keyringReleases: 1,
    catalogConstructions: 1,
    catalogAcquisitions: 1,
    catalogReleases: 1,
  });
}

async function exerciseInjectedProvider(options: {
  readonly plugin: ProviderPlugin;
  readonly initialName: string;
  readonly initialValue: string;
  readonly loginValues: Readonly<Record<string, string>>;
}): Promise<void> {
  const keyring = makeTestKeyring(
    new Map([[`aide:${options.initialName}`, options.initialValue]])
  );
  const provider = authProvider(options.plugin);
  const discoveryLayer = Layer.merge(keyring.layer, testGitHubAuthCatalogLayer);

  expect(
    await Effect.runPromise(
      getAuthProviderStatus(provider).pipe(Effect.provide(discoveryLayer))
    )
  ).toMatchObject({ state: 'configured' });
  expect(
    await Effect.runPromise(
      loginWithAuthProvider(provider, {
        values: options.loginValues,
      }).pipe(Effect.provide(keyring.layer))
    )
  ).toMatchObject({ status: 'stored' });
  expect(
    await Effect.runPromise(
      logoutWithAuthProvider(provider).pipe(Effect.provide(keyring.layer))
    )
  ).toMatchObject({ status: 'removed' });
  expect(keyring.store.has(`aide:${options.initialName}`)).toBe(false);
}

describe('trusted auth-provider keyring composition', () => {
  test('requires registerCommands callers to pass an explicit catalog layer', () => {
    type Options = Parameters<typeof registerCommands>[2];
    const requiresCatalog: 'githubAuthCatalogLayer' extends keyof Options
      ? true
      : false = true;
    const missingCatalogLayerDoesNotCompile = () => {
      // @ts-expect-error Command registration has no hidden GitHub catalog layer.
      registerCommands(yargs([]), createKeyringCommandRegistry(), {
        keyringLayer: makeTestKeyring().layer,
      });
    };
    expect(requiresCatalog).toBe(true);
    expect(missingCatalogLayerDoesNotCompile).toBeFunction();
  });

  test('trusted status and accounts receive the exact injected keyring and catalog services', async () => {
    const keyringService = inertKeyringService();
    const catalogService: GitHubAuthCatalogServiceShape = Object.freeze({
      discover: Effect.succeed(emptyCatalog),
    });
    const observations: Array<
      readonly [KeyringServiceShape, GitHubAuthCatalogServiceShape]
    > = [];
    const observe = () =>
      Effect.map(
        Effect.all([KeyringService, GitHubAuthCatalogService]),
        ([keyring, catalog]) => {
          observations.push([keyring, catalog]);
        }
      );
    const registry = trustedCompositionRegistry({
      status: () => Effect.as(observe(), { state: 'configured' as const }),
      accounts: () => Effect.as(observe(), [] as const),
    });
    const services = createAideInternalHostServices(
      registry,
      Layer.succeed(KeyringService, keyringService),
      Layer.succeed(GitHubAuthCatalogService, catalogService)
    );
    const provider = trustedProviderFrom(services);

    await runDynamicAuthProviderStatus(provider, services);
    await runDynamicAuthProviderAccounts(provider, services);

    expect(observations).toHaveLength(2);
    for (const [keyring, catalog] of observations) {
      expect(keyring).toBe(keyringService);
      expect(catalog).toBe(catalogService);
    }
  });

  test('one trusted status operation builds and finalizes each combined layer once on success, failure, timeout, and interruption', async () => {
    const success = countedCompositionHarness(() =>
      Effect.succeed({ state: 'configured' })
    );
    await runDynamicAuthProviderStatus(success.provider, success.services);
    expectOneCombinedLifecycle(success.counts);

    const typedFailure = new Error('synthetic typed failure');
    const failure = countedCompositionHarness(() => Effect.fail(typedFailure));
    await expect(
      runDynamicAuthProviderStatus(failure.provider, failure.services)
    ).rejects.toThrow();
    expectOneCombinedLifecycle(failure.counts);

    const timeout = countedCompositionHarness(() => Effect.never);
    const timeoutExit = await Effect.runPromiseExit(
      timeout.services.provideTrustedAuthDiscovery(
        getAuthProviderStatus(timeout.provider, {}, { operationTimeout: 1 })
      )
    );
    expect(Exit.isFailure(timeoutExit)).toBe(true);
    expectOneCombinedLifecycle(timeout.counts);

    let entered!: () => void;
    const operationEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const interrupted = countedCompositionHarness(() =>
      Effect.zipRight(Effect.sync(entered), Effect.never)
    );
    const fiber = Effect.runFork(
      interrupted.services.provideTrustedAuthDiscovery(
        getAuthProviderStatus(interrupted.provider)
      )
    );
    await operationEntered;
    const interruptExit = await Effect.runPromise(Fiber.interrupt(fiber));
    expect(Exit.isFailure(interruptExit)).toBe(true);
    if (Exit.isFailure(interruptExit)) {
      expect(Cause.isInterruptedOnly(interruptExit.cause)).toBe(true);
    }
    expectOneCombinedLifecycle(interrupted.counts);
  });

  test('trusted login and logout receive only keyring even when hostile code probes for the catalog service', async () => {
    const keyringService = inertKeyringService();
    let catalogLayerAcquisitions = 0;
    const observations: Array<
      readonly [
        KeyringServiceShape,
        Option.Option<GitHubAuthCatalogServiceShape>,
      ]
    > = [];
    const observe = () =>
      Effect.flatMap(KeyringService, (keyring) =>
        Effect.map(
          Effect.serviceOption(GitHubAuthCatalogService),
          (catalog) => {
            observations.push([keyring, catalog]);
          }
        )
      );
    const registry = trustedCompositionRegistry({
      status: () => Effect.succeed({ state: 'configured' }),
      login: () => Effect.as(observe(), { status: 'stored' as const }),
      logout: () => Effect.as(observe(), { status: 'removed' as const }),
    });
    const catalogLayer = Layer.scoped(
      GitHubAuthCatalogService,
      Effect.acquireRelease(
        Effect.sync(() => {
          catalogLayerAcquisitions += 1;
          return Object.freeze({ discover: Effect.succeed(emptyCatalog) });
        }),
        () => Effect.void
      )
    );
    const services = createAideInternalHostServices(
      registry,
      Layer.succeed(KeyringService, keyringService),
      catalogLayer
    );
    const provider = trustedProviderFrom(services);

    await runDynamicAuthProviderLogin(provider, {}, services);
    await runDynamicAuthProviderLogout(provider, services);

    expect(observations).toHaveLength(2);
    for (const [keyring, catalog] of observations) {
      expect(keyring).toBe(keyringService);
      expect(Option.isNone(catalog)).toBe(true);
    }
    expect(catalogLayerAcquisitions).toBe(0);
  });

  test('legacy auth, Prime status, and pull-request auth remain keyring-only', async () => {
    const keyringService = inertKeyringService();
    let catalogLayerAcquisitions = 0;
    let catalogDiscoveries = 0;
    const github = createGitHubPlugin({
      ghAuthProbe: unavailableGitHubAuthProbe,
    });
    const registry = createKeyringCommandRegistry().registerPlugin(github);
    const services = createAideInternalHostServices(
      registry,
      Layer.succeed(KeyringService, keyringService),
      Layer.scoped(
        GitHubAuthCatalogService,
        Effect.acquireRelease(
          Effect.sync(() => {
            catalogLayerAcquisitions += 1;
            return Object.freeze({
              discover: Effect.sync(() => {
                catalogDiscoveries += 1;
                return emptyCatalog;
              }),
            });
          }),
          () => Effect.void
        )
      )
    );
    const legacyAuth = registry.capabilities.auth()[0]?.capability;
    const primeStatus =
      registry.capabilities.primeContributions()[0]?.capability.status?.[0];
    const pullRequestAuth =
      registry.capabilities.pullRequestProviders()[0]?.capability;
    if (
      legacyAuth === undefined ||
      primeStatus === undefined ||
      pullRequestAuth === undefined
    ) {
      throw new Error('missing legacy, Prime, or pull-request auth probe');
    }

    await Effect.runPromise(
      services.provideTrustedKeyring(legacyAuth.status())
    );
    await Effect.runPromise(
      services.provideTrustedKeyring(primeStatus.status())
    );
    await Effect.runPromise(
      services.provideTrustedKeyring(pullRequestAuth.authStatus())
    );

    expect(catalogLayerAcquisitions).toBe(0);
    expect(catalogDiscoveries).toBe(0);
  });

  test('providing the catalog layer is lazy until an effect asks the service to discover', async () => {
    let discoveries = 0;
    const catalogService: GitHubAuthCatalogServiceShape = Object.freeze({
      discover: Effect.sync(() => {
        discoveries += 1;
        return emptyCatalog;
      }),
    });
    const registry = trustedCompositionRegistry({
      status: () =>
        Effect.as(GitHubAuthCatalogService, { state: 'configured' as const }),
    });
    const services = createAideInternalHostServices(
      registry,
      Layer.succeed(KeyringService, inertKeyringService()),
      Layer.succeed(GitHubAuthCatalogService, catalogService)
    );
    const provider = trustedProviderFrom(services);

    expect(discoveries).toBe(0);
    await runDynamicAuthProviderStatus(provider, services);
    expect(discoveries).toBe(0);
    await Effect.runPromise(
      services.provideTrustedAuthDiscovery(githubAuthCatalog)
    );
    expect(discoveries).toBe(1);
  });

  test('built-in yargs login/logout acquire exactly one injected keyring layer per operation', async () => {
    const bunGet = spyOn(Bun.secrets, 'get').mockImplementation(async () => {
      throw new Error('Bun.secrets.get must not run');
    });
    const bunSet = spyOn(Bun.secrets, 'set').mockImplementation(async () => {
      throw new Error('Bun.secrets.set must not run');
    });
    const bunDelete = spyOn(Bun.secrets, 'delete').mockImplementation(
      async () => {
        throw new Error('Bun.secrets.delete must not run');
      }
    );
    const deprecatedLiveAdapter = spyOn(
      authEffectBridge,
      'runLiveAuthProviderCommandEffect'
    );
    spies.push(bunGet, bunSet, bunDelete, deprecatedLiveAdapter);

    const counts = { constructions: 0, acquisitions: 0, releases: 0 };
    const calls: Array<
      | { readonly operation: 'get'; readonly name: string }
      | { readonly operation: 'set'; readonly name: string }
      | { readonly operation: 'delete'; readonly name: string }
    > = [];
    const store = new Map<string, string>();
    const service: KeyringServiceShape = {
      get: (name: KeyringSecretName) =>
        Effect.sync(() => {
          calls.push({ operation: 'get', name });
          return store.get(name) ?? null;
        }),
      set: (name: KeyringSecretName, value: string) =>
        Effect.sync(() => {
          calls.push({ operation: 'set', name });
          store.set(name, value);
        }),
      delete: (name: KeyringSecretName) =>
        Effect.sync(() => {
          calls.push({ operation: 'delete', name });
          return store.delete(name);
        }),
    };
    const keyringLayer = Layer.scoped(
      KeyringService,
      Effect.gen(function* () {
        counts.constructions += 1;
        return yield* Effect.acquireRelease(
          Effect.sync(() => {
            counts.acquisitions += 1;
            return service;
          }),
          () =>
            Effect.sync(() => {
              counts.releases += 1;
            })
        );
      })
    );
    const registry = authOnlyBuiltinRegistry();
    const operations = [
      [
        'login',
        'jira',
        '--url',
        'https://example.atlassian.net',
        '--email',
        'dev@example.com',
        '--token',
        'jira-token',
      ],
      ['logout', 'jira'],
      ['login', 'github', '--token', 'github-token'],
      ['logout', 'github'],
      [
        'login',
        'ado',
        '--org-url',
        'https://dev.azure.com/example',
        '--pat',
        'ado-token',
        '--auth-method',
        'pat',
      ],
      ['logout', 'ado'],
    ] as const;

    for (const [index, args] of operations.entries()) {
      await registerCommands(
        yargs([...args])
          .scriptName('aide')
          .exitProcess(false),
        registry,
        {
          keyringLayer,
          githubAuthCatalogLayer: testGitHubAuthCatalogLayer,
        }
      )
        .strict()
        .parseAsync();

      const expected = index + 1;
      expect(counts).toEqual({
        constructions: expected,
        acquisitions: expected,
        releases: expected,
      });
    }

    expect(calls.filter((call) => call.operation === 'get')).toHaveLength(1);
    expect(calls.filter((call) => call.operation === 'set')).toHaveLength(3);
    expect(calls.filter((call) => call.operation === 'delete')).toHaveLength(3);
    expect(store.size).toBe(0);
    expect(bunGet).not.toHaveBeenCalled();
    expect(bunSet).not.toHaveBeenCalled();
    expect(bunDelete).not.toHaveBeenCalled();
    expect(deprecatedLiveAdapter).not.toHaveBeenCalled();
  });

  test('Jira status, login, and delete use only the injected keyring', async () => {
    const bunGet = spyOn(Bun.secrets, 'get').mockImplementation(async () => {
      throw new Error('Bun.secrets.get must not run');
    });
    const bunSet = spyOn(Bun.secrets, 'set').mockImplementation(async () => {
      throw new Error('Bun.secrets.set must not run');
    });
    const bunDelete = spyOn(Bun.secrets, 'delete').mockImplementation(
      async () => {
        throw new Error('Bun.secrets.delete must not run');
      }
    );
    spies.push(bunGet, bunSet, bunDelete);

    await exerciseInjectedProvider({
      plugin: createJiraPlugin(),
      initialName: 'jira',
      initialValue: JSON.stringify({
        url: 'https://example.atlassian.net',
        email: 'dev@example.com',
        apiToken: 'old-token',
      }),
      loginValues: {
        url: 'https://example.atlassian.net',
        email: 'dev@example.com',
        token: 'new-token',
      },
    });
    expect(bunGet).not.toHaveBeenCalled();
    expect(bunSet).not.toHaveBeenCalled();
    expect(bunDelete).not.toHaveBeenCalled();
  });

  test('GitHub status uses injected discovery while login and delete stay on the injected keyring', async () => {
    const bunGet = spyOn(Bun.secrets, 'get').mockRejectedValue(
      new Error('Bun.secrets.get must not run')
    );
    const bunSet = spyOn(Bun.secrets, 'set').mockRejectedValue(
      new Error('Bun.secrets.set must not run')
    );
    const bunDelete = spyOn(Bun.secrets, 'delete').mockRejectedValue(
      new Error('Bun.secrets.delete must not run')
    );
    spies.push(bunGet, bunSet, bunDelete);

    await exerciseInjectedProvider({
      plugin: createGitHubPlugin({
        ghAuthProbe: unavailableGitHubAuthProbe,
      }),
      initialName: 'github',
      initialValue: JSON.stringify({ token: 'old-token' }),
      loginValues: { token: 'new-token' },
    });
    expect(bunGet).not.toHaveBeenCalled();
    expect(bunSet).not.toHaveBeenCalled();
    expect(bunDelete).not.toHaveBeenCalled();
  });

  test('Azure DevOps status, login, and delete use only the injected keyring', async () => {
    const bunGet = spyOn(Bun.secrets, 'get').mockRejectedValue(
      new Error('Bun.secrets.get must not run')
    );
    const bunSet = spyOn(Bun.secrets, 'set').mockRejectedValue(
      new Error('Bun.secrets.set must not run')
    );
    const bunDelete = spyOn(Bun.secrets, 'delete').mockRejectedValue(
      new Error('Bun.secrets.delete must not run')
    );
    spies.push(bunGet, bunSet, bunDelete);

    await exerciseInjectedProvider({
      plugin: createAzureDevOpsPlugin(),
      initialName: 'ado',
      initialValue: JSON.stringify({
        orgUrl: 'https://dev.azure.com/example',
        pat: 'old-token',
        authMethod: 'pat',
      }),
      loginValues: {
        orgUrl: 'https://dev.azure.com/example',
        pat: 'new-token',
        authMethod: 'pat',
      },
    });
    expect(bunGet).not.toHaveBeenCalled();
    expect(bunSet).not.toHaveBeenCalled();
    expect(bunDelete).not.toHaveBeenCalled();
  });

  test('built-in reads and mutations use an injected keyring without Bun.secrets fallback', async () => {
    const bunGet = spyOn(Bun.secrets, 'get');
    const bunSet = spyOn(Bun.secrets, 'set');
    spies.push(bunGet, bunSet);

    const keyring = makeTestKeyring(
      new Map([
        [
          'aide:jira',
          JSON.stringify({
            url: 'https://example.atlassian.net',
            email: 'dev@example.com',
            apiToken: 'old-token',
          }),
        ],
      ])
    );
    const provider = jiraProvider();

    const status = await Effect.runPromise(
      getAuthProviderStatus(provider).pipe(Effect.provide(keyring.layer))
    );
    const login = await Effect.runPromise(
      loginWithAuthProvider(provider, {
        values: {
          url: 'https://example.atlassian.net',
          email: 'dev@example.com',
          token: 'new-token',
        },
      }).pipe(Effect.provide(keyring.layer))
    );

    expect(status.state).toBe('configured');
    expect(login.status).toBe('stored');
    expect(JSON.parse(keyring.store.get('aide:jira') ?? '{}')).toMatchObject({
      apiToken: 'new-token',
    });
    expect(bunGet).not.toHaveBeenCalled();
    expect(bunSet).not.toHaveBeenCalled();
  });

  test('core invocation retains KeyringService as a composition requirement', () => {
    const effect = loginWithAuthProvider(jiraProvider(), {
      values: {
        url: 'https://example.atlassian.net',
        email: 'dev@example.com',
        token: 'token',
      },
    });

    const environment: Effect.Effect.Context<
      typeof effect
    > extends KeyringService
      ? true
      : false = true;
    expect(environment).toBe(true);

    const acceptsRunnableEffect = (
      _effect: Effect.Effect<unknown, unknown, never>
    ): void => {};
    // @ts-expect-error The injectable core is not runnable until the host provides KeyringService.
    acceptsRunnableEffect(effect);
  });

  test('the external plugin descriptor remains service-free', () => {
    type PublicCapabilities = NonNullable<
      AidePublicPluginDescriptor['capabilities']
    >;
    type PublicAuthProvider = NonNullable<PublicCapabilities['authProvider']>;
    type PublicEnvironment = Effect.Effect.Context<
      ReturnType<PublicAuthProvider['status']>
    >;

    const serviceFree: [PublicEnvironment] extends [never] ? true : false =
      true;
    expect(serviceFree).toBe(true);
  });

  test('the standalone adapter accepts an injected keyring layer', async () => {
    const values = new Map<string, string>();
    const keyring = makeTestKeyring(values);

    const result = await runAuthProviderLoginWithLayer(
      jiraProvider(),
      {
        values: {
          url: 'https://example.atlassian.net',
          email: 'dev@example.com',
          token: 'injected-token',
        },
      },
      keyring.layer
    );

    expect(result.status).toBe('stored');
    expect(JSON.parse(values.get('aide:jira') ?? '{}')).toMatchObject({
      apiToken: 'injected-token',
    });
  });
});
