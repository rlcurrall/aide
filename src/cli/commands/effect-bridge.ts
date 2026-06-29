import { Cause, Effect, Exit, Option } from 'effect';

export async function runLegacyCommandEffect<A>(
  effect: Effect.Effect<A, unknown, never>
): Promise<A> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;

  const failure = Cause.failureOption(exit.cause);
  if (Option.isSome(failure)) throw failure.value;

  throw Cause.squash(exit.cause);
}
