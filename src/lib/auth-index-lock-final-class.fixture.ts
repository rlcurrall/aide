import { inspect } from 'node:util';

import { Cause, Effect, Match } from 'effect';

import { renderTopLevelError } from '../cli/index.js';
import { AuthIndexLockError } from './auth-index-lock.js';
import { reachableOwnDataText } from './error-redaction.test-helper.js';

const secret = 'AUTH_LOCK_PROTOTYPE_MUTATION_SECRET_7f31';
const error = new AuthIndexLockError({
  reason: 'acquire-failed',
  code: 'unavailable',
  phase: 'acquire',
  providerId: 'github',
  protectedOperationOutcome: 'not-started',
});
const constructor = AuthIndexLockError as typeof AuthIndexLockError &
  Record<PropertyKey, unknown>;
const prototype = AuthIndexLockError.prototype as AuthIndexLockError &
  Record<PropertyKey, unknown>;
const plainArgsSymbol = Object.getOwnPropertySymbols(error).find((symbol) =>
  String(symbol).includes('effect/Data/Error/plainArgs')
);
const plainArgs =
  plainArgsSymbol === undefined
    ? undefined
    : Object.getOwnPropertyDescriptor(error, plainArgsSymbol)?.value;
const stackDescriptor = Object.getOwnPropertyDescriptor(error, 'stack');
const baseline = {
  json: JSON.stringify(error),
  inspect: inspect(error, { depth: 20, getters: false, showHidden: true }),
  causeInspect: inspect(Cause.fail(error), {
    depth: 20,
    getters: false,
    showHidden: true,
  }),
  cli: renderTopLevelError(error),
  string: String(error),
  name: error.name,
  message: error.message,
};
const pinnedSurfaces = [
  'name',
  'message',
  'toJSON',
  'toString',
  inspect.custom,
].every((key) => {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
  return descriptor !== undefined && descriptor.configurable === false;
});

const mutations = [
  Reflect.defineProperty(prototype, 'name', { get: () => secret }),
  Reflect.defineProperty(prototype, 'message', { get: () => secret }),
  Reflect.defineProperty(prototype, 'toJSON', {
    value: () => ({ secret }),
  }),
  Reflect.defineProperty(prototype, 'toString', { value: () => secret }),
  Reflect.defineProperty(prototype, inspect.custom, { value: () => secret }),
  Reflect.defineProperty(prototype, secret, { value: secret }),
  Reflect.defineProperty(constructor, Symbol.hasInstance, {
    value: () => false,
  }),
  Reflect.defineProperty(constructor, 'name', { value: secret }),
  Reflect.defineProperty(constructor, 'prototype', {
    value: { [secret]: secret },
  }),
  Reflect.defineProperty(constructor, secret, { value: secret }),
  Reflect.setPrototypeOf(prototype, { [secret]: secret }),
  Reflect.setPrototypeOf(constructor, function hostileConstructor() {
    return secret;
  }),
];

const observed = {
  json: JSON.stringify(error),
  inspect: inspect(error, { depth: 20, getters: false, showHidden: true }),
  causeInspect: inspect(Cause.fail(error), {
    depth: 20,
    getters: false,
    showHidden: true,
  }),
  cli: renderTopLevelError(error),
  string: String(error),
  name: error.name,
  message: error.message,
};
const caughtReason = await Effect.runPromise(
  Effect.fail(error).pipe(
    Effect.catchTag('AuthIndexLockError', (failure) =>
      Effect.succeed(failure.reason)
    )
  )
);
const matchReason = Match.type<AuthIndexLockError>().pipe(
  Match.tag('AuthIndexLockError', (failure) => failure.reason),
  Match.exhaustive
);
const reachableText = [
  ...Object.values(observed),
  reachableOwnDataText(error),
  inspect(Object.getOwnPropertyDescriptors(prototype), {
    getters: false,
    showHidden: true,
  }),
  inspect(Object.getOwnPropertyDescriptors(constructor), {
    getters: false,
    showHidden: true,
  }),
  Reflect.ownKeys(prototype).map(String).join('\n'),
  Reflect.ownKeys(constructor).map(String).join('\n'),
].join('\n');
const report = {
  constructorFrozen: Object.isFrozen(constructor),
  prototypeFrozen: Object.isFrozen(prototype),
  pinnedSurfaces,
  mutationsRejected: mutations.every((changed) => !changed),
  surfacesStable: Object.keys(baseline).every(
    (key) =>
      observed[key as keyof typeof observed] ===
      baseline[key as keyof typeof baseline]
  ),
  secretAbsent: !reachableText.includes(secret),
  errorInstance: error instanceof AuthIndexLockError,
  nativeInstance: error instanceof Error,
  literalTag: error._tag === 'AuthIndexLockError',
  caughtReason: caughtReason === 'acquire-failed',
  matchedReason: matchReason(error) === 'acquire-failed',
  errorFrozen: Object.isFrozen(error),
  fieldsFrozen: [
    '_tag',
    'reason',
    'code',
    'phase',
    'providerId',
    'protectedOperationOutcome',
  ].every((field) => {
    const descriptor = Object.getOwnPropertyDescriptor(error, field);
    return descriptor?.configurable === false && descriptor.writable === false;
  }),
  plainArgsFrozen: Object.isFrozen(plainArgs),
  stackFrozen:
    stackDescriptor?.configurable === false &&
    stackDescriptor.writable === false,
};

if (!Object.values(report).every(Boolean)) {
  throw new Error(JSON.stringify(report));
}
