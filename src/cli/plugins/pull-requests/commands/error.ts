import { Cause, Effect } from 'effect';

import { pullRequestProviderErrorMessage } from '@cli/host/pull-request-provider-resolver.js';
import {
  boundedSafeCliDiagnostic,
  MAX_SAFE_CLI_DIAGNOSTIC_LENGTH,
  totalSafeErrorMessage,
} from '@cli/safe-error-rendering.js';

const MAX_PULL_REQUEST_COMMAND_DIAGNOSTIC_LENGTH =
  MAX_SAFE_CLI_DIAGNOSTIC_LENGTH;
const pullRequestCommandDiagnostics = new WeakMap<object, string>();

function boundedPullRequestCommandDiagnostic(message: string): string {
  return (
    boundedSafeCliDiagnostic(message) ??
    'Pull request provider execution failed'
  );
}

function capturePullRequestCommandDiagnostic<T extends object>(
  error: T,
  message: string
): T {
  pullRequestCommandDiagnostics.set(
    error,
    boundedPullRequestCommandDiagnostic(message)
  );
  return error;
}

function pullRequestCommandDiagnostic(cause: Cause.Cause<unknown>): string {
  for (const failure of Cause.failures(cause)) {
    const message = pullRequestProviderErrorMessage(failure);
    if (message !== undefined) return message;
  }
  return 'Pull request provider execution failed';
}

class PullRequestCommandEffectError extends Error {
  constructor(cause: Cause.Cause<unknown>) {
    const message = pullRequestCommandDiagnostic(cause);
    super(message);
    this.name = 'PullRequestCommandEffectError';
    capturePullRequestCommandDiagnostic(this, message);
  }
}

/** Create an internal command-validation failure with immutable display text. */
export function pullRequestCommandError(message: string): Error {
  return capturePullRequestCommandDiagnostic(new Error(message), message);
}

/** Internal lookup-only reader for PR command and outer-boundary diagnostics. */
export function pullRequestCommandErrorMessage(
  error: unknown
): string | undefined {
  const message = pullRequestCommandDiagnostics.get(error as object);
  return typeof message === 'string' &&
    message.length > 0 &&
    message.length <= MAX_PULL_REQUEST_COMMAND_DIAGNOSTIC_LENGTH
    ? message
    : undefined;
}

/** One total policy shared by the global renderer and the PR exit handler. */
export function safeCliErrorMessage(error: unknown): string {
  return (
    pullRequestCommandErrorMessage(error) ??
    pullRequestProviderErrorMessage(error) ??
    totalSafeErrorMessage(error)
  );
}

export async function runPullRequestCommandEffect<A, E>(
  effect: Effect.Effect<A, E, never>
): Promise<A> {
  const outcome = await Effect.runPromise(
    Effect.matchCause(effect, {
      onFailure: (cause) => ({ kind: 'failure' as const, cause }),
      onSuccess: (value) => ({ kind: 'success' as const, value }),
    })
  );
  if (outcome.kind === 'success') return outcome.value;
  throw new PullRequestCommandEffectError(outcome.cause);
}

export function handlePullRequestCommandError(error: unknown): never {
  console.error(`Error: ${safeCliErrorMessage(error)}`);
  process.exit(1);
}
