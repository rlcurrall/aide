import { describe, expect, test } from 'bun:test';
import { cp, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  Cause,
  Context,
  Data,
  Deferred,
  Effect,
  Effectable,
  Either,
  Exit,
  Fiber,
  FiberId,
  FiberRef,
  ModuleVersion,
  Option,
} from 'effect';

import {
  invokePublicCapabilityEffect,
  type PublicCapabilityEffectLauncher,
} from './public-capability-invocation.js';

class AmbientBoundaryService extends Context.Tag(
  'aide.test.AmbientBoundaryService'
)<AmbientBoundaryService, { readonly marker: string }>() {}

type BoundaryFailureReason = 'callback' | 'invalid' | 'composition' | 'launch';

interface BoundaryFailure {
  readonly _tag: 'BoundaryFailure';
  readonly reason: BoundaryFailureReason;
}

function boundaryFailure(reason: BoundaryFailureReason): BoundaryFailure {
  return Object.freeze({ _tag: 'BoundaryFailure', reason });
}

function currentFiberRefValue<A>(
  fiberRef: FiberRef.FiberRef<A>
): A | undefined {
  const current = (
    globalThis as typeof globalThis & {
      readonly ['effect/FiberCurrent']?: {
        readonly getFiberRef: (ref: FiberRef.FiberRef<A>) => A;
      };
    }
  )['effect/FiberCurrent'];
  return current?.getFiberRef(fiberRef);
}

function invokeBoundary<A, E>(
  callback: () => unknown,
  launcher?: PublicCapabilityEffectLauncher
): Effect.Effect<A, E | BoundaryFailure, never> {
  return invokePublicCapabilityEffect<A, E, A, E, BoundaryFailure>(
    callback,
    {
      onCallbackThrow: () => boundaryFailure('callback'),
      onInvalidReturn: () => boundaryFailure('invalid'),
      onCompositionFailure: () => boundaryFailure('composition'),
      onLaunchFailure: () => boundaryFailure('launch'),
    },
    (effect) => effect,
    launcher === undefined ? undefined : { launcher }
  );
}

class BoundaryEffectable extends Effectable.Class<string> {
  commit(): Effect.Effect<string> {
    return Effect.succeed('effectable');
  }
}

class BoundaryTaggedError extends Data.TaggedError('BoundaryTaggedError')<{
  readonly detail: string;
}> {}

function effectMarkerPrototypeDepth(value: object): number | null {
  let current: object | null = value;
  let depth = 0;
  while (current !== null) {
    if (
      Reflect.getOwnPropertyDescriptor(current, Effect.EffectTypeId) !==
      undefined
    ) {
      return depth;
    }
    current = Reflect.getPrototypeOf(current);
    depth += 1;
  }
  return null;
}

function effectableAtMarkerDepth<A>(
  markerDepth: number,
  value: A
): Effect.Effect<A> {
  class Base extends Effectable.Class<A> {
    commit(): Effect.Effect<A> {
      return Effect.succeed(value);
    }
  }

  let Current = Base;
  let effect = new Current();
  while ((effectMarkerPrototypeDepth(effect) ?? markerDepth) < markerDepth) {
    Current = class extends Current {};
    effect = new Current();
  }
  expect(effectMarkerPrototypeDepth(effect)).toBe(markerDepth);
  return effect;
}

function incompatibleMarker(version = '0.0.0'): object {
  return Object.freeze({ _V: version });
}

