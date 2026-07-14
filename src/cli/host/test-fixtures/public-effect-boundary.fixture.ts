import { Cause, Effect, Exit, Option } from 'effect';

import {
  AIDE_PLUGIN_API_VERSION,
  defineAidePlugin as definePublicAidePlugin,
} from '@aide/plugin-api';
import {
  createKeyringCommandRegistry,
  type KeyringCommandRegistry,
} from '@cli/host/command-registry.js';
import {
  createAideHostServices,
  createAideInternalHostServices,
} from '@cli/host/runtime-context.js';
import type {
  AidePluginAuthStatus,
  AidePrimeSection,
  AidePullRequestListResult,
  AidePullRequestProviderCapability,
  AidePullRequestRepositoryMatch,
} from '@cli/host/plugin-descriptor.js';
import { snapshotValidPrimeSections } from '@cli/host/prime-contribution.js';
import { buildPrimeOutput } from '@cli/plugins/aide-core/prime.js';
import { makeTestKeyring } from '@lib/auth-keyring.test-helper.js';

type Mode =
  | 'prime-status-proxy'
  | 'prime-strict-sections-proxy'
  | 'prime-tolerant-sections-proxy'
  | 'pr-matcher-proxy'
  | 'pr-operation-proxy'
  | 'forged-instruction'
  | 'prime-message-prototype'
  | 'prime-strict-array-prototype'
  | 'prime-tolerant-array-prototype'
  | 'prime-strict-data-descriptors'
  | 'prime-tolerant-data-descriptors';
type PrototypeBehavior = 'returning' | 'throwing' | 'slow';
type PrimeMessageKey = 'configured' | 'notConfigured' | 'misconfigured';
type PrimeDescriptorSite =
  | 'array-proxy'
  | 'index-accessor'
  | 'section-proxy'
  | 'field-accessor';

const mode = process.argv[2] as Mode;
const prototypeMessageKey = process.argv[3] as PrimeMessageKey | undefined;
const prototypeBehavior = (
  mode === 'prime-message-prototype' ? process.argv[4] : process.argv[3]
) as PrototypeBehavior | undefined;
const primeDescriptorSite = process.argv[3] as PrimeDescriptorSite | undefined;
const primeDescriptorBehavior = process.argv[4] as
  | PrototypeBehavior
  | undefined;
const secret = `SECRET-RUNTIME-INSTRUCTION-${mode}`;
let instructionReads = 0;
let uncaughtExceptions = 0;
let unhandledRejections = 0;
let prototypeHookCalls = 0;

process.on('uncaughtException', () => {
  uncaughtExceptions += 1;
});
process.on('unhandledRejection', () => {
  unhandledRejections += 1;
});

