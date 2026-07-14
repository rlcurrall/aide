import { describe, expect, spyOn, test } from 'bun:test';
import { Context, Effect, Layer } from 'effect';
import yargs from 'yargs';

import {
  AIDE_PLUGIN_API_VERSION,
  defineAideCommand as definePublicAideCommand,
  defineAidePlugin as definePublicAidePlugin,
  pluginCommandDescriptor as publicPluginCommandDescriptor,
  type AidePluginManifest,
  type AidePublicPluginDescriptor,
} from '@aide/plugin-api';
import * as publicPluginApi from '@aide/plugin-api';
import {
  defineAideCommand,
  textResult,
  type AideCommandDefinition,
} from './command-descriptor.js';
import { exportedErrorText } from '@lib/error-redaction.test-helper.js';
import {
  createCommandRegistry,
  createKeyringCommandRegistry,
} from './command-registry.js';
import { createBuiltinCommandRegistry } from '@cli/plugins/builtin.js';
import {
  defineAidePlugin,
  pluginCommandDescriptor,
  pluginCommandModule,
} from './plugin-descriptor.js';
import {
  AideHostServicesTag,
  AideInternalHostServicesTag,
  attachAideHostContext,
  createAideHostServices,
  createAideInternalHostServices,
  getAideHostContext,
  type AideHostContext,
} from './runtime-context.js';
import {
  commandModuleFromDescriptor,
  commandModuleFromPublicDescriptor,
  registerCommands as registerCommandsWithKeyring,
} from './yargs-adapter.js';
import { makeTestKeyring } from '@lib/auth-keyring.test-helper.js';
import { KeyringService, type KeyringServiceShape } from '@lib/auth-keyring.js';
import { aideCorePlugin } from '@cli/plugins/aide-core/plugin.js';

const testKeyringLayer = makeTestKeyring().layer;

function registerCommands(
  yargsInstance: Parameters<typeof registerCommandsWithKeyring>[0],
  registry: Parameters<typeof registerCommandsWithKeyring>[1]
) {
  return registerCommandsWithKeyring(yargsInstance, registry, {
    keyringLayer: testKeyringLayer,
  });
}

function serviceFreePluginCommand<TArgs extends object, E = unknown>(
  descriptor: AideCommandDefinition<TArgs, E, never>,
  placement: Parameters<typeof pluginCommandDescriptor.none>[1] = {}
) {
  return pluginCommandDescriptor.none(
    defineAideCommand.none<TArgs, E>(descriptor),
    placement
  );
}

const expectedPrChildCommandIds = [
  'pr:list',
  'pr:view',
  'pr:diff',
  'pr:create',
  'pr:update',
  'pr:comments',
  'pr:comment',
  'pr:reply',
] as const;

class UnsupportedDescriptorService extends Context.Tag(
  'aide.test.UnsupportedDescriptorService'
)<UnsupportedDescriptorService, { readonly value: string }>() {}

function externalManifest(
  id: string,
  capabilities: readonly (
    | 'commands'
    | 'auth'
    | 'auth-provider'
    | 'prime-contribution'
    | 'pull-request-provider'
  )[] = []
) {
  return {
    id,
    version: '1.0.0',
    aidePluginApiVersion: AIDE_PLUGIN_API_VERSION,
    capabilities,
  } as const;
}

function externalCommandPlugin(
  pluginId: string,
  command: unknown
): AidePublicPluginDescriptor {
  return {
    id: pluginId,
    summary: 'External command identity probe',
    commands: [command],
  } as unknown as AidePublicPluginDescriptor;
}

function externalCommandDescriptor(id: string) {
  return {
    id,
    route: 'identity-command',
    summary: 'External command identity probe',
    run: () => Effect.succeed(textResult('canonical identity dispatch')),
  };
}

function captureThrown(run: () => void): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('Expected operation to throw');
}

