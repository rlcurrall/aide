import { describe, expect, test } from 'bun:test';
import { Effect } from 'effect';
import yargs from 'yargs';

import { textResult } from './command-descriptor.js';
import { createCommandRegistry } from './command-registry.js';
import { createBuiltinCommandRegistry } from '@cli/plugins/builtin.js';
import { defineAidePlugin, pluginCommandModule } from './plugin-descriptor.js';
import { getAideHostContext } from './runtime-context.js';
import {
  commandModuleFromDescriptor,
  registerCommands,
} from './yargs-adapter.js';

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
    expect(registry.commandOwner('whoami')).toBe('legacy-auth');
    expect(registry.commandOwner('missing')).toBeNull();
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
    let observedRegistry: unknown;

    registry.registerModule('sample', {
      command: 'sample',
      describe: 'Sample command',
      handler: (argv) => {
        observedRegistry = getAideHostContext(argv)?.registry;
      },
    });

    await registerCommands(
      yargs(['sample']).scriptName('aide').exitProcess(false),
      registry
    )
      .strict()
      .parseAsync();

    expect(observedRegistry).toBe(registry);
  });

  test('attaches host context to nested legacy yargs module handlers', async () => {
    const registry = createCommandRegistry();
    let observedRegistry: unknown;

    registry.registerModule('parent', {
      command: 'parent <command>',
      describe: 'Parent command',
      builder: (yargs) =>
        yargs.command({
          command: 'child',
          describe: 'Child command',
          handler: (argv) => {
            observedRegistry = getAideHostContext(argv)?.registry;
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

    expect(observedRegistry).toBe(registry);
  });
});