function manifest(
  id: string,
  capability: 'prime-contribution' | 'pull-request-provider'
) {
  return {
    id,
    version: '1.0.0',
    aidePluginApiVersion: AIDE_PLUGIN_API_VERSION,
    capabilities: [capability],
  } as const;
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

function triggerPrototypeHook(): void {
  prototypeHookCalls += 1;
  if (prototypeBehavior === 'throwing') {
    throw new Error(`SECRET-PRIME-PROTOTYPE-${mode}`);
  }
  if (prototypeBehavior === 'slow') {
    for (;;) {
      // The parent kills and awaits a regressed child at the hard deadline.
    }
  }
}

function restoreDescriptor(
  target: object,
  key: PropertyKey,
  original: PropertyDescriptor | undefined
): boolean {
  if (original === undefined) {
    Reflect.deleteProperty(target, key);
  } else {
    Object.defineProperty(target, key, original);
  }
  return descriptorsEqual(
    Reflect.getOwnPropertyDescriptor(target, key),
    original
  );
}

async function runPrimeMessagePrototypeProbe() {
  if (prototypeMessageKey === undefined || prototypeBehavior === undefined) {
    throw new Error('missing Prime message prototype arguments');
  }
  const original = Reflect.getOwnPropertyDescriptor(
    Object.prototype,
    prototypeMessageKey
  );
  let atomic = true;
  let frozenNullPrototype = true;
  let restored = true;
  const marker = 'PROTOTYPE-SAFE-PRIME-MESSAGE';

  Object.defineProperty(Object.prototype, prototypeMessageKey, {
    configurable: true,
    set(this: object, value: unknown) {
      triggerPrototypeHook();
      Object.defineProperty(this, prototypeMessageKey, {
        configurable: true,
        enumerable: true,
        value,
        writable: true,
      });
    },
  });
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const pluginId = `prime-message-prototype-${attempt}`;
      const state =
        prototypeMessageKey === 'misconfigured'
          ? ('misconfigured' as const)
          : ('configured' as const);
      const messages = {
        configured: `${marker}-CONFIGURED`,
        notConfigured: `${marker}-NOT-CONFIGURED`,
        misconfigured: `${marker}-MISCONFIGURED`,
      };
      const candidate = definePublicAidePlugin({
        id: pluginId,
        summary: 'Prime message prototype fixture',
        commands: [],
        capabilities: {
          primeContribution: {
            status: [
              {
                groupId: pluginId,
                groupLabel: 'Prime message prototype fixture',
                label: 'First status',
                messages,
                status: () =>
                  Effect.succeed({ state, detail: `${marker}-DETAIL-ONE` }),
              },
              {
                groupId: pluginId,
                groupLabel: 'Prime message prototype fixture',
                label: 'Second status',
                status: () =>
                  Effect.succeed({ state, detail: `${marker}-DETAIL-TWO` }),
              },
            ],
          },
        },
      });
      const registry = createKeyringCommandRegistry();
      registry.registerExternalPlugin(candidate, {
        manifest: manifest(pluginId, 'prime-contribution'),
      });
      const services = createAideInternalHostServices(
        registry,
        makeTestKeyring().layer
      );
      await buildPrimeOutput({ services });
      const registration =
        createAideHostServices(registry).primeContributions()[0];
      const declarationMessages =
        registration?.capability.status?.[0]?.messages;
      frozenNullPrototype =
        frozenNullPrototype &&
        declarationMessages !== undefined &&
        Object.getPrototypeOf(declarationMessages) === null &&
        Object.isFrozen(declarationMessages) &&
        Reflect.getOwnPropertyDescriptor(
          declarationMessages,
          prototypeMessageKey
        )?.value === messages[prototypeMessageKey];
      atomic =
        atomic &&
        registry.pluginIds().length === 1 &&
        registry.commandIds().length === 0;
    }
  } finally {
    restored = restoreDescriptor(
      Object.prototype,
      prototypeMessageKey,
      original
    );
  }
  return {
    atomic,
    attempts: 2,
    behavior: prototypeBehavior,
    frozenNullPrototype,
    hookCalls: prototypeHookCalls,
    key: prototypeMessageKey,
    kind: 'prototype-safe',
    restored,
    safe: prototypeHookCalls === 0 && atomic && frozenNullPrototype && restored,
  };
}

function isPrimeSectionMarker(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const descriptor = Reflect.getOwnPropertyDescriptor(value, 'id');
  return (
    descriptor !== undefined &&
    Object.hasOwn(descriptor, 'value') &&
    typeof descriptor.value === 'string' &&
    descriptor.value.startsWith('prototype-prime-section')
  );
}

