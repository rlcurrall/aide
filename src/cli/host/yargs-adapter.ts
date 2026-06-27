import type { Argv, CommandModule } from 'yargs';
import { Effect } from 'effect';

import {
  renderCommandResult,
  type AideCommandDescriptor,
} from './command-descriptor.js';
import type { CommandRegistry } from './command-registry.js';

export function commandModuleFromDescriptor<TArgs extends object>(
  descriptor: AideCommandDescriptor<TArgs>
): CommandModule<object, TArgs> {
  return {
    command: descriptor.route,
    describe: descriptor.summary,
    builder: descriptor.yargs?.builder,
    handler: async (argv) => {
      const result = await Effect.runPromise(descriptor.run(argv));
      renderCommandResult(result);
    },
  };
}

export function registerCommands(yargs: Argv, registry: CommandRegistry): Argv {
  let configured = yargs;

  for (const entry of registry.commands()) {
    configured = configured.command(
      entry.kind === 'module'
        ? entry.module
        : commandModuleFromDescriptor(entry.descriptor)
    );
  }

  return configured;
}
