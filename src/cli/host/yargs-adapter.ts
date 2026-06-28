import type { Argv, CommandModule } from 'yargs';
import { Effect } from 'effect';

import {
  renderCommandResult,
  type AideCommandDescriptor,
  type CommandResult,
  type HostAideCommandDescriptor,
  type ServiceFreeAideCommandDescriptor,
} from './command-descriptor.js';
import type { CommandRegistry, RegisteredCommand } from './command-registry.js';
import {
  attachAideHostContext,
  createAideHostServices,
  AideHostServicesTag,
  type AideHostServices,
} from './runtime-context.js';

function isCommandModule(
  value: unknown
): value is CommandModule<object, object> {
  return typeof value === 'object' && value !== null && 'command' in value;
}

function isCommandRoute(value: unknown): value is string | readonly string[] {
  return (
    typeof value === 'string' ||
    (Array.isArray(value) && value.every((part) => typeof part === 'string'))
  );
}

type LegacyBuilder = (yargs: Argv<object>) => Argv<object> | void;
type LegacyHandler = (argv: object) => void | Promise<void>;

function wrapLegacyInlineBuilder(
  builder: unknown,
  services: AideHostServices
): unknown {
  if (typeof builder !== 'function') return builder;

  const legacyBuilder = builder as LegacyBuilder;
  return (yargs: Argv<object>) =>
    withLegacyBuilderCommandWrapping(yargs, services, () =>
      legacyBuilder(yargs)
    ) ?? yargs;
}

function wrapLegacyInlineHandler(
  handler: unknown,
  services: AideHostServices
): unknown {
  if (typeof handler !== 'function') return handler;

  const legacyHandler = handler as LegacyHandler;
  return (argv: object) => {
    attachAideHostContext(argv, { services });
    return legacyHandler(argv);
  };
}

function wrapLegacyCommandArguments(
  args: readonly unknown[],
  services: AideHostServices
): unknown[] {
  if (args.length === 0) return [];

  const [command, ...rest] = args;
  if (isCommandModule(command)) {
    return [legacyCommandModule(command, services), ...rest];
  }
  if (Array.isArray(command) && command.every(isCommandModule)) {
    return [
      command.map((module) => legacyCommandModule(module, services)),
      ...rest,
    ];
  }
  if (isCommandRoute(command)) {
    const wrappedArgs = [...args];
    if (isCommandModule(wrappedArgs[2])) {
      const module = legacyCommandModule(wrappedArgs[2], services);
      wrappedArgs[2] = module.builder ?? {};
      wrappedArgs[3] = module.handler;
      return wrappedArgs;
    }

    wrappedArgs[2] = wrapLegacyInlineBuilder(wrappedArgs[2], services);
    wrappedArgs[3] = wrapLegacyInlineHandler(wrappedArgs[3], services);
    return wrappedArgs;
  }

  return [...args];
}

function withLegacyBuilderCommandWrapping(
  yargs: Argv<object>,
  services: AideHostServices,
  configure: () => Argv<object> | void
): Argv<object> | void {
  const mutableYargs = yargs as Argv<object> & {
    command: (...args: unknown[]) => Argv<object>;
  };
  const originalCommand = mutableYargs.command;
  mutableYargs.command = ((...args: unknown[]) =>
    originalCommand.apply(
      yargs,
      wrapLegacyCommandArguments(args, services)
    )) as typeof mutableYargs.command;

  try {
    return configure();
  } finally {
    mutableYargs.command = originalCommand;
  }
}

function legacyCommandModule(
  module: CommandModule<object, object>,
  services: AideHostServices
): CommandModule<object, object> {
  const wrapped: CommandModule<object, object> = { ...module };
  const builder = module.builder;
  const handler = module.handler;

  if (typeof builder === 'function') {
    wrapped.builder = (yargs) =>
      withLegacyBuilderCommandWrapping(
        yargs,
        services,
        () => builder(yargs) as Argv<object> | void
      ) ?? yargs;
  }

  if (typeof handler === 'function') {
    wrapped.handler = (argv) => {
      attachAideHostContext(argv, { services });
      return handler(argv);
    };
  }

  return wrapped;
}

export function commandModuleFromDescriptor<TArgs extends object, E>(
  descriptor: ServiceFreeAideCommandDescriptor<TArgs, E>
): CommandModule<object, TArgs>;
export function commandModuleFromDescriptor<TArgs extends object, E>(
  descriptor: HostAideCommandDescriptor<TArgs, E>,
  services: AideHostServices
): CommandModule<object, TArgs>;
export function commandModuleFromDescriptor<TArgs extends object>(
  descriptor: AideCommandDescriptor<TArgs, unknown, unknown>,
  services?: AideHostServices
): CommandModule<object, TArgs> {
  return {
    command: descriptor.route,
    describe: descriptor.summary,
    builder: descriptor.yargs?.builder,
    handler: async (argv) => {
      const commandEffect = descriptor.run(argv);
      const runnable =
        services === undefined
          ? commandEffect
          : commandEffect.pipe(
              Effect.provideService(AideHostServicesTag, services)
            );
      const result = await Effect.runPromise(
        runnable as Effect.Effect<CommandResult, unknown, never>
      );
      renderCommandResult(result);
    },
  };
}

function commandModuleFromRegistryEntry(
  entry: RegisteredCommand,
  registry: CommandRegistry,
  services: AideHostServices
): CommandModule<object, object> {
  const module =
    entry.kind === 'module'
      ? legacyCommandModule(entry.module, services)
      : commandModuleFromDescriptor(entry.descriptor, services);
  const children = registry.childCommands(entry.id);
  if (children.length === 0) return module;

  return {
    ...module,
    builder: (yargs) => {
      let configured: Argv<object>;
      if (typeof module.builder === 'function') {
        configured = module.builder(yargs) as Argv<object>;
      } else if (module.builder === undefined) {
        configured = yargs;
      } else {
        configured = yargs.options(module.builder);
      }

      for (const child of children) {
        configured = configured.command(
          commandModuleFromRegistryEntry(child, registry, services)
        );
      }

      return configured;
    },
  };
}

export function registerCommands(yargs: Argv, registry: CommandRegistry): Argv {
  const services = createAideHostServices(registry);
  let configured = yargs;

  for (const entry of registry.commands()) {
    configured = configured.command(
      commandModuleFromRegistryEntry(entry, registry, services)
    );
  }

  return configured;
}
