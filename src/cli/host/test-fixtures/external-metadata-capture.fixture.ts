import { Effect } from 'effect';
import yargs from 'yargs';

import {
  AIDE_PLUGIN_API_VERSION,
  aideReservedAuthProviderIds,
  aideReservedPluginIds,
  aideReservedPullRequestProviderIds,
  isReservedAideAuthProviderId,
  isReservedAidePluginId,
  isReservedAidePullRequestProviderId,
  textResult,
  type AidePublicPluginDescriptor,
} from '@aide/plugin-api';
import {
  createCommandRegistry,
  createKeyringCommandRegistry,
} from '@cli/host/command-registry.js';
import {
  registerCommands,
  YARGS_RUNTIME_INTEGRITY_ERROR_MESSAGE,
  YargsRuntimeIntegrityError,
} from '@cli/host/yargs-adapter.js';
import { makeTestKeyring } from '@lib/auth-keyring.test-helper.js';

type Mode =
  | 'commands-iterator'
  | 'route-iterator'
  | 'route-prototype'
  | 'prototype-semantic'
  | 'registry-prototype-semantic'
  | 'yargs-inner-lifecycle'
  | 'yargs-lifecycle-normal';
type PrototypeBehavior = 'returning' | 'throwing' | 'slow';
type PrototypeConfigurability = 'configurable' | 'nonconfigurable';
type PrototypeHook =
  | 'numeric-setter'
  | 'map'
  | 'filter'
  | 'some'
  | 'push'
  | 'iterator';
type RegistryPrototypeHook =
  | 'reserved-includes'
  | 'object-has-own-property'
  | 'function-call';
type InnerLifecycleTiming = 'nested-builder' | 'handler';

const mode = process.argv[2] as Mode;
const prototypeHook = process.argv[3] as PrototypeHook | undefined;
const prototypeBehavior = process.argv[4] as PrototypeBehavior | undefined;
const prototypeConfigurability = process.argv[5] as
  | PrototypeConfigurability
  | undefined;
const registryPrototypeHook = process.argv[3] as
  | RegistryPrototypeHook
  | undefined;
const innerLifecycleTiming = process.argv[3] as
  | InnerLifecycleTiming
  | undefined;
const innerLifecycleConfigurability = process.argv[4] as
  | PrototypeConfigurability
  | undefined;
let trapCalls = 0;
let prototypeHookActive = false;
const id = `metadata-fixture-${mode}`;
const placement = {
  kind: 'descriptor' as const,
  id: `${id}:command`,
  descriptor: {
    id: `${id}:command`,
    route: [`${id}-route`],
    summary: 'Metadata deadline fixture',
    run: () => Effect.succeed(textResult('fixture')),
  },
};
const commands = [placement];

function hang(): never {
  for (;;) {
    // The parent process supplies the hard deadline for regressions.
  }
}

function descriptorsEqual(
  left: PropertyDescriptor | undefined,
  right: PropertyDescriptor | undefined
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.configurable === right.configurable &&
    left.enumerable === right.enumerable &&
    left.writable === right.writable &&
    Object.is(left.value, right.value) &&
    Object.is(left.get, right.get) &&
    Object.is(left.set, right.set)
  );
}

const prototypeMarker = 'prototype-semantic';
const prototypeSecret = new Error('SECRET-REGISTRY-PROTOTYPE-HOOK');

function isPrototypeMarker(value: unknown): boolean {
  if (typeof value === 'string') return value.startsWith(prototypeMarker);
  if (typeof value !== 'object' || value === null) return false;
  for (const key of ['id', 'pluginId'] as const) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (
      descriptor !== undefined &&
      Object.hasOwn(descriptor, 'value') &&
      typeof descriptor.value === 'string' &&
      descriptor.value.startsWith(prototypeMarker)
    ) {
      return true;
    }
  }
  return false;
}

function isMarkedArray(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  const lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, 'length');
  const length = lengthDescriptor?.value;
  if (typeof length !== 'number') return false;
  const checkedLength = Math.min(length, 64);
  for (let index = 0; index < checkedLength; index += 1) {
    const entry = Reflect.getOwnPropertyDescriptor(value, String(index));
    if (
      entry !== undefined &&
      Object.hasOwn(entry, 'value') &&
      isPrototypeMarker(entry.value)
    ) {
      return true;
    }
  }
  return false;
}

