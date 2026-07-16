import { describe, expect, test } from 'bun:test';
import { Context, Effect } from 'effect';

import {
  createCommandRegistry,
  createKeyringCommandRegistry,
} from './command-registry.js';
import {
  defineAidePlugin,
  type AidePluginDescriptor,
  type AidePluginAuthStatus,
  type AidePullRequestListRequest,
} from './plugin-descriptor.js';
import {
  createAideHostServices,
  createAideInternalHostServices,
} from './runtime-context.js';
import { createBuiltinCommandRegistry } from '@cli/plugins/builtin.js';
import { KeyringService } from '@lib/auth-keyring.js';
import { makeTestKeyring } from '@lib/auth-keyring.test-helper.js';
import { testGitHubAuthCatalogLayer } from '@lib/github-auth-catalog.test-helper.js';

class AlternateAuthStatusService extends Context.Tag(
  'aide.test.AlternateAuthStatusService'
)<AlternateAuthStatusService, { readonly configured: boolean }>() {}

function pullRequestPlugin<R>(
  id: string,
  authStatus: () => Effect.Effect<AidePluginAuthStatus, unknown, R>
): AidePluginDescriptor<never, never, never, never, never, never, R> {
  return defineAidePlugin<never, never, never, never, never, never, R>({
    id,
    summary: `${id} pull request provider`,
    commands: [],
    capabilities: {
      pullRequestProvider: {
        providerId: id,
        priority: 100,
        features: {},
        matchRemote: () => ({
          source: 'git-remote',
          repository: {
            kind: 'external',
            providerId: id,
            displayName: id,
          },
        }),
        matchPullRequestUrl: () => null,
        authStatus,
      },
    },
  });
}

