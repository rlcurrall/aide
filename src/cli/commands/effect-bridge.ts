import { Cause, Effect, Exit, Option, type Layer } from 'effect';
import { KeyringLive, type KeyringService } from '@lib/auth-keyring.js';

/** Trusted CLI boundary for internal auth-provider operations. */
export async function runAuthProviderCommandEffect<A>(
  effect: Effect.Effect<A, unknown, KeyringService>,
  keyringLayer: Layer.Layer<KeyringService>
): Promise<A> {
  return runServiceFreeAuthProviderCommandEffect(
    effect.pipe(Effect.provide(keyringLayer))
  );
}

/** Host command boundary after provenance-specific service composition. */
export async function runServiceFreeAuthProviderCommandEffect<A>(
  effect: Effect.Effect<A, unknown, never>
): Promise<A> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;

  const failure = Cause.failureOption(exit.cause);
  if (Option.isSome(failure)) throw failure.value;

  throw Cause.squash(exit.cause);
}

/** @deprecated Standalone Promise/live compatibility adapter. */
export async function runLiveAuthProviderCommandEffect<A>(
  effect: Effect.Effect<A, unknown, KeyringService>
): Promise<A> {
  return runAuthProviderCommandEffect(effect, KeyringLive);
}
