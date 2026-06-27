import type {
  CommandRegistry,
  OwnedPluginCapability,
} from './command-registry.js';
import type { AidePullRequestProviderCapability } from './plugin-descriptor.js';

const aideHostContextSymbol = Symbol.for('aide.hostContext');

export interface AideHostServices {
  readonly pullRequestProviders: () => readonly OwnedPluginCapability<AidePullRequestProviderCapability>[];
}

export interface AideHostContext {
  readonly services: AideHostServices;
}

type AideHostContextCarrier = {
  [aideHostContextSymbol]?: AideHostContext;
};

export function attachAideHostContext<TArgv extends object>(
  argv: TArgv,
  context: AideHostContext
): TArgv {
  Object.defineProperty(argv, aideHostContextSymbol, {
    value: context,
    enumerable: false,
    configurable: true,
  });
  return argv;
}

export function getAideHostContext(argv: unknown): AideHostContext | null {
  if (argv === null || typeof argv !== 'object') {
    return null;
  }
  return (argv as AideHostContextCarrier)[aideHostContextSymbol] ?? null;
}

export function createAideHostServices(
  registry: CommandRegistry
): AideHostServices {
  const pullRequestProviders = registry.capabilities.pullRequestProviders();
  return Object.freeze({
    pullRequestProviders: () => pullRequestProviders,
  });
}
