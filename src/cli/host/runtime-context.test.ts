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
} from './plugin-descriptor.js';
import { createAideHostServices } from './runtime-context.js';
import { createBuiltinCommandRegistry } from '@cli/plugins/builtin.js';
import { KeyringService } from '@lib/auth-keyring.js';

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