async function runPrimeSectionPrototypeProbe(tolerant: boolean) {
  if (prototypeBehavior === undefined) {
    throw new Error('missing Prime section prototype behavior');
  }
  const original = Reflect.getOwnPropertyDescriptor(Array.prototype, '0');
  let denseFrozen = true;
  let restored = true;
  Object.defineProperty(Array.prototype, '0', {
    configurable: true,
    set(this: unknown[], value: unknown) {
      if (isPrimeSectionMarker(value)) triggerPrototypeHook();
      Object.defineProperty(this, '0', {
        configurable: true,
        enumerable: true,
        value,
        writable: true,
      });
    },
  });
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const pluginId = `prime-section-prototype-${attempt}`;
      const registry = primeRegistry(
        () =>
          Effect.succeed([
            {
              id: `prototype-prime-section-${attempt}`,
              body: `PROTOTYPE-SAFE-PRIME-SECTION-${attempt}`,
              order: attempt,
            },
          ]),
        'sections'
      );
      const sections =
        createAideHostServices(registry).primeContributions()[0]!.capability
          .sections!;
      const strictSnapshot = await Effect.runPromise(sections());
      denseFrozen =
        denseFrozen &&
        Array.isArray(strictSnapshot) &&
        Object.getPrototypeOf(strictSnapshot) === Array.prototype &&
        Object.isFrozen(strictSnapshot) &&
        Reflect.getOwnPropertyDescriptor(strictSnapshot, '0')?.value !==
          undefined &&
        Object.isFrozen(strictSnapshot[0]);
      if (tolerant) {
        const output = await buildPrimeOutput({
          services: createAideInternalHostServices(
            registry,
            makeTestKeyring().layer
          ),
        });
        denseFrozen =
          denseFrozen &&
          output.includes(`PROTOTYPE-SAFE-PRIME-SECTION-${attempt}`);
      }
      if (registry.pluginIds()[0] !== `fixture-${mode}` || pluginId === '') {
        denseFrozen = false;
      }
    }
  } finally {
    restored = restoreDescriptor(Array.prototype, '0', original);
  }
  return {
    attempts: 2,
    behavior: prototypeBehavior,
    denseFrozen,
    hookCalls: prototypeHookCalls,
    kind: 'prototype-safe',
    restored,
    safe: prototypeHookCalls === 0 && denseFrozen && restored,
  };
}

function hostilePrimeSections(
  site: PrimeDescriptorSite,
  behavior: PrototypeBehavior,
  attempt: number
) {
  const hostileSecret = `SECRET-PRIME-DESCRIPTOR-${site}-${attempt}`;
  const attacker = new Error(hostileSecret);
  let armed = true;
  let productionCalls = 0;
  let reachabilityCalls = 0;
  const trigger = <T>(value: T): T => {
    if (!armed) {
      reachabilityCalls += 1;
      return value;
    }
    productionCalls += 1;
    if (behavior === 'throwing') throw attacker;
    if (behavior === 'slow') {
      for (;;) {
        // The parent kills and awaits a regressed child at the hard deadline.
      }
    }
    return value;
  };

  const validSection = {
    id: `hostile-prime-section-${attempt}`,
    body: hostileSecret,
  };
  let control: () => void;
  let sections: unknown;
  switch (site) {
    case 'array-proxy': {
      const proxy = new Proxy([validSection], {
        get(target, property, receiver) {
          return trigger(Reflect.get(target, property, receiver));
        },
      });
      sections = proxy;
      control = () => {
        armed = false;
        Reflect.get(proxy, 'length');
      };
      break;
    }
    case 'index-accessor': {
      const array: unknown[] = [];
      array.length = 1;
      Object.defineProperty(array, '0', {
        configurable: true,
        enumerable: true,
        get: () => trigger(validSection),
      });
      sections = array;
      control = () => {
        armed = false;
        Reflect.get(array, '0');
      };
      break;
    }
    case 'section-proxy': {
      const proxy = new Proxy(validSection, {
        get(target, property, receiver) {
          return trigger(Reflect.get(target, property, receiver));
        },
      });
      sections = [proxy];
      control = () => {
        armed = false;
        Reflect.get(proxy, 'id');
      };
      break;
    }
    case 'field-accessor': {
      const section = { body: hostileSecret } as Record<string, unknown>;
      Object.defineProperty(section, 'id', {
        configurable: true,
        enumerable: true,
        get: () => trigger(`hostile-prime-section-${attempt}`),
      });
      sections = [section];
      control = () => {
        armed = false;
        Reflect.get(section, 'id');
      };
      break;
    }
  }

  return {
    attacker,
    control,
    hostileSecret,
    productionCalls: () => productionCalls,
    reachabilityCalls: () => reachabilityCalls,
    sections,
  };
}