describe('public capability nested Runtime bridge', () => {
  test('admits official inherited-marker Effect representations', async () => {
    expect(
      await Effect.runPromise(
        invokeBoundary<string, never>(() => Either.right('either-right'))
      )
    ).toBe('either-right');
    expect(
      await Effect.runPromise(
        invokeBoundary<string, never>(() => Option.some('option-some'))
      )
    ).toBe('option-some');
    expect(
      await Effect.runPromise(
        invokeBoundary<string, never>(() => new BoundaryEffectable())
      )
    ).toBe('effectable');

    const eitherFailure = Object.freeze({ kind: 'either-left' as const });
    const eitherExit = await Effect.runPromiseExit(
      invokeBoundary<never, typeof eitherFailure>(() =>
        Either.left(eitherFailure)
      )
    );
    expect(eitherExit).toEqual(Exit.fail(eitherFailure));

    const noneExit = await Effect.runPromiseExit(
      invokeBoundary<never, unknown>(() => Option.none())
    );
    expect(Exit.isFailure(noneExit)).toBe(true);
    if (Exit.isSuccess(noneExit))
      throw new Error('expected Option.none failure');
    const noneFailure = Cause.failureOption(noneExit.cause);
    expect(Option.isSome(noneFailure)).toBe(true);
    if (Option.isSome(noneFailure)) {
      expect(noneFailure.value).not.toEqual(boundaryFailure('launch'));
      expect(noneFailure.value).not.toEqual(boundaryFailure('invalid'));
    }

    const tagged = new BoundaryTaggedError({ detail: 'tagged-error' });
    const taggedExit = await Effect.runPromiseExit(
      invokeBoundary<never, BoundaryTaggedError>(() => tagged)
    );
    expect(taggedExit).toEqual(Exit.fail(tagged));
  });

  test('admits Effectable.Class values at and substantially beyond 64 prototype links', async () => {
    for (const markerDepth of [63, 64, 128] as const) {
      const value = `effectable-depth-${markerDepth}`;
      const effect = effectableAtMarkerDepth(markerDepth, value);

      expect(Effect.isEffect(effect), `depth ${markerDepth}`).toBe(true);
      await expect(
        Effect.runPromise(effect),
        `direct depth ${markerDepth}`
      ).resolves.toBe(value);
      await expect(
        Effect.runPromise(invokeBoundary<string, never>(() => effect)),
        `boundary depth ${markerDepth}`
      ).resolves.toBe(value);
    }
  });

  test('admits Effects loaded from a separately copied same-version package', async () => {
    const effectEntry = fileURLToPath(import.meta.resolve('effect'));
    const effectPackage = dirname(dirname(dirname(effectEntry)));
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), 'aide-effect-admission-')
    );
    const copiedPackage = join(temporaryRoot, 'effect');

    try {
      await symlink(
        dirname(effectPackage),
        join(temporaryRoot, 'node_modules'),
        process.platform === 'win32' ? 'junction' : 'dir'
      );
      await cp(effectPackage, copiedPackage, { recursive: true });
      const copied = (await import(
        pathToFileURL(join(copiedPackage, 'dist/esm/index.js')).href
      )) as typeof import('effect');
      expect(copied.ModuleVersion.getCurrentVersion()).toBe(
        ModuleVersion.getCurrentVersion()
      );
      expect(
        await Effect.runPromise(
          invokeBoundary<string, never>(() =>
            copied.Effect.succeed('copied-succeed')
          )
        )
      ).toBe('copied-succeed');
      expect(
        await Effect.runPromise(
          invokeBoundary<string, never>(() =>
            copied.Effect.suspend(() => copied.Effect.succeed('copied-suspend'))
          )
        )
      ).toBe('copied-suspend');
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test('rejects malformed or incompatible public markers without invoking marker or instruction hooks', async () => {
    const cases: readonly {
      readonly name: string;
      readonly value: object;
      readonly expected: BoundaryFailureReason;
      readonly reads: () => number;
    }[] = [
      (() => {
        let reads = 0;
        const value = Object.create(null) as Record<PropertyKey, unknown>;
        Object.defineProperty(value, Effect.EffectTypeId, {
          get() {
            reads += 1;
            throw new Error('SECRET-MARKER-ACCESSOR');
          },
        });
        Object.defineProperty(value, '_op', {
          get() {
            reads += 1;
            throw new Error('SECRET-MARKER-ACCESSOR-OP');
          },
        });
        return {
          name: 'accessor marker',
          value,
          expected: 'launch' as const,
          reads: () => reads,
        };
      })(),
      (() => {
        let reads = 0;
        const marker = new Proxy(incompatibleMarker(), {
          getOwnPropertyDescriptor() {
            reads += 1;
            throw new Error('SECRET-PROXY-MARKER');
          },
        });
        const value = Object.create(null) as Record<PropertyKey, unknown>;
        Object.defineProperty(value, Effect.EffectTypeId, { value: marker });
        Object.defineProperty(value, '_op', {
          get() {
            reads += 1;
            throw new Error('SECRET-PROXY-MARKER-OP');
          },
        });
        return {
          name: 'Proxy marker',
          value,
          expected: 'launch' as const,
          reads: () => reads,
        };
      })(),
      (() => {
        let reads = 0;
        const marker = Object.create(null) as Record<PropertyKey, unknown>;
        Object.defineProperty(marker, '_V', {
          get() {
            reads += 1;
            throw new Error('SECRET-VERSION-ACCESSOR');
          },
        });
        const value = Object.create(null) as Record<PropertyKey, unknown>;
        Object.defineProperty(value, Effect.EffectTypeId, { value: marker });
        Object.defineProperty(value, '_op', {
          get() {
            reads += 1;
            throw new Error('SECRET-VERSION-ACCESSOR-OP');
          },
        });
        return {
          name: 'accessor version marker',
          value,
          expected: 'launch' as const,
          reads: () => reads,
        };
      })(),
      (() => {
        let reads = 0;
        const prototype = new Proxy(Object.create(null), {
          has() {
            reads += 1;
            throw new Error('SECRET-PROXY-PROTOTYPE');
          },
          getOwnPropertyDescriptor() {
            reads += 1;
            throw new Error('SECRET-PROXY-PROTOTYPE-DESCRIPTOR');
          },
          getPrototypeOf() {
            reads += 1;
            throw new Error('SECRET-PROXY-PROTOTYPE-PARENT');
          },
        });
        return {
          name: 'Proxy prototype',
          value: Object.create(prototype),
          expected: 'invalid' as const,
          reads: () => reads,
        };
      })(),
      (() => {
        let reads = 0;
        const value = Object.create(null) as Record<PropertyKey, unknown>;
        Object.defineProperty(value, Effect.EffectTypeId, { value: null });
        Object.defineProperty(value, '_op', {
          get() {
            reads += 1;
            throw new Error('SECRET-MALFORMED-MARKER-OP');
          },
        });
        return {
          name: 'malformed marker',
          value,
          expected: 'launch' as const,
          reads: () => reads,
        };
      })(),
      (() => {
        let reads = 0;
        const value = Object.create(null) as Record<PropertyKey, unknown>;
        Object.defineProperty(value, Effect.EffectTypeId, {
          value: incompatibleMarker(),
        });
        Object.defineProperty(value, '_op', {
          get() {
            reads += 1;
            throw new Error('SECRET-MISMATCHED-MARKER-OP');
          },
        });
        return {
          name: 'forged incompatible marker',
          value,
          expected: 'launch' as const,
          reads: () => reads,
        };
      })(),
    ];

    for (const testCase of cases) {
      const exit = await Effect.runPromiseExit(
        invokeBoundary(() => testCase.value)
      );
      expect(exit, testCase.name).toEqual(
        Exit.fail(boundaryFailure(testCase.expected))
      );
      expect(testCase.reads(), testCase.name).toBe(0);
      expect(JSON.stringify(exit), testCase.name).not.toContain('SECRET-');
    }
  });

  test('runs synchronous callback construction, composition, and composed execution with initial FiberRefs', async () => {
    const fiberRef = FiberRef.unsafeMake('initial');
    const observations: string[] = [];
    const effect = invokePublicCapabilityEffect<
      string,
      never,
      string,
      never,
      BoundaryFailure
    >(
      () => {
        observations.push(`callback:${currentFiberRefValue(fiberRef)}`);
        return Effect.sync(() => {
          observations.push(`returned:${currentFiberRefValue(fiberRef)}`);
          return 'value';
        });
      },
      {
        onCallbackThrow: () => boundaryFailure('callback'),
        onInvalidReturn: () => boundaryFailure('invalid'),
        onCompositionFailure: () => boundaryFailure('composition'),
        onLaunchFailure: () => boundaryFailure('launch'),
      },
      (returned) => {
        observations.push(`compose:${currentFiberRefValue(fiberRef)}`);
        return Effect.flatMap(returned, (value) =>
          Effect.sync(() => {
            observations.push(`composed:${currentFiberRefValue(fiberRef)}`);
            return value;
          })
        );
      }
    );

    const program = Effect.gen(function* () {
      yield* FiberRef.set(fiberRef, 'ambient');
      expect(yield* effect).toBe('value');
      expect(yield* FiberRef.get(fiberRef)).toBe('ambient');
    });

    await Effect.runPromise(program);
    expect(observations).toEqual([
      'callback:initial',
      'compose:initial',
      'returned:initial',
      'composed:initial',
    ]);
  });

  test('replaces callback throws without retaining or rendering the attacker value', async () => {
    const attacker = Object.freeze({
      secret: 'SECRET-CALLBACK-THROW',
      nested: new Error('SECRET-CALLBACK-ERROR'),
    });

    const exit = await Effect.runPromiseExit(
      invokeBoundary(() => {
        throw attacker;
      })
    );

    expect(exit).toEqual(Exit.fail(boundaryFailure('callback')));
    expect(JSON.stringify(exit)).not.toContain(attacker.secret);
    if (Exit.isFailure(exit)) {
      for (const failure of Cause.failures(exit.cause)) {
        expect(failure).not.toBe(attacker);
      }
    }
  });

  test('replaces hostile composition throws and rejects composed Effect Proxies without traps', async () => {
    const attacker = new Error('SECRET-COMPOSITION-THROW');
    const thrownExit = await Effect.runPromiseExit(
      invokePublicCapabilityEffect<
        string,
        never,
        string,
        never,
        BoundaryFailure
      >(
        () => Effect.succeed('value'),
        {
          onCallbackThrow: () => boundaryFailure('callback'),
          onInvalidReturn: () => boundaryFailure('invalid'),
          onCompositionFailure: () => boundaryFailure('composition'),
          onLaunchFailure: () => boundaryFailure('launch'),
        },
        () => {
          throw attacker;
        }
      )
    );
    expect(thrownExit).toEqual(Exit.fail(boundaryFailure('composition')));
    expect(JSON.stringify(thrownExit)).not.toContain(attacker.message);

    let reads = 0;
    const composedProxy = new Proxy(Effect.succeed('unsafe'), {
      get() {
        reads += 1;
        throw new Error('SECRET-COMPOSED-PROXY');
      },
    });
    const proxyExit = await Effect.runPromiseExit(
      invokePublicCapabilityEffect<
        string,
        never,
        string,
        never,
        BoundaryFailure
      >(
        () => Effect.succeed('value'),
        {
          onCallbackThrow: () => boundaryFailure('callback'),
          onInvalidReturn: () => boundaryFailure('invalid'),
          onCompositionFailure: () => boundaryFailure('composition'),
          onLaunchFailure: () => boundaryFailure('launch'),
        },
        () => composedProxy
      )
    );
    expect(proxyExit).toEqual(Exit.fail(boundaryFailure('composition')));
    expect(reads).toBe(0);
  });

  test('rejects top-level Effect Proxies before recognition without invoking traps', async () => {
    let reads = 0;
    const proxy = new Proxy(Effect.succeed('unsafe'), {
      get() {
        reads += 1;
        throw new Error('SECRET-PROXY-INSTRUCTION');
      },
      has() {
        reads += 1;
        throw new Error('SECRET-PROXY-HAS');
      },
    });

    const exit = await Effect.runPromiseExit(invokeBoundary(() => proxy));

    expect(exit).toEqual(Exit.fail(boundaryFailure('invalid')));
    expect(reads).toBe(0);
  });

  test('normalizes synchronous and microtask launch rejection without process events or attacker retention', async () => {
    const attacker = Object.freeze({
      secret: 'SECRET-LAUNCH-REJECTION',
      nested: new Error('SECRET-LAUNCH-ERROR'),
    });
    let uncaught = 0;
    let unhandled = 0;
    const onUncaught = () => {
      uncaught += 1;
    };
    const onUnhandled = () => {
      unhandled += 1;
    };
    process.on('uncaughtException', onUncaught);
    process.on('unhandledRejection', onUnhandled);

    try {
      const launchers: readonly PublicCapabilityEffectLauncher[] = [
        () => {
          throw attacker;
        },
        () => Promise.resolve().then(() => Promise.reject(attacker)),
      ];
      const failures: BoundaryFailure[] = [];
      for (const launcher of launchers) {
        const exit = await Effect.runPromiseExit(
          invokeBoundary(() => Effect.succeed('ignored'), launcher)
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isSuccess(exit)) throw new Error('expected launch failure');
        expect(Array.from(Cause.defects(exit.cause))).toEqual([]);
        const failure = Cause.failureOption(exit.cause);
        expect(Option.isSome(failure)).toBe(true);
        if (Option.isSome(failure)) {
          failures.push(failure.value as BoundaryFailure);
        }
      }
      await Promise.resolve();
      await Bun.sleep(0);

      expect(failures).toEqual([
        boundaryFailure('launch'),
        boundaryFailure('launch'),
      ]);
      expect(failures[0]).not.toBe(failures[1]);
      expect(JSON.stringify(failures)).not.toContain(attacker.secret);
      expect(uncaught).toBe(0);
      expect(unhandled).toBe(0);
    } finally {
      process.off('uncaughtException', onUncaught);
      process.off('unhandledRejection', onUnhandled);
    }
  });

  test('rejects malformed and Proxy launch settlements without attacker retention', async () => {
    let reads = 0;
    const proxy = new Proxy(
      {},
      {
        get() {
          reads += 1;
          throw new Error('SECRET-LAUNCH-EXIT-PROXY');
        },
        has() {
          reads += 1;
          throw new Error('SECRET-LAUNCH-EXIT-HAS');
        },
      }
    );
    const launchers = [
      () => Promise.resolve({}),
      () => Promise.resolve(proxy),
    ] as unknown as readonly PublicCapabilityEffectLauncher[];

    for (const launcher of launchers) {
      const exit = await Effect.runPromiseExit(
        invokeBoundary(() => Effect.succeed('ignored'), launcher)
      );
      expect(exit).toEqual(Exit.fail(boundaryFailure('launch')));
      expect(JSON.stringify(exit)).not.toContain('SECRET-LAUNCH-EXIT');
    }
    // Native Promise resolution performs the one unavoidable thenable probe;
    // the boundary itself performs no additional Proxy reads.
    expect(reads).toBe(1);
  });

  test('round-trips success and generic Fail/Die/Interrupt Causes', async () => {
    const typedFailure = Object.freeze({ secret: 'typed-identity' });
    const defect = new Error('defect-identity');
    const interrupt = Cause.interrupt(FiberId.none);
    const causes = [
      Cause.fail(typedFailure),
      Cause.die(defect),
      interrupt,
      Cause.parallel(Cause.fail(typedFailure), interrupt),
      Cause.sequential(Cause.die(defect), interrupt),
      Cause.parallel(
        Cause.fail(typedFailure),
        Cause.sequential(Cause.die(defect), interrupt)
      ),
    ] as const;

    expect(
      await Effect.runPromise(
        invokeBoundary<string, never>(() => Effect.succeed('ok'))
      )
    ).toBe('ok');
    for (const cause of causes) {
      const exit = await Effect.runPromiseExit(
        invokeBoundary(() => Effect.failCause(cause))
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isSuccess(exit)) throw new Error('expected cause failure');
      expect(exit.cause).toEqual(cause);
      for (const failure of Cause.failures(exit.cause)) {
        expect(failure).toBe(typedFailure);
      }
      for (const actualDefect of Cause.defects(exit.cause)) {
        expect(actualDefect).toBe(defect);
      }
    }
  });

  test('starts with empty Context and FiberRefs, finalizes before cancellation joins, and restores the caller', async () => {
    const observations: string[] = [];
    const fiberRef = FiberRef.unsafeMake('initial');
    const program = Effect.gen(function* () {
      const acquired = yield* Deferred.make<void>();
      const released = yield* Deferred.make<void>();
      yield* FiberRef.set(fiberRef, 'ambient');

      const observe = (phase: string) =>
        Effect.gen(function* () {
          const service = yield* Effect.serviceOption(AmbientBoundaryService);
          const refValue = yield* FiberRef.get(fiberRef);
          observations.push(
            `${phase}:${Option.isSome(service) ? service.value.marker : 'empty'}:${refValue}`
          );
        });
      const nested = Effect.acquireUseRelease(
        observe('acquire').pipe(
          Effect.tap(() => Deferred.succeed(acquired, undefined))
        ),
        () => observe('use').pipe(Effect.zipRight(Effect.never)),
        () =>
          observe('release').pipe(
            Effect.zipRight(Deferred.succeed(released, undefined))
          )
      );
      const fiber = yield* Effect.fork(invokeBoundary(() => nested));
      yield* Deferred.await(acquired);
      const interruption = yield* Fiber.interrupt(fiber);
      expect(Exit.isFailure(interruption)).toBe(true);
      expect(yield* Deferred.isDone(released)).toBe(true);
      expect(yield* FiberRef.get(fiberRef)).toBe('ambient');
      expect(
        Option.isSome(yield* Effect.serviceOption(AmbientBoundaryService))
      ).toBe(true);
    }).pipe(
      Effect.provideService(AmbientBoundaryService, { marker: 'caller' })
    );

    await Effect.runPromise(program);

    expect(observations).toEqual([
      'acquire:empty:initial',
      'use:empty:initial',
      'release:empty:initial',
    ]);
  });

  test('preserves timeout interruption and runs a well-formed finalizer exactly once', async () => {
    let releases = 0;
    const effect = invokeBoundary(() =>
      Effect.acquireUseRelease(
        Effect.void,
        () => Effect.never,
        () => Effect.sync(() => void (releases += 1))
      )
    ).pipe(
      Effect.timeoutFail({
        duration: '20 millis',
        onTimeout: () => 'host-timeout' as const,
      })
    );

    const exit = await Effect.runPromiseExit(effect);

    expect(exit).toEqual(Exit.fail('host-timeout'));
    expect(releases).toBe(1);
  }, 2_000);
});