describe('CommandRegistry', () => {
  test('pairs every trusted provisioning variant with its exact descriptor environment', () => {
    const noneDescriptor = defineAideCommand.none<object, never>({
      id: 'provision-none',
      route: 'provision-none',
      summary: 'No services',
      run: () => Effect.succeed(textResult('none')),
    });
    const internalHostDescriptor = defineAideCommand.internalHost<
      object,
      never
    >({
      id: 'provision-internal-host',
      route: 'provision-internal-host',
      summary: 'Internal host only',
      run: () =>
        Effect.map(AideInternalHostServicesTag, () => textResult('host')),
    });
    const keyringDescriptor = defineAideCommand.keyring<object, never>({
      id: 'provision-keyring',
      route: 'provision-keyring',
      summary: 'Keyring only',
      run: () => Effect.map(KeyringService, () => textResult('keyring')),
    });
    const combinedDescriptor = defineAideCommand.internalHostAndKeyring<
      object,
      never
    >({
      id: 'provision-combined',
      route: 'provision-combined',
      summary: 'Internal host and keyring',
      run: () =>
        Effect.all([AideInternalHostServicesTag, KeyringService]).pipe(
          Effect.map(() => textResult('combined'))
        ),
    });

    const registrations = [
      pluginCommandDescriptor.none(noneDescriptor),
      pluginCommandDescriptor.internalHost(internalHostDescriptor),
      pluginCommandDescriptor.keyring(keyringDescriptor),
      pluginCommandDescriptor.internalHostAndKeyring(combinedDescriptor),
    ];

    const descriptorPrototype = Object.getPrototypeOf(noneDescriptor);
    const prototypeSymbols = Object.getOwnPropertySymbols(descriptorPrototype);
    expect(prototypeSymbols).toHaveLength(1);
    expect(
      Object.getOwnPropertyDescriptor(descriptorPrototype, prototypeSymbols[0]!)
        ?.enumerable
    ).toBe(false);
    expect(Object.getOwnPropertySymbols(noneDescriptor)).toEqual([]);
    expect(Object.getOwnPropertySymbols({ ...noneDescriptor })).toEqual([]);

    const compileTimeMismatchAssertions = () => {
      // @ts-expect-error Provisioning-specific factories do not expose a caller-selected environment parameter.
      defineAideCommand.none<object, never, AideInternalHostServicesTag>(
        noneDescriptor
      );
      // @ts-expect-error A service-free registration cannot erase internal-host requirements.
      pluginCommandDescriptor.none(internalHostDescriptor);
      // @ts-expect-error A service-free registration cannot erase keyring requirements.
      pluginCommandDescriptor.none(keyringDescriptor);
      // @ts-expect-error A service-free registration cannot erase combined requirements.
      pluginCommandDescriptor.none(combinedDescriptor);
      // @ts-expect-error Internal-host provisioning must not relabel a service-free descriptor.
      pluginCommandDescriptor.internalHost(noneDescriptor);
      // @ts-expect-error Internal-host provisioning cannot satisfy a keyring requirement.
      pluginCommandDescriptor.internalHost(keyringDescriptor);
      // @ts-expect-error Internal-host provisioning cannot satisfy combined requirements.
      pluginCommandDescriptor.internalHost(combinedDescriptor);
      // @ts-expect-error Keyring provisioning must not relabel a service-free descriptor.
      pluginCommandDescriptor.keyring(noneDescriptor);
      // @ts-expect-error Keyring provisioning cannot satisfy an internal-host requirement.
      pluginCommandDescriptor.keyring(internalHostDescriptor);
      // @ts-expect-error Keyring provisioning cannot satisfy combined requirements.
      pluginCommandDescriptor.keyring(combinedDescriptor);
      // @ts-expect-error Combined provisioning must not relabel a service-free descriptor.
      pluginCommandDescriptor.internalHostAndKeyring(noneDescriptor);
      // @ts-expect-error Combined provisioning must not relabel an internal-host descriptor.
      pluginCommandDescriptor.internalHostAndKeyring(internalHostDescriptor);
      // @ts-expect-error Combined provisioning must not relabel a keyring descriptor.
      pluginCommandDescriptor.internalHostAndKeyring(keyringDescriptor);
    };
    expect(compileTimeMismatchAssertions).toBeInstanceOf(Function);

    const compileTimeRawDescriptorAssertions = () => {
      // @ts-expect-error Trusted service-free registration requires the constructor-owned brand.
      pluginCommandDescriptor.none({
        id: 'raw-none',
        route: 'raw-none',
        summary: 'Raw none',
        run: () => Effect.succeed(textResult('raw')),
      });
      // @ts-expect-error Trusted internal-host registration requires the constructor-owned brand.
      pluginCommandDescriptor.internalHost({
        id: 'raw-host',
        route: 'raw-host',
        summary: 'Raw host',
        run: () =>
          Effect.map(AideInternalHostServicesTag, () => textResult('raw')),
      });
      // @ts-expect-error Trusted keyring registration requires the constructor-owned brand.
      pluginCommandDescriptor.keyring({
        id: 'raw-keyring',
        route: 'raw-keyring',
        summary: 'Raw keyring',
        run: () => Effect.map(KeyringService, () => textResult('raw')),
      });
      // @ts-expect-error Trusted combined registration requires the constructor-owned brand.
      pluginCommandDescriptor.internalHostAndKeyring({
        id: 'raw-combined',
        route: 'raw-combined',
        summary: 'Raw combined',
        run: () =>
          Effect.all([AideInternalHostServicesTag, KeyringService]).pipe(
            Effect.map(() => textResult('raw'))
          ),
      });

      const rawNone = {
        id: 'spread-none',
        route: 'spread-none',
        summary: 'Spread none',
        run: () => Effect.succeed(textResult('spread')),
      };
      const rawHost = {
        id: 'spread-host',
        route: 'spread-host',
        summary: 'Spread host',
        run: () =>
          Effect.map(AideInternalHostServicesTag, () => textResult('spread')),
      };
      const rawKeyring = {
        id: 'spread-keyring',
        route: 'spread-keyring',
        summary: 'Spread keyring',
        run: () => Effect.map(KeyringService, () => textResult('spread')),
      };
      const rawCombined = {
        id: 'spread-combined',
        route: 'spread-combined',
        summary: 'Spread combined',
        run: () =>
          Effect.all([AideInternalHostServicesTag, KeyringService]).pipe(
            Effect.map(() => textResult('spread'))
          ),
      };
      // @ts-expect-error Spreading a raw definition does not create the trusted brand.
      pluginCommandDescriptor.none({ ...rawNone });
      // @ts-expect-error Spreading a raw definition does not create the trusted brand.
      pluginCommandDescriptor.internalHost({ ...rawHost });
      // @ts-expect-error Spreading a raw definition does not create the trusted brand.
      pluginCommandDescriptor.keyring({ ...rawKeyring });
      // @ts-expect-error Spreading a raw definition does not create the trusted brand.
      pluginCommandDescriptor.internalHostAndKeyring({ ...rawCombined });

      const spreadRealDescriptor = { ...noneDescriptor };
      // @ts-expect-error Object spread cannot copy the private nominal component of a real descriptor.
      pluginCommandDescriptor.none(spreadRealDescriptor);
    };
    expect(compileTimeRawDescriptorAssertions).toBeInstanceOf(Function);

    expect(registrations.map((entry) => entry.provisioning)).toEqual([
      'none',
      'internal-host',
      'keyring',
      'internal-host+keyring',
    ]);
    const raw = {
      id: 'forged-none',
      route: 'forged-none',
      summary: 'Forged none',
      run: () => Effect.succeed(textResult('forged')),
    };
    const runtimeRegistrations = [
      (value: unknown) =>
        pluginCommandDescriptor.none(
          value as Parameters<typeof pluginCommandDescriptor.none>[0]
        ),
      (value: unknown) =>
        pluginCommandDescriptor.internalHost(
          value as Parameters<typeof pluginCommandDescriptor.internalHost>[0]
        ),
      (value: unknown) =>
        pluginCommandDescriptor.keyring(
          value as Parameters<typeof pluginCommandDescriptor.keyring>[0]
        ),
      (value: unknown) =>
        pluginCommandDescriptor.internalHostAndKeyring(
          value as Parameters<
            typeof pluginCommandDescriptor.internalHostAndKeyring
          >[0]
        ),
    ];
    const forgeries = [raw, { ...raw }, { ...noneDescriptor }];

    for (const register of runtimeRegistrations) {
      for (const forgery of forgeries) {
        expect(() => register(forgery)).toThrow(
          'Trusted command descriptors must be created by defineAideCommand'
        );
      }
    }
  });

  test('rejects all genuine trusted descriptor provisioning relabels at runtime', () => {
    const descriptors = [
      {
        provisioning: 'none',
        descriptor: defineAideCommand.none<object, never>({
          id: 'runtime-none',
          route: 'runtime-none',
          summary: 'Runtime none',
          run: () => Effect.succeed(textResult('none')),
        }),
      },
      {
        provisioning: 'internal-host',
        descriptor: defineAideCommand.internalHost<object, never>({
          id: 'runtime-internal-host',
          route: 'runtime-internal-host',
          summary: 'Runtime internal host',
          run: () =>
            Effect.map(AideInternalHostServicesTag, () => textResult('host')),
        }),
      },
      {
        provisioning: 'keyring',
        descriptor: defineAideCommand.keyring<object, never>({
          id: 'runtime-keyring',
          route: 'runtime-keyring',
          summary: 'Runtime keyring',
          run: () => Effect.map(KeyringService, () => textResult('keyring')),
        }),
      },
      {
        provisioning: 'internal-host+keyring',
        descriptor: defineAideCommand.internalHostAndKeyring<object, never>({
          id: 'runtime-combined',
          route: 'runtime-combined',
          summary: 'Runtime combined',
          run: () =>
            Effect.all([AideInternalHostServicesTag, KeyringService]).pipe(
              Effect.map(() => textResult('combined'))
            ),
        }),
      },
    ] as const;
    const registrations = [
      {
        provisioning: 'none',
        register: (descriptor: unknown) =>
          pluginCommandDescriptor.none(
            descriptor as Parameters<typeof pluginCommandDescriptor.none>[0]
          ),
      },
      {
        provisioning: 'internal-host',
        register: (descriptor: unknown) =>
          pluginCommandDescriptor.internalHost(
            descriptor as Parameters<
              typeof pluginCommandDescriptor.internalHost
            >[0]
          ),
      },
      {
        provisioning: 'keyring',
        register: (descriptor: unknown) =>
          pluginCommandDescriptor.keyring(
            descriptor as Parameters<typeof pluginCommandDescriptor.keyring>[0]
          ),
      },
      {
        provisioning: 'internal-host+keyring',
        register: (descriptor: unknown) =>
          pluginCommandDescriptor.internalHostAndKeyring(
            descriptor as Parameters<
              typeof pluginCommandDescriptor.internalHostAndKeyring
            >[0]
          ),
      },
    ] as const;

    let mismatches = 0;
    for (const source of descriptors) {
      for (const target of registrations) {
        if (source.provisioning === target.provisioning) {
          expect(target.register(source.descriptor).provisioning).toBe(
            source.provisioning
          );
          continue;
        }

        mismatches += 1;
        const expectedError = `Trusted command descriptor provisioning mismatch: expected '${target.provisioning}', received '${source.provisioning}'`;
        expect(() => target.register(source.descriptor)).toThrow(expectedError);

        const registry = createCommandRegistry();
        const relabeledPlugin = {
          id: `runtime-mismatch-${mismatches}`,
          summary: 'Runtime provisioning mismatch',
          commands: [
            {
              kind: 'descriptor',
              id: source.descriptor.id,
              execution: 'trusted',
              provisioning: target.provisioning,
              descriptor: source.descriptor,
            },
          ],
        } as unknown as Parameters<typeof registry.registerPlugin>[0];
        expect(() => registry.registerPlugin(relabeledPlugin)).toThrow(
          expectedError
        );
        expect(registry.allCommandIds()).toEqual([]);
      }
    }
    expect(mismatches).toBe(12);
  });

  test('rejects plugin descriptors that require unsupported Effect services at compile time', () => {
    const definition: AideCommandDefinition<
      { value?: string },
      never,
      UnsupportedDescriptorService
    > = {
      id: 'unsupported-service',
      route: 'unsupported-service',
      summary: 'Descriptor requiring a non-host service',
      run: () =>
        Effect.gen(function* () {
          const service = yield* UnsupportedDescriptorService;
          return textResult(service.value);
        }),
    };

    // @ts-expect-error Trusted factories accept only an exact supported Effect environment.
    const descriptor = defineAideCommand.none(definition);
    const command = serviceFreePluginCommand(descriptor);

    expect(command.id).toBe('unsupported-service');
  });

  test('preserves built-in command order for demand messages and help', () => {
    const registry = createBuiltinCommandRegistry();

    expect(registry.pluginIds()).toEqual([
      'jira',
      'github',
      'azure-devops',
      'pull-requests',
      'claude-code',
      'aide-core',
      'legacy-auth',
    ]);
    expect(registry.plugins().map((plugin) => plugin.summary)).toEqual([
      'Jira ticket management',
      'GitHub pull request provider',
      'Azure DevOps pull request provider',
      'Pull request workflows for GitHub and Azure DevOps',
      'Claude Code plugin installation helpers',
      'Core aide commands',
      'Transitional centralized credential commands',
    ]);
    expect(registry.commandIds()).toEqual([
      'jira',
      'pr',
      'plugin',
      'prime',
      'upgrade',
      'login',
      'logout',
      'whoami',
    ]);
    expect(registry.demandMessage()).toBe(
      'Please specify a command (jira, pr, plugin, prime, upgrade, login, logout, whoami)'
    );
    expect(registry.commandOwner('pr')).toBe('pull-requests');
    expect(registry.commandOwner('pr:list')).toBe('pull-requests');
    expect(registry.commandOwner('pr:view')).toBe('pull-requests');
    expect(registry.commandOwner('pr:diff')).toBe('pull-requests');
    expect(registry.commandOwner('pr:create')).toBe('pull-requests');
    expect(registry.commandOwner('pr:update')).toBe('pull-requests');
    expect(registry.commandOwner('pr:comments')).toBe('pull-requests');
    expect(registry.commandOwner('pr:comment')).toBe('pull-requests');
    expect(registry.commandOwner('pr:reply')).toBe('pull-requests');
    expect(registry.commandOwner('whoami')).toBe('legacy-auth');
    expect(registry.commandOwner('missing')).toBeNull();
    expect(
      registry.commands().find((command) => command.id === 'prime')
    ).toMatchObject({
      kind: 'descriptor',
      execution: 'trusted',
      provisioning: 'internal-host',
    });
    expect(
      registry.commands().find((command) => command.id === 'whoami')
    ).toMatchObject({
      kind: 'descriptor',
      execution: 'trusted',
      provisioning: 'none',
    });
    expect(registry.childCommandIds('pr')).toEqual(expectedPrChildCommandIds);
    expect(registry.allCommandIds()).toEqual([
      'jira',
      'pr',
      'plugin',
      'prime',
      'upgrade',
      'login',
      'logout',
      'whoami',
      ...expectedPrChildCommandIds,
    ]);
  });

  test('preserves provisioning through snapshots, extensions, and recursive registry routing', () => {
    const none = defineAideCommand.none<object, never>({
      id: 'trusted:root',
      route: 'trusted-root <command>',
      summary: 'Trusted root',
      run: () => Effect.succeed(textResult('root')),
    });
    const internalHost = defineAideCommand.internalHost<object, never>({
      id: 'trusted:child',
      route: 'child <command>',
      summary: 'Trusted child',
      run: () =>
        Effect.map(AideInternalHostServicesTag, () => textResult('child')),
    });
    const keyring = defineAideCommand.keyring<object, never>({
      id: 'trusted:grandchild',
      route: 'grandchild',
      summary: 'Trusted grandchild',
      run: () => Effect.map(KeyringService, () => textResult('grandchild')),
    });
    const combined = defineAideCommand.internalHostAndKeyring<object, never>({
      id: 'trusted:combined',
      route: 'trusted-combined',
      summary: 'Trusted combined',
      run: () =>
        Effect.all([AideInternalHostServicesTag, KeyringService]).pipe(
          Effect.map(() => textResult('combined'))
        ),
    });
    const registry = createCommandRegistry().registerPlugin(
      defineAidePlugin({
        id: 'trusted-provisioning',
        summary: 'Trusted provisioning variants',
        commands: [
          pluginCommandDescriptor.none(none, {
            acceptsChildren: true,
            extension: { kind: 'open' },
          }),
          pluginCommandDescriptor.internalHost(internalHost, {
            parentId: 'trusted:root',
            acceptsChildren: true,
            extension: { kind: 'open' },
          }),
          pluginCommandDescriptor.keyring(keyring, {
            parentId: 'trusted:child',
          }),
          pluginCommandDescriptor.internalHostAndKeyring(combined),
        ],
      })
    );
    registry.registerExternalPlugin(
      definePublicAidePlugin({
        id: 'external-extension',
        summary: 'Public extension',
        commands: [
          publicPluginCommandDescriptor(
            definePublicAideCommand({
              id: 'external-extension:leaf',
              route: 'external-leaf',
              summary: 'Public leaf',
              run: () => Effect.succeed(textResult('external')),
            }),
            { parentId: 'trusted:child' }
          ),
        ],
      }),
      { manifest: externalManifest('external-extension', ['commands']) }
    );

    const topLevel = registry.commands();
    const root = topLevel.find((entry) => entry.id === 'trusted:root');
    const combinedEntry = topLevel.find(
      (entry) => entry.id === 'trusted:combined'
    );
    const child = registry.childCommands('trusted:root')[0];
    const nested = registry.childCommands('trusted:child');
    const trustedSnapshot = registry
      .plugins()
      .find((plugin) => plugin.id === 'trusted-provisioning');

    expect(root).toMatchObject({
      execution: 'trusted',
      provisioning: 'none',
    });
    expect(combinedEntry).toMatchObject({
      execution: 'trusted',
      provisioning: 'internal-host+keyring',
    });
    expect(child).toMatchObject({
      execution: 'trusted',
      provisioning: 'internal-host',
    });
    expect(nested).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'trusted:grandchild',
          execution: 'trusted',
          provisioning: 'keyring',
        }),
        expect.objectContaining({
          id: 'external-extension:leaf',
          execution: 'public',
        }),
      ])
    );
    expect(
      trustedSnapshot?.commands.map((command) =>
        command.kind === 'descriptor' && command.execution === 'trusted'
          ? command.provisioning
          : command.kind
      )
    ).toEqual(['none', 'internal-host', 'keyring', 'internal-host+keyring']);
    expect(registry.commandOwner('external-extension:leaf')).toBe(
      'external-extension'
    );

    expect(trustedSnapshot).toBeDefined();
    const replayRegistry = createCommandRegistry().registerPlugin(
      trustedSnapshot!
    );
    expect(replayRegistry.commandIds()).toEqual([
      'trusted:root',
      'trusted:combined',
    ]);
    expect(replayRegistry.childCommandIds('trusted:root')).toEqual([
      'trusted:child',
    ]);
    expect(replayRegistry.childCommandIds('trusted:child')).toEqual([
      'trusted:grandchild',
    ]);
    expect(
      replayRegistry
        .plugins()[0]
        ?.commands.every(
          (command) =>
            command.kind !== 'descriptor' ||
            command.execution !== 'trusted' ||
            Object.isFrozen(command.descriptor)
        )
    ).toBe(true);
  });

  test('keeps built-in pr child routes reserved to the owning plugin', () => {
    const registry = createBuiltinCommandRegistry();

    expect(registry.childCommandIds('pr')).toEqual(expectedPrChildCommandIds);

    expect(() =>
      registry.registerPlugin(
        defineAidePlugin({
          id: 'rogue-pr-view',
          summary: 'Rogue PR view command',
          commands: [
            pluginCommandModule(
              'rogue:pr:view',
              {
                command: 'view',
                describe: 'Rogue PR view command',
                handler: () => {},
              },
              { parentId: 'pr' }
            ),
          ],
        })
      )
    ).toThrow(
      "Command 'rogue:pr:view' from plugin 'rogue-pr-view' cannot extend parent 'pr' owned by plugin 'pull-requests' at route 'view'"
    );
  });

  test('rejects duplicate command ids', () => {
    const registry = createCommandRegistry();

    registry.registerModule('sample', {
      command: 'sample',
      describe: 'Sample command',
      handler: () => {},
    });

    expect(() =>
      registry.registerModule('sample', {
        command: 'sample2',
        describe: 'Duplicate sample command',
        handler: () => {},
      })
    ).toThrow("Command 'sample' is already registered");
    expect(registry.commandOwner('sample')).toBeNull();
  });

  test('rejects duplicate plugin ids', () => {
    const registry = createCommandRegistry();
    const plugin = defineAidePlugin({
      id: 'sample-plugin',
      summary: 'Sample plugin',
      commands: [],
    });

    registry.registerPlugin(plugin);

    expect(() => registry.registerPlugin(plugin)).toThrow(
      "Plugin 'sample-plugin' is already registered"
    );
  });

  test('registers descriptor-only external plugins through the public API boundary', () => {
    const registry = createCommandRegistry();

    registry.registerExternalPlugin(
      definePublicAidePlugin({
        id: 'external-tool',
        summary: 'External tool plugin',
        commands: [
          publicPluginCommandDescriptor(
            definePublicAideCommand({
              id: 'external-tool:hello',
              route: 'hello',
              summary: 'Say hello',
              run: () => Effect.succeed(textResult('hello')),
            })
          ),
        ],
      }),
      {
        manifest: {
          id: 'external-tool',
          version: '1.0.0',
          aidePluginApiVersion: AIDE_PLUGIN_API_VERSION,
          trust: 'external',
          capabilities: ['commands'],
          loading: {
            order: 100,
            after: [],
            before: [],
          },
          conflicts: {
            commands: 'reject',
            pullRequestProviders: 'reject',
          },
        },
      }
    );

    expect(registry.pluginIds()).toEqual(['external-tool']);
    expect(registry.commandIds()).toEqual(['external-tool:hello']);
    expect(registry.commandOwner('external-tool:hello')).toBe('external-tool');
  });

  test('rejects mismatched placement and descriptor ids atomically', () => {
    const pluginId = 'identity-probe';
    const plugin = externalCommandPlugin(pluginId, {
      kind: 'descriptor',
      id: 'identity-probe:declared',
      descriptor: externalCommandDescriptor('foreign:runtime'),
    });

    const failures = [createCommandRegistry(), createCommandRegistry()].map(
      (registry) => {
        const failure = captureThrown(() =>
          registry.registerExternalPlugin(plugin, {
            manifest: externalManifest(pluginId, ['commands']),
          })
        );
        expect(registry.pluginIds()).toEqual([]);
        expect(registry.commandIds()).toEqual([]);
        expect(registry.plugins()).toEqual([]);
        expect(registry.commandOwner('identity-probe:declared')).toBeNull();
        expect(registry.commandOwner('foreign:runtime')).toBeNull();
        return failure;
      }
    );
    for (const failure of failures) {
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe(
        'External plugin command placement id must match descriptor id'
      );
    }
    expect(failures[0]).not.toBe(failures[1]);
  });

  test('captures external placement and descriptor ids only from own data properties', () => {
    const invalidIdentityDiagnostic =
      'External plugin command identity must use valid own string data properties';
    const attackerError = new Error('SECRET-EXTERNAL-COMMAND-IDENTITY');
    let placementAccessorReads = 0;
    let descriptorAccessorReads = 0;
    let placementProxyTraps = 0;
    let descriptorProxyTraps = 0;

    const placementAccessor = {
      kind: 'descriptor',
      descriptor: externalCommandDescriptor('identity-placement-accessor:run'),
    };
    Object.defineProperty(placementAccessor, 'id', {
      enumerable: true,
      get() {
        placementAccessorReads += 1;
        throw attackerError;
      },
    });

    const descriptorAccessor = {
      route: 'descriptor-accessor',
      summary: 'Descriptor accessor',
      run: () => Effect.succeed(textResult('unreachable')),
    };
    Object.defineProperty(descriptorAccessor, 'id', {
      enumerable: true,
      get() {
        descriptorAccessorReads += 1;
        throw attackerError;
      },
    });

    const placementProxy = new Proxy(
      {
        kind: 'descriptor' as const,
        id: 'identity-placement-proxy:run',
        descriptor: externalCommandDescriptor('identity-placement-proxy:run'),
      },
      {
        get() {
          placementProxyTraps += 1;
          throw attackerError;
        },
        getOwnPropertyDescriptor() {
          placementProxyTraps += 1;
          throw attackerError;
        },
      }
    );
    const descriptorProxy = new Proxy(
      externalCommandDescriptor('identity-descriptor-proxy:run'),
      {
        get() {
          descriptorProxyTraps += 1;
          throw attackerError;
        },
        getOwnPropertyDescriptor() {
          descriptorProxyTraps += 1;
          throw attackerError;
        },
      }
    );
    const revoked = Proxy.revocable(
      externalCommandDescriptor('identity-revoked-proxy:run'),
      {}
    );
    revoked.revoke();

    const cases = [
      {
        pluginId: 'identity-placement-accessor',
        command: placementAccessor,
      },
      {
        pluginId: 'identity-descriptor-accessor',
        command: {
          kind: 'descriptor',
          id: 'identity-descriptor-accessor:run',
          descriptor: descriptorAccessor,
        },
      },
      {
        pluginId: 'identity-placement-inherited',
        command: Object.assign(
          Object.create({ id: 'identity-placement-inherited:run' }),
          {
            kind: 'descriptor',
            descriptor: externalCommandDescriptor(
              'identity-placement-inherited:run'
            ),
          }
        ),
      },
      {
        pluginId: 'identity-descriptor-inherited',
        command: {
          kind: 'descriptor',
          id: 'identity-descriptor-inherited:run',
          descriptor: Object.assign(
            Object.create({ id: 'identity-descriptor-inherited:run' }),
            {
              route: 'descriptor-inherited',
              summary: 'Descriptor inherited',
              run: () => Effect.succeed(textResult('unreachable')),
            }
          ),
        },
      },
      {
        pluginId: 'identity-placement-proxy',
        command: placementProxy,
      },
      {
        pluginId: 'identity-descriptor-proxy',
        command: {
          kind: 'descriptor',
          id: 'identity-descriptor-proxy:run',
          descriptor: descriptorProxy,
        },
      },
      {
        pluginId: 'identity-revoked-proxy',
        command: {
          kind: 'descriptor',
          id: 'identity-revoked-proxy:run',
          descriptor: revoked.proxy,
        },
      },
    ] as const;

    const failures = cases.map(({ pluginId, command }) => {
      const registry = createCommandRegistry();
      const failure = captureThrown(() =>
        registry.registerExternalPlugin(
          externalCommandPlugin(pluginId, command),
          { manifest: externalManifest(pluginId, ['commands']) }
        )
      );
      expect(registry.pluginIds()).toEqual([]);
      expect(registry.commandIds()).toEqual([]);
      return failure;
    });

    expect(placementAccessorReads).toBe(0);
    expect(descriptorAccessorReads).toBe(0);
    expect(placementProxyTraps).toBe(0);
    expect(descriptorProxyTraps).toBe(0);
    for (const failure of failures) {
      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBe(attackerError);
      expect((failure as Error).message).toBe(invalidIdentityDiagnostic);
      expect((failure as Error).message).not.toContain('SECRET');
    }
    expect(new Set(failures).size).toBe(failures.length);
  });

  test('rejects malformed placement and descriptor ids with fixed fresh diagnostics', () => {
    const invalidIdentityDiagnostic =
      'External plugin command identity must use valid own string data properties';
    const cases = [
      {
        pluginId: 'identity-placement-number',
        placementId: 42,
        descriptorId: 'identity-placement-number:run',
      },
      {
        pluginId: 'identity-placement-empty',
        placementId: '',
        descriptorId: 'identity-placement-empty:run',
      },
      {
        pluginId: 'identity-descriptor-symbol',
        placementId: 'identity-descriptor-symbol:run',
        descriptorId: Symbol('SECRET-IDENTITY'),
      },
      {
        pluginId: 'identity-descriptor-whitespace',
        placementId: 'identity-descriptor-whitespace:run',
        descriptorId: 'identity descriptor whitespace',
      },
    ] as const;

    const failures = cases.map(
      ({ pluginId, placementId, descriptorId }): unknown => {
        const registry = createCommandRegistry();
        const descriptor = {
          ...externalCommandDescriptor(`${pluginId}:run`),
          id: descriptorId,
        };
        const failure = captureThrown(() =>
          registry.registerExternalPlugin(
            externalCommandPlugin(pluginId, {
              kind: 'descriptor',
              id: placementId,
              descriptor,
            }),
            { manifest: externalManifest(pluginId, ['commands']) }
          )
        );
        expect(registry.pluginIds()).toEqual([]);
        expect(registry.commandIds()).toEqual([]);
        return failure;
      }
    );

    for (const failure of failures) {
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe(invalidIdentityDiagnostic);
      expect((failure as Error).message).not.toContain('SECRET');
    }
    expect(new Set(failures).size).toBe(failures.length);
  });

  test('rejects unsafe Unicode in placement and descriptor ids without retaining or executing attacker data', () => {
    const invalidIdentityDiagnostic = 'External plugin metadata capture failed';
    const unsafeCodePoints = [
      ['leading unpaired high surrogate', '\ud800', 'leading'],
      ['trailing unpaired high surrogate', '\ud800', 'trailing'],
      ['embedded unpaired high surrogate', '\ud800', 'embedded'],
      ['leading unpaired low surrogate', '\udc00', 'leading'],
      ['trailing unpaired low surrogate', '\udc00', 'trailing'],
      ['embedded unpaired low surrogate', '\udc00', 'embedded'],
      ['NUL', '\u0000', 'embedded'],
      ['C0 START OF HEADING', '\u0001', 'embedded'],
      ['C0 INFORMATION SEPARATOR ONE', '\u001f', 'embedded'],
      ['C1 PADDING CHARACTER', '\u0080', 'embedded'],
      ['C1 APPLICATION PROGRAM COMMAND', '\u009f', 'embedded'],
      ['LINE SEPARATOR', '\u2028', 'embedded'],
      ['PARAGRAPH SEPARATOR', '\u2029', 'embedded'],
      ['SOFT HYPHEN format character', '\u00ad', 'embedded'],
      ['ARABIC LETTER MARK format character', '\u061c', 'embedded'],
      ['ZERO WIDTH SPACE format character', '\u200b', 'embedded'],
      ['RIGHT-TO-LEFT OVERRIDE format character', '\u202e', 'embedded'],
      ['LEFT-TO-RIGHT ISOLATE format character', '\u2066', 'embedded'],
      ['ZERO WIDTH NO-BREAK SPACE format character', '\ufeff', 'embedded'],
      ['COMBINING GRAPHEME JOINER default-ignorable', '\u034f', 'embedded'],
      ['HANGUL CHOSEONG FILLER default-ignorable', '\u115f', 'embedded'],
      ['MONGOLIAN FREE VARIATION SELECTOR ONE', '\u180b', 'embedded'],
      ['VARIATION SELECTOR-1 default-ignorable', '\ufe00', 'embedded'],
      ['BMP noncharacter', '\ufdd0', 'embedded'],
      ['BMP plane-end noncharacter', '\uffff', 'embedded'],
      ['supplementary plane-end noncharacter', '\u{1fffe}', 'embedded'],
      ['maximum Unicode noncharacter', '\u{10ffff}', 'embedded'],
    ] as const;
    const attackerError = new Error('SECRET-UNSAFE-IDENTITY-ERROR');
    let coercionCalls = 0;
    let metadataGetterCalls = 0;
    let nestedProxyTraps = 0;
    const nestedHostileProxy = new Proxy(Object.freeze({}), {
      get() {
        nestedProxyTraps += 1;
        throw attackerError;
      },
      getOwnPropertyDescriptor() {
        nestedProxyTraps += 1;
        throw attackerError;
      },
      ownKeys() {
        nestedProxyTraps += 1;
        throw attackerError;
      },
    });

    const failures: unknown[] = [];
    for (const [
      caseIndex,
      [label, unsafeCodePoint, position],
    ] of unsafeCodePoints.entries()) {
      for (const identityField of ['placement', 'descriptor'] as const) {
        const pluginId = `unsafe-identity-${caseIndex}-${identityField}`;
        const validId = `${pluginId}:safe`;
        const sourceMarker = `SECRET-UNSAFE-${caseIndex}-${identityField}`;
        const unsafeId =
          position === 'leading'
            ? `${unsafeCodePoint}${pluginId}:${sourceMarker}`
            : position === 'trailing'
              ? `${pluginId}:${sourceMarker}${unsafeCodePoint}`
              : `${pluginId}:${unsafeCodePoint}:${sourceMarker}`;
        const descriptor = {
          id: identityField === 'descriptor' ? unsafeId : validId,
          summary: sourceMarker,
          run: () => {
            throw attackerError;
          },
          hostile: nestedHostileProxy,
          toString() {
            coercionCalls += 1;
            throw attackerError;
          },
          [Symbol.toPrimitive]() {
            coercionCalls += 1;
            throw attackerError;
          },
        };
        Object.defineProperty(descriptor, 'route', {
          enumerable: true,
          get() {
            metadataGetterCalls += 1;
            throw attackerError;
          },
        });
        const command = {
          kind: 'descriptor',
          id: identityField === 'placement' ? unsafeId : validId,
          descriptor,
          hostile: nestedHostileProxy,
          toString() {
            coercionCalls += 1;
            throw attackerError;
          },
          [Symbol.toPrimitive]() {
            coercionCalls += 1;
            throw attackerError;
          },
        };
        Object.defineProperty(command, 'parentId', {
          enumerable: true,
          get() {
            metadataGetterCalls += 1;
            throw attackerError;
          },
        });
        const registry = createCommandRegistry();
        const before = {
          plugins: registry.plugins(),
          commands: registry.commands(),
          pluginIds: registry.pluginIds(),
          commandIds: registry.commandIds(),
        };

        const failure = captureThrown(() =>
          registry.registerExternalPlugin(
            externalCommandPlugin(pluginId, command),
            { manifest: externalManifest(pluginId, ['commands']) }
          )
        );

        expect(failure).toBeInstanceOf(Error);
        expect(failure).not.toBe(attackerError);
        expect((failure as Error).message, `${label} in ${identityField}`).toBe(
          invalidIdentityDiagnostic
        );
        expect((failure as Error & { cause?: unknown }).cause).toBeUndefined();
        expect(exportedErrorText(failure as Error)).not.toContain(sourceMarker);
        expect(registry.plugins()).toEqual(before.plugins);
        expect(registry.commands()).toEqual(before.commands);
        expect(registry.pluginIds()).toEqual(before.pluginIds);
        expect(registry.commandIds()).toEqual(before.commandIds);
        expect(registry.commandOwner(validId)).toBeNull();
        expect(registry.commandOwner(unsafeId)).toBeNull();
        failures.push(failure);
      }
    }

    expect(coercionCalls).toBe(0);
    expect(metadataGetterCalls).toBe(0);
    expect(nestedProxyTraps).toBe(0);
    expect(new Set(failures).size).toBe(failures.length);
  });

  test('rejects every runtime default-ignorable non-Format scalar and noncharacter on both identity sides', () => {
    const invalidIdentityDiagnostic = 'External plugin metadata capture failed';
    const defaultIgnorable = /\p{Default_Ignorable_Code_Point}/u;
    const format = /\p{Format}/u;
    const noncharacter = /\p{Noncharacter_Code_Point}/u;
    const defaultIgnorableOutsideFormat: string[] = [];
    const noncharacters: string[] = [];

    for (let codePoint = 0; codePoint <= 0x10ffff; codePoint += 1) {
      if (codePoint >= 0xd800 && codePoint <= 0xdfff) continue;
      const scalar = String.fromCodePoint(codePoint);
      if (defaultIgnorable.test(scalar) && !format.test(scalar)) {
        defaultIgnorableOutsideFormat.push(scalar);
      }
      if (noncharacter.test(scalar)) noncharacters.push(scalar);
    }

    expect(defaultIgnorableOutsideFormat).toContain('\u034f');
    expect(defaultIgnorableOutsideFormat).toContain('\u115f');
    expect(defaultIgnorableOutsideFormat).toContain('\ufe00');
    expect(noncharacters).toHaveLength(66);
    expect(noncharacters).toContain('\ufdd0');
    expect(noncharacters).toContain('\uffff');
    expect(noncharacters).toContain('\u{10ffff}');

    let metadataGetterCalls = 0;
    let runCalls = 0;
    let previousFailure: unknown;
    const groups = [
      ['default-ignorable', defaultIgnorableOutsideFormat],
      ['noncharacter', noncharacters],
    ] as const;

    for (const [group, scalars] of groups) {
      for (const [scalarIndex, scalar] of scalars.entries()) {
        for (const identityField of ['placement', 'descriptor'] as const) {
          const pluginId = `scalar-${group}-${scalarIndex}-${identityField}`;
          const validId = `${pluginId}:ab`;
          const invalidId = `${pluginId}:a${scalar}b`;
          const sourceMarker = `SECRET-SCALAR-${group}-${scalarIndex}-${identityField}`;
          const descriptor = {
            id: identityField === 'descriptor' ? invalidId : validId,
            summary: sourceMarker,
            run: () => {
              runCalls += 1;
              return Effect.succeed(textResult('unreachable'));
            },
          };
          Object.defineProperty(descriptor, 'route', {
            enumerable: true,
            get() {
              metadataGetterCalls += 1;
              throw new Error(sourceMarker);
            },
          });
          const registry = createCommandRegistry();
          const failure = captureThrown(() =>
            registry.registerExternalPlugin(
              externalCommandPlugin(pluginId, {
                kind: 'descriptor',
                id: identityField === 'placement' ? invalidId : validId,
                descriptor,
              }),
              { manifest: externalManifest(pluginId, ['commands']) }
            )
          );

          expect(failure).toBeInstanceOf(Error);
          expect(failure).not.toBe(previousFailure);
          expect((failure as Error).message).toBe(invalidIdentityDiagnostic);
          expect(
            (failure as Error & { cause?: unknown }).cause
          ).toBeUndefined();
          const errorText = exportedErrorText(failure as Error);
          expect(errorText).not.toContain(sourceMarker);
          expect(errorText).not.toContain(invalidId);
          expect(errorText).not.toContain(scalar);
          expect(registry.pluginIds()).toEqual([]);
          expect(registry.commandIds()).toEqual([]);
          expect(registry.commandOwner(validId)).toBeNull();
          expect(registry.commandOwner(invalidId)).toBeNull();
          previousFailure = failure;
        }
      }
    }

    expect(metadataGetterCalls).toBe(0);
    expect(runCalls).toBe(0);
  });

  test('rejects the plain-id spoof variants atomically while preserving the plain identity', () => {
    const invalidIdentityDiagnostic =
      'External plugin command identity must use valid own string data properties';
    const plainId = 'spoof:ab';
    const defaultIgnorableId = 'spoof:a\u034fb';
    const noncharacterId = 'spoof:a\uffffb';
    const spoofRegistry = createCommandRegistry();

    const failure = captureThrown(() =>
      spoofRegistry.registerExternalPlugin(
        {
          id: 'spoof',
          summary: 'Scalar spoof regression',
          commands: [plainId, defaultIgnorableId, noncharacterId].map(
            (id, index) => ({
              kind: 'descriptor',
              id,
              descriptor: {
                ...externalCommandDescriptor(id),
                route: `spoof-${index}`,
              },
            })
          ),
        } as AidePublicPluginDescriptor,
        { manifest: externalManifest('spoof', ['commands']) }
      )
    );

    expect((failure as Error).message).toBe(invalidIdentityDiagnostic);
    expect(spoofRegistry.pluginIds()).toEqual([]);
    expect(spoofRegistry.commandIds()).toEqual([]);
    expect(spoofRegistry.commandOwner(plainId)).toBeNull();
    expect(spoofRegistry.commandOwner(defaultIgnorableId)).toBeNull();
    expect(spoofRegistry.commandOwner(noncharacterId)).toBeNull();

    const plainRegistry = createCommandRegistry();
    plainRegistry.registerExternalPlugin(
      externalCommandPlugin('spoof', {
        kind: 'descriptor',
        id: plainId,
        descriptor: externalCommandDescriptor(plainId),
      }),
      { manifest: externalManifest('spoof', ['commands']) }
    );
    expect(plainRegistry.commandIds()).toEqual([plainId]);
    expect(plainRegistry.commands()[0]?.id).toBe(plainId);
    expect(plainRegistry.commandOwner(plainId)).toBe('spoof');
  });

  test('preserves exact well-formed non-ASCII command identities without normalization', () => {
    const validIds = [
      ['nonascii-composed', 'nonascii-composed:caf\u00e9'],
      ['nonascii-decomposed', 'nonascii-decomposed:cafe\u0301'],
      ['nonascii-supplementary', 'nonascii-supplementary:\ud801\udc37'],
      ['nonascii-greek', 'nonascii-greek:\u03b1\u03b8\u03ae\u03bd\u03b1'],
      [
        'nonascii-cyrillic',
        'nonascii-cyrillic:\u043c\u043e\u0441\u043a\u0432\u0430',
      ],
      [
        'nonascii-arabic',
        'nonascii-arabic:\u0627\u0644\u0642\u0627\u0647\u0631\u0629',
      ],
      ['nonascii-cjk', 'nonascii-cjk:\u4e2d\u6587'],
      ['nonascii-japanese', 'nonascii-japanese:\u65e5\u672c\u8a9e'],
      ['nonascii-korean', 'nonascii-korean:\ud55c\uad6d\uc5b4'],
      ['nonascii-deseret', 'nonascii-deseret:\u{10437}'],
      ['nonascii-emoji', 'nonascii-emoji:\u{1f680}'],
      [
        'nonascii-ordinary-supplementary',
        'nonascii-ordinary-supplementary:\u{20000}',
      ],
    ] as const;

    for (const [pluginId, canonicalId] of validIds) {
      const registry = createCommandRegistry();
      registry.registerExternalPlugin(
        externalCommandPlugin(pluginId, {
          kind: 'descriptor',
          id: canonicalId,
          descriptor: externalCommandDescriptor(canonicalId),
        }),
        { manifest: externalManifest(pluginId, ['commands']) }
      );

      expect(registry.commandIds()).toEqual([canonicalId]);
      expect(registry.commands()[0]?.id).toBe(canonicalId);
      expect(registry.commandOwner(canonicalId)).toBe(pluginId);
      const snapshotCommand = registry.plugins()[0]?.commands[0];
      expect(snapshotCommand?.id).toBe(canonicalId);
      expect(snapshotCommand?.kind).toBe('descriptor');
      if (snapshotCommand?.kind !== 'descriptor') {
        throw new Error(
          'Expected descriptor-backed non-ASCII command snapshot'
        );
      }
      expect(snapshotCommand.descriptor.id).toBe(canonicalId);
    }

    const mismatchRegistry = createCommandRegistry();
    const mismatch = captureThrown(() =>
      mismatchRegistry.registerExternalPlugin(
        externalCommandPlugin('nonascii-mismatch', {
          kind: 'descriptor',
          id: 'nonascii-mismatch:caf\u00e9',
          descriptor: externalCommandDescriptor('nonascii-mismatch:cafe\u0301'),
        }),
        { manifest: externalManifest('nonascii-mismatch', ['commands']) }
      )
    );
    expect((mismatch as Error).message).toBe(
      'External plugin command placement id must match descriptor id'
    );
    expect(mismatchRegistry.pluginIds()).toEqual([]);
    expect(mismatchRegistry.commandIds()).toEqual([]);
  });

  test('rejects wrong external command kinds with fresh fixed errors before reading ids', () => {
    const wrongKindDiagnostic =
      'External plugin commands must be descriptor-backed; raw yargs modules are trusted internal only';
    const attackerError = new Error('SECRET-WRONG-KIND-ERROR');
    let idAccessorCalls = 0;
    let descriptorAccessorCalls = 0;
    let idProxyTraps = 0;
    const hostileId = new Proxy(Object.freeze({}), {
      get() {
        idProxyTraps += 1;
        throw attackerError;
      },
      getOwnPropertyDescriptor() {
        idProxyTraps += 1;
        throw attackerError;
      },
      ownKeys() {
        idProxyTraps += 1;
        throw attackerError;
      },
    });
    const accessorCommand = {
      kind: 'SECRET-WRONG-KIND',
    };
    Object.defineProperty(accessorCommand, 'id', {
      enumerable: true,
      get() {
        idAccessorCalls += 1;
        throw attackerError;
      },
    });
    Object.defineProperty(accessorCommand, 'descriptor', {
      enumerable: true,
      get() {
        descriptorAccessorCalls += 1;
        throw attackerError;
      },
    });
    const cases = [
      {
        pluginId: 'secret-wrong-kind-accessor',
        command: accessorCommand,
        secrets: [
          'secret-wrong-kind-accessor',
          'SECRET-WRONG-KIND',
          attackerError.message,
        ],
      },
      {
        pluginId: 'secret-wrong-kind-proxy',
        command: {
          kind: 'SECRET-RAW-KIND',
          id: hostileId,
          descriptor: attackerError,
        },
        secrets: [
          'secret-wrong-kind-proxy',
          'SECRET-RAW-KIND',
          attackerError.message,
        ],
      },
    ] as const;

    const commandObjects = new Set<unknown>(
      cases.map(({ command }) => command)
    );
    const originalGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
    let idDescriptorReads = 0;
    const getOwnPropertyDescriptorSpy = spyOn(
      Object,
      'getOwnPropertyDescriptor'
    ).mockImplementation((value, property) => {
      if (commandObjects.has(value) && property === 'id') {
        idDescriptorReads += 1;
      }
      return originalGetOwnPropertyDescriptor(value, property);
    });
    let failures: unknown[] = [];
    try {
      failures = cases.map(({ pluginId, command, secrets }) => {
        const registry = createCommandRegistry();
        const before = {
          plugins: registry.plugins(),
          commands: registry.commands(),
          pluginIds: registry.pluginIds(),
          commandIds: registry.commandIds(),
        };
        const failure = captureThrown(() =>
          registry.registerExternalPlugin(
            externalCommandPlugin(pluginId, command),
            { manifest: externalManifest(pluginId, ['commands']) }
          )
        );

        expect(failure).toBeInstanceOf(Error);
        expect(failure).not.toBe(attackerError);
        expect((failure as Error).message).toBe(wrongKindDiagnostic);
        expect((failure as Error & { cause?: unknown }).cause).toBeUndefined();
        for (const secret of secrets) {
          expect(exportedErrorText(failure as Error)).not.toContain(secret);
        }
        expect(registry.plugins()).toEqual(before.plugins);
        expect(registry.commands()).toEqual(before.commands);
        expect(registry.pluginIds()).toEqual(before.pluginIds);
        expect(registry.commandIds()).toEqual(before.commandIds);
        return failure;
      });
    } finally {
      getOwnPropertyDescriptorSpy.mockRestore();
    }

    expect(failures[0]).not.toBe(failures[1]);
    expect(idDescriptorReads).toBe(0);
    expect(idAccessorCalls).toBe(0);
    expect(descriptorAccessorCalls).toBe(0);
    expect(idProxyTraps).toBe(0);
  });

  test('uses one detached frozen canonical id for snapshots, replay, collision, help, and dispatch', async () => {
    const pluginId = 'canonical-identity';
    const canonicalId = 'canonical-identity:run';
    const descriptor = externalCommandDescriptor(canonicalId);
    const placement = {
      kind: 'descriptor' as const,
      id: canonicalId,
      descriptor,
    };
    const registry = createKeyringCommandRegistry();

    registry.registerExternalPlugin(
      externalCommandPlugin(pluginId, placement),
      { manifest: externalManifest(pluginId, ['commands']) }
    );

    placement.id = 'canonical-identity:mutated-placement';
    descriptor.id = 'canonical-identity:mutated-descriptor';

    const snapshot = registry.plugins()[0];
    const snapshotCommand = snapshot?.commands[0];
    expect(snapshotCommand?.kind).toBe('descriptor');
    if (snapshotCommand?.kind !== 'descriptor') {
      throw new Error('Expected descriptor-backed external command snapshot');
    }
    expect(snapshotCommand.id).toBe(canonicalId);
    expect(snapshotCommand.descriptor.id).toBe(canonicalId);
    expect(snapshotCommand).not.toBe(placement);
    expect(snapshotCommand.descriptor).not.toBe(descriptor);
    expect(Object.isFrozen(snapshotCommand)).toBe(true);
    expect(Object.isFrozen(snapshotCommand.descriptor)).toBe(true);
    expect(registry.commandOwner(canonicalId)).toBe(pluginId);
    expect(registry.commandOwner(placement.id)).toBeNull();
    expect(registry.commandOwner(descriptor.id)).toBeNull();

    expect(() =>
      registry.registerDescriptor({
        id: canonicalId,
        route: 'unreachable-collision',
        summary: 'Canonical id collision',
        run: () => Effect.succeed(textResult('unreachable')),
      })
    ).toThrow(`Command '${canonicalId}' is already registered`);

    const replay = createKeyringCommandRegistry().registerPlugin(snapshot!);
    const replaySnapshot = replay.plugins()[0];
    const replayCommand = replaySnapshot?.commands[0];
    expect(replayCommand?.kind).toBe('descriptor');
    if (replayCommand?.kind !== 'descriptor') {
      throw new Error('Expected replayed descriptor-backed command');
    }
    expect(replayCommand.id).toBe(canonicalId);
    expect(replayCommand.descriptor.id).toBe(canonicalId);
    expect(replayCommand).not.toBe(snapshotCommand);
    expect(replayCommand.descriptor).not.toBe(snapshotCommand.descriptor);
    expect(Object.isFrozen(replayCommand)).toBe(true);
    expect(Object.isFrozen(replayCommand.descriptor)).toBe(true);
    const replayEntry = replay.commands()[0];
    expect(replayEntry?.id).toBe(canonicalId);
    expect(
      replayEntry?.kind === 'descriptor' ? replayEntry.descriptor.id : undefined
    ).toBe(canonicalId);

    const originalLog = console.log;
    const lines: string[] = [];
    console.log = (...args: unknown[]) => lines.push(args.join(' '));
    try {
      const help = await registerCommands(
        yargs(['identity-command', '--help'])
          .scriptName('aide')
          .exitProcess(false),
        replay
      ).getHelp();
      expect(help).toContain('aide identity-command');

      await registerCommands(
        yargs(['identity-command']).scriptName('aide').exitProcess(false),
        replay
      )
        .strict()
        .parseAsync();
    } finally {
      console.log = originalLog;
    }
    expect(lines.at(-1)).toBe('canonical identity dispatch');
  });

  test('snapshots external route arrays recursively and replays their exact canonical routes', () => {
    const rootRoute = ['external-root <command>', 'xr <command>'];
    const childRoute = ['child <command>', 'c <command>'];
    const leafRoute = ['leaf', 'l'];
    const registry = createCommandRegistry();

    registry.registerExternalPlugin(
      definePublicAidePlugin({
        id: 'external-routes',
        summary: 'External route snapshots',
        commands: [
          publicPluginCommandDescriptor(
            definePublicAideCommand({
              id: 'external-routes:root',
              route: rootRoute,
              summary: 'External root',
              run: () => Effect.succeed(textResult('root')),
            }),
            {
              acceptsChildren: true,
              extension: { kind: 'open' },
            }
          ),
          publicPluginCommandDescriptor(
            definePublicAideCommand({
              id: 'external-routes:child',
              route: childRoute,
              summary: 'External child',
              run: () => Effect.succeed(textResult('child')),
            }),
            {
              parentId: 'external-routes:root',
              acceptsChildren: true,
            }
          ),
          publicPluginCommandDescriptor(
            definePublicAideCommand({
              id: 'external-routes:leaf',
              route: leafRoute,
              summary: 'External leaf',
              run: () => Effect.succeed(textResult('leaf')),
            }),
            { parentId: 'external-routes:child' }
          ),
          publicPluginCommandDescriptor(
            definePublicAideCommand({
              id: 'external-routes:string',
              route: 'string-route',
              summary: 'External string route',
              run: () => Effect.succeed(textResult('string')),
            })
          ),
        ],
      }),
      { manifest: externalManifest('external-routes', ['commands']) }
    );

    rootRoute[0] = 'mutated-root <command>';
    childRoute.push('mutated-child <command>');

    const snapshot = registry.plugins()[0];
    const snapshotRoot = snapshot?.commands.find(
      (command) => command.id === 'external-routes:root'
    );
    const snapshotChild = snapshot?.commands.find(
      (command) => command.id === 'external-routes:child'
    );
    const snapshotLeaf = snapshot?.commands.find(
      (command) => command.id === 'external-routes:leaf'
    );
    const snapshotString = snapshot?.commands.find(
      (command) => command.id === 'external-routes:string'
    );

    expect(snapshotRoot?.kind).toBe('descriptor');
    expect(snapshotChild?.kind).toBe('descriptor');
    expect(snapshotLeaf?.kind).toBe('descriptor');
    expect(snapshotString?.kind).toBe('descriptor');
    if (
      snapshotRoot?.kind !== 'descriptor' ||
      snapshotChild?.kind !== 'descriptor' ||
      snapshotLeaf?.kind !== 'descriptor' ||
      snapshotString?.kind !== 'descriptor'
    ) {
      throw new Error('Expected descriptor-backed external route snapshots');
    }

    expect(snapshotRoot.descriptor.route).toEqual([
      'external-root <command>',
      'xr <command>',
    ]);
    expect(snapshotChild.descriptor.route).toEqual([
      'child <command>',
      'c <command>',
    ]);
    expect(snapshotLeaf.descriptor.route).toEqual(['leaf', 'l']);
    expect(snapshotString.descriptor.route).toBe('string-route');
    expect(snapshotRoot.descriptor.route).not.toBe(rootRoute);
    expect(snapshotChild.descriptor.route).not.toBe(childRoute);
    expect(snapshotLeaf.descriptor.route).not.toBe(leafRoute);
    expect(Object.isFrozen(snapshotRoot.descriptor.route)).toBe(true);
    expect(Object.isFrozen(snapshotChild.descriptor.route)).toBe(true);
    expect(Object.isFrozen(snapshotLeaf.descriptor.route)).toBe(true);

    leafRoute[0] = 'mutated-leaf';
    rootRoute.push('mutated-root-alias <command>');

    expect(snapshotRoot.descriptor.route).toEqual([
      'external-root <command>',
      'xr <command>',
    ]);
    expect(snapshotLeaf.descriptor.route).toEqual(['leaf', 'l']);

    const replay = createCommandRegistry().registerPlugin(snapshot!);
    const replaySnapshot = replay.plugins()[0];
    const replayRoot = replaySnapshot?.commands.find(
      (command) => command.id === 'external-routes:root'
    );
    expect(replaySnapshot?.provenance).toBe('external');
    expect(
      replaySnapshot?.commands.map((command) =>
        command.kind === 'descriptor' ? command.descriptor.route : undefined
      )
    ).toEqual([
      ['external-root <command>', 'xr <command>'],
      ['child <command>', 'c <command>'],
      ['leaf', 'l'],
      'string-route',
    ]);
    expect(replayRoot?.kind).toBe('descriptor');
    if (replayRoot?.kind !== 'descriptor') {
      throw new Error('Expected replayed root descriptor');
    }
    expect(replayRoot.descriptor.route).not.toBe(snapshotRoot.descriptor.route);
    expect(Object.isFrozen(replayRoot.descriptor.route)).toBe(true);
    expect(replay.childCommandIds('external-routes:root')).toEqual([
      'external-routes:child',
    ]);
    expect(replay.childCommandIds('external-routes:child')).toEqual([
      'external-routes:leaf',
    ]);
  });

  test('uses one canonical external route for collisions, yargs help, and dispatch', async () => {
    const rootRoute = ['immutable-root <command>', 'ir <command>'];
    const childRoute = ['run', 'r'];
    const registry = createKeyringCommandRegistry();

    registry.registerExternalPlugin(
      definePublicAidePlugin({
        id: 'external-canonical',
        summary: 'Canonical external routes',
        commands: [
          publicPluginCommandDescriptor(
            definePublicAideCommand({
              id: 'external-canonical:root',
              route: rootRoute,
              summary: 'Canonical root',
              run: () => Effect.succeed(textResult('root')),
            }),
            {
              acceptsChildren: true,
              extension: { kind: 'open' },
            }
          ),
          publicPluginCommandDescriptor(
            definePublicAideCommand({
              id: 'external-canonical:run',
              route: childRoute,
              summary: 'Canonical child',
              run: () => Effect.succeed(textResult('canonical dispatch')),
            }),
            { parentId: 'external-canonical:root' }
          ),
        ],
      }),
      { manifest: externalManifest('external-canonical', ['commands']) }
    );

    const snapshot = registry.plugins()[0];
    rootRoute[0] = 'mutated-root <command>';
    childRoute[0] = 'mutated-child';

    expect(() =>
      registry.registerDescriptor({
        id: 'collision:root',
        route: 'immutable-root',
        summary: 'Root collision',
        run: () => Effect.succeed(textResult('collision')),
      })
    ).toThrow(
      "Command 'collision:root' route 'immutable-root' conflicts with command 'external-canonical:root'"
    );
    expect(() =>
      registry.registerDescriptor(
        {
          id: 'collision:child',
          route: 'run',
          summary: 'Child collision',
          run: () => Effect.succeed(textResult('collision')),
        },
        { parentId: 'external-canonical:root' }
      )
    ).toThrow(
      "Command 'collision:child' route 'run' conflicts with command 'external-canonical:run' under 'external-canonical:root'"
    );

    const replay = createKeyringCommandRegistry().registerPlugin(snapshot!);
    const originalLog = console.log;
    const lines: string[] = [];
    console.log = (...args: unknown[]) => {
      lines.push(args.join(' '));
    };

    try {
      const help = await registerCommands(
        yargs(['immutable-root', '--help'])
          .scriptName('aide')
          .exitProcess(false),
        replay
      ).getHelp();
      expect(help).toContain('aide immutable-root run');
      expect(help).not.toContain('mutated-root');
      expect(help).not.toContain('mutated-child');

      await registerCommands(
        yargs(['immutable-root', 'run']).scriptName('aide').exitProcess(false),
        replay
      )
        .strict()
        .parseAsync();
    } finally {
      console.log = originalLog;
    }

    expect(lines.at(-1)).toBe('canonical dispatch');
  });

  test('owns route arrays across direct and trusted module registration paths', () => {
    const directModuleRoute = ['direct-module', 'dm'];
    const directDescriptorRoute = ['direct-descriptor', 'dd'];
    const pluginModuleRoute = ['plugin-module', 'pm'];
    const trustedRouteInput = ['trusted-descriptor', 'td'];
    const trustedDescriptor = defineAideCommand.none<object, never>({
      id: 'trusted-descriptor',
      route: trustedRouteInput,
      summary: 'Trusted descriptor',
      run: () => Effect.succeed(textResult('trusted')),
    });
    const registry = createCommandRegistry()
      .registerModule('direct-module', {
        command: directModuleRoute,
        describe: 'Direct module',
        handler: () => {},
      })
      .registerDescriptor({
        id: 'direct-descriptor',
        route: directDescriptorRoute,
        summary: 'Direct descriptor',
        run: () => Effect.succeed(textResult('direct')),
      })
      .registerPlugin(
        defineAidePlugin({
          id: 'trusted-routes',
          summary: 'Trusted route registration paths',
          commands: [
            pluginCommandModule('plugin-module', {
              command: pluginModuleRoute,
              describe: 'Plugin module',
              handler: () => {},
            }),
            pluginCommandDescriptor.none(trustedDescriptor),
          ],
        })
      );

    const directModule = registry
      .commands()
      .find((entry) => entry.id === 'direct-module');
    const directDescriptor = registry
      .commands()
      .find((entry) => entry.id === 'direct-descriptor');
    const pluginModule = registry
      .commands()
      .find((entry) => entry.id === 'plugin-module');
    const trusted = registry
      .commands()
      .find((entry) => entry.id === 'trusted-descriptor');

    expect(directModule?.kind).toBe('module');
    expect(directDescriptor?.kind).toBe('descriptor');
    expect(pluginModule?.kind).toBe('module');
    expect(trusted).toMatchObject({
      kind: 'descriptor',
      execution: 'trusted',
      provisioning: 'none',
    });
    if (
      directModule?.kind !== 'module' ||
      directDescriptor?.kind !== 'descriptor' ||
      pluginModule?.kind !== 'module' ||
      trusted?.kind !== 'descriptor'
    ) {
      throw new Error('Expected all route registration paths');
    }

    expect(directModule.module.command).not.toBe(directModuleRoute);
    expect(directDescriptor.descriptor.route).not.toBe(directDescriptorRoute);
    expect(pluginModule.module.command).not.toBe(pluginModuleRoute);
    expect(trusted.descriptor.route).not.toBe(trustedDescriptor.route);
    expect(Object.isFrozen(directModule.module.command)).toBe(true);
    expect(Object.isFrozen(directDescriptor.descriptor.route)).toBe(true);
    expect(Object.isFrozen(pluginModule.module.command)).toBe(true);
    expect(Object.isFrozen(trusted.descriptor.route)).toBe(true);

    directModuleRoute[0] = 'mutated-direct-module';
    directDescriptorRoute[0] = 'mutated-direct-descriptor';
    pluginModuleRoute[0] = 'mutated-plugin-module';
    trustedRouteInput[0] = 'mutated-trusted-input';

    expect(directModule.module.command).toEqual(['direct-module', 'dm']);
    expect(directDescriptor.descriptor.route).toEqual([
      'direct-descriptor',
      'dd',
    ]);
    expect(pluginModule.module.command).toEqual(['plugin-module', 'pm']);
    expect(trusted.descriptor.route).toEqual(['trusted-descriptor', 'td']);
  });

  test('keeps yargs builders out of the public plugin command API at compile time', () => {
    const descriptor = definePublicAideCommand({
      id: 'external-tool:compile-only',
      route: 'compile-only',
      summary: 'Compile-only descriptor',
      // @ts-expect-error External plugin commands must not expose yargs builders.
      yargs: {
        builder: () => undefined,
      },
      run: () => Effect.succeed(textResult('compile-only')),
    });

    expect(descriptor.id).toBe('external-tool:compile-only');
  });

  test('keeps trusted descriptor conversion out of the public plugin API at compile time', () => {
    // @ts-expect-error Trusted descriptor conversion is host-internal.
    expect(publicPluginApi.publicPluginToTrustedDescriptor).toBeUndefined();
  });

  test('rejects raw yargs modules from external plugins before mutating the registry', () => {
    const registry = createCommandRegistry();

    expect(() =>
      registry.registerExternalPlugin(
        {
          id: 'external-tool',
          summary: 'External tool plugin',
          commands: [
            {
              kind: 'module',
              id: 'external-tool:raw',
              module: {
                command: 'raw',
                describe: 'Raw yargs command',
                handler: () => {},
              },
            },
          ],
        } as unknown as AidePublicPluginDescriptor,
        { manifest: externalManifest('external-tool', ['commands']) }
      )
    ).toThrow(
      'External plugin commands must be descriptor-backed; raw yargs modules are trusted internal only'
    );
    expect(registry.pluginIds()).toEqual([]);
    expect(registry.allCommandIds()).toEqual([]);
  });

  test('rejects reserved plugin and provider ids for external plugins', () => {
    const registry = createCommandRegistry();

    expect(() =>
      registry.registerExternalPlugin(
        definePublicAidePlugin({
          id: 'github',
          summary: 'Reserved plugin',
          commands: [],
        }),
        { manifest: externalManifest('github') }
      )
    ).toThrow("External plugin 'github' cannot use a reserved aide plugin id");

    expect(() =>
      registry.registerExternalPlugin(
        definePublicAidePlugin({
          id: 'external-github',
          summary: 'External GitHub provider',
          commands: [],
          capabilities: {
            pullRequestProvider: {
              providerId: 'github',
              priority: 1,
              features: {},
              matchRemote: () => null,
              matchPullRequestUrl: () => null,
              authStatus: () => Effect.succeed({ state: 'configured' }),
            },
          },
        }),
        {
          manifest: externalManifest('external-github', [
            'pull-request-provider',
          ]),
        }
      )
    ).toThrow(
      "External plugin 'external-github' cannot declare reserved pull request provider 'github'"
    );

    expect(() =>
      registry.registerExternalPlugin(
        definePublicAidePlugin({
          id: 'external-auth',
          summary: 'External auth provider',
          commands: [],
          capabilities: {
            authProvider: {
              providerId: 'github',
              label: 'External GitHub Auth',
              status: () => Effect.succeed({ state: 'configured' }),
            },
          },
        }),
        { manifest: externalManifest('external-auth', ['auth-provider']) }
      )
    ).toThrow(
      "Plugin 'external-auth' cannot declare reserved auth provider 'github' (reserved for plugin 'github')"
    );

    expect(registry.pluginIds()).toEqual([]);
  });

  test('derives Object.prototype-rejected ids for external plugin and prime group ids', () => {
    const prototypeNames = [
      ...Object.getOwnPropertyNames(Object.prototype),
      'prototype',
    ];
    expect(prototypeNames).toContain('toLocaleString');
    expect(prototypeNames).toContain('prototype');

    for (const prototypeName of prototypeNames) {
      const externalPluginId = prototypeName;
      const plugin = definePublicAidePlugin({
        id: externalPluginId,
        summary: 'Prototype-id external plugin',
        commands: [],
      });
      const registry = createCommandRegistry();

      expect(() =>
        registry.registerExternalPlugin(plugin, {
          manifest: externalManifest(externalPluginId),
        })
      ).toThrow('External plugin id is not canonical');
      expect(registry.pluginIds()).toEqual([]);

      const safeId = `prime-prototype-${prototypeName.toLowerCase()}`;
      expect(() =>
        createCommandRegistry().registerPlugin(
          defineAidePlugin({
            id: safeId,
            summary: 'Prototype group id external guard',
            commands: [],
            capabilities: {
              primeContribution: {
                status: [
                  {
                    groupId: prototypeName,
                    groupLabel: safeId,
                    label: safeId,
                    status: () => Effect.succeed({ state: 'configured' }),
                  },
                ],
              },
            },
          })
        )
      ).toThrow('Prime status group id is not canonical');
    }
  });

  test('validates prime metadata with NFC normalization and expanded-bound rejection', () => {
    const registry = createCommandRegistry();
    registry.registerPlugin(
      defineAidePlugin({
        id: 'nfc-prime',
        summary: 'NFC prime',
        commands: [],
        capabilities: {
          primeContribution: {
            status: [
              {
                groupId: 'nfc-group',
                groupLabel: 'a\u0301',
                label: 'a\u0301',
                messages: {
                  configured: 'a\u0301',
                },
                status: () => Effect.succeed({ state: 'configured' }),
              },
            ],
          },
        },
      })
    );

    const snapshot = registry.capabilities.primeContributions()[0]?.capability;
    expect(snapshot?.status?.[0]).toMatchObject({
      groupLabel: 'á',
      label: 'á',
      messages: { configured: 'á' },
    });

    const labelOverflow = '̈́'.repeat(65);
    expect(labelOverflow.length).toBe(65);
    expect(labelOverflow.normalize('NFC').length).toBe(130);

    const messageOverflow = '̈́'.repeat(513);
    expect(messageOverflow.length).toBe(513);
    expect(messageOverflow.normalize('NFC').length).toBe(1026);

    expect(() =>
      createCommandRegistry().registerPlugin(
        defineAidePlugin({
          id: 'nfc-prime-overflow-label',
          summary: 'NFC prime overflow',
          commands: [],
          capabilities: {
            primeContribution: {
              status: [
                {
                  groupId: 'overflow-group',
                  groupLabel: labelOverflow,
                  label: 'ok',
                  status: () => Effect.succeed({ state: 'configured' }),
                },
              ],
            },
          },
        })
      )
    ).toThrow(
      "Plugin 'nfc-prime-overflow-label' prime contribution field 'groupLabel' is invalid"
    );

    expect(() =>
      createCommandRegistry().registerPlugin(
        defineAidePlugin({
          id: 'nfc-prime-overflow-message',
          summary: 'NFC prime message overflow',
          commands: [],
          capabilities: {
            primeContribution: {
              status: [
                {
                  groupId: 'overflow-message-group',
                  groupLabel: 'overflow',
                  label: 'overflow',
                  messages: {
                    notConfigured: messageOverflow,
                  },
                  status: () => Effect.succeed({ state: 'configured' }),
                },
              ],
            },
          },
        })
      )
    ).toThrow(
      "Plugin 'nfc-prime-overflow-message' prime contribution field 'messages.notConfigured' is invalid"
    );
  });

  test('rejects all Unicode format-category characters in prime metadata', () => {
    const formatCharacters = [
      '\u00ad',
      '\u061c',
      '\u180E',
      '\u200C',
      '\u200D',
      '\u200E',
      '\u200F',
      '\u2060',
      '\uFEFF',
      '\uFFF9',
      '\uFFFA',
      '\uFFFB',
      '\u2028',
      '\u2029',
    ];

    for (const [index, value] of formatCharacters.entries()) {
      const registry = createCommandRegistry();
      const secret = `prime-format-${index}-${value}`;
      let error: unknown;
      try {
        registry.registerPlugin(
          defineAidePlugin({
            id: `format-prime-${index}`,
            summary: 'Format prime rejection',
            commands: [],
            capabilities: {
              primeContribution: {
                status: [
                  {
                    groupId: `format-group-${index}`,
                    groupLabel: `safe-${index}`,
                    label: secret,
                    status: () => Effect.succeed({ state: 'configured' }),
                  },
                ],
              },
            },
          })
        );
      } catch (cause) {
        error = cause;
      }

      expect(error).toBeInstanceOf(Error);
      const typed = error as Error;
      expect(typed.message).toBe(
        `Plugin 'format-prime-${index}' prime contribution field 'label' is invalid`
      );
      expect(typed.message).not.toContain(value);
      expect(exportedErrorText(typed)).not.toContain(value);
      if (error instanceof Error) {
        expect(exportedErrorText(error)).not.toContain(secret);
      }
      expect(registry.pluginIds()).toEqual([]);
    }
  });

  test('does not coerce hostile manifest ids and does not leak them in diagnostics', () => {
    const registry = createCommandRegistry();
    const secret = 'SECRET-MANIFEST-HOSTILE-ID';
    let idGetterCalls = 0;
    let toStringCalls = 0;
    let toPrimitiveCalls = 0;
    const manifest = Object.defineProperties(
      {},
      {
        id: {
          get: () => {
            idGetterCalls += 1;
            return secret;
          },
          enumerable: true,
        },
        toString: {
          value() {
            toStringCalls += 1;
            return secret;
          },
        },
        [Symbol.toPrimitive]: {
          value() {
            toPrimitiveCalls += 1;
            return secret;
          },
        },
      }
    );

    let hostileError: unknown;
    try {
      registry.registerExternalPlugin(
        definePublicAidePlugin({
          id: 'hostile-manifest-id',
          summary: 'Hostile manifest id',
          commands: [],
          capabilities: {
            authProvider: {
              providerId: 'hostile-auth',
              label: 'Hostile Auth',
              status: () => Effect.succeed({ state: 'configured' }),
            },
          },
        }),
        {
          manifest: manifest as AidePluginManifest,
        }
      );
    } catch (cause) {
      hostileError = cause;
    }

    expect(hostileError).toBeInstanceOf(Error);
    expect(idGetterCalls).toBe(0);
    expect(toStringCalls).toBe(0);
    expect(toPrimitiveCalls).toBe(0);
    expect((hostileError as Error).message).toBe(
      'External plugin metadata capture failed'
    );
    expect((hostileError as Error).message).not.toContain(secret);
    expect(exportedErrorText(hostileError as Error)).not.toContain(secret);
    expect(registry.pluginIds()).toEqual([]);

    const mismatchSecret = 'SECRET-MANIFEST-ID-MISMATCH';
    let mismatchError: unknown;
    try {
      registry.registerExternalPlugin(
        definePublicAidePlugin({
          id: 'manifest-mismatch',
          summary: 'Manifest mismatch',
          commands: [],
          capabilities: {
            authProvider: {
              providerId: 'manifest-mismatch-provider',
              label: 'Manifest Mismatch',
              status: () => Effect.succeed({ state: 'configured' }),
            },
          },
        }),
        {
          manifest: {
            id: mismatchSecret,
            version: '1.0.0',
            aidePluginApiVersion: AIDE_PLUGIN_API_VERSION,
            capabilities: ['auth-provider'],
            summary: 'summary',
          },
        }
      );
    } catch (cause) {
      mismatchError = cause;
    }

    expect(mismatchError).toBeInstanceOf(Error);
    expect((mismatchError as Error).message).toBe(
      "Plugin 'manifest-mismatch' manifest id does not match descriptor id"
    );
    expect((mismatchError as Error).message).not.toContain(mismatchSecret);
    expect(exportedErrorText(mismatchError as Error)).not.toContain(
      mismatchSecret
    );
  });

  test('rejects proxy manifests without traps, attacker retention, or registry mutation', () => {
    const registry = createKeyringCommandRegistry();
    registry.registerExternalPlugin(
      definePublicAidePlugin({
        id: 'existing-external',
        summary: 'Existing external plugin',
        commands: [
          publicPluginCommandDescriptor(
            definePublicAideCommand({
              id: 'existing-external:command',
              route: 'existing-external',
              summary: 'Existing external command',
              run: () => Effect.succeed(textResult('existing')),
            })
          ),
        ],
      }),
      { manifest: externalManifest('existing-external', ['commands']) }
    );

    const pluginsBefore = registry.plugins();
    const commandsBefore = registry.commands();
    const pluginIdsBefore = registry.pluginIds();
    const commandIdsBefore = registry.commandIds();
    const attacker = new Error('SECRET-MANIFEST-PROXY');
    let getCalls = 0;
    let descriptorCalls = 0;
    let ownKeysCalls = 0;
    let toStringCalls = 0;
    let toPrimitiveCalls = 0;
    const target = {
      ...externalManifest('proxy-manifest', ['commands']),
      toString() {
        toStringCalls += 1;
        return attacker.message;
      },
      [Symbol.toPrimitive]() {
        toPrimitiveCalls += 1;
        return attacker.message;
      },
    };
    const handler: ProxyHandler<typeof target> = {
      get(object, property, receiver) {
        getCalls += 1;
        return Reflect.get(object, property, receiver);
      },
      getOwnPropertyDescriptor() {
        descriptorCalls += 1;
        throw attacker;
      },
      ownKeys(object) {
        ownKeysCalls += 1;
        return Reflect.ownKeys(object);
      },
    };
    const ordinaryProxy = new Proxy(target, handler);
    const revoked = Proxy.revocable(target, handler);
    revoked.revoke();

    for (const manifest of [ordinaryProxy, revoked.proxy]) {
      let error: unknown;
      try {
        registry.registerExternalPlugin(
          definePublicAidePlugin({
            id: 'proxy-manifest',
            summary: 'Proxy manifest plugin',
            commands: [
              publicPluginCommandDescriptor(
                definePublicAideCommand({
                  id: 'proxy-manifest:command',
                  route: 'proxy-manifest',
                  summary: 'Proxy manifest command',
                  run: () => Effect.succeed(textResult('proxy')),
                })
              ),
            ],
          }),
          { manifest: manifest as AidePluginManifest }
        );
      } catch (cause) {
        error = cause;
      }

      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBe(attacker);
      expect((error as Error & { cause?: unknown }).cause).not.toBe(attacker);
      expect((error as Error).message).toBe(
        'External plugin metadata capture failed'
      );
      expect((error as Error).message).not.toContain(attacker.message);
      expect(exportedErrorText(error as Error)).not.toContain(attacker.message);
      expect(registry.plugins()).toEqual(pluginsBefore);
      expect(registry.commands()).toEqual(commandsBefore);
      expect(registry.pluginIds()).toEqual(pluginIdsBefore);
      expect(registry.commandIds()).toEqual(commandIdsBefore);
      expect(registry.pluginIds()).not.toContain('proxy-manifest');
      expect(registry.commandIds()).not.toContain('proxy-manifest:command');
    }

    expect(getCalls).toBe(0);
    expect(descriptorCalls).toBe(0);
    expect(ownKeysCalls).toBe(0);
    expect(toStringCalls).toBe(0);
    expect(toPrimitiveCalls).toBe(0);
  });

  test('rejects external plugin commands outside the plugin id namespace', () => {
    const registry = createCommandRegistry();

    expect(() =>
      registry.registerExternalPlugin(
        definePublicAidePlugin({
          id: 'external-tool',
          summary: 'External tool plugin',
          commands: [
            publicPluginCommandDescriptor(
              definePublicAideCommand({
                id: 'other-tool:hello',
                route: 'hello',
                summary: 'Say hello',
                run: () => Effect.succeed(textResult('hello')),
              })
            ),
          ],
        }),
        { manifest: externalManifest('external-tool', ['commands']) }
      )
    ).toThrow(
      "External plugin 'external-tool' command 'other-tool:hello' must use the plugin id namespace"
    );
    expect(registry.pluginIds()).toEqual([]);
  });

  test('rejects yargs builders from external plugin descriptors until public argument metadata exists', () => {
    const registry = createCommandRegistry();

    expect(() =>
      registry.registerExternalPlugin(
        {
          id: 'external-tool',
          summary: 'External tool plugin',
          commands: [
            {
              kind: 'descriptor',
              id: 'external-tool:hello',
              descriptor: {
                id: 'external-tool:hello',
                route: 'hello',
                summary: 'Say hello',
                yargs: {
                  builder: () => undefined,
                },
                run: () => Effect.succeed(textResult('hello')),
              },
            },
          ],
        } as unknown as AidePublicPluginDescriptor,
        { manifest: externalManifest('external-tool', ['commands']) }
      )
    ).toThrow(
      "External plugin 'external-tool' command 'external-tool:hello' cannot use yargs builders yet"
    );
    expect(registry.pluginIds()).toEqual([]);
  });

  test('rejects external plugin manifest mismatches before mutating the registry', () => {
    const registry = createCommandRegistry();
    const plugin = definePublicAidePlugin({
      id: 'external-tool',
      summary: 'External tool plugin',
      commands: [
        publicPluginCommandDescriptor(
          definePublicAideCommand({
            id: 'external-tool:hello',
            route: 'hello',
            summary: 'Say hello',
            run: () => Effect.succeed(textResult('hello')),
          })
        ),
      ],
    });

    expect(() =>
      registry.registerExternalPlugin(plugin, {
        manifest: {
          id: 'external-tool',
          version: '1.0.0',
          aidePluginApiVersion: 0 as typeof AIDE_PLUGIN_API_VERSION,
          capabilities: ['commands'],
        },
      })
    ).toThrow("Plugin 'external-tool' manifest aidePluginApiVersion must be 1");

    expect(() =>
      registry.registerExternalPlugin(plugin, {
        manifest: {
          id: 'external-tool',
          version: '1.0.0',
          aidePluginApiVersion: AIDE_PLUGIN_API_VERSION,
          capabilities: [],
        },
      })
    ).toThrow(
      "Plugin 'external-tool' manifest does not declare provided capability 'commands'"
    );

    expect(() =>
      registry.registerExternalPlugin(plugin, {
        manifest: {
          id: 'external-tool',
          version: '1.0.0',
          aidePluginApiVersion: AIDE_PLUGIN_API_VERSION,
          capabilities: ['commands'],
          conflicts: {
            authProviders: 'replace' as 'reject',
          },
        },
      })
    ).toThrow(
      "Plugin 'external-tool' manifest conflicts.authProviders must be 'reject'"
    );
    expect(registry.pluginIds()).toEqual([]);
  });

  test('requires a manifest when registering external plugins', () => {
    const registry = createCommandRegistry();

    expect(() =>
      registry.registerExternalPlugin(
        definePublicAidePlugin({
          id: 'external-tool',
          summary: 'External tool plugin',
          commands: [],
        })
      )
    ).toThrow("External plugin 'external-tool' requires a manifest");
    expect(registry.pluginIds()).toEqual([]);
  });

  test('rejects duplicate command ids declared by a plugin', () => {
    const module = {
      command: 'sample',
      describe: 'Sample command',
      handler: () => {},
    };
    const registry = createCommandRegistry();

    expect(() =>
      registry.registerPlugin(
        defineAidePlugin({
          id: 'sample-plugin',
          summary: 'Sample plugin',
          commands: [
            pluginCommandModule('sample', module),
            pluginCommandModule('sample', module),
          ],
        })
      )
    ).toThrow(
      "Plugin 'sample-plugin' declares command 'sample' more than once"
    );
  });

  test('rejects empty ids before collision checks', () => {
    const registry = createCommandRegistry();

    expect(() =>
      registry.registerPlugin(
        defineAidePlugin({
          id: '',
          summary: 'Empty plugin id',
          commands: [],
        })
      )
    ).toThrow('Plugin id must not be empty');

    expect(() =>
      registry.registerModule('', {
        command: 'sample',
        describe: 'Sample command',
        handler: () => {},
      })
    ).toThrow('Command id must not be empty');
  });

  test('rejects route collisions even when command ids differ', () => {
    const registry = createCommandRegistry();

    registry.registerModule('first', {
      command: 'sample <command>',
      describe: 'First sample command',
      handler: () => {},
    });

    expect(() =>
      registry.registerModule('second', {
        command: 'sample [name]',
        describe: 'Second sample command',
        handler: () => {},
      })
    ).toThrow("Command 'second' route 'sample' conflicts with command 'first'");
  });

  test('rejects route collisions inside one plugin', () => {
    const module = {
      command: 'sample <command>',
      describe: 'Sample command',
      handler: () => {},
    };
    const registry = createCommandRegistry();

    expect(() =>
      registry.registerPlugin(
        defineAidePlugin({
          id: 'sample-plugin',
          summary: 'Sample plugin',
          commands: [
            pluginCommandModule('first', module),
            pluginCommandModule('second', {
              ...module,
              command: 'sample [name]',
            }),
          ],
        })
      )
    ).toThrow(
      "Plugin 'sample-plugin' declares route 'sample' for commands 'first' and 'second'"
    );
  });

  test('allows child route ownership under a command group', () => {
    const registry = createCommandRegistry();

    registry.registerModule('parent', {
      command: 'parent <command>',
      describe: 'Parent command',
      handler: () => {},
    });
    registry.registerDescriptor(
      {
        id: 'parent:child',
        route: 'child',
        summary: 'Child command',
        run: () => Effect.succeed(textResult('child')),
      },
      { parentId: 'parent' }
    );

    expect(registry.commandIds()).toEqual(['parent']);
    expect(registry.childCommandIds('parent')).toEqual(['parent:child']);
    expect(registry.allCommandIds()).toEqual(['parent', 'parent:child']);
  });

  test('allows same-plugin child routes under command groups by default', () => {
    const registry = createCommandRegistry();

    registry.registerPlugin(
      defineAidePlugin({
        id: 'parent-plugin',
        summary: 'Parent plugin',
        commands: [
          pluginCommandModule('parent', {
            command: 'parent <command>',
            describe: 'Parent command',
            handler: () => {},
          }),
          serviceFreePluginCommand(
            {
              id: 'parent:child',
              route: 'child',
              summary: 'Child command',
              run: () => Effect.succeed(textResult('child')),
            },
            { parentId: 'parent' }
          ),
        ],
      })
    );

    expect(registry.childCommandIds('parent')).toEqual(['parent:child']);
  });

  test('allows same-plugin child routes regardless of declaration order', () => {
    const registry = createCommandRegistry();

    registry.registerPlugin(
      defineAidePlugin({
        id: 'parent-plugin',
        summary: 'Parent plugin',
        commands: [
          serviceFreePluginCommand(
            {
              id: 'parent:child',
              route: 'child',
              summary: 'Child command',
              run: () => Effect.succeed(textResult('child')),
            },
            { parentId: 'parent' }
          ),
          pluginCommandModule('parent', {
            command: 'parent <command>',
            describe: 'Parent command',
            handler: () => {},
          }),
        ],
      })
    );

    expect(registry.childCommandIds('parent')).toEqual(['parent:child']);
  });

  test('rejects cross-plugin child routes by default', () => {
    const registry = createCommandRegistry();

    registry.registerPlugin(
      defineAidePlugin({
        id: 'parent-plugin',
        summary: 'Parent plugin',
        commands: [
          pluginCommandModule('parent', {
            command: 'parent <command>',
            describe: 'Parent command',
            handler: () => {},
          }),
        ],
      })
    );

    expect(() =>
      registry.registerPlugin(
        defineAidePlugin({
          id: 'child-plugin',
          summary: 'Child plugin',
          commands: [
            serviceFreePluginCommand(
              {
                id: 'parent:child',
                route: 'child',
                summary: 'Child command',
                run: () => Effect.succeed(textResult('child')),
              },
              { parentId: 'parent' }
            ),
          ],
        })
      )
    ).toThrow(
      "Command 'parent:child' from plugin 'child-plugin' cannot extend parent 'parent' owned by plugin 'parent-plugin' at route 'child'"
    );
    expect(registry.pluginIds()).toEqual(['parent-plugin']);
    expect(registry.childCommandIds('parent')).toEqual([]);
  });

  test('allows cross-plugin child routes when the parent extension policy is open', () => {
    const registry = createCommandRegistry();

    registry.registerPlugin(
      defineAidePlugin({
        id: 'parent-plugin',
        summary: 'Parent plugin',
        commands: [
          pluginCommandModule(
            'parent',
            {
              command: 'parent <command>',
              describe: 'Parent command',
              handler: () => {},
            },
            { extension: { kind: 'open' } }
          ),
        ],
      })
    );
    registry.registerPlugin(
      defineAidePlugin({
        id: 'child-plugin',
        summary: 'Child plugin',
        commands: [
          serviceFreePluginCommand(
            {
              id: 'parent:child',
              route: 'child',
              summary: 'Child command',
              run: () => Effect.succeed(textResult('child')),
            },
            { parentId: 'parent' }
          ),
        ],
      })
    );

    expect(registry.childCommandIds('parent')).toEqual(['parent:child']);
  });

  test('allows cross-plugin child routes under same-plugin child groups that opt into open extension', () => {
    const registry = createCommandRegistry();

    registry.registerPlugin(
      defineAidePlugin({
        id: 'parent-plugin',
        summary: 'Parent plugin',
        commands: [
          pluginCommandModule(
            'parent',
            {
              command: 'parent',
              describe: 'Parent command',
              handler: () => {},
            },
            { acceptsChildren: true }
          ),
          serviceFreePluginCommand(
            {
              id: 'parent:child',
              route: 'child',
              summary: 'Child command group',
              run: () => Effect.succeed(textResult('child')),
            },
            {
              parentId: 'parent',
              acceptsChildren: true,
              extension: { kind: 'open' },
            }
          ),
        ],
      })
    );
    registry.registerPlugin(
      defineAidePlugin({
        id: 'grandchild-plugin',
        summary: 'Grandchild plugin',
        commands: [
          serviceFreePluginCommand(
            {
              id: 'parent:child:grandchild',
              route: 'grandchild',
              summary: 'Grandchild command',
              run: () => Effect.succeed(textResult('grandchild')),
            },
            { parentId: 'parent:child' }
          ),
        ],
      })
    );

    expect(registry.childCommandIds('parent')).toEqual(['parent:child']);
    expect(registry.childCommandIds('parent:child')).toEqual([
      'parent:child:grandchild',
    ]);
  });

  test('allows cross-plugin child routes only for allowlisted plugins', () => {
    const registry = createCommandRegistry();

    registry.registerPlugin(
      defineAidePlugin({
        id: 'parent-plugin',
        summary: 'Parent plugin',
        commands: [
          pluginCommandModule(
            'parent',
            {
              command: 'parent <command>',
              describe: 'Parent command',
              handler: () => {},
            },
            {
              extension: {
                kind: 'allowlist',
                pluginIds: ['allowed-child-plugin'],
              },
            }
          ),
        ],
      })
    );
    registry.registerPlugin(
      defineAidePlugin({
        id: 'allowed-child-plugin',
        summary: 'Allowed child plugin',
        commands: [
          serviceFreePluginCommand(
            {
              id: 'parent:allowed-child',
              route: 'allowed',
              summary: 'Allowed child command',
              run: () => Effect.succeed(textResult('allowed')),
            },
            { parentId: 'parent' }
          ),
        ],
      })
    );

    expect(() =>
      registry.registerPlugin(
        defineAidePlugin({
          id: 'blocked-child-plugin',
          summary: 'Blocked child plugin',
          commands: [
            serviceFreePluginCommand(
              {
                id: 'parent:blocked-child',
                route: 'blocked',
                summary: 'Blocked child command',
                run: () => Effect.succeed(textResult('blocked')),
              },
              { parentId: 'parent' }
            ),
          ],
        })
      )
    ).toThrow(
      "Command 'parent:blocked-child' from plugin 'blocked-child-plugin' cannot extend parent 'parent' owned by plugin 'parent-plugin' at route 'blocked'"
    );
    expect(registry.childCommandIds('parent')).toEqual([
      'parent:allowed-child',
    ]);
  });

  test('snapshots allowlist policy plugin ids', () => {
    const registry = createCommandRegistry();
    const pluginIds = ['allowed-child-plugin'];

    registry.registerPlugin(
      defineAidePlugin({
        id: 'parent-plugin',
        summary: 'Parent plugin',
        commands: [
          pluginCommandModule(
            'parent',
            {
              command: 'parent <command>',
              describe: 'Parent command',
              handler: () => {},
            },
            {
              extension: {
                kind: 'allowlist',
                pluginIds,
              },
            }
          ),
        ],
      })
    );
    pluginIds[0] = 'blocked-child-plugin';

    registry.registerPlugin(
      defineAidePlugin({
        id: 'allowed-child-plugin',
        summary: 'Allowed child plugin',
        commands: [
          serviceFreePluginCommand(
            {
              id: 'parent:allowed-child',
              route: 'allowed',
              summary: 'Allowed child command',
              run: () => Effect.succeed(textResult('allowed')),
            },
            { parentId: 'parent' }
          ),
        ],
      })
    );

    expect(() =>
      registry.registerPlugin(
        defineAidePlugin({
          id: 'blocked-child-plugin',
          summary: 'Blocked child plugin',
          commands: [
            serviceFreePluginCommand(
              {
                id: 'parent:blocked-child',
                route: 'blocked',
                summary: 'Blocked child command',
                run: () => Effect.succeed(textResult('blocked')),
              },
              { parentId: 'parent' }
            ),
          ],
        })
      )
    ).toThrow(
      "Command 'parent:blocked-child' from plugin 'blocked-child-plugin' cannot extend parent 'parent' owned by plugin 'parent-plugin' at route 'blocked'"
    );
    expect(registry.childCommandIds('parent')).toEqual([
      'parent:allowed-child',
    ]);
  });

  test('rejects invalid allowlist plugin ids without registering the plugin', () => {
    const registry = createCommandRegistry();

    expect(() =>
      registry.registerPlugin(
        defineAidePlugin({
          id: 'parent-plugin',
          summary: 'Parent plugin',
          commands: [
            pluginCommandModule(
              'parent',
              {
                command: 'parent <command>',
                describe: 'Parent command',
                handler: () => {},
              },
              {
                extension: {
                  kind: 'allowlist',
                  pluginIds: ['bad plugin'],
                },
              }
            ),
          ],
        })
      )
    ).toThrow("Plugin id 'bad plugin' must not contain whitespace");
    expect(registry.pluginIds()).toEqual([]);
    expect(registry.commandIds()).toEqual([]);
  });

  test('rejects child commands for missing or non-group parents', () => {
    const registry = createCommandRegistry();

    expect(() =>
      registry.registerDescriptor(
        {
          id: 'missing:child',
          route: 'child',
          summary: 'Child command',
          run: () => Effect.succeed(textResult('child')),
        },
        { parentId: 'missing' }
      )
    ).toThrow("Command 'missing:child' parent 'missing' is not registered");

    registry.registerModule('plain', {
      command: 'plain',
      describe: 'Plain command',
      handler: () => {},
    });

    expect(() =>
      registry.registerDescriptor(
        {
          id: 'plain:child',
          route: 'child',
          summary: 'Child command',
          run: () => Effect.succeed(textResult('child')),
        },
        { parentId: 'plain' }
      )
    ).toThrow(
      "Command 'plain:child' parent 'plain' does not accept subcommands"
    );
  });

  test('rejects extension policy on commands that are not command groups', () => {
    const registry = createCommandRegistry();

    expect(() =>
      registry.registerPlugin(
        defineAidePlugin({
          id: 'plain-plugin',
          summary: 'Plain plugin',
          commands: [
            pluginCommandModule(
              'plain',
              {
                command: 'plain',
                describe: 'Plain command',
                handler: () => {},
              },
              { extension: { kind: 'open' } }
            ),
          ],
        })
      )
    ).toThrow(
      "Command 'plain' declares an extension policy but does not accept subcommands"
    );
    expect(() =>
      registry.registerModule(
        'direct-plain',
        {
          command: 'direct-plain',
          describe: 'Direct plain command',
          handler: () => {},
        },
        { extension: { kind: 'open' } }
      )
    ).toThrow(
      "Command 'direct-plain' declares an extension policy but does not accept subcommands"
    );

    registry.registerModule('direct-plain', {
      command: 'direct-plain',
      describe: 'Direct plain command',
      handler: () => {},
    });
    expect(registry.commandIds()).toEqual(['direct-plain']);
  });

  test('rejects extension policy on child commands that are not command groups', () => {
    const pluginRegistry = createCommandRegistry();

    expect(() =>
      pluginRegistry.registerPlugin(
        defineAidePlugin({
          id: 'parent-plugin',
          summary: 'Parent plugin',
          commands: [
            pluginCommandModule('parent', {
              command: 'parent <command>',
              describe: 'Parent command',
              handler: () => {},
            }),
            serviceFreePluginCommand(
              {
                id: 'parent:child',
                route: 'child',
                summary: 'Child command',
                run: () => Effect.succeed(textResult('child')),
              },
              {
                parentId: 'parent',
                extension: { kind: 'open' },
              }
            ),
          ],
        })
      )
    ).toThrow(
      "Command 'parent:child' declares an extension policy but does not accept subcommands"
    );
    expect(pluginRegistry.pluginIds()).toEqual([]);
    expect(pluginRegistry.commandIds()).toEqual([]);

    const directRegistry = createCommandRegistry();
    directRegistry.registerModule('parent', {
      command: 'parent <command>',
      describe: 'Parent command',
      handler: () => {},
    });

    expect(() =>
      directRegistry.registerDescriptor(
        {
          id: 'parent:child',
          route: 'child',
          summary: 'Child command',
          run: () => Effect.succeed(textResult('child')),
        },
        {
          parentId: 'parent',
          extension: { kind: 'open' },
        }
      )
    ).toThrow(
      "Command 'parent:child' declares an extension policy but does not accept subcommands"
    );
    expect(directRegistry.childCommandIds('parent')).toEqual([]);

    directRegistry.registerDescriptor(
      {
        id: 'parent:child',
        route: 'child',
        summary: 'Child command',
        run: () => Effect.succeed(textResult('child')),
      },
      { parentId: 'parent' }
    );
    expect(directRegistry.childCommandIds('parent')).toEqual(['parent:child']);
  });

  test('allows explicit child command groups with extension policies', () => {
    const registry = createCommandRegistry();

    registry.registerModule(
      'parent',
      {
        command: 'parent',
        describe: 'Parent command',
        handler: () => {},
      },
      { acceptsChildren: true }
    );
    registry.registerDescriptor(
      {
        id: 'parent:child',
        route: 'child',
        summary: 'Child command group',
        run: () => Effect.succeed(textResult('child')),
      },
      {
        parentId: 'parent',
        acceptsChildren: true,
        extension: { kind: 'open' },
      }
    );
    registry.registerDescriptor(
      {
        id: 'parent:child:grandchild',
        route: 'grandchild',
        summary: 'Grandchild command',
        run: () => Effect.succeed(textResult('grandchild')),
      },
      { parentId: 'parent:child' }
    );

    expect(registry.childCommandIds('parent')).toEqual(['parent:child']);
    expect(registry.childCommandIds('parent:child')).toEqual([
      'parent:child:grandchild',
    ]);
    expect(registry.allCommandIds()).toEqual([
      'parent',
      'parent:child',
      'parent:child:grandchild',
    ]);
  });

  test('lets explicit command group metadata override route syntax fallback', () => {
    const registry = createCommandRegistry();

    registry.registerModule(
      'parent',
      {
        command: 'parent <command>',
        describe: 'Parent command',
        handler: () => {},
      },
      { acceptsChildren: false }
    );

    expect(() =>
      registry.registerDescriptor(
        {
          id: 'parent:child',
          route: 'child',
          summary: 'Child command',
          run: () => Effect.succeed(textResult('child')),
        },
        { parentId: 'parent' }
      )
    ).toThrow(
      "Command 'parent:child' parent 'parent' does not accept subcommands"
    );
    expect(() =>
      registry.registerModule(
        'other',
        {
          command: 'other <command>',
          describe: 'Other command',
          handler: () => {},
        },
        {
          acceptsChildren: false,
          extension: { kind: 'open' },
        }
      )
    ).toThrow(
      "Command 'other' declares an extension policy but does not accept subcommands"
    );
    expect(registry.childCommandIds('parent')).toEqual([]);
    expect(registry.commandIds()).toEqual(['parent']);
  });

  test('rejects non-boolean plugin command group metadata before mutating the registry', () => {
    const registry = createCommandRegistry();

    expect(() =>
      registry.registerPlugin(
        defineAidePlugin({
          id: 'malformed-plugin',
          summary: 'Malformed plugin',
          commands: [
            pluginCommandModule(
              'malformed',
              {
                command: 'malformed',
                describe: 'Malformed command',
                handler: () => {},
              },
              { acceptsChildren: 'yes' as unknown as boolean }
            ),
          ],
        })
      )
    ).toThrow(
      "Plugin 'malformed-plugin' command 'malformed' acceptsChildren must be a boolean"
    );
    expect(registry.pluginIds()).toEqual([]);
    expect(registry.commandIds()).toEqual([]);
  });

  test('rejects plugin command parent cycles before mutating the registry', () => {
    const registry = createCommandRegistry();

    expect(() =>
      registry.registerPlugin(
        defineAidePlugin({
          id: 'cycle-plugin',
          summary: 'Plugin with a command parent cycle',
          commands: [
            serviceFreePluginCommand(
              {
                id: 'cycle:a',
                route: 'a',
                summary: 'Cycle command A',
                run: () => Effect.succeed(textResult('a')),
              },
              { parentId: 'cycle:b', acceptsChildren: true }
            ),
            serviceFreePluginCommand(
              {
                id: 'cycle:b',
                route: 'b',
                summary: 'Cycle command B',
                run: () => Effect.succeed(textResult('b')),
              },
              { parentId: 'cycle:a', acceptsChildren: true }
            ),
          ],
        })
      )
    ).toThrow(
      "Plugin 'cycle-plugin' declares a command parent cycle: cycle:a -> cycle:b -> cycle:a"
    );
    expect(registry.pluginIds()).toEqual([]);
    expect(registry.allCommandIds()).toEqual([]);
  });

  test('registers recursive plugin command groups in parent-depth order', () => {
    const registry = createCommandRegistry();

    registry.registerPlugin(
      defineAidePlugin({
        id: 'recursive-plugin',
        summary: 'Recursive command plugin',
        commands: [
          serviceFreePluginCommand(
            {
              id: 'recursive:child:grandchild',
              route: 'grandchild',
              summary: 'Grandchild command',
              run: () => Effect.succeed(textResult('grandchild')),
            },
            { parentId: 'recursive:child' }
          ),
          serviceFreePluginCommand(
            {
              id: 'recursive:child',
              route: 'child',
              summary: 'Child command group',
              run: () => Effect.succeed(textResult('child')),
            },
            { parentId: 'recursive', acceptsChildren: true }
          ),
          pluginCommandModule(
            'recursive',
            {
              command: 'recursive',
              describe: 'Recursive parent command',
              handler: () => {},
            },
            { acceptsChildren: true }
          ),
        ],
      })
    );

    expect(registry.childCommandIds('recursive')).toEqual(['recursive:child']);
    expect(registry.childCommandIds('recursive:child')).toEqual([
      'recursive:child:grandchild',
    ]);
    expect(registry.allCommandIds()).toEqual([
      'recursive',
      'recursive:child',
      'recursive:child:grandchild',
    ]);
  });

  test('rejects duplicate child routes under the same parent', () => {
    const registry = createCommandRegistry();

    expect(() =>
      registry.registerPlugin(
        defineAidePlugin({
          id: 'parent-plugin',
          summary: 'Parent plugin',
          commands: [
            pluginCommandModule('parent', {
              command: 'parent <command>',
              describe: 'Parent command',
              handler: () => {},
            }),
            serviceFreePluginCommand(
              {
                id: 'parent:first-child',
                route: 'child',
                summary: 'First child',
                run: () => Effect.succeed(textResult('first')),
              },
              { parentId: 'parent' }
            ),
            serviceFreePluginCommand(
              {
                id: 'parent:second-child',
                route: 'child',
                summary: 'Second child',
                run: () => Effect.succeed(textResult('second')),
              },
              { parentId: 'parent' }
            ),
          ],
        })
      )
    ).toThrow(
      "Plugin 'parent-plugin' declares route 'child' under 'parent' for commands 'parent:first-child' and 'parent:second-child'"
    );
  });

  test('returns array snapshots for plugins and commands', () => {
    const registry = createBuiltinCommandRegistry();

    const plugins = registry.plugins() as unknown[];
    const commands = registry.commands() as unknown[];

    plugins.length = 0;
    commands.length = 0;

    expect(registry.pluginIds()).toEqual([
      'jira',
      'github',
      'azure-devops',
      'pull-requests',
      'claude-code',
      'aide-core',
      'legacy-auth',
    ]);
    expect(registry.commandIds()).toEqual([
      'jira',
      'pr',
      'plugin',
      'prime',
      'upgrade',
      'login',
      'logout',
      'whoami',
    ]);
    expect(registry.childCommandIds('pr')).toEqual(expectedPrChildCommandIds);
  });

  test('freezes retained command and plugin descriptor shells', () => {
    const registry = createBuiltinCommandRegistry();
    const command = registry.commands()[0] as unknown as { id: string };
    const plugin = registry.plugins()[0] as unknown as { id: string };

    expect(() => {
      command.id = 'mutated-command';
    }).toThrow();
    expect(() => {
      plugin.id = 'mutated-plugin';
    }).toThrow();

    expect(registry.commandIds()[0]).toBe('jira');
    expect(registry.pluginIds()[0]).toBe('jira');
  });

  test('discovers auth capabilities with plugin ownership without invoking them', async () => {
    const registry = createCommandRegistry();
    let statusCalls = 0;

    registry
      .registerPlugin(
        defineAidePlugin({
          id: 'no-auth-plugin',
          summary: 'Plugin without auth',
          commands: [],
        })
      )
      .registerPlugin(
        defineAidePlugin({
          id: 'auth-plugin',
          summary: 'Plugin with auth',
          commands: [],
          capabilities: {
            auth: {
              status: () =>
                Effect.sync(() => {
                  statusCalls += 1;
                  return {
                    state: 'configured' as const,
                    detail: 'ready',
                  };
                }),
            },
          },
        })
      );

    expect(statusCalls).toBe(0);

    const capabilities = registry.capabilities.auth();

    expect(statusCalls).toBe(0);
    expect(capabilities).toHaveLength(1);
    expect(capabilities[0]?.pluginId).toBe('auth-plugin');

    const status = await Effect.runPromise(
      capabilities[0]!.capability
        .status()
        .pipe(Effect.provide(makeTestKeyring().layer))
    );

    expect(statusCalls).toBe(1);
    expect(status).toEqual({ state: 'configured', detail: 'ready' });
  });

  test('discovers auth providers and prime contributions without invoking them', async () => {
    const registry = createCommandRegistry();
    let statusCalls = 0;
    let sectionCalls = 0;
    const status = () =>
      Effect.sync(() => {
        statusCalls += 1;
        return {
          state: 'configured' as const,
          detail: 'ready',
        };
      });

    registry.registerPlugin(
      defineAidePlugin({
        id: 'dynamic-auth-plugin',
        summary: 'Plugin with dynamic auth',
        commands: [],
        capabilities: {
          authProvider: {
            providerId: 'dynamic-auth',
            label: 'Dynamic Auth',
            status,
            operations: {
              login: () =>
                Effect.succeed({
                  status: 'stored' as const,
                  messages: ['logged in'],
                }),
              logout: () =>
                Effect.succeed({
                  status: 'removed' as const,
                  messages: ['logged out'],
                }),
            },
          },
          primeContribution: {
            status: [
              {
                groupId: 'dynamic-auth',
                groupLabel: 'Dynamic Auth',
                label: 'Dynamic Auth',
                status,
              },
            ],
            sections: () =>
              Effect.sync(() => {
                sectionCalls += 1;
                return [
                  {
                    id: 'dynamic-auth-help',
                    order: 500,
                    body: '## Dynamic Auth',
                  },
                ];
              }),
          },
        },
      })
    );

    const authProviders = registry.capabilities.authProviders();
    const primeContributions = registry.capabilities.primeContributions();

    expect(statusCalls).toBe(0);
    expect(sectionCalls).toBe(0);
    expect(authProviders).toHaveLength(1);
    expect(authProviders[0]).toMatchObject({
      pluginId: 'dynamic-auth-plugin',
      capability: {
        providerId: 'dynamic-auth',
        label: 'Dynamic Auth',
      },
    });
    expect(primeContributions).toHaveLength(1);
    expect(primeContributions[0]?.pluginId).toBe('dynamic-auth-plugin');

    const providerStatus = await Effect.runPromise(
      authProviders[0]!.capability
        .status()
        .pipe(Effect.provide(makeTestKeyring().layer))
    );
    const loginResult = await Effect.runPromise(
      authProviders[0]!.capability.operations!.login!({}).pipe(
        Effect.provide(makeTestKeyring().layer)
      )
    );
    const logoutResult = await Effect.runPromise(
      authProviders[0]!.capability.operations!.logout!().pipe(
        Effect.provide(makeTestKeyring().layer)
      )
    );
    const primeStatus = await Effect.runPromise(
      primeContributions[0]!.capability
        .status![0]!.status()
        .pipe(Effect.provide(makeTestKeyring().layer))
    );
    const sections = await Effect.runPromise(
      primeContributions[0]!.capability.sections!()
    );

    expect(providerStatus).toEqual({ state: 'configured', detail: 'ready' });
    expect(loginResult).toEqual({
      status: 'stored',
      messages: ['logged in'],
    });
    expect(logoutResult).toEqual({
      status: 'removed',
      messages: ['logged out'],
    });
    expect(primeStatus).toEqual({ state: 'configured', detail: 'ready' });
    expect(sections).toEqual([
      { id: 'dynamic-auth-help', order: 500, body: '## Dynamic Auth' },
    ]);
    expect(statusCalls).toBe(2);
    expect(sectionCalls).toBe(1);
  });

  test('rejects duplicate dynamic auth provider ids', () => {
    const registry = createCommandRegistry();

    registry.registerPlugin(
      defineAidePlugin({
        id: 'first-auth-plugin',
        summary: 'First auth plugin',
        commands: [],
        capabilities: {
          authProvider: {
            providerId: 'shared-auth',
            label: 'Shared Auth',
            status: () => Effect.succeed({ state: 'configured' }),
          },
        },
      })
    );

    expect(() =>
      registry.registerPlugin(
        defineAidePlugin({
          id: 'second-auth-plugin',
          summary: 'Second auth plugin',
          commands: [],
          capabilities: {
            authProvider: {
              providerId: 'shared-auth',
              label: 'Shared Auth',
              status: () => Effect.succeed({ state: 'configured' }),
            },
          },
        })
      )
    ).toThrow(
      "Auth provider 'shared-auth' is already registered by plugin 'first-auth-plugin'"
    );
  });

  test('enforces canonical auth provider ids while allowing external namespaces', () => {
    const invalidProviderIds = [
      'constructor',
      '__proto__',
      'toString',
      'provider/name',
      'provider:name',
      'Provider-Name',
      ' provider-name ',
      'p'.repeat(65),
      'K',
      'githubK',
      'Ｇithub',
      '\u00a0provider-name',
    ];

    for (const providerId of invalidProviderIds) {
      const registry = createCommandRegistry();
      expect(() =>
        registry.registerPlugin(
          defineAidePlugin({
            id: 'provider-policy-test',
            summary: 'Provider policy test',
            commands: [],
            capabilities: {
              authProvider: {
                providerId,
                label: 'Provider Policy Test',
                status: () => Effect.succeed({ state: 'configured' }),
              },
            },
          })
        )
      ).toThrow(/auth provider id/i);
      expect(registry.pluginIds()).toEqual([]);
    }

    const registry = createCommandRegistry();
    registry.registerExternalPlugin(
      definePublicAidePlugin({
        id: 'external-provider-policy-test',
        summary: 'External provider policy test',
        commands: [],
        capabilities: {
          authProvider: {
            providerId: 'acme.auth_v2',
            label: 'Acme Auth',
            status: () => Effect.succeed({ state: 'configured' }),
          },
        },
      }),
      {
        manifest: externalManifest('external-provider-policy-test', [
          'auth-provider',
        ]),
      }
    );

    expect(
      registry.capabilities.authProviders()[0]?.capability.providerId
    ).toBe('acme.auth_v2');
  });

  test('validates auth provider and prime contribution capability shape', () => {
    const registry = createCommandRegistry();

    expect(() =>
      registry.registerPlugin(
        defineAidePlugin({
          id: 'bad-auth-plugin',
          summary: 'Bad auth plugin',
          commands: [],
          capabilities: {
            authProvider: {
              providerId: 'bad-auth',
              label: 'Bad Auth',
              status: 'ready',
            },
          },
        } as unknown as Parameters<typeof registry.registerPlugin>[0])
      )
    ).toThrow(
      "Plugin 'bad-auth-plugin' auth provider capability field 'status' must be a function"
    );

    expect(() =>
      registry.registerPlugin(
        defineAidePlugin({
          id: 'bad-prime-plugin',
          summary: 'Bad prime plugin',
          commands: [],
          capabilities: {
            primeContribution: {
              status: 'ready',
            },
          },
        } as unknown as Parameters<typeof registry.registerPlugin>[0])
      )
    ).toThrow(
      "Plugin 'bad-prime-plugin' prime contribution status must be an array"
    );

    expect(() =>
      registry.registerPlugin(
        defineAidePlugin({
          id: 'bad-auth-operations-plugin',
          summary: 'Bad auth operations plugin',
          commands: [],
          capabilities: {
            authProvider: {
              providerId: 'bad-auth-operations',
              label: 'Bad Auth Operations',
              status: () => Effect.succeed({ state: 'configured' }),
              operations: {
                login: 'ready',
              },
            },
          },
        } as unknown as Parameters<typeof registry.registerPlugin>[0])
      )
    ).toThrow(
      "Plugin 'bad-auth-operations-plugin' auth provider 'bad-auth-operations' operation 'login' must be a function"
    );

    expect(() =>
      registry.registerPlugin(
        defineAidePlugin({
          id: 'bad-auth-metadata-plugin',
          summary: 'Bad auth metadata plugin',
          commands: [],
          capabilities: {
            authProvider: {
              providerId: 'bad-auth-metadata',
              label: 'Bad Auth Metadata',
              status: () => Effect.succeed({ state: 'configured' }),
              login: {
                fields: [
                  {
                    kind: 'select',
                    key: 'mode',
                    label: 'Mode',
                    choices: [],
                  },
                ],
              },
            },
          },
        } as unknown as Parameters<typeof registry.registerPlugin>[0])
      )
    ).toThrow(
      "Plugin 'bad-auth-metadata-plugin' auth provider 'bad-auth-metadata' login field 'mode' choices must be a non-empty array"
    );

    expect(() =>
      registry.registerPlugin(
        defineAidePlugin({
          id: 'bad-auth-flag-plugin',
          summary: 'Bad auth flag plugin',
          commands: [],
          capabilities: {
            authProvider: {
              providerId: 'bad-auth-flag',
              label: 'Bad Auth Flag',
              status: () => Effect.succeed({ state: 'configured' }),
              login: {
                fields: [
                  {
                    kind: 'text',
                    key: 'apiToken',
                    label: 'API token',
                  },
                  {
                    kind: 'text',
                    key: 'api-token',
                    label: 'API token alias',
                  },
                ],
              },
            },
          },
        })
      )
    ).toThrow(
      "Plugin 'bad-auth-flag-plugin' auth provider 'bad-auth-flag' declares login fields 'apiToken' and 'api-token' that both map to flag '--api-token'"
    );

    expect(() =>
      registry.registerPlugin(
        defineAidePlugin({
          id: 'bad-auth-reserved-flag-plugin',
          summary: 'Bad auth reserved flag plugin',
          commands: [],
          capabilities: {
            authProvider: {
              providerId: 'bad-auth-reserved-flag',
              label: 'Bad Auth Reserved Flag',
              status: () => Effect.succeed({ state: 'configured' }),
              login: {
                fields: [
                  {
                    kind: 'text',
                    key: 'fromEnv',
                    label: 'From env',
                  },
                ],
              },
            },
          },
        })
      )
    ).toThrow(
      "Plugin 'bad-auth-reserved-flag-plugin' auth provider 'bad-auth-reserved-flag' login field 'fromEnv' maps to reserved flag '--from-env'"
    );

    expect(() =>
      registry.registerPlugin(
        defineAidePlugin({
          id: 'bad-auth-invalid-flag-plugin',
          summary: 'Bad auth invalid flag plugin',
          commands: [],
          capabilities: {
            authProvider: {
              providerId: 'bad-auth-invalid-flag',
              label: 'Bad Auth Invalid Flag',
              status: () => Effect.succeed({ state: 'configured' }),
              login: {
                fields: [
                  {
                    kind: 'text',
                    key: 'ApiToken',
                    label: 'API token',
                  },
                ],
              },
            },
          },
        })
      )
    ).toThrow(
      "Plugin 'bad-auth-invalid-flag-plugin' auth provider 'bad-auth-invalid-flag' login field 'ApiToken' maps to invalid flag name '-api-token'"
    );

    expect(() =>
      registry.registerPlugin(
        defineAidePlugin({
          id: 'bad-auth-command-plugin',
          summary: 'Bad auth command plugin',
          commands: [],
          capabilities: {
            authProvider: {
              providerId: 'bad-auth-command',
              label: 'Bad Auth Command',
              status: () => Effect.succeed({ state: 'configured' }),
              login: {
                command: {
                  name: '--bad',
                },
              },
            },
          },
        })
      )
    ).toThrow(
      "Plugin 'bad-auth-command-plugin' auth provider 'bad-auth-command' login command name '--bad' must be lowercase kebab-case"
    );

    expect(() =>
      registry.registerPlugin(
        defineAidePlugin({
          id: 'bad-prime-message-plugin',
          summary: 'Bad prime message plugin',
          commands: [],
          capabilities: {
            primeContribution: {
              status: [
                {
                  groupId: 'bad-prime',
                  groupLabel: 'Bad Prime',
                  label: 'Bad Prime',
                  messages: {
                    notConfigured: '',
                  },
                  status: () => Effect.succeed({ state: 'not-configured' }),
                },
              ],
            },
          },
        } as unknown as Parameters<typeof registry.registerPlugin>[0])
      )
    ).toThrow(
      "Plugin 'bad-prime-message-plugin' prime contribution message 'notConfigured' must be a non-empty string"
    );
  });

  test('registers external auth provider and prime contribution capabilities dynamically', () => {
    const registry = createCommandRegistry();

    registry.registerExternalPlugin(
      definePublicAidePlugin({
        id: 'external-tool',
        summary: 'External tool plugin',
        commands: [],
        capabilities: {
          authProvider: {
            providerId: 'external-tool-auth',
            label: 'External Tool',
            status: () => Effect.succeed({ state: 'configured' }),
          },
          primeContribution: {
            sections: () =>
              Effect.succeed([
                {
                  id: 'external-tool-help',
                  body: '## External Tool',
                },
              ]),
          },
        },
      }),
      {
        manifest: externalManifest('external-tool', [
          'auth-provider',
          'prime-contribution',
        ]),
      }
    );

    expect(
      registry.capabilities
        .authProviders()
        .map((provider) => provider.capability.providerId)
    ).toEqual(['external-tool-auth']);
    expect(registry.capabilities.primeContributions()).toHaveLength(1);
  });

  test('discovers pull request provider capabilities with plugin ownership', () => {
    const registry = createBuiltinCommandRegistry();

    const providers = registry.capabilities.pullRequestProviders();

    expect(providers.map((provider) => provider.pluginId)).toEqual([
      'github',
      'azure-devops',
    ]);
    expect(providers.map((provider) => provider.capability.providerId)).toEqual(
      ['github', 'azure-devops']
    );
  });
});