function triggerPrototypeHook(): void {
  trapCalls += 1;
  if (prototypeBehavior === 'throwing') {
    throw prototypeSecret;
  }
  if (prototypeBehavior === 'slow') hang();
}

function installPrototypeHook(): {
  readonly installed: PropertyDescriptor;
  readonly property: PropertyKey;
  readonly original: PropertyDescriptor | undefined;
} {
  if (
    prototypeHook === undefined ||
    prototypeBehavior === undefined ||
    prototypeConfigurability === undefined
  ) {
    throw new Error('missing prototype semantic arguments');
  }
  const property: PropertyKey =
    prototypeHook === 'numeric-setter'
      ? '0'
      : prototypeHook === 'iterator'
        ? Symbol.iterator
        : prototypeHook;
  const original = Reflect.getOwnPropertyDescriptor(Array.prototype, property);
  if (prototypeHook === 'numeric-setter') {
    Object.defineProperty(Array.prototype, property, {
      configurable: prototypeConfigurability === 'configurable',
      set(this: unknown[], value: unknown) {
        if (prototypeHookActive && isPrototypeMarker(value)) {
          triggerPrototypeHook();
        }
        Object.defineProperty(this, '0', {
          configurable: true,
          enumerable: true,
          value,
          writable: true,
        });
      },
    });
  } else {
    Object.defineProperty(Array.prototype, property, {
      configurable: prototypeConfigurability === 'configurable',
      get(this: unknown[]) {
        if (prototypeHookActive && isMarkedArray(this)) {
          triggerPrototypeHook();
        }
        return original?.value;
      },
    });
  }
  const installed = Reflect.getOwnPropertyDescriptor(Array.prototype, property);
  if (installed === undefined) throw new Error('prototype hook not installed');
  return { installed, original, property };
}

function restorePrototypeHook(
  property: PropertyKey,
  original: PropertyDescriptor | undefined
): boolean {
  if (original === undefined) {
    Reflect.deleteProperty(Array.prototype, property);
  } else {
    Object.defineProperty(Array.prototype, property, original);
  }
  return descriptorsEqual(
    Reflect.getOwnPropertyDescriptor(Array.prototype, property),
    original
  );
}

