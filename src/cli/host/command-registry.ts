import type { CommandModule } from 'yargs';

import {
  eraseCommandDescriptor,
  type AideCommandDescriptor,
  type AnyAideCommandDescriptor,
} from './command-descriptor.js';
import type {
  AidePluginAuthCapability,
  AidePluginCommand,
  AidePluginDescriptor,
  AidePullRequestProviderCapability,
  AnyYargsCommandModule,
} from './plugin-descriptor.js';

function eraseCommandModule<TBase extends object, TArgs extends object>(
  module: CommandModule<TBase, TArgs>
): AnyYargsCommandModule {
  return Object.freeze({ ...module }) as unknown as AnyYargsCommandModule;
}

function snapshotCommandDescriptor<TArgs extends object>(
  descriptor: AideCommandDescriptor<TArgs>
): AnyAideCommandDescriptor {
  const erased = eraseCommandDescriptor(descriptor);
  return Object.freeze({
    ...erased,
    yargs:
      erased.yargs === undefined
        ? undefined
        : Object.freeze({ ...erased.yargs }),
  });
}

function freezeRouteKeys(keys: readonly string[]): readonly string[] {
  return Object.freeze([...keys]);
}

function assertId(kind: 'Command' | 'Plugin', id: string): void {
  if (id.trim() === '') {
    throw new Error(`${kind} id must not be empty`);
  }
  if (/\s/.test(id)) {
    throw new Error(`${kind} id '${id}' must not contain whitespace`);
  }
}

function routeKeys(route: string | readonly string[] | undefined): string[] {
  const routes = Array.isArray(route) ? route : [route];
  const keys = routes.flatMap((value) => {
    const key = value?.trim().split(/\s+/)[0];
    return key === undefined || key === '' ? [] : [key];
  });

  return Array.from(new Set(keys));
}

function assertRouteKeys(id: string, keys: readonly string[]): void {
  if (keys.length === 0) {
    throw new Error(`Command '${id}' must declare a route`);
  }
}

function snapshotPlugin(plugin: AidePluginDescriptor): AidePluginDescriptor {
  const commands = plugin.commands.map((command): AidePluginCommand => {
    if (command.kind === 'module') {
      return Object.freeze({
        kind: 'module',
        id: command.id,
        module: eraseCommandModule(command.module),
      });
    }

    return Object.freeze({
      kind: 'descriptor',
      id: command.id,
      descriptor: snapshotCommandDescriptor(command.descriptor),
    });
  });

  return Object.freeze({
    id: plugin.id,
    summary: plugin.summary,
    commands: Object.freeze(commands),
    capabilities:
      plugin.capabilities === undefined
        ? undefined
        : Object.freeze({ ...plugin.capabilities }),
  });
}

export type RegisteredCommand =
  | {
      readonly kind: 'module';
      readonly id: string;
      readonly pluginId?: string;
      readonly routeKeys: readonly string[];
      readonly module: AnyYargsCommandModule;
    }
  | {
      readonly kind: 'descriptor';
      readonly id: string;
      readonly pluginId?: string;
      readonly routeKeys: readonly string[];
      readonly descriptor: AnyAideCommandDescriptor;
    };

export interface OwnedPluginCapability<TCapability> {
  readonly pluginId: string;
  readonly capability: TCapability;
}

export class CommandRegistry {
  readonly #commands: RegisteredCommand[] = [];
  readonly #plugins: AidePluginDescriptor[] = [];
  readonly #ids = new Set<string>();
  readonly #pluginIds = new Set<string>();
  readonly #routeOwners = new Map<string, string>();
  readonly #commandOwners = new Map<string, string>();

