import type { CommandRegistry } from './command-registry.js';

const aideHostContextSymbol = Symbol.for('aide.hostContext');

export interface AideHostContext {
  readonly registry: CommandRegistry;
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