async function runPrototypeSemanticProbe() {
  let registered = 0;
  let replayed = 0;
  let collisions = 0;
  let denseFrozen = true;
  let atomic = true;
  let outsideCallbackCalls = 0;
  const failures: unknown[] = [];
  const parsers = [
    yargs([`${prototypeMarker}-0`])
      .scriptName('aide')
      .exitProcess(false),
    yargs([`${prototypeMarker}-1`])
      .scriptName('aide')
      .exitProcess(false),
  ];
  const originalLog = console.log;
  console.log = () => {};
  const installedHook = installPrototypeHook();
  prototypeHookActive = true;

  async function captureFailure(operation: () => unknown): Promise<void> {
    try {
      await operation();
    } catch (error) {
      const index = Reflect.getOwnPropertyDescriptor(failures, 'length')
        ?.value as number;
      Object.defineProperty(failures, String(index), {
        configurable: true,
        enumerable: true,
        value: error,
        writable: true,
      });
    }
  }

  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const pluginId = `${prototypeMarker}-${attempt}`;
      const commandId = `${pluginId}:command`;
      const route = [pluginId];
      const candidate = {
        id: pluginId,
        summary: 'Prototype semantic fixture',
        commands: [
          {
            kind: 'descriptor' as const,
            id: commandId,
            descriptor: {
              id: commandId,
              route,
              summary: 'Prototype semantic fixture',
              run: () => Effect.succeed(textResult(`DISPATCH-${pluginId}`)),
            },
          },
        ],
      } as AidePublicPluginDescriptor;
      const manifest = {
        id: pluginId,
        version: '1.0.0',
        aidePluginApiVersion: AIDE_PLUGIN_API_VERSION,
        capabilities: ['commands'],
      } as const;
      const registry = createCommandRegistry();
      const replay = createCommandRegistry();

      registry.registerExternalPlugin(candidate, { manifest });
      registered += 1;
      const snapshot = Reflect.getOwnPropertyDescriptor(
        registry.plugins(),
        '0'
      )?.value;
      if (snapshot !== undefined) {
        replay.registerPlugin(snapshot);
        replayed += 1;
        try {
          registry.registerPlugin(snapshot);
        } catch {
          collisions += 1;
        }
      }

      const plugins = registry.plugins();
      const commandsSnapshot = snapshot?.commands;
      denseFrozen =
        denseFrozen &&
        Array.isArray(plugins) &&
        Reflect.getOwnPropertyDescriptor(plugins, '0')?.value === snapshot &&
        Array.isArray(commandsSnapshot) &&
        Object.isFrozen(commandsSnapshot) &&
        Object.isFrozen(snapshot);
      atomic =
        atomic &&
        registry.pluginIds().length === 1 &&
        registry.commandIds().length === 1 &&
        replay.pluginIds().length === 1 &&
        replay.commandIds().length === 1;

      const parser = parsers[attempt]!;
      await captureFailure(() =>
        registerCommands(parser, registry, {
          keyringLayer: makeTestKeyring().layer,
        })
      );
      await captureFailure(() => parser.getHelp());
      await captureFailure(() =>
        parser.showHelp(() => {
          outsideCallbackCalls += 1;
        })
      );
      await captureFailure(() => parser.parse());
      await captureFailure(() => parser.parseSync());
      await captureFailure(() => parser.parseAsync());
    }
  } finally {
    prototypeHookActive = false;
    console.log = originalLog;
  }

  const descriptorUnchanged = descriptorsEqual(
    Reflect.getOwnPropertyDescriptor(Array.prototype, installedHook.property),
    installedHook.installed
  );
  const restored =
    prototypeConfigurability === 'configurable'
      ? restorePrototypeHook(installedHook.property, installedHook.original)
      : undefined;
  const failureCount = Reflect.getOwnPropertyDescriptor(failures, 'length')
    ?.value as number;
  let fixedFailures = failureCount === 12;
  let freshFailures = failureCount === 12;
  let noExternalRetention = failureCount === 12;
  for (let index = 0; index < failureCount; index += 1) {
    const error = Reflect.getOwnPropertyDescriptor(
      failures,
      String(index)
    )?.value;
    const message = Reflect.getOwnPropertyDescriptor(error, 'message')?.value;
    fixedFailures =
      fixedFailures &&
      error instanceof YargsRuntimeIntegrityError &&
      message === YARGS_RUNTIME_INTEGRITY_ERROR_MESSAGE;
    noExternalRetention =
      noExternalRetention &&
      error !== prototypeSecret &&
      message !== prototypeSecret.message &&
      Reflect.getOwnPropertyDescriptor(error, 'cause') === undefined;
    for (let prior = 0; prior < index; prior += 1) {
      freshFailures =
        freshFailures &&
        error !==
          Reflect.getOwnPropertyDescriptor(failures, String(prior))?.value;
    }
  }

  return {
    atomic,
    attempts: 2,
    behavior: prototypeBehavior,
    collisions,
    configurability: prototypeConfigurability,
    denseFrozen,
    descriptorUnchanged,
    failureCount,
    fixedFailures,
    freshFailures,
    hook: prototypeHook,
    noExternalRetention,
    outsideCallbackCalls,
    registered,
    replayed,
    restored:
      prototypeConfigurability === 'configurable'
        ? restored
        : 'process-isolated',
    safe:
      trapCalls === 0 &&
      registered === 2 &&
      replayed === 2 &&
      collisions === 2 &&
      fixedFailures &&
      freshFailures &&
      noExternalRetention &&
      outsideCallbackCalls === 0 &&
      atomic &&
      denseFrozen &&
      descriptorUnchanged &&
      (prototypeConfigurability === 'nonconfigurable' || restored === true),
  };
}

