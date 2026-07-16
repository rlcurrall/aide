import type { Argv, CommandModule } from 'yargs';
import { Effect, type Layer } from 'effect';

import {
  renderCommandResult,
  type AnyPublicAideCommandDescriptor,
  type ServiceFreeAideCommandDescriptor,
} from './command-descriptor.js';
import type {
  KeyringCommandRegistry,
  RegisteredCommand,
  RegisteredTrustedCommand,
} from './command-registry.js';
import {
  attachAideHostContext,
  createAideInternalHostServices,
  AideInternalHostServicesTag,
  type AideHostServices,
  type AideInternalHostServices,
} from './runtime-context.js';
import { runPublicCommand } from './public-command-invocation.js';
import {
  defineHostArrayIndex,
  ownArrayDataValue,
  ownArrayLength,
} from './host-owned-array.js';
import type { KeyringService } from '@lib/auth-keyring.js';
import type { GitHubAuthCatalogService } from '@lib/github-auth-catalog.js';

const getOwnPropertyDescriptor = Reflect.getOwnPropertyDescriptor;
const ownKeys = Reflect.ownKeys;
const reflectApply = Reflect.apply;
const reflectGet = Reflect.get;
const defineProperty = Object.defineProperty;
const hasOwn = Object.hasOwn;
const sameValue = Object.is;
const arrayPrototype = Array.prototype;
const arrayIterator = Symbol.iterator;

const baselineArrayPrototypeKeys = ownKeys(arrayPrototype);
const baselineArrayPrototypeDescriptors: PropertyDescriptor[] = [];
const baselineArrayPrototypeKeyCount = getOwnPropertyDescriptor(
  baselineArrayPrototypeKeys,
  'length'
)?.value as number;
for (let index = 0; index < baselineArrayPrototypeKeyCount; index += 1) {
  const key = getOwnPropertyDescriptor(
    baselineArrayPrototypeKeys,
    String(index)
  )?.value as PropertyKey;
  const descriptor = getOwnPropertyDescriptor(arrayPrototype, key);
  if (descriptor !== undefined) {
    defineProperty(baselineArrayPrototypeDescriptors, String(index), {
      configurable: true,
      enumerable: true,
      value: descriptor,
      writable: true,
    });
  }
}

const baselineIndexDescriptor = getOwnPropertyDescriptor(arrayPrototype, '0');
const baselineMapDescriptor = getOwnPropertyDescriptor(arrayPrototype, 'map');
const baselineFilterDescriptor = getOwnPropertyDescriptor(
  arrayPrototype,
  'filter'
);
const baselineSomeDescriptor = getOwnPropertyDescriptor(arrayPrototype, 'some');
const baselinePushDescriptor = getOwnPropertyDescriptor(arrayPrototype, 'push');
const baselineIteratorDescriptor = getOwnPropertyDescriptor(
  arrayPrototype,
  arrayIterator
);

function isCanonicalArrayMethodDescriptor(
  descriptor: PropertyDescriptor | undefined
): boolean {
  return (
    descriptor !== undefined &&
    descriptor.configurable === true &&
    descriptor.enumerable === false &&
    descriptor.writable === true &&
    hasOwn(descriptor, 'value') &&
    typeof descriptor.value === 'function'
  );
}

const baselineDescriptorsAreCanonical =
  baselineIndexDescriptor === undefined &&
  baselineArrayPrototypeDescriptors.length === baselineArrayPrototypeKeyCount &&
  isCanonicalArrayMethodDescriptor(baselineMapDescriptor) &&
  isCanonicalArrayMethodDescriptor(baselineFilterDescriptor) &&
  isCanonicalArrayMethodDescriptor(baselineSomeDescriptor) &&
  isCanonicalArrayMethodDescriptor(baselinePushDescriptor) &&
  isCanonicalArrayMethodDescriptor(baselineIteratorDescriptor);

