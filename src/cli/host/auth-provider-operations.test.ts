import { describe, expect, test } from 'bun:test';
import { Effect } from 'effect';

import type {
  AideAuthLoginRequest,
  AideAuthLogoutRequest,
  AideAuthAccountDiscoveryRequest,
  AideAuthProviderCapability,
  AideAuthProviderOperations,
  AideAuthStatusRequest,
  AideDiscoveredCapability,
} from './plugin-descriptor.js';
import {
  AuthProviderOperationError,
  AuthProviderOperationTimeoutError,
  InvalidAuthProviderOperationResultError,
  UnsupportedAuthProviderOperationError,
  getAuthProviderStatus,
  listAuthProviderAccounts,
  loginWithAuthProvider,
  logoutWithAuthProvider,
} from './auth-provider-operations.js';

function authProvider(
  operations?: AideAuthProviderOperations,
  overrides: Partial<AideAuthProviderCapability> = {}
): AideDiscoveredCapability<AideAuthProviderCapability> {
  return Object.freeze({
    pluginId: 'test-plugin',
    capability: Object.freeze({
      providerId: 'test-auth',
      label: 'Test Auth',
      status: () => Effect.succeed({ state: 'configured' as const }),
      operations,
      ...overrides,
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

  test('snapshots scoped login and logout requests immutably', async () => {
    const scope = {
      id: 'test-auth:github.com/openai',
      providerId: 'test-auth',
      host: 'github.com',
      org: 'openai',
      account: 'work',
      label: 'OpenAI work',
      sourceKind: 'keyring' as const,
      metadata: { priority: 1, default: true },
    };
    let observedLoginRequest: AideAuthLoginRequest | undefined;
    let observedLogoutRequest: AideAuthLogoutRequest | undefined;

    const provider = authProvider({
      login: (request) =>
        Effect.sync(() => {
          observedLoginRequest = request;
          return { status: 'stored' as const };
        }),
      logout: (request) =>
        Effect.sync(() => {
          observedLogoutRequest = request;
          return { status: 'removed' as const };
        }),
    });

    await Effect.runPromise(
      loginWithAuthProvider(provider, {
        scope,
        values: { token: 'token' },
      })
    );
    await Effect.runPromise(logoutWithAuthProvider(provider, { scope }));

    expect(observedLoginRequest?.scope).toEqual(scope);
    expect(observedLogoutRequest?.scope).toEqual(scope);
    expect(observedLoginRequest?.scope).not.toBe(scope);
    expect(observedLogoutRequest?.scope).not.toBe(scope);
    expect(Object.isFrozen(observedLoginRequest)).toBe(true);
    expect(Object.isFrozen(observedLoginRequest?.scope)).toBe(true);
    expect(Object.isFrozen(observedLoginRequest?.scope?.metadata)).toBe(true);
    expect(Object.isFrozen(observedLoginRequest?.values)).toBe(true);
    expect(Object.isFrozen(observedLogoutRequest)).toBe(true);
    expect(Object.isFrozen(observedLogoutRequest?.scope)).toBe(true);
    expect(Object.isFrozen(observedLogoutRequest?.scope?.metadata)).toBe(true);

    (scope.metadata as Record<string, string | number | boolean>).priority = 2;
    expect(observedLoginRequest?.scope?.metadata?.priority).toBe(1);
    expect(observedLogoutRequest?.scope?.metadata?.priority).toBe(1);
  });

  test('invokes no-scope logout without a request argument', async () => {
    const argumentCounts: number[] = [];
    const provider = authProvider({
      logout: function () {
        argumentCounts.push(arguments.length);
        return Effect.succeed({ status: 'removed' as const });
      },
    });

    await Effect.runPromise(logoutWithAuthProvider(provider));
    await Effect.runPromise(logoutWithAuthProvider(provider, {}));

    expect(argumentCounts).toEqual([0, 0]);
  });

  test('invokes options-only logout without a request argument', async () => {
    let argumentCount: number | undefined;

    await Effect.runPromise(
      logoutWithAuthProvider(
        authProvider({
          logout: function () {
            argumentCount = arguments.length;
            return Effect.succeed({ status: 'removed' as const });
          },
        }),
        { operationTimeout: '1 second' }
      )
    );

    expect(argumentCount).toBe(0);
  });

  test('invokes no-scope status without a request argument', async () => {
    const argumentCounts: number[] = [];
    const provider = authProvider(undefined, {
      status: function () {
        argumentCounts.push(arguments.length);
        return Effect.succeed({ state: 'configured' as const });
      },
    });

    await Effect.runPromise(getAuthProviderStatus(provider));
    await Effect.runPromise(getAuthProviderStatus(provider, {}));

    expect(argumentCounts).toEqual([0, 0]);
  });

  test('invokes scoped logout with one frozen request argument', async () => {
    const scope = {
      id: 'test-auth:github.com/openai',
      providerId: 'test-auth',
      host: 'github.com',
      org: 'openai',
      account: 'work',
      metadata: { priority: 1 },
    };
    let argumentCount: number | undefined;
    let observedRequest: AideAuthLogoutRequest | undefined;

    await Effect.runPromise(
      logoutWithAuthProvider(
        authProvider({
          logout: function (request) {
            argumentCount = arguments.length;
            observedRequest = request;
            return Effect.succeed({ status: 'removed' as const });
          },
        }),
        { scope }
      )
    );

    expect(argumentCount).toBe(1);
    expect(observedRequest?.scope).toEqual(scope);
    expect(observedRequest?.scope).not.toBe(scope);
    expect(Object.isFrozen(observedRequest)).toBe(true);
    expect(Object.isFrozen(observedRequest?.scope)).toBe(true);
    expect(Object.isFrozen(observedRequest?.scope?.metadata)).toBe(true);

    scope.metadata.priority = 2;
    expect(observedRequest?.scope?.metadata?.priority).toBe(1);
  });

  test('invokes scoped status with one frozen request argument', async () => {
    const scope = {
      id: 'test-auth:example.com/acme',
      providerId: 'test-auth',
      host: 'example.com',
      org: 'acme',
      metadata: { rank: 1, default: true },
    };
    let argumentCount: number | undefined;
    let observedRequest: AideAuthStatusRequest | undefined;

    await Effect.runPromise(
      getAuthProviderStatus(
        authProvider(undefined, {
          status: function (request) {
            argumentCount = arguments.length;
            observedRequest = request;
            return Effect.succeed({ state: 'configured' as const });
          },
        }),
        { scope }
      )
    );

    expect(argumentCount).toBe(1);
    expect(observedRequest?.scope).toEqual(scope);
    expect(observedRequest?.scope).not.toBe(scope);
    expect(Object.isFrozen(observedRequest)).toBe(true);
    expect(Object.isFrozen(observedRequest?.scope)).toBe(true);
    expect(Object.isFrozen(observedRequest?.scope?.metadata)).toBe(true);

    scope.metadata.rank = 2;
    expect(observedRequest?.scope?.metadata?.rank).toBe(1);
  });

  test('validates and snapshots auth status results and requests', async () => {
    const scope = {
      id: 'test-auth:example.com/acme',
      providerId: 'test-auth',
      host: 'example.com',
      org: 'acme',
      metadata: { rank: 1 },
    };
    let observedRequest: AideAuthStatusRequest | undefined;

    const result = await Effect.runPromise(
      getAuthProviderStatus(
        authProvider(undefined, {
          status: (request) =>
            Effect.sync(() => {
              observedRequest = request;
              return { state: 'configured' as const, detail: 'ready' };
            }),
        }),
        { scope }
      )
    );

    expect(result).toEqual({ state: 'configured', detail: 'ready' });
    expect(Object.isFrozen(result)).toBe(true);
    expect(observedRequest?.scope).toEqual(scope);
    expect(observedRequest?.scope).not.toBe(scope);
    expect(Object.isFrozen(observedRequest)).toBe(true);
    expect(Object.isFrozen(observedRequest?.scope)).toBe(true);
    expect(Object.isFrozen(observedRequest?.scope?.metadata)).toBe(true);
  });

  test('rejects status operations that do not return Effects', async () => {
    const error = await Effect.runPromise(
      getAuthProviderStatus(
        authProvider(undefined, {
          status: (() => ({ state: 'configured' })) as never,
        })
      ).pipe(Effect.flip)
    );

    expect(error).toBeInstanceOf(InvalidAuthProviderOperationResultError);
    if (!(error instanceof InvalidAuthProviderOperationResultError)) {
      throw new Error('Expected invalid auth provider operation result error');
    }
    expect(error.reason).toBe('operation must return an Effect');
  });

  test('rejects malformed auth status results', async () => {
    const error = await Effect.runPromise(
      getAuthProviderStatus(
        authProvider(undefined, {
          status: () => Effect.succeed({ state: 'almost-ready' } as never),
        })
      ).pipe(Effect.flip)
    );

    expect(error).toBeInstanceOf(InvalidAuthProviderOperationResultError);
    if (!(error instanceof InvalidAuthProviderOperationResultError)) {
      throw new Error('Expected invalid auth provider operation result error');
    }
    expect(error.reason).toBe(
      "state must be 'configured', 'not-configured', 'misconfigured', or 'unavailable'"
    );
  });

  test('validates and snapshots discovered accounts', async () => {
    const sourceAccount = {
      id: 'primary',
      label: 'Primary account',
      detail: 'Ready',
      sourceKind: 'keyring' as const,
      metadata: { rank: 1, default: true },
      scope: {
        id: 'example.com/acme',
        host: 'example.com',
        org: 'acme',
        account: 'primary',
        metadata: { seats: 5 },
      },
    };

    const result = await Effect.runPromise(
      listAuthProviderAccounts(
        authProvider(undefined, {
          accounts: () => Effect.succeed([sourceAccount]),
        })
      )
    );

    expect(result).toEqual([
      {
        id: 'primary',
        providerId: 'test-auth',
        label: 'Primary account',
        detail: 'Ready',
        sourceKind: 'keyring',
        metadata: { rank: 1, default: true },
        scope: {
          id: 'example.com/acme',
          providerId: 'test-auth',
          host: 'example.com',
          org: 'acme',
          account: 'primary',
          metadata: { seats: 5 },
        },
      },
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result[0])).toBe(true);
    expect(Object.isFrozen(result[0]?.metadata)).toBe(true);
    expect(Object.isFrozen(result[0]?.scope)).toBe(true);
    expect(Object.isFrozen(result[0]?.scope?.metadata)).toBe(true);

    sourceAccount.label = 'Mutated';
    sourceAccount.metadata.rank = 2;
    sourceAccount.scope.metadata.seats = 10;
    expect(result[0]?.label).toBe('Primary account');
    expect(result[0]?.metadata?.rank).toBe(1);
    expect(result[0]?.scope?.metadata?.seats).toBe(5);
  });

  test('rejects malformed discovered accounts with typed errors', async () => {
    const error = await Effect.runPromise(
      listAuthProviderAccounts(
        authProvider(undefined, {
          accounts: () =>
            Effect.succeed([
              {
                id: 'primary',
                label: 'Primary account',
                sourceKind: 'cloud',
              },
            ] as never),
        })
      ).pipe(Effect.flip)
    );

    expect(error).toBeInstanceOf(InvalidAuthProviderOperationResultError);
    if (!(error instanceof InvalidAuthProviderOperationResultError)) {
      throw new Error('Expected invalid auth provider operation result error');
    }
    expect(error.reason).toBe(
      'accounts[0].sourceKind must be one of: env, keyring, external, unknown'
    );
  });

  test('invokes no-scope accounts without a request argument', async () => {
    const argumentCounts: number[] = [];
    const provider = authProvider(undefined, {
      accounts: function () {
        argumentCounts.push(arguments.length);
        return Effect.succeed([]);
      },
    });

    await Effect.runPromise(listAuthProviderAccounts(provider));
    await Effect.runPromise(listAuthProviderAccounts(provider, {}));

    expect(argumentCounts).toEqual([0, 0]);
  });

  test('invokes scoped accounts with one frozen request argument', async () => {
    const scope = {
      id: 'test-auth:example.com/acme',
      providerId: 'test-auth',
      host: 'example.com',
      org: 'acme',
      metadata: { rank: 1, default: true },
    };
    let argumentCount: number | undefined;
    let observedRequest: AideAuthAccountDiscoveryRequest | undefined;

    await Effect.runPromise(
      listAuthProviderAccounts(
        authProvider(undefined, {
          accounts: function (request) {
            argumentCount = arguments.length;
            observedRequest = request;
            return Effect.succeed([]);
          },
        }),
        { scope }
      )
    );

    expect(argumentCount).toBe(1);
    expect(observedRequest?.scope).toEqual(scope);
    expect(observedRequest?.scope).not.toBe(scope);
    expect(Object.isFrozen(observedRequest)).toBe(true);
    expect(Object.isFrozen(observedRequest?.scope)).toBe(true);
    expect(Object.isFrozen(observedRequest?.scope?.metadata)).toBe(true);

    scope.metadata.rank = 2;
    expect(observedRequest?.scope?.metadata?.rank).toBe(1);
  });

  test('wraps synchronous account discovery throws', async () => {
    const error = await Effect.runPromise(
      listAuthProviderAccounts(
        authProvider(undefined, {
          accounts: (() => {
            throw new Error('sync account boom');
          }) as NonNullable<AideAuthProviderCapability['accounts']>,
        })
      ).pipe(Effect.flip)
    );

    expect(error).toBeInstanceOf(AuthProviderOperationError);
    expect(error.message).toContain('sync account boom');
  });

  test('applies timeouts to account discovery operations', async () => {
    const error = await Effect.runPromise(
      listAuthProviderAccounts(
        authProvider(undefined, {
          accounts: () => Effect.never,
        }),
        {},
        { operationTimeout: '1 millis' }
      ).pipe(Effect.flip)
    );

    expect(error).toBeInstanceOf(AuthProviderOperationTimeoutError);
    expect(error.message).toContain('timed out during accounts');
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

  test('keeps logout timeout options compatible as the second argument', async () => {
    const error = await Effect.runPromise(
      logoutWithAuthProvider(
        authProvider({
          logout: () => Effect.never,
        }),
        { operationTimeout: '1 millis' }
      ).pipe(Effect.flip)
    );

    expect(error).toBeInstanceOf(AuthProviderOperationTimeoutError);
    expect(error.message).toContain('timed out during logout');
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