function installRegistryPrototypeHook(): {
  readonly installed: PropertyDescriptor;
  readonly original: PropertyDescriptor;
  readonly property: PropertyKey;
  readonly target: object;
} {
  if (
    registryPrototypeHook === undefined ||
    prototypeBehavior === undefined ||
    prototypeConfigurability === undefined
  ) {
    throw new Error('missing registry prototype arguments');
  }
  const target =
    registryPrototypeHook === 'reserved-includes'
      ? Array.prototype
      : registryPrototypeHook === 'object-has-own-property'
        ? Object.prototype
        : Function.prototype;
  const property =
    registryPrototypeHook === 'reserved-includes'
      ? 'includes'
      : registryPrototypeHook === 'object-has-own-property'
        ? 'hasOwnProperty'
        : 'call';
  const original = Reflect.getOwnPropertyDescriptor(target, property);
  if (original === undefined || typeof original.value !== 'function') {
    throw new Error('missing registry prototype baseline');
  }
  const originalFunction = original.value as (...args: unknown[]) => unknown;
  const originalHasOwnProperty = Object.prototype.hasOwnProperty;
  Object.defineProperty(target, property, {
    configurable: prototypeConfigurability === 'configurable',
    get(this: unknown) {
      const selected =
        registryPrototypeHook === 'reserved-includes'
          ? this === aideReservedPluginIds ||
            this === aideReservedAuthProviderIds ||
            this === aideReservedPullRequestProviderIds
          : registryPrototypeHook === 'object-has-own-property'
            ? this === Object.prototype
            : this === originalHasOwnProperty;
      if (prototypeHookActive && selected) triggerPrototypeHook();
      return originalFunction;
    },
  });
  const installed = Reflect.getOwnPropertyDescriptor(target, property);
  if (installed === undefined) throw new Error('registry hook not installed');
  return { installed, original, property, target };
}

async function runRegistryPrototypeSemanticProbe() {
  const installedHook = installRegistryPrototypeHook();
  const acceptedRegistries: ReturnType<typeof createCommandRegistry>[] = [];
  const rejectedRegistries: ReturnType<typeof createCommandRegistry>[] = [];
  const failures: unknown[] = [];
  const outsideSecret = new Error('SECRET-REGISTRY-CAPTURE-ACCESSOR');
  let outsideAccessorCalls = 0;
  let registered = 0;
  let replayed = 0;
  let collisions = 0;
  prototypeHookActive = true;
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const pluginId = `registry-prototype-${attempt}`;
      const commandId = `${pluginId}:run`;
      const candidate = {
        id: pluginId,
        summary: 'Registry prototype semantic fixture',
        commands: [
          {
            kind: 'descriptor' as const,
            id: commandId,
            descriptor: {
              id: commandId,
              route: [`registry-prototype-route-${attempt}`],
              summary: 'Registry prototype command',
              run: () => Effect.succeed(textResult('registry prototype')),
            },
          },
        ],
      } as AidePublicPluginDescriptor;
      const manifest = {
        id: pluginId,
        version: '1.0.0',
        aidePluginApiVersion: AIDE_PLUGIN_API_VERSION,
        capabilities: ['commands'],
      } as const;
      const registry = createCommandRegistry();
      const replay = createCommandRegistry();
      registry.registerExternalPlugin(candidate, { manifest });
      registered += 1;
      acceptedRegistries.push(registry);
      const snapshot = Reflect.getOwnPropertyDescriptor(
        registry.plugins(),
        '0'
      )?.value;
      if (snapshot !== undefined) {
        replay.registerPlugin(snapshot);
        replayed += 1;
        try {
          registry.registerPlugin(snapshot);
        } catch {
          collisions += 1;
        }
      }

      const rejected = createCommandRegistry();
      rejectedRegistries.push(rejected);
      const rejectedCommand = {
        kind: 'descriptor' as const,
        id: `${pluginId}:rejected`,
        descriptor: {
          id: `${pluginId}:rejected`,
          route: `registry-prototype-${attempt}-rejected`,
          summary: 'Rejected registry prototype command',
          run: () => undefined,
        },
      } as Record<string, unknown>;
      Object.defineProperty(rejectedCommand, 'parentId', {
        configurable: true,
        enumerable: true,
        get() {
          outsideAccessorCalls += 1;
          throw outsideSecret;
        },
      });
      try {
        rejected.registerExternalPlugin(
          {
            id: `${pluginId}-rejected`,
            summary: 'Rejected registry prototype fixture',
            commands: [rejectedCommand],
          } as unknown as AidePublicPluginDescriptor,
          {
            manifest: {
              ...manifest,
              id: `${pluginId}-rejected`,
            },
          }
        );
      } catch (error) {
        failures.push(error);
      }
    }

    if (
      !isReservedAidePluginId('github') ||
      isReservedAidePluginId('registry-prototype') ||
      !isReservedAideAuthProviderId('jira') ||
      isReservedAideAuthProviderId('registry-prototype') ||
      !isReservedAidePullRequestProviderId('azure-devops') ||
      isReservedAidePullRequestProviderId('registry-prototype')
    ) {
      throw new Error('reserved id behavior changed');
    }
  } finally {
    prototypeHookActive = false;
  }

  const descriptorUnchanged = descriptorsEqual(
    Reflect.getOwnPropertyDescriptor(
      installedHook.target,
      installedHook.property
    ),
    installedHook.installed
  );
  const restored =
    prototypeConfigurability === 'configurable'
      ? (() => {
          Object.defineProperty(
            installedHook.target,
            installedHook.property,
            installedHook.original
          );
          return descriptorsEqual(
            Reflect.getOwnPropertyDescriptor(
              installedHook.target,
              installedHook.property
            ),
            installedHook.original
          );
        })()
      : undefined;
  const fixedFailures =
    failures.length === 2 &&
    failures.every(
      (failure) =>
        failure instanceof Error &&
        failure.message === 'External plugin metadata capture failed'
    );
  const freshFailures = failures.length === 2 && failures[0] !== failures[1];
  const noExternalRetention = failures.every(
    (failure) =>
      failure !== outsideSecret &&
      !String(failure).includes(outsideSecret.message) &&
      (typeof failure !== 'object' ||
        failure === null ||
        Reflect.getOwnPropertyDescriptor(failure, 'cause') === undefined)
  );
  const atomic =
    acceptedRegistries.every(
      (registry) =>
        registry.pluginIds().length === 1 && registry.commandIds().length === 1
    ) &&
    rejectedRegistries.every(
      (registry) =>
        registry.pluginIds().length === 0 && registry.commandIds().length === 0
    );
  return {
    atomic,
    attempts: 2,
    behavior: prototypeBehavior,
    collisions,
    configurability: prototypeConfigurability,
    descriptorUnchanged,
    fixedFailures,
    freshFailures,
    hook: registryPrototypeHook,
    noExternalRetention,
    outsideAccessorCalls,
    registered,
    replayed,
    restored:
      prototypeConfigurability === 'configurable'
        ? restored
        : 'process-isolated',
    safe:
      trapCalls === 0 &&
      outsideAccessorCalls === 0 &&
      registered === 2 &&
      replayed === 2 &&
      collisions === 2 &&
      fixedFailures &&
      freshFailures &&
      noExternalRetention &&
      atomic &&
      descriptorUnchanged &&
      (prototypeConfigurability === 'nonconfigurable' || restored === true),
    trapCalls,
  };
}