function descriptorsEqual(
  left: PropertyDescriptor | undefined,
  right: PropertyDescriptor | undefined
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    sameValue(
      getOwnPropertyDescriptor(left, 'configurable')?.value,
      getOwnPropertyDescriptor(right, 'configurable')?.value
    ) &&
    sameValue(
      getOwnPropertyDescriptor(left, 'enumerable')?.value,
      getOwnPropertyDescriptor(right, 'enumerable')?.value
    ) &&
    sameValue(
      getOwnPropertyDescriptor(left, 'writable')?.value,
      getOwnPropertyDescriptor(right, 'writable')?.value
    ) &&
    sameValue(
      getOwnPropertyDescriptor(left, 'value')?.value,
      getOwnPropertyDescriptor(right, 'value')?.value
    ) &&
    sameValue(
      getOwnPropertyDescriptor(left, 'get')?.value,
      getOwnPropertyDescriptor(right, 'get')?.value
    ) &&
    sameValue(
      getOwnPropertyDescriptor(left, 'set')?.value,
      getOwnPropertyDescriptor(right, 'set')?.value
    )
  );
}

function arrayPrototypeMatchesBaseline(): boolean {
  const currentKeys = ownKeys(arrayPrototype);
  const currentKeyCount = getOwnPropertyDescriptor(currentKeys, 'length')
    ?.value as number;
  if (currentKeyCount !== baselineArrayPrototypeKeyCount) return false;
  for (let index = 0; index < currentKeyCount; index += 1) {
    const currentKey = getOwnPropertyDescriptor(currentKeys, String(index))
      ?.value as PropertyKey;
    const baselineKey = getOwnPropertyDescriptor(
      baselineArrayPrototypeKeys,
      String(index)
    )?.value as PropertyKey;
    if (!sameValue(currentKey, baselineKey)) return false;
    const baselineDescriptor = getOwnPropertyDescriptor(
      baselineArrayPrototypeDescriptors,
      String(index)
    )?.value as PropertyDescriptor | undefined;
    if (
      !descriptorsEqual(
        getOwnPropertyDescriptor(arrayPrototype, currentKey),
        baselineDescriptor
      )
    ) {
      return false;
    }
  }
  return true;
}

export const YARGS_RUNTIME_INTEGRITY_ERROR_MESSAGE =
  'Aide command runtime integrity check failed';

export class YargsRuntimeIntegrityError extends Error {
  constructor() {
    super(YARGS_RUNTIME_INTEGRITY_ERROR_MESSAGE);
    defineProperty(this, 'name', {
      configurable: true,
      enumerable: false,
      value: 'YargsRuntimeIntegrityError',
      writable: true,
    });
  }
}

/** Verify yargs' required Array intrinsics without reading or rewriting them. */
export function assertYargsRuntimeIntegrity(): void {
  if (!baselineDescriptorsAreCanonical || !arrayPrototypeMatchesBaseline()) {
    throw new YargsRuntimeIntegrityError();
  }
}

type GuardedYargsMethod =
  | 'command'
  | 'getHelp'
  | 'parse'
  | 'parseAsync'
  | 'parseSync'
  | 'showHelp';

const guardedYargsInstances = new WeakSet<object>();

function defineGuardedYargsMethod(
  target: object,
  property: GuardedYargsMethod
) {
  const original = reflectGet(target, property) as unknown;
  if (typeof original !== 'function') return;
  defineProperty(target, property, {
    configurable: true,
    enumerable: false,
    value: function runtimeIntegrityCheckedYargsMethod(
      this: unknown,
      ...args: unknown[]
    ) {
      assertYargsRuntimeIntegrity();
      return reflectApply(original, this, args);
    },
    writable: true,
  });
}

function installYargsLifecycleGuards(yargs: Argv): void {
  if (guardedYargsInstances.has(yargs)) return;
  defineGuardedYargsMethod(yargs, 'command');
  defineGuardedYargsMethod(yargs, 'getHelp');
  defineGuardedYargsMethod(yargs, 'parse');
  defineGuardedYargsMethod(yargs, 'parseAsync');
  defineGuardedYargsMethod(yargs, 'parseSync');
  defineGuardedYargsMethod(yargs, 'showHelp');
  guardedYargsInstances.add(yargs);
}

function snapshotYargsCommandRoute(
  route: string | readonly string[]
): string | readonly string[] {
  if (typeof route === 'string') return route;
  const snapshot: string[] = [];
  const routeCount = ownArrayLength(route) ?? 0;
  for (let index = 0; index < routeCount; index += 1) {
    const entry = ownArrayDataValue<string>(route, index);
    if (entry.found) defineHostArrayIndex(snapshot, index, entry.value);
  }
  return snapshot;
}

