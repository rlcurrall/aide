import { types as nodeUtilTypes } from 'node:util';

import { Data, Effect } from 'effect';
import type { ArgumentsCamelCase } from 'yargs';

import type {
  AnyPublicAideCommandDescriptor,
  CommandResult,
  PublicAideCommandDescriptor,
} from './command-descriptor.js';
import {
  invokePublicCapabilityEffect,
  runPublicCapabilityEffect,
} from './public-capability-invocation.js';
import {
  AideHostServicesTag,
  type AideHostServices,
} from './runtime-context.js';

export type PublicCommandHostFailureReason =
  | 'callback-threw'
  | 'invalid-effect'
  | 'composition-failed'
  | 'execution-invalid'
  | 'invalid-result';

export class PublicCommandHostError extends Data.TaggedError(
  'PublicCommandHostError'
)<{
  readonly reason: PublicCommandHostFailureReason;
}> {
  override get message(): string {
    switch (this.reason) {
      case 'callback-threw':
        return 'External command callback threw';
      case 'invalid-effect':
        return 'External command callback must return an Effect';
      case 'composition-failed':
        return 'External command Effect composition failed';
      case 'execution-invalid':
        return 'External command Effect execution was invalid';
      case 'invalid-result':
        return 'External command returned an invalid CommandResult';
    }
  }
}

const isNodeProxy = nodeUtilTypes.isProxy;
const hasOwn = Object.hasOwn;
const MAX_COMMAND_RESULT_TEXT_LENGTH = 65_536;

type SnapshotResult =
  | { readonly ok: true; readonly value: CommandResult }
  | { readonly ok: false };

function ownDataValue(
  value: object,
  key: PropertyKey
):
  | { readonly found: true; readonly value: unknown }
  | { readonly found: false } {
  const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && hasOwn(descriptor, 'value')
    ? { found: true, value: descriptor.value }
    : { found: false };
}

/**
 * Deterministically copy the bounded public result contract without invoking
 * plugin accessors, inheritance, iteration hooks, inspection, or coercion.
 * This is same-process validation, not a JavaScript sandbox.
 */
export function snapshotPublicCommandResult(value: unknown): SnapshotResult {
  if (typeof value !== 'object' || value === null || isNodeProxy(value)) {
    return { ok: false };
  }

  try {
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return { ok: false };
    }

    const tag = ownDataValue(value, '_tag');
    if (!tag.found) return { ok: false };
    if (tag.value === 'Empty') {
      return { ok: true, value: Object.freeze({ _tag: 'Empty' as const }) };
    }
    if (tag.value !== 'Text') return { ok: false };

    const text = ownDataValue(value, 'text');
    if (
      !text.found ||
      typeof text.value !== 'string' ||
      text.value.length > MAX_COMMAND_RESULT_TEXT_LENGTH
    ) {
      return { ok: false };
    }
    return {
      ok: true,
      value: Object.freeze({ _tag: 'Text' as const, text: text.value }),
    };
  } catch {
    return { ok: false };
  }
}

function commandHostError(
  reason: PublicCommandHostFailureReason
): PublicCommandHostError {
  return new PublicCommandHostError({ reason });
}

export function invokePublicCommandEffect<E>(
  descriptor: PublicAideCommandDescriptor<object, E, AideHostServicesTag>,
  argv: object,
  services: AideHostServices
): Effect.Effect<CommandResult, E | PublicCommandHostError, never> {
  return invokePublicCapabilityEffect<
    CommandResult,
    E,
    CommandResult,
    E | PublicCommandHostError,
    PublicCommandHostError,
    AideHostServicesTag
  >(
    () => descriptor.run(argv as ArgumentsCamelCase<object>),
    {
      onCallbackThrow: () => commandHostError('callback-threw'),
      onInvalidReturn: () => commandHostError('invalid-effect'),
      onCompositionFailure: () => commandHostError('composition-failed'),
      onLaunchFailure: () => commandHostError('execution-invalid'),
    },
    (effect) =>
      Effect.flatMap(
        Effect.provideService(effect, AideHostServicesTag, services),
        (result) => {
          const snapshot = snapshotPublicCommandResult(result);
          return snapshot.ok
            ? Effect.succeed(snapshot.value)
            : Effect.fail(commandHostError('invalid-result'));
        }
      )
  );
}

export function runPublicCommand(
  descriptor: AnyPublicAideCommandDescriptor,
  argv: object,
  services: AideHostServices
): Promise<CommandResult> {
  return runPublicCapabilityEffect(
    invokePublicCommandEffect(descriptor, argv, services)
  );
}
