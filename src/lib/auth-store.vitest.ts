import { describe, expect, test } from 'vitest';
import { Effect, Layer } from 'effect';

import {
  AuthIndexConsistencyError,
  AuthIndexDocumentError,
  AuthStoreValidationError,
  authIndexSecretName,
  listIndexedAuthScopesEffect,
  resolveAuthSecretEffect,
  writeAuthSecretEffect,
} from './auth-store.js';
import {
  KeyringService,
  KeyringUnavailableError,
  type KeyringSecretName,
} from './auth-keyring.js';

function memoryLayer(
  store: Map<string, string>,
  failOperation?: 'get' | 'set' | 'delete'
): Layer.Layer<KeyringService> {
  return Layer.succeed(KeyringService, {
    get: (name: KeyringSecretName) =>
      failOperation === 'get'
        ? Effect.fail(new KeyringUnavailableError('get'))
        : Effect.succeed(store.get(name) ?? null),
    set: (name: KeyringSecretName, value: string) =>
      failOperation === 'set'
        ? Effect.fail(new KeyringUnavailableError('set'))
        : Effect.sync(() => {
            store.set(name, value);
          }),
    delete: (name: KeyringSecretName) =>
      failOperation === 'delete'
        ? Effect.fail(new KeyringUnavailableError('delete'))
        : Effect.sync(() => store.delete(name)),
  } satisfies import('./auth-keyring.js').KeyringServiceShape);
}

describe('auth-store Effect foundation', () => {
  test('composes the core with isolated in-memory layers concurrently', async () => {
    const firstStore = new Map<string, string>();
    const secondStore = new Map<string, string>();

    const [first, second] = await Promise.all([
      Effect.runPromise(
        writeAuthSecretEffect('github', 'FIRST').pipe(
          Effect.provide(memoryLayer(firstStore))
        )
      ),
      Effect.runPromise(
        writeAuthSecretEffect('github', 'SECOND').pipe(
          Effect.provide(memoryLayer(secondStore))
        )
      ),
    ]);

    expect(first).toMatchObject({ name: 'github', kind: 'legacy' });
    expect(second).toMatchObject({ name: 'github', kind: 'legacy' });
    expect(firstStore).toEqual(new Map([['github', 'FIRST']]));
    expect(secondStore).toEqual(new Map([['github', 'SECOND']]));
  });

  test('keeps keyring and validation failures in tagged Effect channels', async () => {
    const keyringFailure = await Effect.runPromise(
      resolveAuthSecretEffect('github').pipe(
        Effect.provide(memoryLayer(new Map(), 'get')),
        Effect.flip
      )
    );
    const validationFailure = await Effect.runPromise(
      writeAuthSecretEffect('github', 'TOKEN', { host: 'not a host' }).pipe(
        Effect.provide(memoryLayer(new Map())),
        Effect.flip
      )
    );

    expect(keyringFailure).toBeInstanceOf(KeyringUnavailableError);
    expect(keyringFailure).toMatchObject({
      _tag: 'KeyringUnavailableError',
      operation: 'get',
      classification: 'unavailable',
    });
    expect(validationFailure).toBeInstanceOf(AuthStoreValidationError);
    expect(validationFailure).toMatchObject({
      _tag: 'AuthStoreValidationError',
      code: 'invalid-target',
      providerId: 'github',
    });
  });

  test('emits tagged document and consistency diagnostics without causes', async () => {
    const store = new Map<string, string>([
      [authIndexSecretName('effect-fixture'), '{malformed'],
    ]);
    const documentFailure = await Effect.runPromise(
      listIndexedAuthScopesEffect('effect-fixture').pipe(
        Effect.provide(memoryLayer(store)),
        Effect.flip
      )
    );
    const consistencyFailure = new AuthIndexConsistencyError({
      operation: 'write',
      phase: 'index-update',
      providerId: 'github',
      rollback: 'succeeded',
      residualState: 'none',
      cause: new Error('must be discarded'),
    });

    expect(documentFailure).toBeInstanceOf(AuthIndexDocumentError);
    expect(documentFailure).toMatchObject({
      _tag: 'AuthIndexDocumentError',
      code: 'malformed-json',
      providerId: 'effect-fixture',
    });
    expect(consistencyFailure).toMatchObject({
      _tag: 'AuthIndexConsistencyError',
      failure: 'keyring-unavailable',
    });
    expect(Object.hasOwn(consistencyFailure, 'cause')).toBe(false);
  });
});