  readonly capabilities = {
    auth: (): readonly OwnedPluginCapability<AidePluginAuthCapability>[] =>
      this.#plugins.flatMap((plugin) => {
        const capability = plugin.capabilities?.auth;
        return capability === undefined
          ? []
          : [{ pluginId: plugin.id, capability }];
      }),
    pullRequestProviders:
      (): readonly OwnedPluginCapability<AidePullRequestProviderCapability>[] =>
        this.#plugins.flatMap((plugin) => {
          const capability = plugin.capabilities?.pullRequestProvider;
          return capability === undefined
            ? []
            : [{ pluginId: plugin.id, capability }];
        }),
  };

  registerModule<TBase extends object, TArgs extends object>(
    id: string,
    module: CommandModule<TBase, TArgs>
  ): this {
    assertId('Command', id);
    this.#assertAvailable(id);
    const keys = routeKeys(module.command);
    assertRouteKeys(id, keys);
    this.#assertRoutesAvailable(id, keys);
    this.#commands.push(
      Object.freeze({
        kind: 'module',
        id,
        routeKeys: freezeRouteKeys(keys),
        module: eraseCommandModule(module),
      })
    );
    this.#ids.add(id);
    this.#claimRoutes(id, keys);
    return this;
  }

  registerDescriptor<TArgs extends object>(
    descriptor: AideCommandDescriptor<TArgs>
  ): this {
    assertId('Command', descriptor.id);
    this.#assertAvailable(descriptor.id);
    const keys = routeKeys(descriptor.route);
    assertRouteKeys(descriptor.id, keys);
    this.#assertRoutesAvailable(descriptor.id, keys);
    this.#commands.push(
      Object.freeze({
        kind: 'descriptor',
        id: descriptor.id,
        routeKeys: freezeRouteKeys(keys),
        descriptor: snapshotCommandDescriptor(descriptor),
      })
    );
    this.#ids.add(descriptor.id);
    this.#claimRoutes(descriptor.id, keys);
    return this;
  }

  registerPlugin(plugin: AidePluginDescriptor): this {
    assertId('Plugin', plugin.id);
    const snapshot = snapshotPlugin(plugin);
    this.#assertPluginAvailable(snapshot.id);

    const commandIds = snapshot.commands.map((command) => {
      assertId('Command', command.id);
      return command.id;
    });
    const duplicateCommandId = commandIds.find(
      (id, index) => commandIds.indexOf(id) !== index
    );
    if (duplicateCommandId !== undefined) {
      throw new Error(
        `Plugin '${snapshot.id}' declares command '${duplicateCommandId}' more than once`
      );
    }

    for (const id of commandIds) {
      this.#assertAvailable(id);
    }

    const commandRouteKeys = new Map<string, readonly string[]>();
    const pluginRouteOwners = new Map<string, string>();
    for (const command of snapshot.commands) {
      const keys =
        command.kind === 'module'
          ? routeKeys(command.module.command)
          : routeKeys(command.descriptor.route);
      assertRouteKeys(command.id, keys);
      for (const key of keys) {
        const existingCommand = pluginRouteOwners.get(key);
        if (existingCommand !== undefined) {
          throw new Error(
            `Plugin '${snapshot.id}' declares route '${key}' for commands '${existingCommand}' and '${command.id}'`
          );
        }
        pluginRouteOwners.set(key, command.id);
      }
      commandRouteKeys.set(command.id, keys);
      this.#assertRoutesAvailable(command.id, keys);
    }

    this.#plugins.push(snapshot);
    for (const command of snapshot.commands) {
      const resolvedKeys = commandRouteKeys.get(command.id) ?? [];
      if (command.kind === 'module') {
        this.#commands.push(
          Object.freeze({
            kind: 'module',
            id: command.id,
            pluginId: snapshot.id,
            routeKeys: freezeRouteKeys(resolvedKeys),
            module: command.module,
          })
        );
      } else {
        this.#commands.push(
          Object.freeze({
            kind: 'descriptor',
            id: command.id,
            pluginId: snapshot.id,
            routeKeys: freezeRouteKeys(resolvedKeys),
            descriptor: command.descriptor,
          })
        );
      }
      this.#ids.add(command.id);
      this.#commandOwners.set(command.id, snapshot.id);
      this.#claimRoutes(command.id, resolvedKeys);
    }

    this.#pluginIds.add(snapshot.id);
    return this;
  }

  commands(): readonly RegisteredCommand[] {
    return [...this.#commands];
  }

  entries(): readonly RegisteredCommand[] {
    return this.commands();
  }

  commandIds(): readonly string[] {
    return this.#commands.map((entry) => entry.id);
  }

  ids(): readonly string[] {
    return this.commandIds();
  }

  plugins(): readonly AidePluginDescriptor[] {
    return [...this.#plugins];
  }

  pluginIds(): readonly string[] {
    return this.#plugins.map((plugin) => plugin.id);
  }

  commandOwner(commandId: string): string | null {
    return this.#commandOwners.get(commandId) ?? null;
  }

  demandMessage(): string {
    return `Please specify a command (${this.ids().join(', ')})`;
  }

  #assertAvailable(id: string): void {
    if (this.#ids.has(id)) {
      throw new Error(`Command '${id}' is already registered`);
    }
  }

  #assertPluginAvailable(id: string): void {
    if (this.#pluginIds.has(id)) {
      throw new Error(`Plugin '${id}' is already registered`);
    }
  }

  #assertRoutesAvailable(commandId: string, keys: readonly string[]): void {
    for (const key of keys) {
      const owner = this.#routeOwners.get(key);
      if (owner !== undefined) {
        throw new Error(
          `Command '${commandId}' route '${key}' conflicts with command '${owner}'`
        );
      }
    }
  }

  #claimRoutes(commandId: string, keys: readonly string[]): void {
    for (const key of keys) {
      this.#routeOwners.set(key, commandId);
    }
  }
}

export function createCommandRegistry(): CommandRegistry {
  return new CommandRegistry();
}
