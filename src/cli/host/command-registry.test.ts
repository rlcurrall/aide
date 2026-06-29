import { describe, expect, test } from 'bun:test';
import { Context, Effect } from 'effect';
import yargs from 'yargs';

import {
  AIDE_PLUGIN_API_VERSION,
  defineAideCommand as definePublicAideCommand,
  defineAidePlugin as definePublicAidePlugin,
  pluginCommandDescriptor as publicPluginCommandDescriptor,
  type AidePublicPluginDescriptor,
} from '@aide/plugin-api';
import * as publicPluginApi from '@aide/plugin-api';
import { defineAideCommand, textResult } from './command-descriptor.js';
import { createCommandRegistry } from './command-registry.js';
import { createBuiltinCommandRegistry } from '@cli/plugins/builtin.js';
import {
  defineAidePlugin,
  pluginCommandDescriptor,
  pluginCommandModule,
} from './plugin-descriptor.js';
import {
  AideHostServicesTag,
  attachAideHostContext,
  createAideHostServices,
  getAideHostContext,
  type AideHostContext,
} from './runtime-context.js';
import {
  commandModuleFromDescriptor,
  registerCommands,
} from './yargs-adapter.js';

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

describe('CommandRegistry', () => {
  test('rejects plugin descriptors that require unsupported Effect services at compile time', () => {
    const descriptor = defineAideCommand<
      { value?: string },
      never,
      UnsupportedDescriptorService
    >({
      id: 'unsupported-service',
      route: 'unsupported-service',
      summary: 'Descriptor requiring a non-host service',
      run: () =>
        Effect.gen(function* () {
          const service = yield* UnsupportedDescriptorService;
          return textResult(service.value);
        }),
    });

    // @ts-expect-error Plugin descriptors can only require host services, or no services.
    const command = pluginCommandDescriptor(descriptor);

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
      "External plugin 'external-tool' command 'external-tool:raw' must be descriptor-backed; raw yargs modules are trusted internal only"
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
          pluginCommandDescriptor(
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
          pluginCommandDescriptor(
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
            pluginCommandDescriptor(
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
          pluginCommandDescriptor(
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
          pluginCommandDescriptor(
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
          pluginCommandDescriptor(
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
          pluginCommandDescriptor(
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
            pluginCommandDescriptor(
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
          pluginCommandDescriptor(
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
            pluginCommandDescriptor(
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
            pluginCommandDescriptor(
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
            pluginCommandDescriptor(
              {
                id: 'cycle:a',
                route: 'a',
                summary: 'Cycle command A',
                run: () => Effect.succeed(textResult('a')),
              },
              { parentId: 'cycle:b', acceptsChildren: true }
            ),
            pluginCommandDescriptor(
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
          pluginCommandDescriptor(
            {
              id: 'recursive:child:grandchild',
              route: 'grandchild',
              summary: 'Grandchild command',
              run: () => Effect.succeed(textResult('grandchild')),
            },
            { parentId: 'recursive:child' }
          ),
          pluginCommandDescriptor(
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
            pluginCommandDescriptor(
              {
                id: 'parent:first-child',
                route: 'child',
                summary: 'First child',
                run: () => Effect.succeed(textResult('first')),
              },
              { parentId: 'parent' }
            ),
            pluginCommandDescriptor(
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
      capabilities[0]!.capability.status()
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
      authProviders[0]!.capability.status()
    );
    const loginResult = await Effect.runPromise(
      authProviders[0]!.capability.operations!.login!({})
    );
    const logoutResult = await Effect.runPromise(
      authProviders[0]!.capability.operations!.logout!()
    );
    const primeStatus = await Effect.runPromise(
      primeContributions[0]!.capability.status![0]!.status()
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
        } as unknown as Parameters<typeof defineAidePlugin>[0])
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
        } as unknown as Parameters<typeof defineAidePlugin>[0])
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
        } as unknown as Parameters<typeof defineAidePlugin>[0])
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
        } as unknown as Parameters<typeof defineAidePlugin>[0])
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
        } as unknown as Parameters<typeof defineAidePlugin>[0])
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
            {
              id: 'sample',
              route: 'sample',
              summary: 'Sample descriptor-backed command',
              run: () => Effect.succeed(textResult('descriptor output')),
            },
            createAideHostServices(createCommandRegistry())
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
          commandModuleFromDescriptor(
            defineAideCommand<object, never, AideHostServicesTag>({
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
      services: createAideHostServices(createCommandRegistry()),
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
      services: createAideHostServices(createCommandRegistry()),
    };
    const forgedContext: AideHostContext = {
      services: createAideHostServices(createCommandRegistry()),
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
      services: createAideHostServices(createCommandRegistry()),
    };
    const secondContext: AideHostContext = {
      services: createAideHostServices(createCommandRegistry()),
    };

    attachAideHostContext(argv, firstContext);
    attachAideHostContext(argv, secondContext);

    expect(getAideHostContext(argv)?.services).toBe(firstContext.services);
  });
});

describe('registerCommands', () => {
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
      services: createAideHostServices(createCommandRegistry()),
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
      services: createAideHostServices(createCommandRegistry()),
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