function isCommandModule(
  value: unknown
): value is CommandModule<object, object> {
  return typeof value === 'object' && value !== null && 'command' in value;
}

function isCommandRoute(value: unknown): value is string | readonly string[] {
  if (typeof value === 'string') return true;
  if (!Array.isArray(value)) return false;
  const length = ownArrayLength(value);
  if (length === undefined) return false;
  for (let index = 0; index < length; index += 1) {
    const entry = ownArrayDataValue<unknown>(value, index);
    if (!entry.found || typeof entry.value !== 'string') return false;
  }
  return true;
}

function copyArguments(source: readonly unknown[]): unknown[] {
  const result: unknown[] = [];
  const length = ownArrayLength(source);
  if (length === undefined) return result;
  for (let index = 0; index < length; index += 1) {
    const entry = ownArrayDataValue<unknown>(source, index);
    if (!entry.found) continue;
    defineHostArrayIndex(result, index, entry.value);
  }
  return result;
}

type LegacyBuilder = (yargs: Argv<object>) => Argv<object> | void;
type LegacyHostBuilder = (
  yargs: Argv<object>,
  services: AideInternalHostServices
) => Argv<object> | void;
type LegacyHandler = (argv: object) => void | Promise<void>;

function runtimeIntegrityCheckedBuilder<T>(builder: T): T {
  if (typeof builder !== 'function') return builder;
  const invoke = builder as (yargs: Argv<object>) => unknown;
  return ((yargs: Argv<object>) => {
    assertYargsRuntimeIntegrity();
    return invoke(yargs);
  }) as T;
}

export interface AideHostAwareCommandModule<
  TBase extends object,
  TArgs extends object,
> extends CommandModule<TBase, TArgs> {
  readonly aideBuilder?: LegacyHostBuilder;
}

function hostAwareBuilder(
  module: CommandModule<object, object>
): LegacyHostBuilder | undefined {
  const value = (module as AideHostAwareCommandModule<object, object>)
    .aideBuilder;
  return typeof value === 'function' ? value : undefined;
}

function wrapLegacyInlineBuilder(
  builder: unknown,
  services: AideInternalHostServices,
  keyringLayer: Layer.Layer<KeyringService>
): unknown {
  if (typeof builder !== 'function') return builder;

  const legacyBuilder = builder as LegacyBuilder;
  return (yargs: Argv<object>) => {
    assertYargsRuntimeIntegrity();
    return (
      withLegacyBuilderCommandWrapping(yargs, services, keyringLayer, () =>
        legacyBuilder(yargs)
      ) ?? yargs
    );
  };
}

function wrapLegacyInlineHandler(
  handler: unknown,
  services: AideInternalHostServices,
  keyringLayer: Layer.Layer<KeyringService>
): unknown {
  if (typeof handler !== 'function') return handler;

  const legacyHandler = handler as LegacyHandler;
  return (argv: object) => {
    assertYargsRuntimeIntegrity();
    attachAideHostContext(argv, { services, keyringLayer });
    return legacyHandler(argv);
  };
}