describe('commandModuleFromDescriptor', () => {
  test('routes every provisioning variant recursively without relabeling', async () => {
    let acquisitions = 0;
    let releases = 0;
    const service = {
      get: () => Effect.succeed(null),
      set: () => Effect.void,
      delete: () => Effect.succeed(false),
    } satisfies KeyringServiceShape;
    const keyringLayer = Layer.scoped(
      KeyringService,
      Effect.acquireRelease(
        Effect.sync(() => {
          acquisitions += 1;
          return service;
        }),
        () =>
          Effect.sync(() => {
            releases += 1;
          })
      )
    );
    const registry = createCommandRegistry().registerPlugin(
      defineAidePlugin({
        id: 'provisioning-routes',
        summary: 'Provisioning routes',
        commands: [
          pluginCommandDescriptor.none(
            defineAideCommand.none<object, never>({
              id: 'routes:none',
              route: 'none',
              summary: 'No provisioning',
              run: () => Effect.succeed(textResult('none')),
            })
          ),
          pluginCommandDescriptor.internalHost(
            defineAideCommand.internalHost<object, never>({
              id: 'routes:host',
              route: 'host <command>',
              summary: 'Host provisioning',
              run: () =>
                Effect.map(AideInternalHostServicesTag, () =>
                  textResult('host')
                ),
            }),
            { acceptsChildren: true }
          ),
          pluginCommandDescriptor.keyring(
            defineAideCommand.keyring<object, never>({
              id: 'routes:keyring',
              route: 'keyring',
              summary: 'Keyring provisioning',
              run: () =>
                Effect.map(KeyringService, () => textResult('keyring')),
            }),
            { parentId: 'routes:host' }
          ),
          pluginCommandDescriptor.internalHostAndKeyring(
            defineAideCommand.internalHostAndKeyring<object, never>({
              id: 'routes:combined',
              route: 'combined',
              summary: 'Combined provisioning',
              run: () =>
                Effect.all([AideInternalHostServicesTag, KeyringService]).pipe(
                  Effect.map(() => textResult('combined'))
                ),
            })
          ),
        ],
      })
    );
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => lines.push(args.join(' '));

    try {
      for (const args of [['none'], ['host', 'keyring'], ['combined']]) {
        await registerCommandsWithKeyring(yargs(args), registry, {
          keyringLayer,
        })
          .scriptName('aide')
          .strict()
          .exitProcess(false)
          .parseAsync();
      }
    } finally {
      console.log = originalLog;
    }

    expect(lines).toEqual(['none', 'keyring', 'combined']);
    expect(acquisitions).toBe(2);
    expect(releases).toBe(2);
  });

  test('actual trusted yargs execution acquires exactly one injected keyring layer', async () => {
    let constructions = 0;
    let acquisitions = 0;
    let releases = 0;
    const service = {
      get: () => Effect.succeed(null),
      set: () => Effect.void,
      delete: () => Effect.succeed(false),
    } satisfies KeyringServiceShape;
    const makeLayer = () => {
      constructions += 1;
      return Layer.scoped(
        KeyringService,
        Effect.acquireRelease(
          Effect.sync(() => {
            acquisitions += 1;
            return service;
          }),
          () =>
            Effect.sync(() => {
              releases += 1;
            })
        )
      );
    };
    const keyringLayer = makeLayer();
    const registry = createCommandRegistry<
      never,
      never,
      never,
      never,
      never,
      KeyringService,
      never
    >()
      .registerPlugin(
        defineAidePlugin({
          id: 'test-prime-status',
          summary: 'Injected prime status',
          commands: [],
          capabilities: {
            primeContribution: {
              status: [
                {
                  groupId: 'test',
                  groupLabel: 'Test',
                  label: 'Test',
                  status: () =>
                    Effect.flatMap(KeyringService, (keyring) =>
                      keyring.get('jira')
                    ).pipe(
                      Effect.map(() => ({
                        state: 'configured' as const,
                      }))
                    ),
                },
                {
                  groupId: 'test-secondary',
                  groupLabel: 'Test Secondary',
                  label: 'Test Secondary',
                  status: () =>
                    Effect.flatMap(KeyringService, (keyring) =>
                      keyring.get('github')
                    ).pipe(
                      Effect.map(() => ({
                        state: 'configured' as const,
                      }))
                    ),
                },
              ],
            },
          },
        })
      )
      .registerPlugin(aideCorePlugin);
    const bunGet = spyOn(Bun.secrets, 'get').mockRejectedValue(
      new Error('live keyring must not be acquired')
    );
    const bunSet = spyOn(Bun.secrets, 'set').mockRejectedValue(
      new Error('live keyring must not be acquired')
    );
    const bunDelete = spyOn(Bun.secrets, 'delete').mockRejectedValue(
      new Error('live keyring must not be acquired')
    );
    const originalLog = console.log;
    console.log = () => {};

    try {
      await registerCommandsWithKeyring(yargs(['prime']), registry, {
        keyringLayer,
      })
        .scriptName('aide')
        .strict()
        .exitProcess(false)
        .parseAsync();
    } finally {
      console.log = originalLog;
      bunGet.mockRestore();
      bunSet.mockRestore();
      bunDelete.mockRestore();
    }

    expect(constructions).toBe(1);
    expect(acquisitions).toBe(1);
    expect(releases).toBe(1);
    expect(bunGet).not.toHaveBeenCalled();
    expect(bunSet).not.toHaveBeenCalled();
    expect(bunDelete).not.toHaveBeenCalled();
  });

  test('adapts an internal descriptor to yargs and renders the command result', async () => {
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.join(' '));
    };

    try {
      await yargs(['sample'])
        .scriptName('aide')
        .command(
          commandModuleFromDescriptor(
            defineAideCommand.none<object, never>({
              id: 'sample',
              route: 'sample',
              summary: 'Sample descriptor-backed command',
              run: () => Effect.succeed(textResult('descriptor output')),
            })
          )
        )
        .strict()
        .exitProcess(false)
        .parseAsync();
    } finally {
      console.log = originalLog;
    }

    expect(lines).toEqual(['descriptor output']);
  });

  test('provides host services to descriptors without hidden argv context', async () => {
    const services = createAideHostServices(createCommandRegistry());
    const lines: string[] = [];
    let observedHiddenContext: boolean | undefined;
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.join(' '));
    };

    try {
      await yargs(['sample'])
        .scriptName('aide')
        .command(
          commandModuleFromPublicDescriptor(
            definePublicAideCommand<object, never>({
              id: 'sample',
              route: 'sample',
              summary: 'Sample descriptor-backed command',
              run: (argv) =>
                Effect.gen(function* () {
                  observedHiddenContext = getAideHostContext(argv) !== null;
                  const hostServices = yield* AideHostServicesTag;
                  return textResult(
                    hostServices === services
                      ? 'effect host services'
                      : 'wrong services'
                  );
                }),
            }),
            services
          )
        )
        .strict()
        .exitProcess(false)
        .parseAsync();
    } finally {
      console.log = originalLog;
    }

    expect(observedHiddenContext).toBe(false);
    expect(lines).toEqual(['effect host services']);
  });
});

