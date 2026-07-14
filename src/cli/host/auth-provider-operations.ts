import { types as nodeUtilTypes } from 'node:util';

import { Cause, Data, Effect, type Duration } from 'effect';

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
import { invokePublicCapabilityEffect } from './public-capability-invocation.js';
import {
  defineHostArrayIndex,
  ownArrayDataValue,
  ownArrayLength,
} from './host-owned-array.js';
import {
  boundedSafeCliDiagnostic,
  safeNativeErrorMessage,
} from '@cli/safe-error-rendering.js';

const hasOwn = Object.hasOwn;

function safeAuthDiagnosticField(value: unknown): string {
  return boundedSafeCliDiagnostic(value) ?? '<invalid>';
}

function installSafeAuthMessage(error: Error, message: string): void {
  Object.defineProperty(error, 'message', {
    configurable: true,
    value: message,
    writable: true,
  });
}

export class UnsupportedAuthProviderOperationError extends Data.TaggedError(
  'UnsupportedAuthProviderOperationError'
)<{
  readonly pluginId: string;
  readonly providerId: string;
  readonly operation: string;
}> {
  constructor(args: {
    readonly pluginId: string;
    readonly providerId: string;
    readonly operation: string;
  }) {
    super(args);
    installSafeAuthMessage(
      this,
      `Auth provider '${safeAuthDiagnosticField(args.providerId)}' from plugin '${safeAuthDiagnosticField(args.pluginId)}' does not implement ${safeAuthDiagnosticField(args.operation)}`
    );
  }

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
  constructor(args: {
    readonly pluginId: string;
    readonly providerId: string;
    readonly operation: string;
    readonly reason: string;
  }) {
    super(args);
    installSafeAuthMessage(
      this,
      `Auth provider '${safeAuthDiagnosticField(args.providerId)}' from plugin '${safeAuthDiagnosticField(args.pluginId)}' returned invalid ${safeAuthDiagnosticField(args.operation)} result: ${safeAuthDiagnosticField(args.reason)}`
    );
  }

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
  constructor(args: {
    readonly pluginId: string;
    readonly providerId: string;
    readonly operation: string;
    readonly cause: unknown;
  }) {
    super(args);
    const detail = safeNativeErrorMessage(args.cause);
    installSafeAuthMessage(
      this,
      `Auth provider '${safeAuthDiagnosticField(args.providerId)}' from plugin '${safeAuthDiagnosticField(args.pluginId)}' failed during ${safeAuthDiagnosticField(args.operation)}${detail === undefined ? '' : `: ${detail}`}`
    );
  }

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
  constructor(args: {
    readonly pluginId: string;
    readonly providerId: string;
    readonly operation: string;
  }) {
    super(args);
    installSafeAuthMessage(
      this,
      `Auth provider '${safeAuthDiagnosticField(args.providerId)}' from plugin '${safeAuthDiagnosticField(args.pluginId)}' timed out during ${safeAuthDiagnosticField(args.operation)}`
    );
  }

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

type AuthProviderIdentity = AideDiscoveredCapability<{
  readonly providerId: string;
}> & {
  /** Registry-owned provenance. Missing provenance fails closed as public. */
  readonly provenance?: 'trusted' | 'external';
};

const isNodeProxy = nodeUtilTypes.isProxy;

// Public and trusted results share this conservative snapshot contract. The
// 1,000-item collection cap matches the existing Prime registry/result caps;
// retained plugin text uses the existing 1,024-code-unit Prime message bound.
const MAX_AUTH_RESULT_ACCOUNT_COUNT = 1_000;
const MAX_AUTH_RESULT_MESSAGE_COUNT = 1_000;
const MAX_AUTH_RESULT_MESSAGE_LENGTH = 1_024;
const MAX_AUTH_RESULT_METADATA_ENTRIES = 100;
const MAX_AUTH_RESULT_METADATA_KEY_LENGTH = 128;
const MAX_AUTH_RESULT_METADATA_STRING_LENGTH = 1_024;
const unsafeMetadataKeys = new Set<string>();
unsafeMetadataKeys.add('__proto__');
unsafeMetadataKeys.add('constructor');
unsafeMetadataKeys.add('prototype');

type SnapshotResult<A> =
  | { readonly ok: true; readonly value: A }
  | {
      readonly ok: false;
      readonly error: InvalidAuthProviderOperationResultError;
    };

function snapshotSuccess<A>(value: A): SnapshotResult<A> {
  return { ok: true, value };
}

function snapshotFailure(
  error: InvalidAuthProviderOperationResultError
): SnapshotResult<never> {
  return { ok: false, error };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

function isOperationOptions(
  value: AideAuthLogoutRequest | AuthProviderOperationOptions
): value is AuthProviderOperationOptions {
  return isRecord(value) && 'operationTimeout' in value && !('scope' in value);
}

function isAuthSourceKind(value: unknown): value is AideAuthSourceKind {
  return (
    value === 'env' ||
    value === 'keyring' ||
    value === 'external' ||
    value === 'unknown'
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
  provider: AuthProviderIdentity,
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

function fixedOperationCause(operation: string, reason: string): Error {
  return new Error(`Auth provider ${operation} ${reason}`);
}

function publicOperationError(
  provider: AuthProviderIdentity,
  operation: string,
  reason: string
): AuthProviderOperationError {
  return new AuthProviderOperationError({
    pluginId: provider.pluginId,
    providerId: provider.capability.providerId,
    operation,
    cause: fixedOperationCause(operation, reason),
  });
}

function isGuardedResultRecord(value: unknown): value is object {
  if (typeof value !== 'object' || value === null) return false;
  try {
    if (isNodeProxy(value) || Array.isArray(value)) return false;
    const prototype = Reflect.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function readOwnDataField(
  provider: AuthProviderIdentity,
  operation: string,
  object: object,
  field: string,
  diagnosticField = field
): SnapshotResult<unknown> {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Reflect.getOwnPropertyDescriptor(object, field);
  } catch {
    return snapshotFailure(
      invalidResult(
        provider,
        operation,
        `${diagnosticField} must be a readable own data property`
      )
    );
  }
  if (descriptor === undefined) return snapshotSuccess(undefined);
  if (!hasOwn(descriptor, 'value')) {
    return snapshotFailure(
      invalidResult(
        provider,
        operation,
        `${diagnosticField} must be an own data property`
      )
    );
  }
  return snapshotSuccess(descriptor.value);
}

function readDenseResultArray(
  provider: AuthProviderIdentity,
  operation: string,
  field: string,
  value: unknown,
  maximumLength: number
): SnapshotResult<readonly unknown[]> {
  if (typeof value !== 'object' || value === null) {
    return snapshotFailure(
      invalidResult(provider, operation, `${field} must be an array`)
    );
  }
  try {
    if (isNodeProxy(value) || !Array.isArray(value)) {
      return snapshotFailure(
        invalidResult(provider, operation, `${field} must be an array`)
      );
    }
  } catch {
    return snapshotFailure(
      invalidResult(provider, operation, `${field} must be an array`)
    );
  }

  const length = ownArrayLength(value);
  if (
    typeof length !== 'number' ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > maximumLength
  ) {
    return snapshotFailure(
      invalidResult(
        provider,
        operation,
        `${field} must contain at most ${maximumLength} entries`
      )
    );
  }

  const entries: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const entry = ownArrayDataValue<unknown>(value, index);
    if (!entry.found) {
      return snapshotFailure(
        invalidResult(
          provider,
          operation,
          `${field}[${index}] must be a dense own data property`
        )
      );
    }
    defineHostArrayIndex(entries, index, entry.value);
  }
  return snapshotSuccess(entries);
}

function snapshotMessages(
  provider: AuthProviderIdentity,
  operation: string,
  messages: unknown
): Effect.Effect<
  readonly string[] | undefined,
  InvalidAuthProviderOperationResultError
> {
  if (messages === undefined) return Effect.succeed(undefined);
  const input = readDenseResultArray(
    provider,
    operation,
    'messages',
    messages,
    MAX_AUTH_RESULT_MESSAGE_COUNT
  );
  if (!input.ok) return Effect.fail(input.error);

  const snapshot: string[] = [];
  const length = ownArrayLength(input.value);
  if (length === undefined) {
    return Effect.fail(
      invalidResult(provider, operation, 'messages must be a readable array')
    );
  }
  for (let index = 0; index < length; index += 1) {
    const entry = ownArrayDataValue<unknown>(input.value, index);
    if (!entry.found) {
      return Effect.fail(
        invalidResult(
          provider,
          operation,
          `messages[${index}] must be a dense own data property`
        )
      );
    }
    const message = entry.value;
    if (typeof message !== 'string' || message.length === 0) {
      return Effect.fail(
        invalidResult(provider, operation, 'messages must contain strings')
      );
    }
    if (message.length > MAX_AUTH_RESULT_MESSAGE_LENGTH) {
      return Effect.fail(
        invalidResult(
          provider,
          operation,
          `messages must contain strings of at most ${MAX_AUTH_RESULT_MESSAGE_LENGTH} code units`
        )
      );
    }
    defineHostArrayIndex(snapshot, index, message);
  }

  return Effect.succeed(Object.freeze(snapshot));
}

function validateOptionalString(
  provider: AuthProviderIdentity,
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
  provider: AuthProviderIdentity,
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
  provider: AuthProviderIdentity,
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
        `${field} must be one of: env, keyring, external, unknown`
      )
    );
  }
  return Effect.succeed(value);
}

function validateMetadata(
  provider: AuthProviderIdentity,
  operation: string,
  field: string,
  value: unknown
): Effect.Effect<
  Readonly<Record<string, string | number | boolean>> | undefined,
  InvalidAuthProviderOperationResultError
> {
  if (value === undefined) return Effect.succeed(undefined);
  if (!isGuardedResultRecord(value)) {
    return Effect.fail(
      invalidResult(provider, operation, `${field} must be an object`)
    );
  }

  let keys: readonly PropertyKey[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    return Effect.fail(
      invalidResult(provider, operation, `${field} must be a readable object`)
    );
  }
  const keyCount = ownArrayLength(keys);
  if (keyCount === undefined || keyCount > MAX_AUTH_RESULT_METADATA_ENTRIES) {
    return Effect.fail(
      invalidResult(
        provider,
        operation,
        `${field} must contain at most ${MAX_AUTH_RESULT_METADATA_ENTRIES} entries`
      )
    );
  }

  const snapshot: Record<string, string | number | boolean> = {};
  for (let index = 0; index < keyCount; index += 1) {
    const keyEntry = ownArrayDataValue<PropertyKey>(keys, index);
    if (!keyEntry.found) {
      return Effect.fail(
        invalidResult(provider, operation, `${field} must be a readable object`)
      );
    }
    const key = keyEntry.value;
    if (
      typeof key !== 'string' ||
      key.length === 0 ||
      key.length > MAX_AUTH_RESULT_METADATA_KEY_LENGTH ||
      unsafeMetadataKeys.has(key)
    ) {
      return Effect.fail(
        invalidResult(provider, operation, `${field} contains an unsafe key`)
      );
    }
    const entryResult = readOwnDataField(
      provider,
      operation,
      value,
      key,
      `${field} entry`
    );
    if (!entryResult.ok) return Effect.fail(entryResult.error);
    const entry = entryResult.value;
    if (
      typeof entry !== 'string' &&
      typeof entry !== 'boolean' &&
      !(typeof entry === 'number' && Number.isFinite(entry))
    ) {
      return Effect.fail(
        invalidResult(
          provider,
          operation,
          `${field} entries must be strings, numbers, or booleans`
        )
      );
    }
    if (
      typeof entry === 'string' &&
      entry.length > MAX_AUTH_RESULT_METADATA_STRING_LENGTH
    ) {
      return Effect.fail(
        invalidResult(
          provider,
          operation,
          `${field} string values must contain at most ${MAX_AUTH_RESULT_METADATA_STRING_LENGTH} code units`
        )
      );
    }
    Object.defineProperty(snapshot, key, {
      configurable: true,
      enumerable: true,
      value: entry,
      writable: true,
    });
  }

  return Effect.succeed(Object.freeze(snapshot));
}

type AuthFieldSuccess<T extends Effect.Effect<unknown, unknown, unknown>> =
  Effect.Effect.Success<T>;

function collectValidatedAuthFields<
  TFields extends Record<
    string,
    Effect.Effect<unknown, InvalidAuthProviderOperationResultError, never>
  >,
>(
  fields: TFields
): Effect.Effect<
  { readonly [K in keyof TFields]: AuthFieldSuccess<TFields[K]> },
  InvalidAuthProviderOperationResultError,
  never
> {
  const snapshot = Object.create(null) as Record<PropertyKey, unknown>;
  let validated: Effect.Effect<
    Record<PropertyKey, unknown>,
    InvalidAuthProviderOperationResultError,
    never
  > = Effect.succeed(snapshot);
  const keys = Reflect.ownKeys(fields);
  const keyCount = ownArrayLength(keys) ?? 0;
  for (let index = 0; index < keyCount; index += 1) {
    const keyEntry = ownArrayDataValue<PropertyKey>(keys, index);
    if (!keyEntry.found) continue;
    const key = keyEntry.value;
    const field = Reflect.getOwnPropertyDescriptor(fields, key);
    if (field === undefined || !hasOwn(field, 'value')) continue;
    const fieldEffect = field.value as Effect.Effect<
      unknown,
      InvalidAuthProviderOperationResultError,
      never
    >;
    validated = Effect.flatMap(validated, (result) =>
      Effect.map(fieldEffect, (value) => {
        Object.defineProperty(result, key, {
          configurable: true,
          enumerable: true,
          value,
          writable: true,
        });
        return result;
      })
    );
  }
  return validated as Effect.Effect<
    { readonly [K in keyof TFields]: AuthFieldSuccess<TFields[K]> },
    InvalidAuthProviderOperationResultError,
    never
  >;
}

function validateResultScope(
  provider: AuthProviderIdentity,
  operation: string,
  field: string,
  value: unknown
): Effect.Effect<
  AideAuthScope | undefined,
  InvalidAuthProviderOperationResultError
> {
  if (value === undefined) return Effect.succeed(undefined);
  if (!isGuardedResultRecord(value)) {
    return Effect.fail(
      invalidResult(provider, operation, `${field} must be an object`)
    );
  }

  const id = readOwnDataField(provider, operation, value, 'id', `${field}.id`);
  const providerId = readOwnDataField(
    provider,
    operation,
    value,
    'providerId',
    `${field}.providerId`
  );
  const host = readOwnDataField(
    provider,
    operation,
    value,
    'host',
    `${field}.host`
  );
  const org = readOwnDataField(
    provider,
    operation,
    value,
    'org',
    `${field}.org`
  );
  const account = readOwnDataField(
    provider,
    operation,
    value,
    'account',
    `${field}.account`
  );
  const label = readOwnDataField(
    provider,
    operation,
    value,
    'label',
    `${field}.label`
  );
  const sourceKind = readOwnDataField(
    provider,
    operation,
    value,
    'sourceKind',
    `${field}.sourceKind`
  );
  const metadata = readOwnDataField(
    provider,
    operation,
    value,
    'metadata',
    `${field}.metadata`
  );
  if (!id.ok) return Effect.fail(id.error);
  if (!providerId.ok) return Effect.fail(providerId.error);
  if (!host.ok) return Effect.fail(host.error);
  if (!org.ok) return Effect.fail(org.error);
  if (!account.ok) return Effect.fail(account.error);
  if (!label.ok) return Effect.fail(label.error);
  if (!sourceKind.ok) return Effect.fail(sourceKind.error);
  if (!metadata.ok) return Effect.fail(metadata.error);

  return collectValidatedAuthFields({
    id: validateNonEmptyString(provider, operation, `${field}.id`, id.value),
    providerId: validateOptionalString(
      provider,
      operation,
      `${field}.providerId`,
      providerId.value
    ),
    host: validateOptionalString(
      provider,
      operation,
      `${field}.host`,
      host.value
    ),
    org: validateOptionalString(provider, operation, `${field}.org`, org.value),
    account: validateOptionalString(
      provider,
      operation,
      `${field}.account`,
      account.value
    ),
    label: validateOptionalString(
      provider,
      operation,
      `${field}.label`,
      label.value
    ),
    sourceKind: validateSourceKind(
      provider,
      operation,
      `${field}.sourceKind`,
      sourceKind.value
    ),
    metadata: validateMetadata(
      provider,
      operation,
      `${field}.metadata`,
      metadata.value
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
  provider: AuthProviderIdentity,
  result: unknown
): Effect.Effect<AideAuthLoginResult, InvalidAuthProviderOperationResultError> {
  const operation = 'login';
  if (!isGuardedResultRecord(result)) {
    return Effect.fail(
      invalidResult(provider, operation, 'result must be an object')
    );
  }

  const statusResult = readOwnDataField(provider, operation, result, 'status');
  if (!statusResult.ok) return Effect.fail(statusResult.error);
  const messagesResult = readOwnDataField(
    provider,
    operation,
    result,
    'messages'
  );
  if (!messagesResult.ok) return Effect.fail(messagesResult.error);
  const status = statusResult.value;
  if (status !== 'stored' && status !== 'external' && status !== 'unchanged') {
    return Effect.fail(
      invalidResult(
        provider,
        operation,
        "status must be 'stored', 'external', or 'unchanged'"
      )
    );
  }

  return snapshotMessages(provider, operation, messagesResult.value).pipe(
    Effect.map((messages) =>
      Object.freeze({
        status,
        ...(messages === undefined ? {} : { messages }),
      })
    )
  );
}

function validateLogoutResult(
  provider: AuthProviderIdentity,
  result: unknown
): Effect.Effect<
  AideAuthLogoutResult,
  InvalidAuthProviderOperationResultError
> {
  const operation = 'logout';
  if (!isGuardedResultRecord(result)) {
    return Effect.fail(
      invalidResult(provider, operation, 'result must be an object')
    );
  }

  const statusResult = readOwnDataField(provider, operation, result, 'status');
  if (!statusResult.ok) return Effect.fail(statusResult.error);
  const messagesResult = readOwnDataField(
    provider,
    operation,
    result,
    'messages'
  );
  if (!messagesResult.ok) return Effect.fail(messagesResult.error);
  const status = statusResult.value;
  if (status !== 'removed' && status !== 'not-found') {
    return Effect.fail(
      invalidResult(
        provider,
        operation,
        "status must be 'removed' or 'not-found'"
      )
    );
  }

  return snapshotMessages(provider, operation, messagesResult.value).pipe(
    Effect.map((messages) =>
      Object.freeze({
        status,
        ...(messages === undefined ? {} : { messages }),
      })
    )
  );
}

function validateAuthStatus(
  provider: AuthProviderIdentity,
  operation: string,
  result: unknown
): Effect.Effect<
  AidePluginAuthStatus,
  InvalidAuthProviderOperationResultError
> {
  if (!isGuardedResultRecord(result)) {
    return Effect.fail(
      invalidResult(provider, operation, 'result must be an object')
    );
  }

  const stateResult = readOwnDataField(provider, operation, result, 'state');
  if (!stateResult.ok) return Effect.fail(stateResult.error);
  const detailResult = readOwnDataField(provider, operation, result, 'detail');
  if (!detailResult.ok) return Effect.fail(detailResult.error);
  const state = stateResult.value;
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
    detailResult.value
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
  provider: AuthProviderIdentity,
  operation: string,
  account: unknown,
  index: number
): Effect.Effect<AideAuthAccount, InvalidAuthProviderOperationResultError> {
  const field = `accounts[${index}]`;
  if (!isGuardedResultRecord(account)) {
    return Effect.fail(
      invalidResult(provider, operation, `${field} must be an object`)
    );
  }

  const id = readOwnDataField(
    provider,
    operation,
    account,
    'id',
    `${field}.id`
  );
  const providerId = readOwnDataField(
    provider,
    operation,
    account,
    'providerId',
    `${field}.providerId`
  );
  const label = readOwnDataField(
    provider,
    operation,
    account,
    'label',
    `${field}.label`
  );
  const detail = readOwnDataField(
    provider,
    operation,
    account,
    'detail',
    `${field}.detail`
  );
  const sourceKind = readOwnDataField(
    provider,
    operation,
    account,
    'sourceKind',
    `${field}.sourceKind`
  );
  const metadata = readOwnDataField(
    provider,
    operation,
    account,
    'metadata',
    `${field}.metadata`
  );
  const scope = readOwnDataField(
    provider,
    operation,
    account,
    'scope',
    `${field}.scope`
  );
  if (!id.ok) return Effect.fail(id.error);
  if (!providerId.ok) return Effect.fail(providerId.error);
  if (!label.ok) return Effect.fail(label.error);
  if (!detail.ok) return Effect.fail(detail.error);
  if (!sourceKind.ok) return Effect.fail(sourceKind.error);
  if (!metadata.ok) return Effect.fail(metadata.error);
  if (!scope.ok) return Effect.fail(scope.error);

  return collectValidatedAuthFields({
    id: validateNonEmptyString(provider, operation, `${field}.id`, id.value),
    providerId: validateOptionalString(
      provider,
      operation,
      `${field}.providerId`,
      providerId.value
    ),
    label: validateNonEmptyString(
      provider,
      operation,
      `${field}.label`,
      label.value
    ),
    detail: validateOptionalString(
      provider,
      operation,
      `${field}.detail`,
      detail.value
    ),
    sourceKind: validateSourceKind(
      provider,
      operation,
      `${field}.sourceKind`,
      sourceKind.value
    ),
    metadata: validateMetadata(
      provider,
      operation,
      `${field}.metadata`,
      metadata.value
    ),
    scope: validateResultScope(
      provider,
      operation,
      `${field}.scope`,
      scope.value
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
  provider: AuthProviderIdentity,
  result: unknown
): Effect.Effect<
  readonly AideAuthAccount[],
  InvalidAuthProviderOperationResultError
> {
  const operation = 'accounts';
  const input = readDenseResultArray(
    provider,
    operation,
    'result',
    result,
    MAX_AUTH_RESULT_ACCOUNT_COUNT
  );
  if (!input.ok) return Effect.fail(input.error);

  const length = ownArrayLength(input.value);
  if (length === undefined) {
    return Effect.fail(
      invalidResult(provider, operation, 'result must be a readable array')
    );
  }

  const accounts: AideAuthAccount[] = [];
  let validated: Effect.Effect<
    AideAuthAccount[],
    InvalidAuthProviderOperationResultError
  > = Effect.succeed(accounts);
  for (let index = 0; index < length; index += 1) {
    const entry = ownArrayDataValue<unknown>(input.value, index);
    if (!entry.found) {
      return Effect.fail(
        invalidResult(
          provider,
          operation,
          `result[${index}] must be a dense own data property`
        )
      );
    }
    validated = Effect.flatMap(validated, (snapshot) =>
      validateAccountResult(provider, operation, entry.value, index).pipe(
        Effect.map((account) => {
          defineHostArrayIndex(snapshot, index, account);
          return snapshot;
        })
      )
    );
  }
  return validated.pipe(Effect.map((snapshot) => Object.freeze(snapshot)));
}

function invokeTrustedAuthProviderOperation<A, B, R>(
  provider: AuthProviderIdentity,
  operationName: string,
  operation: () => Effect.Effect<A, unknown, R>,
  validate: (
    result: A
  ) => Effect.Effect<B, InvalidAuthProviderOperationResultError>
): Effect.Effect<B, AuthProviderOperationInvocationError, R> {
  return Effect.suspend(
    (): Effect.Effect<B, AuthProviderOperationInvocationError, R> => {
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

      let recognized = false;
      try {
        recognized = Effect.isEffect(operationResult);
      } catch {
        return Effect.fail(
          invalidResult(
            provider,
            operationName,
            'operation must return an Effect'
          )
        );
      }
      if (!recognized) {
        return Effect.fail(
          invalidResult(
            provider,
            operationName,
            'operation must return an Effect'
          )
        );
      }

      return Effect.flatMap(
        Effect.mapErrorCause(
          operationResult as Effect.Effect<A, unknown, R>,
          (cause) =>
            Cause.map(
              cause,
              (failure) =>
                new AuthProviderOperationError({
                  pluginId: provider.pluginId,
                  providerId: provider.capability.providerId,
                  operation: operationName,
                  cause: failure,
                })
            )
        ),
        validate
      );
    }
  );
}

function invokePublicAuthProviderOperation<A, B>(
  provider: AuthProviderIdentity,
  operationName: string,
  operation: () => unknown,
  validate: (
    result: A
  ) => Effect.Effect<B, InvalidAuthProviderOperationResultError>
): Effect.Effect<B, AuthProviderOperationInvocationError, never> {
  const invalidEffect = () =>
    invalidResult(provider, operationName, 'operation must return an Effect');
  return invokePublicCapabilityEffect<
    A,
    unknown,
    B,
    AuthProviderOperationInvocationError,
    AuthProviderOperationInvocationError
  >(
    operation,
    {
      onCallbackThrow: () =>
        publicOperationError(provider, operationName, 'callback threw'),
      onInvalidReturn: invalidEffect,
      onCompositionFailure: () =>
        invalidResult(
          provider,
          operationName,
          'operation Effect composition failed'
        ),
      onLaunchFailure: () =>
        publicOperationError(
          provider,
          operationName,
          'Effect execution failed'
        ),
    },
    (effect) =>
      Effect.flatMap(
        Effect.mapErrorCause(effect, (cause) =>
          Cause.map(cause, () =>
            publicOperationError(provider, operationName, 'Effect failed')
          )
        ),
        validate
      )
  );
}

function invokeAuthProviderOperation<A, B, R>(
  provider: AuthProviderIdentity,
  operationName: string,
  operation: (() => Effect.Effect<A, unknown, R>) | undefined,
  validate: (
    result: A
  ) => Effect.Effect<B, InvalidAuthProviderOperationResultError>,
  options: AuthProviderOperationOptions = {}
): Effect.Effect<B, AuthProviderOperationInvocationError, R> {
  if (operation === undefined) {
    return Effect.fail(
      new UnsupportedAuthProviderOperationError({
        pluginId: provider.pluginId,
        providerId: provider.capability.providerId,
        operation: operationName,
      })
    );
  }

  const invoked =
    provider.provenance === 'trusted'
      ? invokeTrustedAuthProviderOperation(
          provider,
          operationName,
          operation,
          validate
        )
      : (invokePublicAuthProviderOperation(
          provider,
          operationName,
          operation,
          validate
        ) as Effect.Effect<B, AuthProviderOperationInvocationError, R>);

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

export function loginWithAuthProvider<RStatus, RAccounts, RLogin, RLogout>(
  provider: AideDiscoveredCapability<
    AideAuthProviderCapability<RStatus, RAccounts, RLogin, RLogout>
  >,
  request: AideAuthLoginRequest,
  options: AuthProviderOperationOptions = {}
): Effect.Effect<
  AideAuthLoginResult,
  AuthProviderOperationInvocationError,
  RLogin
> {
  const operationRequest = snapshotLoginRequest(request);
  const login = provider.capability.operations?.login;
  return invokeAuthProviderOperation(
    provider,
    'login',
    login === undefined ? undefined : () => login(operationRequest),
    (result) => validateLoginResult(provider, result),
    options
  );
}

export function getAuthProviderStatus<RStatus, RAccounts, RLogin, RLogout>(
  provider: AideDiscoveredCapability<
    AideAuthProviderCapability<RStatus, RAccounts, RLogin, RLogout>
  >,
  request: AideAuthStatusRequest = {},
  options: AuthProviderOperationOptions = {}
): Effect.Effect<
  AidePluginAuthStatus,
  AuthProviderOperationInvocationError,
  RStatus
> {
  const operationRequest = snapshotStatusRequest(request);
  const operation =
    operationRequest.scope === undefined
      ? () => provider.capability.status()
      : () => provider.capability.status(operationRequest);
  return invokeAuthProviderOperation(
    provider,
    'status',
    operation,
    (result) => validateAuthStatus(provider, 'status', result),
    options
  );
}

export function logoutWithAuthProvider<RStatus, RAccounts, RLogin, RLogout>(
  provider: AideDiscoveredCapability<
    AideAuthProviderCapability<RStatus, RAccounts, RLogin, RLogout>
  >,
  options?: AuthProviderOperationOptions
): Effect.Effect<
  AideAuthLogoutResult,
  AuthProviderOperationInvocationError,
  RLogout
>;
export function logoutWithAuthProvider<RStatus, RAccounts, RLogin, RLogout>(
  provider: AideDiscoveredCapability<
    AideAuthProviderCapability<RStatus, RAccounts, RLogin, RLogout>
  >,
  request?: AideAuthLogoutRequest,
  options?: AuthProviderOperationOptions
): Effect.Effect<
  AideAuthLogoutResult,
  AuthProviderOperationInvocationError,
  RLogout
>;
export function logoutWithAuthProvider<RStatus, RAccounts, RLogin, RLogout>(
  provider: AideDiscoveredCapability<
    AideAuthProviderCapability<RStatus, RAccounts, RLogin, RLogout>
  >,
  requestOrOptions: AideAuthLogoutRequest | AuthProviderOperationOptions = {},
  options: AuthProviderOperationOptions = {}
): Effect.Effect<
  AideAuthLogoutResult,
  AuthProviderOperationInvocationError,
  RLogout
> {
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
    (result) => validateLogoutResult(provider, result),
    operationOptions
  );
}

export function listAuthProviderAccounts<RStatus, RAccounts, RLogin, RLogout>(
  provider: AideDiscoveredCapability<
    AideAuthProviderCapability<RStatus, RAccounts, RLogin, RLogout>
  >,
  request: AideAuthAccountDiscoveryRequest = {},
  options: AuthProviderOperationOptions = {}
): Effect.Effect<
  readonly AideAuthAccount[],
  AuthProviderOperationInvocationError,
  RAccounts
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
    (result) => validateAccountsResult(provider, result),
    options
  );
}