async function runInnerLifecycleProbe() {
  if (
    innerLifecycleTiming === undefined ||
    innerLifecycleConfigurability === undefined
  ) {
    throw new Error('missing inner lifecycle arguments');
  }
  const property = '997';
  const original = Reflect.getOwnPropertyDescriptor(Array.prototype, property);
  if (original !== undefined) throw new Error('inner lifecycle index occupied');
  let parentBuilderCalls = 0;
  let nestedBuilderCalls = 0;
  let handlerCalls = 0;
  let installed: PropertyDescriptor | undefined;
  const installDivergence = () => {
    Object.defineProperty(Array.prototype, property, {
      configurable: innerLifecycleConfigurability === 'configurable',
      enumerable: false,
      value: 'inner-lifecycle-divergence',
      writable: false,
    });
    installed = Reflect.getOwnPropertyDescriptor(Array.prototype, property);
  };
  const registry = createKeyringCommandRegistry();
  registry.registerModule('inner-root', {
    command:
      innerLifecycleTiming === 'nested-builder'
        ? 'inner-root <command>'
        : 'inner-root',
    describe: 'Inner lifecycle root',
    builder: (parser) => {
      parentBuilderCalls += 1;
      if (innerLifecycleTiming === 'nested-builder') {
        const configured = parser.command({
          command: 'child',
          describe: 'Inner lifecycle child',
          builder: (childParser) => {
            nestedBuilderCalls += 1;
            return childParser;
          },
          handler: () => {
            handlerCalls += 1;
          },
        });
        installDivergence();
        return configured;
      }
      installDivergence();
      return parser;
    },
    handler: () => {
      handlerCalls += 1;
    },
  });
  const parser = yargs(
    innerLifecycleTiming === 'nested-builder'
      ? ['inner-root', 'child']
      : ['inner-root']
  )
    .scriptName('aide')
    .exitProcess(false)
    .fail((message, error) => {
      throw error ?? new Error(message);
    });
  let failure: unknown;
  try {
    await registerCommands(parser, registry, {
      keyringLayer: makeTestKeyring().layer,
    })
      .strict()
      .parseAsync();
  } catch (error) {
    failure = error;
  }
  const descriptorUnchanged =
    installed !== undefined &&
    descriptorsEqual(
      Reflect.getOwnPropertyDescriptor(Array.prototype, property),
      installed
    );
  const restored =
    innerLifecycleConfigurability === 'configurable'
      ? Reflect.deleteProperty(Array.prototype, property) &&
        Reflect.getOwnPropertyDescriptor(Array.prototype, property) === original
      : undefined;
  return {
    configurability: innerLifecycleConfigurability,
    descriptorUnchanged,
    fixedFailure:
      failure instanceof YargsRuntimeIntegrityError &&
      failure.message === YARGS_RUNTIME_INTEGRITY_ERROR_MESSAGE &&
      Reflect.getOwnPropertyDescriptor(failure, 'cause') === undefined,
    handlerCalls,
    nestedBuilderCalls,
    parentBuilderCalls,
    restored:
      innerLifecycleConfigurability === 'configurable'
        ? restored
        : 'process-isolated',
    safe:
      parentBuilderCalls === 1 &&
      nestedBuilderCalls === 0 &&
      handlerCalls === 0 &&
      failure instanceof YargsRuntimeIntegrityError &&
      descriptorUnchanged &&
      (innerLifecycleConfigurability === 'nonconfigurable' ||
        restored === true),
    timing: innerLifecycleTiming,
  };
}

