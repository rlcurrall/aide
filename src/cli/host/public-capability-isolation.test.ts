import { describe, expect, test } from 'bun:test';
import { Context, Effect, Option } from 'effect';
import yargs from 'yargs';

import {
  AIDE_PLUGIN_API_VERSION,
  defineAidePlugin as definePublicAidePlugin,
} from '@aide/plugin-api';
import {
  createKeyringCommandRegistry,
  type KeyringCommandRegistry,
} from '@cli/host/command-registry.js';
import {
  getAideHostContext,
  createAideInternalHostServices,
  type AideInternalHostServices,
} from '@cli/host/runtime-context.js';
import { registerCommands } from '@cli/host/yargs-adapter.js';
import {
  runDynamicAuthProviderAccounts,
  runDynamicAuthProviderLogin,
  runDynamicAuthProviderLogout,
  runDynamicAuthProviderStatus,
} from '@cli/commands/auth-provider-command-utils.js';
import { AuthProviderOperationError } from '@cli/host/auth-provider-operations.js';
import { buildPrimeOutput } from '@cli/plugins/aide-core/prime.js';
import { aideCorePlugin } from '@cli/plugins/aide-core/plugin.js';
import { legacyAuthPlugin } from '@cli/plugins/legacy-auth/plugin.js';
import type {
  AideAuthAccount,
  AideAuthLoginResult,
  AideAuthLogoutResult,
  AidePluginAuthStatus,
  AidePrimeSection,
} from '@cli/host/plugin-descriptor.js';
import type { KeyringServiceShape } from '@lib/auth-keyring.js';
import { makeTestKeyring } from '@lib/auth-keyring.test-helper.js';

class ShadowKeyringService extends Context.Tag('aide/KeyringService')<
  ShadowKeyringService,
  KeyringServiceShape
>() {}

class ShadowInternalHostServices extends Context.Tag(
  'AideInternalHostServices'
)<ShadowInternalHostServices, AideInternalHostServices>() {}

const fakeSecret = 'FAKE-SECRET';

function observeInjectedKeyring<A>(
  observations: Map<string, string | null>,
  internalHostObservations: Map<string, boolean>,
  operation: string,
  result: A
): Effect.Effect<A, never, never> {
  return Effect.all([
    Effect.serviceOption(ShadowKeyringService).pipe(
      Effect.flatMap((keyring) =>
        Option.match(keyring, {
          onNone: () => Effect.sync(() => observations.set(operation, null)),
          onSome: (service) =>
            service.get('jira').pipe(
              Effect.tap((secret) =>
                Effect.sync(() => observations.set(operation, secret))
              ),
              Effect.catchAll(() =>
                Effect.sync(() => observations.set(operation, null))
              )
            ),
        })
      )
    ),
    Effect.serviceOption(ShadowInternalHostServices).pipe(
      Effect.tap((services) =>
        Effect.sync(() =>
          internalHostObservations.set(operation, Option.isSome(services))
        )
      )
    ),
  ]).pipe(Effect.as(result)) as Effect.Effect<A, never, never>;
}

function externalManifest(
  id: string,
  capabilities: readonly ('auth-provider' | 'prime-contribution')[]
) {
  return {
    id,
    version: '1.0.0',
    aidePluginApiVersion: AIDE_PLUGIN_API_VERSION,
    capabilities,
  } as const;
}

function registerWithFakeKeyring(
  registry: KeyringCommandRegistry,
  args: readonly string[]
) {
  const keyring = makeTestKeyring(new Map([['aide:jira', fakeSecret]]));
  return registerCommands(
    yargs([...args])
      .scriptName('aide')
      .exitProcess(false),
    registry,
    { keyringLayer: keyring.layer }
  )
    .strict()
    .parseAsync();
}

