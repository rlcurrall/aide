import { Data, Effect, type Duration } from 'effect';

import type {
  AideAuthAccount,
  AideAuthAccountDiscoveryRequest,
  AideAuthLoginRequest,
  AideAuthLoginResult,
  AideAuthLogoutRequest,
  AideAuthLogoutResult,
  AideAuthScope,
  AideAuthSourceKind,
  AideAuthStatusRequest,
  AideAuthProviderCapability,
  AideDiscoveredCapability,
  AidePluginAuthStatus,
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

function isOperationOptions(
  value: AideAuthLogoutRequest | AuthProviderOperationOptions
): value is AuthProviderOperationOptions {
  return isRecord(value) && 'operationTimeout' in value && !('scope' in value);
}

const authSourceKinds = Object.freeze([
  'env',
  'keyring',
  'external',
  'unknown',
] as const);

function isAuthSourceKind(value: unknown): value is AideAuthSourceKind {
  return (
    typeof value === 'string' &&
    authSourceKinds.includes(value as AideAuthSourceKind)
  );
}

function snapshotScope(
  scope: AideAuthScope | undefined
): AideAuthScope | undefined {
  if (scope === undefined) return undefined;
  return Object.freeze({
    id: scope.id,
    providerId: scope.providerId,
    host: scope.host,
    org: scope.org,
    account: scope.account,
    label: scope.label,
    sourceKind: scope.sourceKind,
    metadata:
      scope.metadata === undefined
        ? undefined
        : Object.freeze({ ...scope.metadata }),
  });
}

function snapshotStatusRequest(
  request: AideAuthStatusRequest = {}
): AideAuthStatusRequest {
  return Object.freeze({
    scope: snapshotScope(request.scope),
  });
}

function snapshotAccountDiscoveryRequest(
  request: AideAuthAccountDiscoveryRequest = {}
): AideAuthAccountDiscoveryRequest {
  return Object.freeze({
    scope: snapshotScope(request.scope),
  });
}

function snapshotLoginRequest(
  request: AideAuthLoginRequest
): AideAuthLoginRequest {
  return Object.freeze({
    scope: snapshotScope(request.scope),
    fromEnv: request.fromEnv,
    values:
      request.values === undefined
        ? undefined
        : Object.freeze({ ...request.values }),
    prompt: request.prompt,
  });
}

function snapshotLogoutRequest(
  request: AideAuthLogoutRequest = {}
): AideAuthLogoutRequest {
  return Object.freeze({
    scope: snapshotScope(request.scope),
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

function validateOptionalString(
  provider: AideDiscoveredCapability<AideAuthProviderCapability>,
  operation: string,
  field: string,
  value: unknown
): Effect.Effect<string | undefined, InvalidAuthProviderOperationResultError> {
  if (value === undefined) return Effect.succeed(undefined);
  if (typeof value !== 'string') {
    return Effect.fail(
      invalidResult(provider, operation, `${field} must be a string`)
    );
  }
  return Effect.succeed(value);
}

function validateNonEmptyString(
  provider: AideDiscoveredCapability<AideAuthProviderCapability>,
  operation: string,
  field: string,
  value: unknown
): Effect.Effect<string, InvalidAuthProviderOperationResultError> {
  if (typeof value !== 'string' || value.trim() === '') {
    return Effect.fail(
      invalidResult(provider, operation, `${field} must be a non-empty string`)
    );
  }
  return Effect.succeed(value);
}

function validateSourceKind(
  provider: AideDiscoveredCapability<AideAuthProviderCapability>,
  operation: string,
  field: string,
  value: unknown
): Effect.Effect<
  AideAuthSourceKind | undefined,
  InvalidAuthProviderOperationResultError
> {
  if (value === undefined) return Effect.succeed(undefined);
  if (!isAuthSourceKind(value)) {
    return Effect.fail(
      invalidResult(
        provider,
        operation,
        `${field} must be one of: ${authSourceKinds.join(', ')}`
      )
    );
  }
  return Effect.succeed(value);
}

function validateMetadata(
  provider: AideDiscoveredCapability<AideAuthProviderCapability>,
  operation: string,
  field: string,
  value: unknown
): Effect.Effect<
  Readonly<Record<string, string | number | boolean>> | undefined,
  InvalidAuthProviderOperationResultError
> {
  if (value === undefined) return Effect.succeed(undefined);
  if (!isRecord(value) || Array.isArray(value)) {
    return Effect.fail(
      invalidResult(provider, operation, `${field} must be an object`)
    );
  }

  const snapshot: Record<string, string | number | boolean> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (
      typeof entry !== 'string' &&
      typeof entry !== 'boolean' &&
      !(typeof entry === 'number' && Number.isFinite(entry))
    ) {
      return Effect.fail(
        invalidResult(
          provider,
          operation,
          `${field}.${key} must be a string, number, or boolean`
        )
      );
    }
    snapshot[key] = entry;
  }

  return Effect.succeed(Object.freeze(snapshot));
}

function validateResultScope(
  provider: AideDiscoveredCapability<AideAuthProviderCapability>,
  operation: string,
  field: string,
  value: unknown
): Effect.Effect<
  AideAuthScope | undefined,
  InvalidAuthProviderOperationResultError
> {
  if (value === undefined) return Effect.succeed(undefined);
  if (!isRecord(value)) {
    return Effect.fail(
      invalidResult(provider, operation, `${field} must be an object`)
    );
  }

  return Effect.all({
    id: validateNonEmptyString(provider, operation, `${field}.id`, value.id),
    providerId: validateOptionalString(
      provider,
      operation,
      `${field}.providerId`,
      value.providerId
    ),
    host: validateOptionalString(
      provider,
      operation,
      `${field}.host`,
      value.host
    ),
    org: validateOptionalString(provider, operation, `${field}.org`, value.org),
    account: validateOptionalString(
      provider,
      operation,
      `${field}.account`,
      value.account
    ),
    label: validateOptionalString(
      provider,
      operation,
      `${field}.label`,
      value.label
    ),
    sourceKind: validateSourceKind(
      provider,
      operation,
      `${field}.sourceKind`,
      value.sourceKind
    ),
    metadata: validateMetadata(
      provider,
      operation,
      `${field}.metadata`,
      value.metadata
    ),
  }).pipe(
    Effect.flatMap((scope) => {
      const providerId = scope.providerId ?? provider.capability.providerId;
      if (providerId !== provider.capability.providerId) {
        return Effect.fail(
          invalidResult(
            provider,
            operation,
            `${field}.providerId must match provider id '${provider.capability.providerId}'`
          )
        );
      }

      return Effect.succeed(
        Object.freeze({
          id: scope.id,
          providerId,
          ...(scope.host === undefined ? {} : { host: scope.host }),
          ...(scope.org === undefined ? {} : { org: scope.org }),
          ...(scope.account === undefined ? {} : { account: scope.account }),
          ...(scope.label === undefined ? {} : { label: scope.label }),
          ...(scope.sourceKind === undefined
            ? {}
            : { sourceKind: scope.sourceKind }),
          ...(scope.metadata === undefined ? {} : { metadata: scope.metadata }),
        })
      );
    })
  );
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

function validateAuthStatus(
  provider: AideDiscoveredCapability<AideAuthProviderCapability>,
  operation: string,
  result: unknown
): Effect.Effect<
  AidePluginAuthStatus,
  InvalidAuthProviderOperationResultError
> {
  if (!isRecord(result)) {
    return Effect.fail(
      invalidResult(provider, operation, 'result must be an object')
    );
  }

  const state = result.state;
  if (
    state !== 'configured' &&
    state !== 'not-configured' &&
    state !== 'misconfigured' &&
    state !== 'unavailable'
  ) {
    return Effect.fail(
      invalidResult(
        provider,
        operation,
        "state must be 'configured', 'not-configured', 'misconfigured', or 'unavailable'"
      )
    );
  }

  return validateOptionalString(
    provider,
    operation,
    'detail',
    result.detail
  ).pipe(
    Effect.map((detail) =>
      Object.freeze({
        state,
        ...(detail === undefined ? {} : { detail }),
      })
    )
  );
}

function validateAccountResult(
  provider: AideDiscoveredCapability<AideAuthProviderCapability>,
  operation: string,
  account: unknown,
  index: number
): Effect.Effect<AideAuthAccount, InvalidAuthProviderOperationResultError> {
  const field = `accounts[${index}]`;
  if (!isRecord(account)) {
    return Effect.fail(
      invalidResult(provider, operation, `${field} must be an object`)
    );
  }

  return Effect.all({
    id: validateNonEmptyString(provider, operation, `${field}.id`, account.id),
    providerId: validateOptionalString(
      provider,
      operation,
      `${field}.providerId`,
      account.providerId
    ),
    label: validateNonEmptyString(
      provider,
      operation,
      `${field}.label`,
      account.label
    ),
    detail: validateOptionalString(
      provider,
      operation,
      `${field}.detail`,
      account.detail
    ),
    sourceKind: validateSourceKind(
      provider,
      operation,
      `${field}.sourceKind`,
      account.sourceKind
    ),
    metadata: validateMetadata(
      provider,
      operation,
      `${field}.metadata`,
      account.metadata
    ),
    scope: validateResultScope(
      provider,
      operation,
      `${field}.scope`,
      account.scope
    ),
  }).pipe(
    Effect.flatMap((snapshot) => {
      const providerId = snapshot.providerId ?? provider.capability.providerId;
      if (providerId !== provider.capability.providerId) {
        return Effect.fail(
          invalidResult(
            provider,
            operation,
            `${field}.providerId must match provider id '${provider.capability.providerId}'`
          )
        );
      }

      return Effect.succeed(
        Object.freeze({
          id: snapshot.id,
          providerId,
          label: snapshot.label,
          ...(snapshot.detail === undefined ? {} : { detail: snapshot.detail }),
          ...(snapshot.sourceKind === undefined
            ? {}
            : { sourceKind: snapshot.sourceKind }),
          ...(snapshot.metadata === undefined
            ? {}
            : { metadata: snapshot.metadata }),
          ...(snapshot.scope === undefined ? {} : { scope: snapshot.scope }),
        })
      );
    })
  );
}

function validateAccountsResult(
  provider: AideDiscoveredCapability<AideAuthProviderCapability>,
  result: unknown
): Effect.Effect<
  readonly AideAuthAccount[],
  InvalidAuthProviderOperationResultError
> {
  const operation = 'accounts';
  if (!Array.isArray(result)) {
    return Effect.fail(
      invalidResult(provider, operation, 'result must be an array')
    );
  }

  return Effect.all(
    result.map((account, index) =>
      validateAccountResult(provider, operation, account, index)
    )
  ).pipe(Effect.map((accounts) => Object.freeze([...accounts])));
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

export function getAuthProviderStatus(
  provider: AideDiscoveredCapability<AideAuthProviderCapability>,
  request: AideAuthStatusRequest = {},
  options: AuthProviderOperationOptions = {}
): Effect.Effect<AidePluginAuthStatus, AuthProviderOperationInvocationError> {
  const operationRequest = snapshotStatusRequest(request);
  const operation =
    operationRequest.scope === undefined
      ? () => provider.capability.status()
      : () => provider.capability.status(operationRequest);
  return invokeAuthProviderOperation(
    provider,
    'status',
    operation,
    options
  ).pipe(
    Effect.flatMap((result) => validateAuthStatus(provider, 'status', result))
  );
}

export function logoutWithAuthProvider(
  provider: AideDiscoveredCapability<AideAuthProviderCapability>,
  options?: AuthProviderOperationOptions
): Effect.Effect<AideAuthLogoutResult, AuthProviderOperationInvocationError>;
export function logoutWithAuthProvider(
  provider: AideDiscoveredCapability<AideAuthProviderCapability>,
  request?: AideAuthLogoutRequest,
  options?: AuthProviderOperationOptions
): Effect.Effect<AideAuthLogoutResult, AuthProviderOperationInvocationError>;
export function logoutWithAuthProvider(
  provider: AideDiscoveredCapability<AideAuthProviderCapability>,
  requestOrOptions: AideAuthLogoutRequest | AuthProviderOperationOptions = {},
  options: AuthProviderOperationOptions = {}
): Effect.Effect<AideAuthLogoutResult, AuthProviderOperationInvocationError> {
  const operationOptions = isOperationOptions(requestOrOptions)
    ? requestOrOptions
    : options;
  const request = isOperationOptions(requestOrOptions) ? {} : requestOrOptions;
  const operationRequest = snapshotLogoutRequest(request);
  const logout = provider.capability.operations?.logout;
  const operation =
    logout === undefined
      ? undefined
      : operationRequest.scope === undefined
        ? () => logout()
        : () => logout(operationRequest);
  return invokeAuthProviderOperation(
    provider,
    'logout',
    operation,
    operationOptions
  ).pipe(Effect.flatMap((result) => validateLogoutResult(provider, result)));
}

export function listAuthProviderAccounts(
  provider: AideDiscoveredCapability<AideAuthProviderCapability>,
  request: AideAuthAccountDiscoveryRequest = {},
  options: AuthProviderOperationOptions = {}
): Effect.Effect<
  readonly AideAuthAccount[],
  AuthProviderOperationInvocationError
> {
  const operationRequest = snapshotAccountDiscoveryRequest(request);
  const accounts = provider.capability.accounts;
  const operation =
    accounts === undefined
      ? undefined
      : operationRequest.scope === undefined
        ? () => accounts()
        : () => accounts(operationRequest);
  return invokeAuthProviderOperation(
    provider,
    'accounts',
    operation,
    options
  ).pipe(Effect.flatMap((result) => validateAccountsResult(provider, result)));
}