async function runNormalYargsLifecycleProbe() {
  let registered = 0;
  let helped = 0;
  let shown = 0;
  let dispatched = 0;
  let ordinaryArrays = true;
  let receiverReturns = 0;
  let synchronousReturns = 0;
  let promiseReturns = 0;
  let parseCallbacks = 0;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const pluginId = `normal-yargs-${attempt}`;
    const rootId = `${pluginId}:root`;
    const childId = `${pluginId}:child`;
    const leafId = `${pluginId}:leaf`;
    const rootRoute = [`normal-${attempt} <command>`, `n${attempt} <command>`];
    const childRoute = ['child <command>', 'c <command>'];
    const leafRoute = ['run', 'r'];
    const registry = createCommandRegistry();
    registry.registerExternalPlugin(
      {
        id: pluginId,
        summary: 'Normal recursive yargs lifecycle fixture',
        commands: [
          {
            kind: 'descriptor',
            id: rootId,
            acceptsChildren: true,
            extension: { kind: 'open' },
            descriptor: {
              id: rootId,
              route: rootRoute,
              summary: 'Normal root',
              run: () => Effect.succeed(textResult('normal root')),
            },
          },
          {
            kind: 'descriptor',
            id: childId,
            parentId: rootId,
            acceptsChildren: true,
            descriptor: {
              id: childId,
              route: childRoute,
              summary: 'Normal child',
              run: () => Effect.succeed(textResult('normal child')),
            },
          },
          {
            kind: 'descriptor',
            id: leafId,
            parentId: childId,
            descriptor: {
              id: leafId,
              route: leafRoute,
              summary: 'Normal leaf',
              run: () => {
                dispatched += 1;
                return Effect.succeed(textResult(`NORMAL-DISPATCH-${attempt}`));
              },
            },
          },
        ],
      } as AidePublicPluginDescriptor,
      {
        manifest: {
          id: pluginId,
          version: '1.0.0',
          aidePluginApiVersion: AIDE_PLUGIN_API_VERSION,
          capabilities: ['commands'],
        },
      }
    );
    registered += 1;
    const snapshot = registry.plugins()[0];
    ordinaryArrays =
      ordinaryArrays &&
      Array.isArray(snapshot?.commands) &&
      Object.getPrototypeOf(snapshot?.commands) === Array.prototype &&
      !Object.hasOwn(snapshot?.commands ?? {}, 'map') &&
      !Object.hasOwn(snapshot?.commands ?? {}, Symbol.iterator);

    const output: string[] = [];
    const originalLog = console.log;
    console.log = (...values: unknown[]) => {
      const outputIndex = Reflect.getOwnPropertyDescriptor(output, 'length')
        ?.value as number;
      Object.defineProperty(output, String(outputIndex), {
        configurable: true,
        enumerable: true,
        value: values.join(' '),
        writable: true,
      });
    };
    try {
      const configure = (args: readonly string[]) =>
        registerCommands(
          yargs(args).scriptName('aide').exitProcess(false),
          registry,
          { keyringLayer: makeTestKeyring().layer }
        );
      const helpParser = configure([`n${attempt}`, 'c', '--help']);
      const helpPromise = Reflect.apply(helpParser.getHelp, helpParser, []);
      if (helpPromise instanceof Promise) promiseReturns += 1;
      const help = await helpPromise;
      if (help.includes('run') && help.includes('Normal leaf')) helped += 1;

      const showParser = configure([`n${attempt}`, 'c', '--help']);
      let shownHelp = '';
      const showReturn = Reflect.apply(showParser.showHelp, showParser, [
        (value: string) => {
          shownHelp = value;
        },
      ]);
      if (showReturn === showParser) receiverReturns += 1;
      if (shownHelp.includes('run') && shownHelp.includes('Normal leaf')) {
        shown += 1;
      }

      const parseParser = configure([]).strict();
      const parseReturn = Reflect.apply(parseParser.parse, parseParser, [
        [`n${attempt}`, 'c', '--help'],
        {},
        (error: Error | null, _argv: unknown, callbackOutput: string) => {
          if (
            error == null &&
            callbackOutput.includes('run') &&
            callbackOutput.includes('Normal leaf')
          ) {
            parseCallbacks += 1;
          }
        },
      ]);
      if (!(parseReturn instanceof Promise)) synchronousReturns += 1;

      const syncParser = configure([]).strict();
      const parseSyncReturn = Reflect.apply(syncParser.parseSync, syncParser, [
        [`n${attempt}`, 'c', '--help'],
      ]);
      if (!(parseSyncReturn instanceof Promise)) synchronousReturns += 1;

      const asyncParser = configure([]).strict();
      const asyncReturn = Reflect.apply(asyncParser.parseAsync, asyncParser, [
        [`n${attempt}`, 'c', 'r'],
      ]);
      if (asyncReturn instanceof Promise) promiseReturns += 1;
      await asyncReturn;
    } finally {
      console.log = originalLog;
    }
  }

  return {
    attempts: 2,
    dispatched,
    helped,
    ordinaryArrays,
    parseCallbacks,
    promiseReturns,
    receiverReturns,
    registered,
    shown,
    synchronousReturns,
    safe:
      registered === 2 &&
      helped === 2 &&
      shown === 2 &&
      dispatched === 2 &&
      receiverReturns === 2 &&
      synchronousReturns === 4 &&
      promiseReturns === 4 &&
      parseCallbacks === 2 &&
      ordinaryArrays,
  };
}

