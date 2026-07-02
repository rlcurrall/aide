import { Data, Effect, type Duration } from 'effect';

import type {
  AideAuthLoginRequest,
  AideAuthLoginResult,
  AideAuthLogoutResult,
  AideAuthProviderCapability,
  AideDiscoveredCapability,
} from './plugin-descriptor.js';

export class UnsupportedAuthProviderOperationError extends Data.TaggedError(
  'UnsupportedAuthProviderOperationError'
)<{
  readonly pluginId: string;
  readonly providerId: string;
  readonly operation: string;
}> {
  override get message(): string {
    return `Auth provider '${this.providerId}' from plugin '${this.pluginId}' does not implement ${this.operation}`;
  }
}

export class InvalidAuthProviderOperationResultError extends Data.TaggedError(
  'InvalidAuthProviderOperationResultError'
)<{
  readonly pluginId: string;
  readonly providerId: string;
  readonly operation: string;
  readonly reason: string;
}> {
  override get message(): string {
    return `Auth provider '${this.providerId}' from plugin '${this.pluginId}' returned invalid ${this.operation} result: ${this.reason}`;
  }
}

export class AuthProviderOperationError extends Data.TaggedError(
  'AuthProviderOperationError'
)<{
  readonly pluginId: string;
  readonly providerId: string;
  readonly operation: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    const detail = this.cause instanceof Error ? `: ${this.cause.message}` : '';
    return `Auth provider '${this.providerId}' from plugin '${this.pluginId}' failed during ${this.operation}${detail}`;
  }
}

export class AuthProviderOperationTimeoutError extends Data.TaggedError(
  'AuthProviderOperationTimeoutError'
)<{
  readonly pluginId: string;
  readonly providerId: string;
  readonly operation: string;
}> {
  override get message(): string {
    return `Auth provider '${this.providerId}' from plugin '${this.pluginId}' timed out during ${this.operation}`;
  }
}

export type AuthProviderOperationInvocationError =
  | UnsupportedAuthProviderOperationError
  | InvalidAuthProviderOperationResultError
  | AuthProviderOperationError
  | AuthProviderOperationTimeoutError;

