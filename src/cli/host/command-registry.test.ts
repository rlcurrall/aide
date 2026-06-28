import { describe, expect, test } from 'bun:test';
import { Context, Effect } from 'effect';
import yargs from 'yargs';

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

  test('rejects extension policy on child commands', () => {
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
      "Command 'parent:child' declares an extension policy but is not a top-level command group"
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
      "Command 'parent:child' declares an extension policy but is not a top-level command group"
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