describe('runtime host context bridge', () => {
  test('stores legacy host context outside argv properties', () => {
    const argv = {};
    const context: AideHostContext = {
      services: createAideInternalHostServices(
        createKeyringCommandRegistry(),
        testKeyringLayer
      ),
      keyringLayer: testKeyringLayer,
    };

    attachAideHostContext(argv, context);

    expect(getAideHostContext(argv)?.services).toBe(context.services);
    expect(Object.keys(argv)).toEqual([]);
    expect(Object.getOwnPropertySymbols(argv)).not.toContain(
      Symbol.for('aide.hostContext')
    );
    expect(
      (argv as Record<PropertyKey, unknown>)[Symbol.for('aide.hostContext')]
    ).toBeUndefined();
  });

  test('ignores forged global symbol host context values', () => {
    const argv = {};
    const realContext: AideHostContext = {
      services: createAideInternalHostServices(
        createKeyringCommandRegistry(),
        testKeyringLayer
      ),
      keyringLayer: testKeyringLayer,
    };
    const forgedContext: AideHostContext = {
      services: createAideInternalHostServices(
        createKeyringCommandRegistry(),
        testKeyringLayer
      ),
      keyringLayer: testKeyringLayer,
    };

    Object.defineProperty(argv, Symbol.for('aide.hostContext'), {
      value: forgedContext,
      enumerable: true,
      configurable: true,
    });
    attachAideHostContext(argv, realContext);

    expect(
      (argv as Record<PropertyKey, unknown>)[Symbol.for('aide.hostContext')]
    ).toBe(forgedContext);
    expect(getAideHostContext(argv)).not.toBe(forgedContext);
    expect(getAideHostContext(argv)?.services).toBe(realContext.services);
  });

  test('does not overwrite an attached host context', () => {
    const argv = {};
    const firstContext: AideHostContext = {
      services: createAideInternalHostServices(
        createKeyringCommandRegistry(),
        testKeyringLayer
      ),
      keyringLayer: testKeyringLayer,
    };
    const secondContext: AideHostContext = {
      services: createAideInternalHostServices(
        createKeyringCommandRegistry(),
        testKeyringLayer
      ),
      keyringLayer: testKeyringLayer,
    };

    attachAideHostContext(argv, firstContext);
    attachAideHostContext(argv, secondContext);

    expect(getAideHostContext(argv)?.services).toBe(firstContext.services);
  });
});