if (mode === 'commands-iterator') {
  Object.defineProperty(commands, Symbol.iterator, { value: hang });
} else if (mode === 'route-iterator') {
  Object.defineProperty(placement.descriptor.route, Symbol.iterator, {
    value: hang,
  });
} else if (mode === 'route-prototype') {
  Object.setPrototypeOf(
    placement.descriptor.route,
    new Proxy(Array.prototype, { get: hang })
  );
}

if (mode === 'prototype-semantic') {
  const result = await runPrototypeSemanticProbe();
  console.log(JSON.stringify({ mode, trapCalls, ...result }));
} else if (mode === 'registry-prototype-semantic') {
  const result = await runRegistryPrototypeSemanticProbe();
  console.log(JSON.stringify({ mode, ...result }));
} else if (mode === 'yargs-inner-lifecycle') {
  const result = await runInnerLifecycleProbe();
  console.log(JSON.stringify({ mode, trapCalls, ...result }));
} else if (mode === 'yargs-lifecycle-normal') {
  const result = await runNormalYargsLifecycleProbe();
  console.log(JSON.stringify({ mode, trapCalls, ...result }));
} else {
  const registry = createCommandRegistry();
  let safe = false;
  try {
    registry.registerExternalPlugin(
      {
        id,
        summary: 'Metadata deadline fixture',
        commands,
      } as AidePublicPluginDescriptor,
      {
        manifest: {
          id,
          version: '1.0.0',
          aidePluginApiVersion: AIDE_PLUGIN_API_VERSION,
          capabilities: ['commands'],
        },
      }
    );
    safe = true;
  } catch (error) {
    safe =
      error instanceof Error &&
      error.message === 'External plugin metadata capture failed';
  }

  console.log(
    JSON.stringify({
      mode,
      safe,
      trapCalls,
      pluginCount: registry.pluginIds().length,
      commandCount: registry.commandIds().length,
    })
  );
}