describe('public AideHostServices construction', () => {
  test('requires an explicit catalog layer and keeps internal provisioners out of public services', async () => {
    const registry = createKeyringCommandRegistry();
    const keyringLayer = makeTestKeyring().layer;
    const missingCatalogLayerDoesNotCompile = () => {
      // @ts-expect-error Trusted host construction has no hidden GitHub catalog layer.
      createAideInternalHostServices(registry, keyringLayer);
    };
    const internal = createAideInternalHostServices(
      registry,
      keyringLayer,
      testGitHubAuthCatalogLayer
    );
    const publicKeys = Reflect.ownKeys(internal.publicServices);

    expect(publicKeys).not.toContain('provideTrustedKeyring');
    expect(publicKeys).not.toContain('provideTrustedAuthDiscovery');
    expect(publicKeys).not.toContain('keyringLayer');
    expect(publicKeys).not.toContain('githubAuthCatalogLayer');
    expect(publicKeys).not.toContain('withPullRequestAuthScopeSelector');
    expect(missingCatalogLayerDoesNotCompile).toBeFunction();
    expect(JSON.stringify(internal.publicServices)).not.toContain(
      'GitHubAuthCatalog'
    );

    const indexSource = await Bun.file(
      new URL('../index.ts', import.meta.url)
    ).text();
    expect(indexSource).toContain(
      'githubAuthCatalogLayer: GitHubAuthCatalogLive'
    );
  });

  test('keeps synthetic PR auth selection on an internal closure-only invocation wrapper', async () => {
    const order: string[] = [];
    let observedRequest: AidePullRequestListRequest | undefined;
    const repository = Object.freeze({
      kind: 'external' as const,
      providerId: 'internal-selection',
      displayName: 'Internal selection',
    });
    const registry = createKeyringCommandRegistry().registerPlugin(
      defineAidePlugin({
        id: 'internal-selection',
        summary: 'Internal selection provider',
        commands: [],
        capabilities: {
          pullRequestProvider: {
            providerId: 'internal-selection',
            priority: 100,
            features: {},
            authStatus: () => Effect.succeed({ state: 'configured' }),
            matchRemote: () => {
              order.push('provider-resolution');
              return { source: 'git-remote', repository };
            },
            matchPullRequestUrl: () => null,
            operations: {
              listPullRequests: (request) => {
                order.push('provider-operation');
                observedRequest = request;
                return Effect.succeed({ repository, pullRequests: [] });
              },
            },
          },
        },
      })
    );
    const internal = createAideInternalHostServices(
      registry,
      makeTestKeyring().layer,
      testGitHubAuthCatalogLayer
    );
    const publicServices = createAideHostServices(registry);
    const publicSelectorDoesNotCompile = () => {
      // @ts-expect-error Public host services cannot install authentication selectors.
      publicServices.withPullRequestAuthScopeSelector(() =>
        Effect.succeed(undefined)
      );
    };
    const selected = internal.withPullRequestAuthScopeSelector((provider) => {
      order.push('auth-selection');
      expect(provider.providerId).toBe('internal-selection');
      expect(Object.isFrozen(provider)).toBe(true);
      expect('capability' in provider).toBe(false);
      return Effect.succeed({
        id: 'internal-selection:host:example.test:account:ada',
        providerId: 'internal-selection',
        host: 'example.test',
        account: 'ada',
      });
    });

    await Effect.runPromise(
      selected.listPullRequestsForRemote('ssh://example.test/acme/widgets.git')
    );

    expect(order).toEqual([
      'provider-resolution',
      'auth-selection',
      'provider-operation',
    ]);
    expect(observedRequest?.authScope).toEqual({
      id: 'internal-selection:host:example.test:account:ada',
      providerId: 'internal-selection',
      host: 'example.test',
      account: 'ada',
    });
    expect(Object.isFrozen(observedRequest?.authScope)).toBe(true);
    expect('withPullRequestAuthScopeSelector' in selected).toBe(false);
    expect('withPullRequestAuthScopeSelector' in internal.publicServices).toBe(
      false
    );
    expect(publicSelectorDoesNotCompile).toBeFunction();
  });

  test('resolves PR providers from service-free registries', async () => {
    const registry = createCommandRegistry().registerPlugin(
      pullRequestPlugin('service-free-pr', () =>
        Effect.succeed({ state: 'configured' })
      )
    );

    const result = await Effect.runPromise(
      createAideHostServices(registry).resolvePullRequestProviderForRemote(
        'git@example.test:acme/widgets.git'
      )
    );

    expect(result.providerId).toBe('service-free-pr');
  });

  test('resolves PR providers from the built-in keyring registry', async () => {
    const services = createAideHostServices(createBuiltinCommandRegistry());
    const result = await Effect.runPromise(
      services.resolvePullRequestProviderForRemote(
        'https://github.com/acme/widgets.git'
      )
    );

    expect(result.providerId).toBe('github');
    expect('trustedAuthProviders' in services).toBe(false);
    expect('publicServices' in services).toBe(false);
  });

  test('resolves PR providers from mixed-environment registries', async () => {
    const registry = createCommandRegistry<
      never,
      KeyringService,
      never,
      never,
      never,
      never,
      never
    >()
      .registerPlugin(
        defineAidePlugin<
          never,
          KeyringService,
          never,
          never,
          never,
          never,
          never
        >({
          id: 'mixed-auth',
          summary: 'Mixed auth environments',
          commands: [],
          capabilities: {
            authProvider: {
              providerId: 'mixed-auth',
              label: 'Mixed Auth',
              status: () =>
                Effect.map(KeyringService, () => ({
                  state: 'configured' as const,
                })),
            },
          },
        })
      )
      .registerPlugin(
        pullRequestPlugin('mixed-pr', () =>
          Effect.succeed({ state: 'configured' })
        )
      );

    const services = createAideHostServices(registry);
    const result = await Effect.runPromise(
      services.resolvePullRequestProviderForRemote(
        'git@example.test:acme/widgets.git'
      )
    );

    expect(result.providerId).toBe('mixed-pr');
    expect(services.authProviders()[0]?.capability.providerId).toBe(
      'mixed-auth'
    );
    expect('status' in services.authProviders()[0]!.capability).toBe(false);
  });

  test('does not require a non-keyring PR auth-status service to resolve', async () => {
    const registry = createCommandRegistry<
      never,
      never,
      never,
      never,
      never,
      never,
      AlternateAuthStatusService
    >().registerPlugin(
      pullRequestPlugin('alternate-auth-pr', () =>
        Effect.map(AlternateAuthStatusService, ({ configured }) => ({
          state: configured
            ? ('configured' as const)
            : ('not-configured' as const),
        }))
      )
    );

    const result = await Effect.runPromise(
      createAideHostServices(registry).resolvePullRequestProviderForRemote(
        'git@example.test:acme/widgets.git'
      )
    );

    expect(result.providerId).toBe('alternate-auth-pr');
  });

  test('constructs public services from an empty keyring registry', () => {
    const services = createAideHostServices(createKeyringCommandRegistry());

    expect(services.authProviders()).toEqual([]);
    expect(services.primeContributions()).toEqual([]);
  });
});
