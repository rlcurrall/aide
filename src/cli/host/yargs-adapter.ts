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
      ? entry.module
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
  let configured = yargs.middleware((argv) => {
    attachAideHostContext(argv, { services });
  }, true);

  for (const entry of registry.commands()) {
    configured = configured.command(
      commandModuleFromRegistryEntry(entry, registry, services)
    );
  }

  return configured;
}