describe('registerCommands', () => {
  test('gives public descriptors a runtime object with no trusted capability access', async () => {
    let observedTrustedFields: readonly string[] | undefined;
    const registry = createCommandRegistry();
    registry.registerExternalPlugin(
      definePublicAidePlugin({
        id: 'external-boundary',
        summary: 'External boundary probe',
        commands: [
          publicPluginCommandDescriptor(
            definePublicAideCommand({
              id: 'external-boundary:probe',
              route: 'boundary-probe',
              summary: 'Probe public runtime services',
              run: () =>
                Effect.gen(function* () {
                  const services = yield* AideHostServicesTag;
                  observedTrustedFields = [
                    'publicServices',
                    'trustedAuthProviders',
                    'trustedPrimeContributions',
                  ].filter((field) => field in services);
                  return textResult('public boundary');
                }),
            })
          ),
        ],
      }),
      {
        manifest: externalManifest('external-boundary', ['commands']),
      }
    );
    const originalLog = console.log;
    console.log = () => {};

    try {
      await registerCommands(
        yargs(['boundary-probe']).scriptName('aide').exitProcess(false),
        registry
      )
        .strict()
        .parseAsync();
    } finally {
      console.log = originalLog;
    }

    expect(observedTrustedFields).toEqual([]);
  });

  test('attaches host context to legacy yargs module handlers', async () => {
    const registry = createCommandRegistry();
    let observedCanResolvePullRequestProviders: boolean | undefined;
    let observedRawProviderAccess: boolean | undefined;
    let observedHasRegistryProperty: boolean | undefined;

    registry.registerModule('sample', {
      command: 'sample',
      describe: 'Sample command',
      handler: (argv) => {
        const context = getAideHostContext(argv);
        observedCanResolvePullRequestProviders =
          typeof context?.services.resolvePullRequestProviderForRemote ===
          'function';
        observedRawProviderAccess =
          context !== null &&
          'pullRequestProviders' in (context.services as object);
        observedHasRegistryProperty =
          context !== null && 'registry' in (context as object);
      },
    });

    await registerCommands(
      yargs(['sample']).scriptName('aide').exitProcess(false),
      registry
    )
      .strict()
      .parseAsync();

    expect(observedCanResolvePullRequestProviders).toBe(true);
    expect(observedRawProviderAccess).toBe(false);
    expect(observedHasRegistryProperty).toBe(false);
  });

  test('does not let legacy handlers forge host context through global symbols', async () => {
    const registry = createCommandRegistry();
    const forgedContext: AideHostContext = {
      services: createAideInternalHostServices(
        createKeyringCommandRegistry(),
        testKeyringLayer
      ),
      keyringLayer: testKeyringLayer,
    };
    let observedGlobalSymbolIsForged: boolean | undefined;
    let observedContextIsForged: boolean | undefined;
    let observedCanResolvePullRequestProviders: boolean | undefined;

    registry.registerModule('sample', {
      command: 'sample',
      describe: 'Sample command',
      handler: (argv) => {
        Object.defineProperty(argv, Symbol.for('aide.hostContext'), {
          value: forgedContext,
          enumerable: true,
          configurable: true,
        });
        const context = getAideHostContext(argv);
        observedGlobalSymbolIsForged =
          (argv as Record<PropertyKey, unknown>)[
            Symbol.for('aide.hostContext')
          ] === forgedContext;
        observedContextIsForged = context === forgedContext;
        observedCanResolvePullRequestProviders =
          typeof context?.services.resolvePullRequestProviderForRemote ===
          'function';
      },
    });

    await registerCommands(
      yargs(['sample']).scriptName('aide').exitProcess(false),
      registry
    )
      .strict()
      .parseAsync();

    expect(observedGlobalSymbolIsForged).toBe(true);
    expect(observedContextIsForged).toBe(false);
    expect(observedCanResolvePullRequestProviders).toBe(true);
  });

  test('does not let legacy handlers overwrite attached host context', async () => {
    const registry = createCommandRegistry();
    const forgedContext: AideHostContext = {
      services: createAideInternalHostServices(
        createKeyringCommandRegistry(),
        testKeyringLayer
      ),
      keyringLayer: testKeyringLayer,
    };
    let observedContextIsForged: boolean | undefined;
    let observedCanResolvePullRequestProviders: boolean | undefined;

    registry.registerModule('sample', {
      command: 'sample',
      describe: 'Sample command',
      handler: (argv) => {
        attachAideHostContext(argv, forgedContext);
        const context = getAideHostContext(argv);
        observedContextIsForged = context === forgedContext;
        observedCanResolvePullRequestProviders =
          typeof context?.services.resolvePullRequestProviderForRemote ===
          'function';
      },
    });

    await registerCommands(
      yargs(['sample']).scriptName('aide').exitProcess(false),
      registry
    )
      .strict()
      .parseAsync();

    expect(observedContextIsForged).toBe(false);
    expect(observedCanResolvePullRequestProviders).toBe(true);
  });

  test('attaches host context to nested legacy yargs module handlers', async () => {
    const registry = createCommandRegistry();
    let observedCanResolvePullRequestProviders: boolean | undefined;
    let observedRawProviderAccess: boolean | undefined;

    registry.registerModule('parent', {
      command: 'parent <command>',
      describe: 'Parent command',
      builder: (yargs) =>
        yargs.command({
          command: 'child',
          describe: 'Child command',
          handler: (argv) => {
            const services = getAideHostContext(argv)?.services;
            observedCanResolvePullRequestProviders =
              typeof services?.resolvePullRequestProviderForRemote ===
              'function';
            observedRawProviderAccess =
              services !== undefined &&
              'pullRequestProviders' in (services as object);
          },
        }),
      handler: () => {},
    });

    await registerCommands(
      yargs(['parent', 'child']).scriptName('aide').exitProcess(false),
      registry
    )
      .strict()
      .parseAsync();

    expect(observedCanResolvePullRequestProviders).toBe(true);
    expect(observedRawProviderAccess).toBe(false);
  });

  test('attaches host context to legacy builder string-overload handlers', async () => {
    const registry = createCommandRegistry();
    let observedCanResolvePullRequestProviders: boolean | undefined;

    registry.registerModule('parent', {
      command: 'parent <command>',
      describe: 'Parent command',
      builder: (yargs) =>
        yargs.command('child', 'Child command', {}, (argv) => {
          const services = getAideHostContext(argv)?.services;
          observedCanResolvePullRequestProviders =
            typeof services?.resolvePullRequestProviderForRemote === 'function';
        }),
      handler: () => {},
    });

    await registerCommands(
      yargs(['parent', 'child']).scriptName('aide').exitProcess(false),
      registry
    )
      .strict()
      .parseAsync();

    expect(observedCanResolvePullRequestProviders).toBe(true);
  });

  test('attaches host context to legacy builder route-module overload handlers', async () => {
    const registry = createCommandRegistry();
    let observedCanResolvePullRequestProviders: boolean | undefined;

    registry.registerModule('parent', {
      command: 'parent <command>',
      describe: 'Parent command',
      builder: (yargs) =>
        yargs.command('child', 'Child command', {
          command: 'child',
          describe: 'Child command',
          handler: (argv) => {
            const services = getAideHostContext(argv)?.services;
            observedCanResolvePullRequestProviders =
              typeof services?.resolvePullRequestProviderForRemote ===
              'function';
          },
        }),
      handler: () => {},
    });

    await registerCommands(
      yargs(['parent', 'child']).scriptName('aide').exitProcess(false),
      registry
    )
      .strict()
      .parseAsync();

    expect(observedCanResolvePullRequestProviders).toBe(true);
  });

  test('provides host services to descriptor commands through Effect context', async () => {
    const registry = createCommandRegistry();
    const lines: string[] = [];
    let observedHiddenContext: boolean | undefined;
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.join(' '));
    };

    registry.registerPlugin(
      defineAidePlugin({
        id: 'effect-provider-plugin',
        summary: 'Effect provider plugin',
        commands: [],
        capabilities: {
          pullRequestProvider: {
            providerId: 'effect-provider',
            priority: 100,
            features: {},
            authStatus: () => Effect.succeed({ state: 'configured' }),
            matchRemote: (remoteUrl) =>
              remoteUrl === 'effect-remote'
                ? {
                    source: 'git-remote',
                    repository: {
                      kind: 'external',
                      providerId: 'effect-provider',
                      displayName: 'Effect Provider',
                    },
                  }
                : null,
            matchPullRequestUrl: () => null,
          },
        },
      })
    );
    registry.registerDescriptor({
      id: 'sample',
      route: 'sample',
      summary: 'Sample descriptor-backed command',
      run: (argv) =>
        Effect.gen(function* () {
          observedHiddenContext = getAideHostContext(argv) !== null;
          const services = yield* AideHostServicesTag;
          const provider =
            yield* services.resolvePullRequestProviderForRemote(
              'effect-remote'
            );
          return textResult(`${provider.pluginId}/${provider.providerId}`);
        }),
    });

    try {
      await registerCommands(
        yargs(['sample']).scriptName('aide').exitProcess(false),
        registry
      )
        .strict()
        .parseAsync();
    } finally {
      console.log = originalLog;
    }

    expect(observedHiddenContext).toBe(false);
    expect(lines).toEqual(['effect-provider-plugin/effect-provider']);
  });

  test('composes registry child commands into parent yargs modules', async () => {
    const registry = createCommandRegistry();
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.join(' '));
    };

    registry.registerModule('parent', {
      command: 'parent <command>',
      describe: 'Parent command',
      builder: (yargs) => yargs.demandCommand(1, 'Pick a child command'),
      handler: () => {},
    });
    registry.registerDescriptor(
      {
        id: 'parent:child',
        route: 'child',
        summary: 'Child command',
        run: () => Effect.succeed(textResult('child output')),
      },
      { parentId: 'parent' }
    );

    try {
      await registerCommands(
        yargs(['parent', 'child']).scriptName('aide').exitProcess(false),
        registry
      )
        .strict()
        .parseAsync();
    } finally {
      console.log = originalLog;
    }

    expect(lines).toEqual(['child output']);
  });

  test('composes explicit recursive registry command groups into yargs modules', async () => {
    const registry = createCommandRegistry();
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.join(' '));
    };

    registry.registerModule(
      'parent',
      {
        command: 'parent',
        describe: 'Parent command',
        builder: (yargs) => yargs.demandCommand(1, 'Pick a child command'),
        handler: () => {},
      },
      { acceptsChildren: true }
    );
    registry.registerDescriptor(
      {
        id: 'parent:child',
        route: 'child',
        summary: 'Child command group',
        yargs: {
          builder: (yargs) =>
            yargs.demandCommand(1, 'Pick a grandchild command'),
        },
        run: () => Effect.succeed(textResult('child output')),
      },
      { parentId: 'parent', acceptsChildren: true }
    );
    registry.registerDescriptor(
      {
        id: 'parent:child:grandchild',
        route: 'grandchild',
        summary: 'Grandchild command',
        run: () => Effect.succeed(textResult('grandchild output')),
      },
      { parentId: 'parent:child' }
    );

    try {
      await registerCommands(
        yargs(['parent', 'child', 'grandchild'])
          .scriptName('aide')
          .exitProcess(false),
        registry
      )
        .strict()
        .parseAsync();
    } finally {
      console.log = originalLog;
    }

    expect(lines).toEqual(['grandchild output']);
  });

  test('preserves strict parsing for registry child commands', async () => {
    const registry = createCommandRegistry();

    registry.registerModule('parent', {
      command: 'parent <command>',
      describe: 'Parent command',
      builder: (yargs) => yargs.demandCommand(1, 'Pick a child command'),
      handler: () => {},
    });
    registry.registerDescriptor(
      {
        id: 'parent:child',
        route: 'child',
        summary: 'Child command',
        yargs: {
          builder: (yargs) =>
            yargs.option('known', {
              type: 'string',
              describe: 'Known option',
            }),
        },
        run: () => Effect.succeed(textResult('child output')),
      },
      { parentId: 'parent' }
    );

    let thrown: unknown;
    try {
      await registerCommands(
        yargs(['parent', 'child', '--bogus'])
          .scriptName('aide')
          .exitProcess(false)
          .fail((message, error) => {
            throw error ?? new Error(message);
          }),
        registry
      )
        .strict()
        .parseAsync();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('Unknown argument: bogus');
  });
});