async function runPrimeDataDescriptorProbe(tolerant: boolean) {
  if (
    primeDescriptorSite === undefined ||
    primeDescriptorBehavior === undefined
  ) {
    throw new Error('missing Prime data-descriptor probe arguments');
  }

  const failures: unknown[] = [];
  const failureDiagnostics: unknown[] = [];
  const failureEntryIndices: unknown[] = [];
  let defects = 0;
  let productionCalls = 0;
  let reachabilityCalls = 0;
  let denseSanitized = true;
  let tolerantDropped = true;
  let attackerRetained = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const hostile = hostilePrimeSections(
      primeDescriptorSite,
      primeDescriptorBehavior,
      attempt
    );
    const registry = primeRegistry(
      () => Effect.succeed(hostile.sections as readonly AidePrimeSection[]),
      'sections'
    );
    if (tolerant) {
      const snapshot = snapshotValidPrimeSections(
        `fixture-${mode}`,
        hostile.sections
      );
      const output = await buildPrimeOutput({
        services: createAideInternalHostServices(
          registry,
          makeTestKeyring().layer
        ),
      });
      denseSanitized =
        denseSanitized &&
        Array.isArray(snapshot) &&
        Object.getPrototypeOf(snapshot) === Array.prototype &&
        Object.isFrozen(snapshot) &&
        Reflect.ownKeys(snapshot).length === 1 &&
        snapshot.length === 0;
      tolerantDropped =
        tolerantDropped && !output.includes(hostile.hostileSecret);
    } else {
      const sections =
        createAideHostServices(registry).primeContributions()[0]!.capability
          .sections!;
      const exit = await Effect.runPromiseExit(sections());
      const failure = Exit.isFailure(exit)
        ? Cause.failureOption(exit.cause)
        : Option.none();
      const value = Option.isSome(failure) ? failure.value : undefined;
      failures.push(value);
      failureDiagnostics.push(
        typeof value === 'object' && value !== null && 'diagnostic' in value
          ? value.diagnostic
          : undefined
      );
      failureEntryIndices.push(
        typeof value === 'object' && value !== null && 'entryIndex' in value
          ? value.entryIndex
          : undefined
      );
      if (Exit.isFailure(exit)) {
        defects += Array.from(Cause.defects(exit.cause)).length;
      }
      attackerRetained =
        attackerRetained ||
        value === hostile.attacker ||
        JSON.stringify(exit).includes(hostile.hostileSecret);
    }
    productionCalls += hostile.productionCalls();
    hostile.control();
    reachabilityCalls += hostile.reachabilityCalls();
  }

  const strictFailuresValid =
    tolerant ||
    (failures.length === 2 &&
      failures[0] !== failures[1] &&
      failures.every(
        (failure) =>
          typeof failure === 'object' &&
          failure !== null &&
          '_tag' in failure &&
          failure._tag === 'PrimeContributionError' &&
          !Object.hasOwn(failure, 'cause')
      ) &&
      failureDiagnostics.every(
        (diagnostic) =>
          diagnostic ===
          (primeDescriptorSite === 'array-proxy'
            ? 'result-length-unreadable'
            : 'entry-unreadable')
      ) &&
      failureEntryIndices.every(
        (entryIndex) =>
          entryIndex === (primeDescriptorSite === 'array-proxy' ? undefined : 0)
      ));
  return {
    attackerRetained,
    attempts: 2,
    behavior: primeDescriptorBehavior,
    denseSanitized,
    defects,
    failureCount: failures.length,
    failureDiagnostics,
    kind: 'descriptor-safe',
    productionCalls,
    reachabilityCalls,
    safe:
      productionCalls === 0 &&
      reachabilityCalls === 2 &&
      strictFailuresValid &&
      denseSanitized &&
      tolerantDropped &&
      !attackerRetained,
    site: primeDescriptorSite,
    strictFailuresValid,
    tolerantDropped,
  };
}

