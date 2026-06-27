import { describe, expect, test } from 'bun:test';
import { Effect } from 'effect';
import yargs from 'yargs';

import { textResult } from './command-descriptor.js';
import { createCommandRegistry } from './command-registry.js';
import { createBuiltinCommandRegistry } from '@cli/plugins/builtin.js';
import {
  defineAidePlugin,
  pluginCommandDescriptor,
  pluginCommandModule,
} from './plugin-descriptor.js';
import { getAideHostContext } from './runtime-context.js';
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

describe('CommandRegistry', () => {
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
          commandModuleFromDescriptor({
            id: 'sample',
            route: 'sample',
            summary: 'Sample descriptor-backed command',
            run: () => Effect.succeed(textResult('descriptor output')),
          })
        )
        .strict()
        .exitProcess(false)
        .parseAsync();
    } finally {
      console.log = originalLog;
    }

    expect(lines).toEqual(['descriptor output']);
  });
});

describe('registerCommands', () => {
  test('attaches host context to legacy yargs module handlers', async () => {
    const registry = createCommandRegistry();
    let observedProviderCount: number | undefined;
    let observedHasRegistryProperty: boolean | undefined;

    registry.registerModule('sample', {
      command: 'sample',
      describe: 'Sample command',
      handler: (argv) => {
        const context = getAideHostContext(argv);
        observedProviderCount = context?.services.pullRequestProviders().length;
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

    expect(observedProviderCount).toBe(0);
    expect(observedHasRegistryProperty).toBe(false);
  });

  test('attaches host context to nested legacy yargs module handlers', async () => {
    const registry = createCommandRegistry();
    let observedProviderCount: number | undefined;

    registry.registerModule('parent', {
      command: 'parent <command>',
      describe: 'Parent command',
      builder: (yargs) =>
        yargs.command({
          command: 'child',
          describe: 'Child command',
          handler: (argv) => {
            observedProviderCount =
              getAideHostContext(argv)?.services.pullRequestProviders().length;
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

    expect(observedProviderCount).toBe(0);
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
