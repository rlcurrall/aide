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

function routeAcceptsChildCommands(
  route: string | readonly string[] | undefined
): boolean {
  const routes = Array.isArray(route) ? route : [route];
  return routes.some((value) => {
    const parts = value?.trim().split(/\s+/) ?? [];
    return parts.some((part: string, index: number) => {
      if (index === 0) return false;
      return part === '<command>' || part === '[command]';
    });
  });
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
        parentId: command.parentId,
        module: eraseCommandModule(command.module),
      });
    }

    return Object.freeze({
      kind: 'descriptor',
      id: command.id,
      parentId: command.parentId,
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
      readonly parentId?: string;
      readonly routeKeys: readonly string[];
      readonly module: AnyYargsCommandModule;
    }
  | {
      readonly kind: 'descriptor';
      readonly id: string;
      readonly pluginId?: string;
      readonly parentId?: string;
      readonly routeKeys: readonly string[];
      readonly descriptor: AnyAideCommandDescriptor;
    };

export interface RegisterCommandOptions {
  readonly parentId?: string;
}

export interface OwnedPluginCapability<TCapability> {
  readonly pluginId: string;
  readonly capability: TCapability;
}

export class CommandRegistry {
  readonly #commands: RegisteredCommand[] = [];
  readonly #childCommands = new Map<string, RegisteredCommand[]>();
  readonly #plugins: AidePluginDescriptor[] = [];
  readonly #ids = new Set<string>();
  readonly #pluginIds = new Set<string>();
  readonly #routeOwners = new Map<string, string>();
  readonly #childRouteOwners = new Map<string, Map<string, string>>();
  readonly #commandGroupIds = new Set<string>();
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
    module: CommandModule<TBase, TArgs>,
    options: RegisterCommandOptions = {}
  ): this {
    assertId('Command', id);
    this.#assertAvailable(id);
    const keys = routeKeys(module.command);
    assertRouteKeys(id, keys);
    const entry = Object.freeze({
      kind: 'module' as const,
      id,
      parentId: options.parentId,
      routeKeys: freezeRouteKeys(keys),
      module: eraseCommandModule(module),
    });

    if (options.parentId === undefined) {
      this.#assertRoutesAvailable(id, keys);
      this.#commands.push(entry);
      this.#claimRoutes(id, keys);
      if (routeAcceptsChildCommands(module.command)) {
        this.#commandGroupIds.add(id);
      }
    } else {
      this.#assertParentAcceptsChildren(id, options.parentId);
      this.#assertChildRoutesAvailable(id, options.parentId, keys);
      this.#addChildCommand(options.parentId, entry);
      this.#claimChildRoutes(id, options.parentId, keys);
    }

    this.#ids.add(id);
    return this;
  }

  registerDescriptor<TArgs extends object>(
    descriptor: AideCommandDescriptor<TArgs>,
    options: RegisterCommandOptions = {}
  ): this {
    assertId('Command', descriptor.id);
    this.#assertAvailable(descriptor.id);
    const keys = routeKeys(descriptor.route);
    assertRouteKeys(descriptor.id, keys);
    const entry = Object.freeze({
      kind: 'descriptor' as const,
      id: descriptor.id,
      parentId: options.parentId,
      routeKeys: freezeRouteKeys(keys),
      descriptor: snapshotCommandDescriptor(descriptor),
    });

    if (options.parentId === undefined) {
      this.#assertRoutesAvailable(descriptor.id, keys);
      this.#commands.push(entry);
      this.#claimRoutes(descriptor.id, keys);
      if (routeAcceptsChildCommands(descriptor.route)) {
        this.#commandGroupIds.add(descriptor.id);
      }
    } else {
      this.#assertParentAcceptsChildren(descriptor.id, options.parentId);
      this.#assertChildRoutesAvailable(descriptor.id, options.parentId, keys);
      this.#addChildCommand(options.parentId, entry);
      this.#claimChildRoutes(descriptor.id, options.parentId, keys);
    }

    this.#ids.add(descriptor.id);
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

    const pluginCommandIds = new Set(commandIds);
    const pluginGroupIds = new Set(
      snapshot.commands.flatMap((command) => {
        if (command.parentId !== undefined) return [];
        const acceptsChildren =
          command.kind === 'module'
            ? routeAcceptsChildCommands(command.module.command)
            : routeAcceptsChildCommands(command.descriptor.route);
        return acceptsChildren ? [command.id] : [];
      })
    );

    const commandRouteKeys = new Map<string, readonly string[]>();
    const pluginRouteOwners = new Map<string, string>();
    const pluginChildRouteOwners = new Map<string, Map<string, string>>();

    for (const command of snapshot.commands) {
      if (command.parentId === command.id) {
        throw new Error(`Command '${command.id}' cannot be its own parent`);
      }

      const keys =
        command.kind === 'module'
          ? routeKeys(command.module.command)
          : routeKeys(command.descriptor.route);
      assertRouteKeys(command.id, keys);
      commandRouteKeys.set(command.id, keys);

      if (command.parentId === undefined) {
        for (const key of keys) {
          const existingCommand = pluginRouteOwners.get(key);
          if (existingCommand !== undefined) {
            throw new Error(
              `Plugin '${snapshot.id}' declares route '${key}' for commands '${existingCommand}' and '${command.id}'`
            );
          }
          pluginRouteOwners.set(key, command.id);
        }
        this.#assertRoutesAvailable(command.id, keys);
        continue;
      }

      const parentInSamePlugin = pluginCommandIds.has(command.parentId);
      const existingParent = this.#ids.has(command.parentId);
      if (!parentInSamePlugin && !existingParent) {
        throw new Error(
          `Command '${command.id}' parent '${command.parentId}' is not registered`
        );
      }

      const parentAcceptsChildren =
        this.#commandGroupIds.has(command.parentId) ||
        pluginGroupIds.has(command.parentId);
      if (!parentAcceptsChildren) {
        throw new Error(
          `Command '${command.id}' parent '${command.parentId}' does not accept subcommands`
        );
      }

      let routeOwners = pluginChildRouteOwners.get(command.parentId);
      if (routeOwners === undefined) {
        routeOwners = new Map<string, string>();
        pluginChildRouteOwners.set(command.parentId, routeOwners);
      }
      for (const key of keys) {
        const existingCommand = routeOwners.get(key);
        if (existingCommand !== undefined) {
          throw new Error(
            `Plugin '${snapshot.id}' declares route '${key}' under '${command.parentId}' for commands '${existingCommand}' and '${command.id}'`
          );
        }
        routeOwners.set(key, command.id);
      }
      this.#assertChildRoutesAvailable(command.id, command.parentId, keys);
    }

    this.#plugins.push(snapshot);

    for (const command of snapshot.commands) {
      if (command.parentId !== undefined) continue;
      const resolvedKeys = commandRouteKeys.get(command.id) ?? [];
      const entry =
        command.kind === 'module'
          ? Object.freeze({
              kind: 'module' as const,
              id: command.id,
              pluginId: snapshot.id,
              routeKeys: freezeRouteKeys(resolvedKeys),
              module: command.module,
            })
          : Object.freeze({
              kind: 'descriptor' as const,
              id: command.id,
              pluginId: snapshot.id,
              routeKeys: freezeRouteKeys(resolvedKeys),
              descriptor: command.descriptor,
            });
      this.#commands.push(entry);
      this.#ids.add(command.id);
      this.#commandOwners.set(command.id, snapshot.id);
      this.#claimRoutes(command.id, resolvedKeys);
      if (pluginGroupIds.has(command.id)) {
        this.#commandGroupIds.add(command.id);
      }
    }

    for (const command of snapshot.commands) {
      if (command.parentId === undefined) continue;
      const resolvedKeys = commandRouteKeys.get(command.id) ?? [];
      const entry =
        command.kind === 'module'
          ? Object.freeze({
              kind: 'module' as const,
              id: command.id,
              pluginId: snapshot.id,
              parentId: command.parentId,
              routeKeys: freezeRouteKeys(resolvedKeys),
              module: command.module,
            })
          : Object.freeze({
              kind: 'descriptor' as const,
              id: command.id,
              pluginId: snapshot.id,
              parentId: command.parentId,
              routeKeys: freezeRouteKeys(resolvedKeys),
              descriptor: command.descriptor,
            });
      this.#addChildCommand(command.parentId, entry);
      this.#ids.add(command.id);
      this.#commandOwners.set(command.id, snapshot.id);
      this.#claimChildRoutes(command.id, command.parentId, resolvedKeys);
    }

    this.#pluginIds.add(snapshot.id);
    return this;
  }

  commands(): readonly RegisteredCommand[] {
    return [...this.#commands];
  }

  childCommands(parentId: string): readonly RegisteredCommand[] {
    return [...(this.#childCommands.get(parentId) ?? [])];
  }

  childCommandIds(parentId: string): readonly string[] {
    return this.childCommands(parentId).map((entry) => entry.id);
  }

  entries(): readonly RegisteredCommand[] {
    return [
      ...this.#commands,
      ...Array.from(this.#childCommands.values()).flat(),
    ];
  }

  commandIds(): readonly string[] {
    return this.#commands.map((entry) => entry.id);
  }

  allCommandIds(): readonly string[] {
    return this.entries().map((entry) => entry.id);
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

  #assertParentAcceptsChildren(commandId: string, parentId: string): void {
    if (!this.#ids.has(parentId)) {
      throw new Error(
        `Command '${commandId}' parent '${parentId}' is not registered`
      );
    }
    if (!this.#commandGroupIds.has(parentId)) {
      throw new Error(
        `Command '${commandId}' parent '${parentId}' does not accept subcommands`
      );
    }
  }

  #assertChildRoutesAvailable(
    commandId: string,
    parentId: string,
    keys: readonly string[]
  ): void {
    const routeOwners = this.#childRouteOwners.get(parentId);
    if (routeOwners === undefined) return;
    for (const key of keys) {
      const owner = routeOwners.get(key);
      if (owner !== undefined) {
        throw new Error(
          `Command '${commandId}' route '${key}' conflicts with command '${owner}' under '${parentId}'`
        );
      }
    }
  }

  #addChildCommand(parentId: string, entry: RegisteredCommand): void {
    const commands = this.#childCommands.get(parentId) ?? [];
    commands.push(entry);
    this.#childCommands.set(parentId, commands);
  }

  #claimRoutes(commandId: string, keys: readonly string[]): void {
    for (const key of keys) {
      this.#routeOwners.set(key, commandId);
    }
  }

  #claimChildRoutes(
    commandId: string,
    parentId: string,
    keys: readonly string[]
  ): void {
    let routeOwners = this.#childRouteOwners.get(parentId);
    if (routeOwners === undefined) {
      routeOwners = new Map<string, string>();
      this.#childRouteOwners.set(parentId, routeOwners);
    }
    for (const key of keys) {
      routeOwners.set(key, commandId);
    }
  }
}

export function createCommandRegistry(): CommandRegistry {
  return new CommandRegistry();
}
