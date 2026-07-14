import { types as nodeUtilTypes } from 'node:util';

import {
  Context,
  Effect,
  Exit,
  FiberRefs,
  ModuleVersion,
  Runtime,
} from 'effect';

const isNodeProxy = nodeUtilTypes.isProxy;
const hasOwn = Object.hasOwn;
const publicCapabilityEffectVersion = ModuleVersion.getCurrentVersion();

type EffectAdmission = 'compatible' | 'incompatible' | 'absent';

/**
 * Effect.isEffect is the public recognizer, but it performs property lookup.
 * First locate its public marker without invoking accessors or Proxy prototype
 * traps, then use the public predicate once that lookup is known to be safe.
 */
function effectAdmission(value: unknown): EffectAdmission {
  if (
    (typeof value !== 'object' && typeof value !== 'function') ||
    value === null ||
    isNodeProxy(value)
  ) {
    return 'absent';
  }

  let current: object | null = value;
  try {
    while (current !== null) {
      if (isNodeProxy(current)) return 'absent';
      const markerDescriptor = Reflect.getOwnPropertyDescriptor(
        current,
        Effect.EffectTypeId
      );
      if (markerDescriptor !== undefined) {
        if (!hasOwn(markerDescriptor, 'value')) return 'incompatible';
        const marker = markerDescriptor.value;
        if (
          typeof marker !== 'object' ||
          marker === null ||
          isNodeProxy(marker)
        ) {
          return 'incompatible';
        }
        const versionDescriptor = Reflect.getOwnPropertyDescriptor(
          marker,
          '_V'
        );
        if (
          versionDescriptor === undefined ||
          !hasOwn(versionDescriptor, 'value') ||
          versionDescriptor.value !== publicCapabilityEffectVersion
        ) {
          return 'incompatible';
        }
        return Effect.isEffect(value) ? 'compatible' : 'incompatible';
      }
      current = Reflect.getPrototypeOf(current);
    }
  } catch {
    return 'incompatible';
  }
  return 'absent';
}

const publicCapabilityRuntime: Runtime.Runtime<never> = Runtime.make({
  context: Context.empty(),
  runtimeFlags: Runtime.defaultRuntime.runtimeFlags,
  fiberRefs: FiberRefs.empty(),
});

export interface PublicCapabilityBoundaryErrors<EHost> {
  readonly onCallbackThrow: () => EHost;
  readonly onInvalidReturn: () => EHost;
  readonly onCompositionFailure: () => EHost;
  readonly onLaunchFailure: () => EHost;
}

export type PublicCapabilityEffectLauncher = (
  effect: Effect.Effect<unknown, unknown, never>,
  signal: AbortSignal
) => Promise<Exit.Exit<unknown, unknown>>;

interface PublicCapabilityInvocationOptions {
  /** Test seam for synchronous and asynchronous Runtime launch rejection. */
  readonly launcher?: PublicCapabilityEffectLauncher;
}

const defaultPublicCapabilityLauncher: PublicCapabilityEffectLauncher = (
  effect,
  signal
) => Runtime.runPromiseExit(publicCapabilityRuntime, effect, { signal });

/**
 * Replace, rather than merge, the input context for a public capability.
 * Synchronous public contracts use this directly. Effect-returning callbacks
 * must use invokePublicCapabilityEffect so execution also starts with empty
 * FiberRefs in the dedicated nested Runtime.
 */
export function isolatePublicCapabilityEffect<A, E>(
  effect: Effect.Effect<A, E, never>
): Effect.Effect<A, E, never> {
  return Effect.mapInputContext(effect, () => Context.empty());
}

/**
 * Launch a host-owned public-boundary program in the same module-private
 * empty-Context/empty-FiberRefs Runtime used by the nested invocation bridge.
 * This is the Promise handoff for adapters whose framework contract is a
 * Promise; public callback code must still enter through
 * invokePublicCapabilityEffect.
 */
export function runPublicCapabilityEffect<A, E>(
  effect: Effect.Effect<A, E, never>
): Promise<A> {
  return Runtime.runPromise(publicCapabilityRuntime, effect);
}

function bridgeInvocationProgram<A, E, ELaunch>(
  effect: Effect.Effect<A, E, never>,
  onLaunchFailure: () => ELaunch,
  launcher: PublicCapabilityEffectLauncher
): Effect.Effect<Exit.Exit<A, E>, ELaunch, never> {
  return Effect.async<Exit.Exit<A, E>, ELaunch>((resume, signal) => {
    let resumed = false;
    const resumeOnce = (result: Effect.Effect<Exit.Exit<A, E>, ELaunch>) => {
      if (resumed) return;
      resumed = true;
      resume(result);
    };
    const launched = Promise.resolve().then(() =>
      launcher(effect as Effect.Effect<unknown, unknown, never>, signal)
    ) as Promise<Exit.Exit<A, E>>;

    launched.then(
      (exit) => resumeOnce(Effect.succeed(exit)),
      () => resumeOnce(Effect.fail(onLaunchFailure()))
    );

    // Outer interruption aborts the nested Runtime through signal. Awaiting
    // settlement makes interruption join ordinary nested finalizers.
    return Effect.promise(() =>
      launched.then(
        () => undefined,
        () => undefined
      )
    );
  });
}

/**
 * The single host boundary for public callbacks returning Effects.
 *
 * One host-created invocation program performs callback construction,
 * structural recognition, host composition, composed-Effect recognition and
 * execution, and caller-specific result validation. That complete program runs
 * in the single nested Runtime with Context.empty() and FiberRefs.empty(). The
 * outer fiber only launches it, awaits its Exit, validates that launch result,
 * and rehydrates the Exit.
 */
export function invokePublicCapabilityEffect<
  A,
  E,
  B,
  EComposed,
  EHost,
  R = never,
>(
  callback: () => unknown,
  errors: PublicCapabilityBoundaryErrors<EHost>,
  compose: (
    effect: Effect.Effect<A, E, R>
  ) => Effect.Effect<B, EComposed, never>,
  options: PublicCapabilityInvocationOptions = {}
): Effect.Effect<B, EComposed | EHost, never> {
  const invocationProgram = Effect.suspend(
    (): Effect.Effect<B, EComposed | EHost, never> => {
      let returned: unknown;
      try {
        returned = callback();
      } catch {
        return Effect.fail(errors.onCallbackThrow());
      }

      const admission = effectAdmission(returned);
      if (admission === 'absent') return Effect.fail(errors.onInvalidReturn());
      if (admission === 'incompatible') {
        return Effect.fail(errors.onLaunchFailure());
      }

      let composed: unknown;
      try {
        composed = compose(returned as Effect.Effect<A, E, R>);
      } catch {
        return Effect.fail(errors.onCompositionFailure());
      }

      return effectAdmission(composed) === 'compatible'
        ? (composed as Effect.Effect<B, EComposed | EHost, never>)
        : Effect.fail(errors.onCompositionFailure());
    }
  );

  const bridged = bridgeInvocationProgram(
    invocationProgram,
    errors.onLaunchFailure,
    options.launcher ?? defaultPublicCapabilityLauncher
  );

  return Effect.flatMap(
    bridged,
    (exit): Effect.Effect<B, EComposed | EHost, never> => {
      let validExit = false;
      try {
        validExit = !isNodeProxy(exit) && Exit.isExit(exit);
      } catch {
        return Effect.fail(errors.onLaunchFailure());
      }
      if (!validExit) return Effect.fail(errors.onLaunchFailure());
      return Exit.isSuccess(exit)
        ? Effect.succeed(exit.value)
        : Effect.failCause(exit.cause);
    }
  );
}