describe('public capability runtime isolation', () => {
  test('external registry snapshots replay with provenance and remain isolated', async () => {
    const observations = new Map<string, string | null>();
    const internalHostObservations = new Map<string, boolean>();
    const source = createKeyringCommandRegistry();
    source.registerExternalPlugin(
      definePublicAidePlugin({
        id: 'external-replay-probe',
        summary: 'External replay isolation probe',
        commands: [],
        capabilities: {
          authProvider: {
            providerId: 'external-replay',
            label: 'External Replay',
            login: { fields: [], summary: 'Probe replayed login' },
            logout: { summary: 'Probe replayed logout' },
            status: () =>
              observeInjectedKeyring(
                observations,
                internalHostObservations,
                'replay-status',
                { state: 'configured' as const }
              ),
            accounts: () =>
              observeInjectedKeyring<readonly AideAuthAccount[]>(
                observations,
                internalHostObservations,
                'replay-accounts',
                [{ id: 'replay-account', label: 'Replay account' }]
              ),
            operations: {
              login: () =>
                observeInjectedKeyring<AideAuthLoginResult>(
                  observations,
                  internalHostObservations,
                  'replay-login',
                  { status: 'stored' }
                ),
              logout: () =>
                observeInjectedKeyring<AideAuthLogoutResult>(
                  observations,
                  internalHostObservations,
                  'replay-logout',
                  { status: 'removed' }
                ),
            },
          },
          primeContribution: {
            status: [
              {
                groupId: 'external-replay',
                groupLabel: 'External Replay',
                label: 'External Replay',
                status: () =>
                  observeInjectedKeyring(
                    observations,
                    internalHostObservations,
                    'replay-prime-status',
                    { state: 'configured' as const }
                  ),
              },
            ],
            sections: () =>
              observeInjectedKeyring<readonly AidePrimeSection[]>(
                observations,
                internalHostObservations,
                'replay-prime-sections',
                [{ id: 'external-replay', body: '## External Replay' }]
              ),
          },
        },
      }),
      {
        manifest: externalManifest('external-replay-probe', [
          'auth-provider',
          'prime-contribution',
        ]),
      }
    );

    const snapshot = source.plugins()[0];
    expect(snapshot).toBeDefined();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot?.commands)).toBe(true);
    expect(
      Object.isFrozen(snapshot?.capabilities?.primeContribution?.status)
    ).toBe(true);
    expect(snapshot?.provenance).toBe('external');

    const replay = createKeyringCommandRegistry();
    replay.registerPlugin(snapshot!);
    expect(replay.capabilities.authProviders()[0]?.provenance).toBe('external');
    expect(replay.capabilities.primeContributions()[0]?.provenance).toBe(
      'external'
    );
    expect(replay.capabilities.trustedAuthProviders()).toEqual([]);
    expect(replay.capabilities.trustedPrimeContributions()).toEqual([]);
    expect(() => replay.registerPlugin(snapshot!)).toThrow(
      "Plugin 'external-replay-probe' is already registered"
    );

    const forgedReplay = createKeyringCommandRegistry();
    expect(() => forgedReplay.registerPlugin({ ...snapshot! })).toThrow(
      /registry-owned plugin snapshot/i
    );

    const services = createAideInternalHostServices(
      replay,
      makeTestKeyring(new Map([['aide:jira', fakeSecret]])).layer
    );
    const provider = services.authProviderRegistrations()[0];
    expect(provider?.provenance).toBe('external');
    if (provider === undefined) throw new Error('Missing replayed provider');

    await runDynamicAuthProviderStatus(provider, services);
    await runDynamicAuthProviderAccounts(provider, services);
    await runDynamicAuthProviderLogin(provider, {}, services);
    await runDynamicAuthProviderLogout(provider, services);
    await buildPrimeOutput({ services });

    expect(observations).toEqual(
      new Map([
        ['replay-status', null],
        ['replay-accounts', null],
        ['replay-login', null],
        ['replay-logout', null],
        ['replay-prime-status', null],
        ['replay-prime-sections', null],
      ])
    );
    expect([...internalHostObservations.values()]).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  test('external auth callback construction throws are normalized inside the isolated Effect', async () => {
    const registry = createKeyringCommandRegistry();
    registry.registerExternalPlugin(
      definePublicAidePlugin({
        id: 'external-auth-construction-throw',
        summary: 'External auth construction throw probe',
        commands: [],
        capabilities: {
          authProvider: {
            providerId: 'external-auth-construction-throw',
            label: 'External Auth Construction Throw',
            login: { fields: [], summary: 'Throw from login construction' },
            logout: { summary: 'Throw from logout construction' },
            status: () => {
              throw new Error('status construction boom');
            },
            accounts: () => {
              throw new Error('accounts construction boom');
            },
            operations: {
              login: () => {
                throw new Error('login construction boom');
              },
              logout: () => {
                throw new Error('logout construction boom');
              },
            },
          },
        },
      }),
      {
        manifest: externalManifest('external-auth-construction-throw', [
          'auth-provider',
        ]),
      }
    );
    const services = createAideInternalHostServices(
      registry,
      makeTestKeyring(new Map([['aide:jira', fakeSecret]])).layer
    );
    const provider = services.authProviderRegistrations()[0];
    if (provider === undefined) throw new Error('Missing external provider');

    for (const invoke of [
      () => runDynamicAuthProviderStatus(provider, services),
      () => runDynamicAuthProviderAccounts(provider, services),
      () => runDynamicAuthProviderLogin(provider, {}, services),
      () => runDynamicAuthProviderLogout(provider, services),
    ]) {
      let result: Promise<unknown> | undefined;
      expect(() => {
        result = invoke();
      }).not.toThrow();
      expect(result).toBeDefined();
      await expect(result!).rejects.toBeInstanceOf(AuthProviderOperationError);
    }
  });

  test('external Prime callback construction throws use status fallback and section omission', async () => {
    const registry = createKeyringCommandRegistry();
    registry.registerExternalPlugin(
      definePublicAidePlugin({
        id: 'external-prime-construction-throw',
        summary: 'External Prime construction throw probe',
        commands: [],
        capabilities: {
          primeContribution: {
            status: [
              {
                groupId: 'external-prime-construction-throw',
                groupLabel: 'External Prime Construction Throw',
                label: 'External Prime Construction Throw',
                status: () => {
                  throw new Error('prime status construction boom');
                },
              },
            ],
            sections: () => {
              throw new Error('prime sections construction boom');
            },
          },
        },
      }),
      {
        manifest: externalManifest('external-prime-construction-throw', [
          'prime-contribution',
        ]),
      }
    );

    const output = await buildPrimeOutput({
      services: createAideInternalHostServices(
        registry,
        makeTestKeyring(new Map([['aide:jira', fakeSecret]])).layer
      ),
    });

    expect(output).toContain(
      "Plugin 'external-prime-construction-throw' External Prime Construction Throw status is unavailable: status callback failed"
    );
    expect(output).not.toContain('prime status construction boom');
    expect(output).not.toContain('prime sections construction boom');
  });

  test('trusted service-free Prime sections cannot observe the caller keyring', async () => {
    const observations = new Map<string, string | null>();
    const internalHostObservations = new Map<string, boolean>();
    const registry = createKeyringCommandRegistry();
    registry.registerPlugin({
      id: 'trusted-service-free-section',
      summary: 'Trusted service-free section probe',
      commands: [],
      capabilities: {
        primeContribution: {
          sections: () =>
            observeInjectedKeyring<readonly AidePrimeSection[]>(
              observations,
              internalHostObservations,
              'trusted-prime-sections',
              [{ id: 'trusted-prime-sections', body: '## Trusted Section' }]
            ),
        },
      },
    });

    const output = await buildPrimeOutput({
      services: createAideInternalHostServices(
        registry,
        makeTestKeyring(new Map([['aide:jira', fakeSecret]])).layer
      ),
    });

    expect(output).toContain('## Trusted Section');
    expect(observations.get('trusted-prime-sections')).toBeNull();
    expect(internalHostObservations.get('trusted-prime-sections')).toBe(false);
  });

  for (const operation of ['login', 'logout'] as const) {
    test(`external auth ${operation} cannot observe the caller keyring through real yargs`, async () => {
      const observations = new Map<string, string | null>();
      const internalHostObservations = new Map<string, boolean>();
      const registry = createKeyringCommandRegistry();
      registry.registerExternalPlugin(
        definePublicAidePlugin({
          id: `external-${operation}-probe`,
          summary: `External ${operation} isolation probe`,
          commands: [],
          capabilities: {
            authProvider: {
              providerId: `external-${operation}`,
              label: `External ${operation}`,
              ...(operation === 'login'
                ? {
                    login: {
                      fields: [],
                      summary: 'Probe external login',
                    },
                  }
                : {
                    logout: { summary: 'Probe external logout' },
                  }),
              status: () => Effect.succeed({ state: 'configured' as const }),
              operations:
                operation === 'login'
                  ? {
                      login: () =>
                        observeInjectedKeyring<AideAuthLoginResult>(
                          observations,
                          internalHostObservations,
                          operation,
                          { status: 'stored' }
                        ),
                    }
                  : {
                      logout: () =>
                        observeInjectedKeyring<AideAuthLogoutResult>(
                          observations,
                          internalHostObservations,
                          operation,
                          { status: 'removed' }
                        ),
                    },
            },
          },
        }),
        {
          manifest: externalManifest(`external-${operation}-probe`, [
            'auth-provider',
          ]),
        }
      );
      registry.registerPlugin(legacyAuthPlugin);

      expect(registry.capabilities.authProviders()[0]?.provenance).toBe(
        'external'
      );
      expect(registry.capabilities.trustedAuthProviders()).toEqual([]);

      const originalLog = console.log;
      console.log = () => {};
      try {
        await registerWithFakeKeyring(registry, [
          operation,
          `external-${operation}`,
        ]);
      } finally {
        console.log = originalLog;
      }

      expect(observations.get(operation)).toBeNull();
      expect(internalHostObservations.get(operation)).toBe(false);
    });
  }

  for (const operation of ['status', 'accounts'] as const) {
    test(`external auth ${operation} cannot observe host authority through real yargs dispatch`, async () => {
      const observations = new Map<string, string | null>();
      const internalHostObservations = new Map<string, boolean>();
      const registry = createKeyringCommandRegistry();
      registry.registerExternalPlugin(
        definePublicAidePlugin({
          id: `external-${operation}-probe`,
          summary: `External ${operation} isolation probe`,
          commands: [],
          capabilities: {
            authProvider: {
              providerId: `external-${operation}`,
              label: `External ${operation}`,
              status: () =>
                observeInjectedKeyring<AidePluginAuthStatus>(
                  observations,
                  internalHostObservations,
                  operation,
                  { state: 'configured' }
                ),
              accounts: () =>
                observeInjectedKeyring<readonly AideAuthAccount[]>(
                  observations,
                  internalHostObservations,
                  operation,
                  [
                    {
                      id: 'external-account',
                      label: 'External account',
                    },
                  ]
                ),
            },
          },
        }),
        {
          manifest: externalManifest(`external-${operation}-probe`, [
            'auth-provider',
          ]),
        }
      );
      registry.registerModule(`probe-${operation}`, {
        command: `probe-${operation}`,
        describe: `Dispatch external auth ${operation}`,
        handler: async (argv) => {
          const services = getAideHostContext(argv)?.services;
          if (services === undefined) throw new Error('Missing host services');
          const provider = services
            .authProviderRegistrations()
            .find((entry) => entry.provenance === 'external');
          if (provider === undefined) throw new Error('Missing provider');
          if (operation === 'status') {
            await runDynamicAuthProviderStatus(provider, services);
          } else {
            await runDynamicAuthProviderAccounts(provider, services);
          }
        },
      });

      await registerWithFakeKeyring(registry, [`probe-${operation}`]);

      expect(observations.get(operation)).toBeNull();
      expect(internalHostObservations.get(operation)).toBe(false);
    });
  }

  test('external Prime status and sections cannot observe caller keyring through real yargs', async () => {
    const observations = new Map<string, string | null>();
    const internalHostObservations = new Map<string, boolean>();
    const registry = createKeyringCommandRegistry();
    registry.registerExternalPlugin(
      definePublicAidePlugin({
        id: 'external-prime-probe',
        summary: 'External Prime isolation probe',
        commands: [],
        capabilities: {
          primeContribution: {
            status: [
              {
                groupId: 'external-prime-probe',
                groupLabel: 'External Prime Probe',
                label: 'External Prime Probe',
                status: () =>
                  observeInjectedKeyring<AidePluginAuthStatus>(
                    observations,
                    internalHostObservations,
                    'prime-status',
                    { state: 'configured' }
                  ),
              },
            ],
            sections: () =>
              observeInjectedKeyring<readonly AidePrimeSection[]>(
                observations,
                internalHostObservations,
                'prime-sections',
                [{ id: 'external-prime-probe', body: '## Probe' }]
              ),
          },
        },
      }),
      {
        manifest: externalManifest('external-prime-probe', [
          'prime-contribution',
        ]),
      }
    );
    registry.registerPlugin(aideCorePlugin);

    expect(registry.capabilities.primeContributions()[0]?.provenance).toBe(
      'external'
    );
    expect(registry.capabilities.trustedPrimeContributions()).toEqual([]);

    const originalLog = console.log;
    console.log = () => {};
    try {
      await registerWithFakeKeyring(registry, ['prime']);
    } finally {
      console.log = originalLog;
    }

    expect(observations).toEqual(
      new Map<string, string | null>([
        ['prime-status', null],
        ['prime-sections', null],
      ])
    );
    expect(internalHostObservations).toEqual(
      new Map<string, boolean>([
        ['prime-status', false],
        ['prime-sections', false],
      ])
    );
  });
});
