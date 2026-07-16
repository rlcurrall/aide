import { Effect, Layer } from 'effect';

import {
  KeyringService,
  KeyringUnavailableError,
  type KeyringSecretName,
} from './auth-keyring.js';

export type TestKeyringOperation = 'get' | 'set' | 'delete';

export interface TestKeyringCall {
  readonly operation: TestKeyringOperation;
  readonly name: string;
  readonly value?: string;
}

export interface TestKeyringOptions {
  readonly delay?: boolean;
  readonly rejection?: unknown;
  readonly fail?: (
    call: TestKeyringCall,
    occurrence: number
  ) => boolean | 'before' | 'after';
}

export interface TestKeyring {
  readonly store: Map<string, string>;
  readonly layer: Layer.Layer<KeyringService>;
  readonly replace: (options?: TestKeyringOptions) => TestKeyringCall[];
}

export function makeTestKeyring(
  store: Map<string, string> = new Map()
): TestKeyring {
  let options: TestKeyringOptions = {};
  let calls: TestKeyringCall[] = [];
  let occurrences = new Map<string, number>();

  function run<A>(
    call: TestKeyringCall,
    apply: () => A
  ): Effect.Effect<A, KeyringUnavailableError> {
    return Effect.gen(function* () {
      calls.push(call);
      const key = `${call.operation}:${call.name}`;
      const occurrence = (occurrences.get(key) ?? 0) + 1;
      occurrences.set(key, occurrence);
      if (options.delay) yield* Effect.sleep('1 millis');

      const failure = options.fail?.(call, occurrence);
      if (failure === true || failure === 'before') {
        return yield* Effect.fail(new KeyringUnavailableError(call.operation));
      }
      const result = apply();
      if (failure === 'after') {
        return yield* Effect.fail(new KeyringUnavailableError(call.operation));
      }
      return result;
    });
  }

  const service = {
    get: (name: KeyringSecretName) =>
      run({ operation: 'get', name }, () => store.get(`aide:${name}`) ?? null),
    set: (name: KeyringSecretName, value: string) =>
      run({ operation: 'set', name, value }, () => {
        store.set(`aide:${name}`, value);
      }),
    delete: (name: KeyringSecretName) =>
      run({ operation: 'delete', name }, () => store.delete(`aide:${name}`)),
  } satisfies import('./auth-keyring.js').KeyringServiceShape;

  return {
    store,
    layer: Layer.succeed(KeyringService, service),
    replace: (nextOptions = {}) => {
      options = nextOptions;
      calls = [];
      occurrences = new Map();
      return calls;
    },
  };
}