export interface AuthProviderOperationOptions {
  readonly operationTimeout?: Duration.DurationInput;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

function snapshotLoginRequest(
  request: AideAuthLoginRequest
): AideAuthLoginRequest {
  return Object.freeze({
    fromEnv: request.fromEnv,
    values:
      request.values === undefined
        ? undefined
        : Object.freeze({ ...request.values }),
    prompt: request.prompt,
  });
}

function invalidResult(
  provider: AideDiscoveredCapability<AideAuthProviderCapability>,
  operation: string,
  reason: string
): InvalidAuthProviderOperationResultError {
  return new InvalidAuthProviderOperationResultError({
    pluginId: provider.pluginId,
    providerId: provider.capability.providerId,
    operation,
    reason,
  });
}

function snapshotMessages(
  provider: AideDiscoveredCapability<AideAuthProviderCapability>,
  operation: string,
  messages: unknown
): Effect.Effect<
  readonly string[] | undefined,
  InvalidAuthProviderOperationResultError
> {
  if (messages === undefined) return Effect.succeed(undefined);
  if (!Array.isArray(messages)) {
    return Effect.fail(
      invalidResult(provider, operation, 'messages must be an array')
    );
  }

  for (const message of messages) {
    if (typeof message !== 'string' || message.length === 0) {
      return Effect.fail(
        invalidResult(provider, operation, 'messages must contain strings')
      );
    }
  }

  return Effect.succeed(Object.freeze([...messages]));
}

function validateLoginResult(
  provider: AideDiscoveredCapability<AideAuthProviderCapability>,
  result: unknown
): Effect.Effect<AideAuthLoginResult, InvalidAuthProviderOperationResultError> {
  const operation = 'login';
  if (!isRecord(result)) {
    return Effect.fail(
      invalidResult(provider, operation, 'result must be an object')
    );
  }

  const status = result.status;
  if (status !== 'stored' && status !== 'external' && status !== 'unchanged') {
    return Effect.fail(
      invalidResult(
        provider,
        operation,
        "status must be 'stored', 'external', or 'unchanged'"
      )
    );
  }

  return snapshotMessages(provider, operation, result.messages).pipe(
    Effect.map((messages) =>
      Object.freeze({
        status,
        ...(messages === undefined ? {} : { messages }),
      })
    )
  );
}

function validateLogoutResult(
  provider: AideDiscoveredCapability<AideAuthProviderCapability>,
  result: unknown
): Effect.Effect<
  AideAuthLogoutResult,
  InvalidAuthProviderOperationResultError
> {
  const operation = 'logout';
  if (!isRecord(result)) {
    return Effect.fail(
      invalidResult(provider, operation, 'result must be an object')
    );
  }

  const status = result.status;
  if (status !== 'removed' && status !== 'not-found') {
    return Effect.fail(
      invalidResult(
        provider,
        operation,
        "status must be 'removed' or 'not-found'"
      )
    );
  }

  return snapshotMessages(provider, operation, result.messages).pipe(
    Effect.map((messages) =>
      Object.freeze({
        status,
        ...(messages === undefined ? {} : { messages }),
      })
    )
  );
}

function invokeAuthProviderOperation<A>(
  provider: AideDiscoveredCapability<AideAuthProviderCapability>,
  operationName: string,
  operation: (() => Effect.Effect<A, unknown, never>) | undefined,
  options: AuthProviderOperationOptions = {}
): Effect.Effect<A, AuthProviderOperationInvocationError> {
  if (operation === undefined) {
    return Effect.fail(
      new UnsupportedAuthProviderOperationError({
        pluginId: provider.pluginId,
        providerId: provider.capability.providerId,
        operation: operationName,
      })
    );
  }

  const invoked = Effect.suspend(
    (): Effect.Effect<
      A,
      InvalidAuthProviderOperationResultError | AuthProviderOperationError,
      never
    > => {
      let operationResult: unknown;
      try {
        operationResult = operation();
      } catch (cause) {
        return Effect.fail(
          new AuthProviderOperationError({
            pluginId: provider.pluginId,
            providerId: provider.capability.providerId,
            operation: operationName,
            cause,
          })
        );
      }

      if (!Effect.isEffect(operationResult)) {
        return Effect.fail(
          invalidResult(
            provider,
            operationName,
            'operation must return an Effect'
          )
        );
      }

      return (operationResult as Effect.Effect<A, unknown, never>).pipe(
        Effect.mapError(
          (cause) =>
            new AuthProviderOperationError({
              pluginId: provider.pluginId,
              providerId: provider.capability.providerId,
              operation: operationName,
              cause,
            })
        )
      );
    }
  );

  if (options.operationTimeout === undefined) return invoked;

  return invoked.pipe(
    Effect.timeoutFail({
      duration: options.operationTimeout,
      onTimeout: () =>
        new AuthProviderOperationTimeoutError({
          pluginId: provider.pluginId,
          providerId: provider.capability.providerId,
          operation: operationName,
        }),
    })
  );
}

export function loginWithAuthProvider(
  provider: AideDiscoveredCapability<AideAuthProviderCapability>,
  request: AideAuthLoginRequest,
  options: AuthProviderOperationOptions = {}
): Effect.Effect<AideAuthLoginResult, AuthProviderOperationInvocationError> {
  const operationRequest = snapshotLoginRequest(request);
  const login = provider.capability.operations?.login;
  return invokeAuthProviderOperation(
    provider,
    'login',
    login === undefined ? undefined : () => login(operationRequest),
    options
  ).pipe(Effect.flatMap((result) => validateLoginResult(provider, result)));
}

export function logoutWithAuthProvider(
  provider: AideDiscoveredCapability<AideAuthProviderCapability>,
  options: AuthProviderOperationOptions = {}
): Effect.Effect<AideAuthLogoutResult, AuthProviderOperationInvocationError> {
  const logout = provider.capability.operations?.logout;
  return invokeAuthProviderOperation(
    provider,
    'logout',
    logout === undefined ? undefined : () => logout(),
    options
  ).pipe(Effect.flatMap((result) => validateLogoutResult(provider, result)));
}