function instructionProxy<A, E>(
  effect: Effect.Effect<A, E>
): Effect.Effect<A, E> {
  return new Proxy(effect, {
    get(target, property, receiver) {
      if (
        property === '_op' ||
        property === '_tag' ||
        property === 'effect_instruction_i0'
      ) {
        instructionReads += 1;
        throw new Error(secret);
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

function forgedInstructionEffect(): Effect.Effect<readonly AidePrimeSection[]> {
  const forged = Object.create(null) as Record<PropertyKey, unknown>;
  Object.defineProperty(forged, Effect.EffectTypeId, {
    enumerable: false,
    value: Object.freeze({}),
  });
  Object.defineProperty(forged, '_op', {
    get() {
      instructionReads += 1;
      throw new Error(secret);
    },
  });
  return forged as unknown as Effect.Effect<readonly AidePrimeSection[]>;
}

function primeRegistry(
  callback: () => Effect.Effect<unknown, unknown>,
  contribution: 'status' | 'sections'
): KeyringCommandRegistry {
  const pluginId = `fixture-${mode}`;
  const registry = createKeyringCommandRegistry();
  registry.registerExternalPlugin(
    definePublicAidePlugin({
      id: pluginId,
      summary: 'Public Effect boundary subprocess fixture',
      commands: [],
      capabilities: {
        primeContribution:
          contribution === 'status'
            ? {
                status: [
                  {
                    groupId: pluginId,
                    groupLabel: 'Fixture Status',
                    label: 'Fixture Status',
                    status:
                      callback as () => Effect.Effect<AidePluginAuthStatus>,
                  },
                ],
              }
            : {
                sections: callback as () => Effect.Effect<
                  readonly AidePrimeSection[]
                >,
              },
      },
    }),
    { manifest: manifest(pluginId, 'prime-contribution') }
  );
  return registry;
}

const repository = Object.freeze({
  kind: 'external' as const,
  providerId: 'fixture-pr',
  displayName: 'Fixture PR',
  metadata: Object.freeze({ repository: 'widgets' }),
});

function prRegistry(
  capability: AidePullRequestProviderCapability
): KeyringCommandRegistry {
  const pluginId = `fixture-${mode}`;
  const registry = createKeyringCommandRegistry();
  registry.registerExternalPlugin(
    definePublicAidePlugin({
      id: pluginId,
      summary: 'Public Effect boundary PR subprocess fixture',
      commands: [],
      capabilities: { pullRequestProvider: capability },
    }),
    { manifest: manifest(pluginId, 'pull-request-provider') }
  );
  return registry;
}

function failureTag(exit: Exit.Exit<unknown, unknown>): string {
  if (Exit.isSuccess(exit)) return 'Success';
  const failure = Cause.failureOption(exit.cause);
  return Option.isSome(failure) &&
    typeof failure.value === 'object' &&
    failure.value !== null &&
    '_tag' in failure.value
    ? String(failure.value._tag)
    : 'Cause';
}

async function runMode(): Promise<Readonly<Record<string, unknown>>> {
  switch (mode) {
    case 'prime-status-proxy': {
      const registry = primeRegistry(
        () =>
          instructionProxy(Effect.succeed({ state: 'configured' as const })),
        'status'
      );
      const output = await buildPrimeOutput({
        services: createAideInternalHostServices(
          registry,
          makeTestKeyring().layer
        ),
      });
      return {
        kind: output.includes('status callback returned an invalid Effect')
          ? 'status-fallback'
          : 'unexpected-status-output',
        safe: !output.includes(secret),
      };
    }
    case 'prime-strict-sections-proxy': {
      const registry = primeRegistry(
        () =>
          instructionProxy(
            Effect.succeed([{ id: 'fixture', body: 'unsafe fixture' }])
          ),
        'sections'
      );
      const sections =
        createAideHostServices(registry).primeContributions()[0]!.capability
          .sections!;
      const exit = await Effect.runPromiseExit(sections());
      return {
        kind: failureTag(exit),
        safe: !JSON.stringify(exit).includes(secret),
      };
    }
    case 'prime-tolerant-sections-proxy': {
      const registry = primeRegistry(
        () =>
          instructionProxy(
            Effect.succeed([{ id: 'fixture', body: 'unsafe fixture' }])
          ),
        'sections'
      );
      const output = await buildPrimeOutput({
        services: createAideInternalHostServices(
          registry,
          makeTestKeyring().layer
        ),
      });
      return {
        kind: output.includes('unsafe fixture')
          ? 'unsafe-section'
          : 'section-dropped',
        safe: !output.includes(secret),
      };
    }
    case 'pr-matcher-proxy': {
      const match: AidePullRequestRepositoryMatch = {
        source: 'repository-ref',
        repository,
      };
      const registry = prRegistry({
        providerId: 'fixture-pr',
        priority: 10,
        features: {},
        authStatus: () => Effect.succeed({ state: 'configured' }),
        matchRemote: () => null,
        matchRepository: () => instructionProxy(Effect.succeed(match)),
        matchPullRequestUrl: () => null,
      });
      const exit = await Effect.runPromiseExit(
        createAideHostServices(
          registry
        ).resolvePullRequestProviderForRepositoryInput({
          providerId: 'fixture-pr',
          repo: 'widgets',
        })
      );
      return {
        kind: failureTag(exit),
        safe: !JSON.stringify(exit).includes(secret),
      };
    }
    case 'pr-operation-proxy': {
      const result: AidePullRequestListResult = {
        repository,
        pullRequests: [],
      };
      const registry = prRegistry({
        providerId: 'fixture-pr',
        priority: 10,
        features: {},
        authStatus: () => Effect.succeed({ state: 'configured' }),
        matchRemote: () => ({ source: 'git-remote', repository }),
        matchPullRequestUrl: () => null,
        operations: {
          listPullRequests: () => instructionProxy(Effect.succeed(result)),
        },
      });
      const exit = await Effect.runPromiseExit(
        createAideHostServices(registry).listPullRequestsForRepository(
          repository
        )
      );
      return {
        kind: failureTag(exit),
        safe: !JSON.stringify(exit).includes(secret),
      };
    }
    case 'forged-instruction': {
      const registry = primeRegistry(
        () => forgedInstructionEffect(),
        'sections'
      );
      const sections =
        createAideHostServices(registry).primeContributions()[0]!.capability
          .sections!;
      const exit = await Effect.runPromiseExit(sections());
      return {
        kind: failureTag(exit),
        safe: !JSON.stringify(exit).includes(secret),
      };
    }
    case 'prime-message-prototype':
      return runPrimeMessagePrototypeProbe();
    case 'prime-strict-array-prototype':
      return runPrimeSectionPrototypeProbe(false);
    case 'prime-tolerant-array-prototype':
      return runPrimeSectionPrototypeProbe(true);
    case 'prime-strict-data-descriptors':
      return runPrimeDataDescriptorProbe(false);
    case 'prime-tolerant-data-descriptors':
      return runPrimeDataDescriptorProbe(true);
  }
}

try {
  const result = await runMode();
  await Promise.resolve();
  await Bun.sleep(0);
  console.log(
    JSON.stringify({
      ok: true,
      mode,
      instructionReads,
      uncaughtExceptions,
      unhandledRejections,
      ...result,
    })
  );
} catch {
  await Promise.resolve();
  await Bun.sleep(0);
  console.log(
    JSON.stringify({
      ok: false,
      mode,
      instructionReads,
      uncaughtExceptions,
      unhandledRejections,
      kind: 'escaped-runtime-rejection',
    })
  );
}
