import { describe, expect, test } from 'bun:test';
import { Effect } from 'effect';

import type {
  AideAuthProviderCapability,
  AideAuthProviderOperations,
  AideDiscoveredCapability,
} from './plugin-descriptor.js';
import {
  AuthProviderOperationError,
  AuthProviderOperationTimeoutError,
  InvalidAuthProviderOperationResultError,
  UnsupportedAuthProviderOperationError,
  loginWithAuthProvider,
  logoutWithAuthProvider,
} from './auth-provider-operations.js';

function authProvider(
  operations?: AideAuthProviderOperations
): AideDiscoveredCapability<AideAuthProviderCapability> {
  return Object.freeze({
    pluginId: 'test-plugin',
    capability: Object.freeze({
      providerId: 'test-auth',
      label: 'Test Auth',
      status: () => Effect.succeed({ state: 'configured' as const }),
      operations,
    }),
  });
}

describe('auth provider operation invocation', () => {
  test('snapshots login requests and validates successful results', async () => {
    let receivedValuesFrozen = false;

    const result = await Effect.runPromise(
      loginWithAuthProvider(
        authProvider({
          login: (request) =>
            Effect.sync(() => {
              receivedValuesFrozen = Object.isFrozen(request.values);
              return {
                status: 'stored' as const,
                messages: ['logged in'],
              };
            }),
        }),
        {
          values: { token: 'token' },
        }
      )
    );

    expect(receivedValuesFrozen).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.messages)).toBe(true);
    expect(result).toEqual({ status: 'stored', messages: ['logged in'] });
  });

  test('rejects missing login operations', async () => {
    const error = await Effect.runPromise(
      loginWithAuthProvider(authProvider({}), {}).pipe(Effect.flip)
    );

    expect(error).toBeInstanceOf(UnsupportedAuthProviderOperationError);
    expect(error.message).toContain('does not implement login');
  });

  test('rejects login operations that do not return Effects', async () => {
    const error = await Effect.runPromise(
      loginWithAuthProvider(
        authProvider({
          login: (() => ({ status: 'stored' })) as never,
        }),
        {}
      ).pipe(Effect.flip)
    );

    expect(error).toBeInstanceOf(InvalidAuthProviderOperationResultError);
    if (!(error instanceof InvalidAuthProviderOperationResultError)) {
      throw new Error('Expected invalid auth provider operation result error');
    }
    expect(error.reason).toBe('operation must return an Effect');
  });

  test('wraps synchronous provider operation throws', async () => {
    const error = await Effect.runPromise(
      loginWithAuthProvider(
        authProvider({
          login: (() => {
            throw new Error('sync boom');
          }) as unknown as NonNullable<AideAuthProviderOperations['login']>,
        }),
        {}
      ).pipe(Effect.flip)
    );

    expect(error).toBeInstanceOf(AuthProviderOperationError);
    expect(error.message).toContain('sync boom');
  });

  test('rejects malformed login statuses', async () => {
    const error = await Effect.runPromise(
      loginWithAuthProvider(
        authProvider({
          login: () => Effect.succeed({ status: 'ok' } as never),
        }),
        {}
      ).pipe(Effect.flip)
    );

    expect(error).toBeInstanceOf(InvalidAuthProviderOperationResultError);
    if (!(error instanceof InvalidAuthProviderOperationResultError)) {
      throw new Error('Expected invalid auth provider operation result error');
    }
    expect(error.reason).toBe(
      "status must be 'stored', 'external', or 'unchanged'"
    );
  });

  test('rejects malformed result messages', async () => {
    const error = await Effect.runPromise(
      logoutWithAuthProvider(
        authProvider({
          logout: () =>
            Effect.succeed({
              status: 'removed',
              messages: [42],
            } as never),
        })
      ).pipe(Effect.flip)
    );

    expect(error).toBeInstanceOf(InvalidAuthProviderOperationResultError);
    if (!(error instanceof InvalidAuthProviderOperationResultError)) {
      throw new Error('Expected invalid auth provider operation result error');
    }
    expect(error.reason).toBe('messages must contain strings');
  });

  test('applies operation timeouts only when requested', async () => {
    const error = await Effect.runPromise(
      loginWithAuthProvider(
        authProvider({
          login: () => Effect.never,
        }),
        {},
        { operationTimeout: '1 millis' }
      ).pipe(Effect.flip)
    );

    expect(error).toBeInstanceOf(AuthProviderOperationTimeoutError);
    expect(error.message).toContain('timed out during login');
  });
});