function wrapLegacyCommandArguments(
  args: readonly unknown[],
  services: AideInternalHostServices,
  keyringLayer: Layer.Layer<KeyringService>
): unknown[] {
  const argumentCount = ownArrayLength(args);
  if (argumentCount === undefined || argumentCount === 0) return [];

  const commandEntry = ownArrayDataValue<unknown>(args, 0);
  if (!commandEntry.found) return [];
  const command = commandEntry.value;
  if (isCommandModule(command)) {
    const wrappedArgs = copyArguments(args);
    defineHostArrayIndex(
      wrappedArgs,
      0,
      legacyCommandModule(command, services, keyringLayer)
    );
    return wrappedArgs;
  }
  if (Array.isArray(command)) {
    const commandCount = ownArrayLength(command);
    if (commandCount !== undefined) {
      let allModules = true;
      const modules: CommandModule<object, object>[] = [];
      for (let index = 0; index < commandCount; index += 1) {
        const moduleEntry = ownArrayDataValue<unknown>(command, index);
        if (!moduleEntry.found || !isCommandModule(moduleEntry.value)) {
          allModules = false;
          break;
        }
        defineHostArrayIndex(
          modules,
          index,
          legacyCommandModule(moduleEntry.value, services, keyringLayer)
        );
      }
      if (allModules) {
        const wrappedArgs = copyArguments(args);
        defineHostArrayIndex(wrappedArgs, 0, modules);
        return wrappedArgs;
      }
    }
  }
  if (isCommandRoute(command)) {
    const wrappedArgs = copyArguments(args);
    const third = ownArrayDataValue<unknown>(wrappedArgs, 2);
    if (third.found && isCommandModule(third.value)) {
      const module = legacyCommandModule(third.value, services, keyringLayer);
      defineHostArrayIndex(wrappedArgs, 2, module.builder ?? {});
      defineHostArrayIndex(wrappedArgs, 3, module.handler);
      return wrappedArgs;
    }

    defineHostArrayIndex(
      wrappedArgs,
      2,
      wrapLegacyInlineBuilder(
        third.found ? third.value : undefined,
        services,
        keyringLayer
      )
    );
    const fourth = ownArrayDataValue<unknown>(wrappedArgs, 3);
    defineHostArrayIndex(
      wrappedArgs,
      3,
      wrapLegacyInlineHandler(
        fourth.found ? fourth.value : undefined,
        services,
        keyringLayer
      )
    );
    return wrappedArgs;
  }

  return copyArguments(args);
}

function withLegacyBuilderCommandWrapping(
  yargs: Argv<object>,
  services: AideInternalHostServices,
  keyringLayer: Layer.Layer<KeyringService>,
  configure: () => Argv<object> | void
): Argv<object> | void {
  const mutableYargs = yargs as Argv<object> & {
    command: (...args: unknown[]) => Argv<object>;
  };
  const originalCommand = mutableYargs.command;
  mutableYargs.command = ((...args: unknown[]) => {
    assertYargsRuntimeIntegrity();
    return reflectApply(
      originalCommand,
      yargs,
      wrapLegacyCommandArguments(args, services, keyringLayer)
    );
  }) as typeof mutableYargs.command;

  try {
    assertYargsRuntimeIntegrity();
    return configure();
  } finally {
    mutableYargs.command = originalCommand;
  }
}

function legacyCommandModule(
  module: CommandModule<object, object>,
  services: AideInternalHostServices,
  keyringLayer: Layer.Layer<KeyringService>
): CommandModule<object, object> {
  const wrapped: CommandModule<object, object> = { ...module };
  const aideBuilder = hostAwareBuilder(module);
  const builder = module.builder;
  const handler = module.handler;

  if (aideBuilder !== undefined) {
    wrapped.builder = (yargs) =>
      withLegacyBuilderCommandWrapping(yargs, services, keyringLayer, () =>
        aideBuilder(yargs, services)
      ) ?? yargs;
  } else if (typeof builder === 'function') {
    wrapped.builder = (yargs) =>
      withLegacyBuilderCommandWrapping(
        yargs,
        services,
        keyringLayer,
        () => builder(yargs) as Argv<object> | void
      ) ?? yargs;
  }

  if (typeof handler === 'function') {
    wrapped.handler = (argv) => {
      assertYargsRuntimeIntegrity();
      attachAideHostContext(argv, { services, keyringLayer });
      return handler(argv);
    };
  }

  return wrapped;
}

export function commandModuleFromDescriptor<TArgs extends object, E>(
  descriptor: ServiceFreeAideCommandDescriptor<TArgs, E>
): CommandModule<object, TArgs> {
  return {
    command: snapshotYargsCommandRoute(descriptor.route),
    describe: descriptor.summary,
    builder: runtimeIntegrityCheckedBuilder(descriptor.yargs?.builder),
    handler: async (argv) => {
      assertYargsRuntimeIntegrity();
      const result = await Effect.runPromise(descriptor.run(argv));
      renderCommandResult(result);
    },
  };
}

export function commandModuleFromPublicDescriptor(
  descriptor: AnyPublicAideCommandDescriptor,
  services: AideHostServices
): CommandModule<object, object> {
  return {
    command: snapshotYargsCommandRoute(descriptor.route),
    describe: descriptor.summary,
    builder: runtimeIntegrityCheckedBuilder(descriptor.yargs?.builder),
    handler: async (argv) => {
      assertYargsRuntimeIntegrity();
      const result = await runPublicCommand(descriptor, argv, services);
      renderCommandResult(result);
    },
  };
}

export function commandModuleFromTrustedDescriptor(
  entry: RegisteredTrustedCommand,
  services: AideInternalHostServices,
  keyringLayer: Layer.Layer<KeyringService>
): CommandModule<object, object> {
  return {
    command: snapshotYargsCommandRoute(entry.descriptor.route),
    describe: entry.descriptor.summary,
    builder: runtimeIntegrityCheckedBuilder(entry.descriptor.yargs?.builder),
    handler: async (argv) => {
      assertYargsRuntimeIntegrity();
      const result =
        entry.provisioning === 'none'
          ? await Effect.runPromise(entry.descriptor.run(argv))
          : entry.provisioning === 'internal-host'
            ? await Effect.runPromise(
                entry.descriptor
                  .run(argv)
                  .pipe(
                    Effect.provideService(AideInternalHostServicesTag, services)
                  )
              )
            : entry.provisioning === 'keyring'
              ? await Effect.runPromise(
                  entry.descriptor.run(argv).pipe(Effect.provide(keyringLayer))
                )
              : await Effect.runPromise(
                  entry.descriptor
                    .run(argv)
                    .pipe(
                      Effect.provideService(
                        AideInternalHostServicesTag,
                        services
                      ),
                      Effect.provide(keyringLayer)
                    )
                );
      renderCommandResult(result);
    },
  };
}

function commandModuleFromRegistryEntry(
  entry: RegisteredCommand,
  registry: KeyringCommandRegistry,
  services: AideInternalHostServices,
  keyringLayer: Layer.Layer<KeyringService>
): CommandModule<object, object> {
  const module =
    entry.kind === 'module'
      ? legacyCommandModule(entry.module, services, keyringLayer)
      : entry.execution === 'public'
        ? commandModuleFromPublicDescriptor(
            entry.descriptor,
            services.publicServices
          )
        : commandModuleFromTrustedDescriptor(entry, services, keyringLayer);
  const children = registry.childCommands(entry.id);
  const childCount = ownArrayLength(children);
  if (childCount === undefined || childCount === 0) return module;

  return {
    ...module,
    builder: (yargs) => {
      assertYargsRuntimeIntegrity();
      let configured: Argv<object>;
      if (typeof module.builder === 'function') {
        configured = module.builder(yargs) as Argv<object>;
      } else if (module.builder === undefined) {
        configured = yargs;
      } else {
        configured = yargs.options(module.builder);
      }

      for (let index = 0; index < childCount; index += 1) {
        const child = ownArrayDataValue<RegisteredCommand>(children, index);
        if (!child.found) continue;
        assertYargsRuntimeIntegrity();
        configured = configured.command(
          commandModuleFromRegistryEntry(
            child.value,
            registry,
            services,
            keyringLayer
          )
        );
      }

      return configured;
    },
  };
}

export interface RegisterCommandsOptions {
  readonly keyringLayer: Layer.Layer<KeyringService>;
  readonly githubAuthCatalogLayer: Layer.Layer<GitHubAuthCatalogService>;
}

export function registerCommands(
  yargs: Argv,
  registry: KeyringCommandRegistry,
  options: RegisterCommandsOptions
): Argv {
  installYargsLifecycleGuards(yargs);
  assertYargsRuntimeIntegrity();
  const services = createAideInternalHostServices(
    registry,
    options.keyringLayer,
    options.githubAuthCatalogLayer
  );
  let configured = yargs;

  const entries = registry.commands();
  const entryCount = ownArrayLength(entries);
  if (entryCount === undefined) return configured;
  for (let index = 0; index < entryCount; index += 1) {
    const entry = ownArrayDataValue<RegisteredCommand>(entries, index);
    if (!entry.found) continue;
    assertYargsRuntimeIntegrity();
    configured = configured.command(
      commandModuleFromRegistryEntry(
        entry.value,
        registry,
        services,
        options.keyringLayer
      )
    );
  }

  return configured;
}
