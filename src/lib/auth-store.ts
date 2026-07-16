import { isProxy } from 'node:util/types';

import { Data, Effect } from 'effect';

import {
  AuthIndexProviderError,
  authIndexScopeName,
  authIndexSecretName,
  emptyAuthIndexDocument,
  legacyAuthSecretName,
  makeAuthIndexDocument,
  normalizeAuthProviderId,
  normalizeAuthStoreScope,
  parseAuthIndexDocument,
  removeAuthIndexScope,
  scopedAuthSecretName,
  serializeAuthIndexDocument,
  upsertAuthIndexScope,
  type AuthIndexDocument,
  type AuthIndexDocumentError,
  type AuthProviderId,
  type AuthStoreScope,
  type NormalizedAuthStoreScope,
} from './auth-index-codec.js';
import { AuthIndexLockError, withAuthIndexLock } from './auth-index-lock.js';
import {
  KeyringLive,
  KeyringService,
  KeyringUnavailableError,
  type AuthIndexSecretName,
  type KeyringServiceShape,
  type ScopedSecretName,
  type StoredSecretName,
} from './auth-keyring.js';

const arrayIsArray = Array.isArray;
const objectDefineProperty = Object.defineProperty;
const objectFreeze = Object.freeze;
const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const objectHasOwn = Object.hasOwn;

function ownHostArrayLength(value: object): number | undefined {
  const descriptor = objectGetOwnPropertyDescriptor(value, 'length');
  return descriptor !== undefined &&
    objectHasOwn(descriptor, 'value') &&
    typeof descriptor.value === 'number' &&
    Number.isSafeInteger(descriptor.value) &&
    descriptor.value >= 0
    ? descriptor.value
    : undefined;
}

function ownHostArrayValue<T>(value: object, index: number): T | undefined {
  const descriptor = objectGetOwnPropertyDescriptor(value, String(index));
  return descriptor !== undefined && objectHasOwn(descriptor, 'value')
    ? (descriptor.value as T)
    : undefined;
}

function defineHostArrayIndex<T>(target: T[], index: number, value: T): void {
  objectDefineProperty(target, String(index), {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function appendHostArrayValue<T>(target: T[], value: T): void {
  const length = ownHostArrayLength(target);
  if (length === undefined) throw new TypeError('Invalid host auth array');
  defineHostArrayIndex(target, length, value);
}

export * from './auth-index-codec.js';

export type AuthSecretStorageKind = 'scoped' | 'legacy';

export interface AuthSecretReference {
  readonly name: StoredSecretName;
  readonly kind: AuthSecretStorageKind;
  readonly providerId: string;
  readonly scope?: NormalizedAuthStoreScope;
}

export interface ResolvedAuthSecret extends AuthSecretReference {
  readonly value: string;
}

export type AuthSecretReferenceFailureCode =
  | 'invalid-reference'
  | 'reference-mismatch';

interface AuthSecretReferenceErrorFields {
  readonly code: AuthSecretReferenceFailureCode;
  readonly providerId?: string;
}

export class AuthSecretReferenceError extends Data.TaggedError(
  'AuthSecretReferenceError'
)<AuthSecretReferenceErrorFields> {
  constructor(code: AuthSecretReferenceFailureCode, providerId?: string) {
    super({ code, ...(providerId === undefined ? {} : { providerId }) });
  }

  override get message(): string {
    return this.providerId === undefined
      ? `Cannot read an auth secret from an invalid reference (${this.code}).`
      : `Cannot read a ${this.providerId} auth secret from an invalid reference (${this.code}).`;
  }
}

export type AuthStoreValidationFailureCode =
  | 'invalid-target'
  | 'invalid-index-scope';

interface AuthStoreValidationErrorFields {
  readonly code: AuthStoreValidationFailureCode;
  readonly providerId: string;
}

export class AuthStoreValidationError extends Data.TaggedError(
  'AuthStoreValidationError'
)<AuthStoreValidationErrorFields> {
  constructor(code: AuthStoreValidationFailureCode, providerId: string) {
    super({ code, providerId });
  }

  override get message(): string {
    return this.code === 'invalid-target'
      ? `Cannot build an auth secret key for provider '${this.providerId}'.`
      : `Cannot index an auth secret for provider '${this.providerId}'.`;
  }
}

export type AuthIndexConsistencyOperation = 'write' | 'delete' | 'repair';
export type AuthIndexConsistencyPhase =
  | 'credential-write'
  | 'credential-delete'
  | 'index-update'
  | 'index-cleanup';
export type AuthIndexRollback = 'succeeded' | 'failed' | 'not-needed';
export type AuthIndexResidualState = 'none' | 'stale-index' | 'unknown';
export type AuthIndexFailureClassification = 'keyring-unavailable';

interface AuthIndexConsistencyErrorFields {
  readonly operation: AuthIndexConsistencyOperation;
  readonly phase: AuthIndexConsistencyPhase;
  readonly providerId: string;
  readonly rollback: AuthIndexRollback;
  readonly residualState: AuthIndexResidualState;
  readonly failure: AuthIndexFailureClassification;
}

export class AuthIndexConsistencyError extends Data.TaggedError(
  'AuthIndexConsistencyError'
)<AuthIndexConsistencyErrorFields> {
  constructor(options: {
    readonly operation: AuthIndexConsistencyOperation;
    readonly phase: AuthIndexConsistencyPhase;
    readonly providerId: string;
    readonly rollback: AuthIndexRollback;
    readonly residualState: AuthIndexResidualState;
    readonly cause?: unknown;
  }) {
    super({
      operation: options.operation,
      phase: options.phase,
      providerId: options.providerId,
      rollback: options.rollback,
      residualState: options.residualState,
      failure: 'keyring-unavailable',
    });
  }

  override get message(): string {
    return `The ${this.providerId} auth ${this.operation} could not keep its index consistent during ${this.phase}; rollback ${this.rollback}.`;
  }
}

export type AuthIndexReadError =
  | AuthIndexProviderError
  | AuthIndexDocumentError
  | AuthIndexConsistencyError
  | AuthIndexLockError
  | KeyringUnavailableError;

export type AuthSecretReadError =
  | AuthIndexProviderError
  | AuthSecretReferenceError
  | KeyringUnavailableError
  | AuthStoreValidationError;

export type AuthIndexMutationError =
  | AuthIndexProviderError
  | AuthIndexDocumentError
  | AuthIndexConsistencyError
  | AuthIndexLockError
  | KeyringUnavailableError
  | AuthStoreValidationError;

export type AuthStoreError = AuthSecretReadError | AuthIndexMutationError;

interface AuthIndexState {
  readonly raw: string | null;
  readonly document: AuthIndexDocument;
}

interface CapturedAuthProviderCatalogEntry {
  readonly scope: NormalizedAuthStoreScope;
  readonly value: string;
}

interface ParsedAuthProviderCatalog<T> {
  readonly legacy: T;
  readonly indexed: readonly T[];
}

const redactedCatalogJson = objectFreeze({
  type: 'CapturedAuthProviderCatalog',
} as const);
const nodeInspectCustom = Symbol.for('nodejs.util.inspect.custom');

class CapturedAuthProviderCatalog {
  readonly #legacyValue: string | null;
  readonly #entries: readonly CapturedAuthProviderCatalogEntry[];

  constructor(
    legacyValue: string | null,
    entries: readonly CapturedAuthProviderCatalogEntry[]
  ) {
    this.#legacyValue = legacyValue;
    this.#entries = entries;
    objectFreeze(this);
  }

  parse<T>(
    parser: (value: string | null, scope?: AuthStoreScope) => T
  ): ParsedAuthProviderCatalog<T> {
    const indexed: T[] = [];
    const entryCount = ownHostArrayLength(this.#entries);
    if (entryCount === undefined) {
      throw new TypeError('Invalid captured auth catalog entries');
    }
    for (let index = 0; index < entryCount; index += 1) {
      const entry = ownHostArrayValue<CapturedAuthProviderCatalogEntry>(
        this.#entries,
        index
      );
      if (entry === undefined) {
        throw new TypeError('Invalid captured auth catalog entry');
      }
      appendHostArrayValue(indexed, parser(entry.value, entry.scope));
    }
    return objectFreeze({
      legacy: parser(this.#legacyValue),
      indexed: objectFreeze(indexed),
    });
  }

  toJSON(): typeof redactedCatalogJson {
    return redactedCatalogJson;
  }

  [nodeInspectCustom](): string {
    return 'CapturedAuthProviderCatalog { <redacted> }';
  }
}

objectFreeze(CapturedAuthProviderCatalog.prototype);
objectFreeze(CapturedAuthProviderCatalog);

export function authSecretCandidates(
  providerId: AuthProviderId,
  scope: AuthStoreScope | undefined
): readonly AuthSecretReference[] {
  const normalized = normalizeAuthStoreScope(providerId, scope);
  const scopedName = scopedAuthSecretName(providerId, scope);
  const legacyName = legacyAuthSecretName(providerId);
  const candidates: AuthSecretReference[] = [];

  if (scope !== undefined) {
    if (scopedName !== null && normalized !== null) {
      appendHostArrayValue(candidates, {
        name: scopedName,
        kind: 'scoped',
        providerId: normalized.providerId,
        scope: normalized,
      });
    }
    return objectFreeze(candidates);
  }

  if (legacyName !== null && normalized !== null) {
    appendHostArrayValue(candidates, {
      name: legacyName,
      kind: 'legacy',
      providerId: normalized.providerId,
    });
  }
  return objectFreeze(candidates);
}

export function authSecretTarget(
  providerId: AuthProviderId,
  scope: AuthStoreScope | undefined
): AuthSecretReference | null {
  return (
    ownHostArrayValue<AuthSecretReference>(
      authSecretCandidates(providerId, scope),
      0
    ) ?? null
  );
}

export function authSecretScopesMatch(
  providerId: AuthProviderId,
  left: AuthStoreScope,
  right: AuthStoreScope
): boolean {
  const leftName = scopedAuthSecretName(providerId, left);
  return (
    leftName !== null && leftName === scopedAuthSecretName(providerId, right)
  );
}

function readAuthIndexState(
  providerId: string,
  keyring: KeyringServiceShape
): Effect.Effect<
  AuthIndexState,
  AuthIndexDocumentError | KeyringUnavailableError
> {
  return Effect.gen(function* () {
    const raw = yield* keyring.get(authIndexSecretName(providerId));
    const document =
      raw === null
        ? emptyAuthIndexDocument(providerId)
        : yield* parseAuthIndexDocument(raw, providerId);
    return { raw, document };
  });
}

type VerifiedMutationOutcome =
  | { readonly kind: 'desired' }
  | { readonly kind: 'previous'; readonly error: KeyringUnavailableError }
  | { readonly kind: 'unknown'; readonly error: KeyringUnavailableError };

interface AuthTransactionSnapshot {
  readonly credentialName: ScopedSecretName;
  readonly credentialValue: string | null;
  readonly indexName: AuthIndexSecretName;
  readonly indexValue: string | null;
}

interface ReconciliationResult {
  readonly rollback: Exclude<AuthIndexRollback, 'not-needed'>;
  readonly residualState: AuthIndexResidualState;
}

function mutateKeyringValue(
  keyring: KeyringServiceShape,
  name: ScopedSecretName | AuthIndexSecretName,
  desiredValue: string | null
): Effect.Effect<void, KeyringUnavailableError> {
  return desiredValue === null
    ? Effect.asVoid(keyring.delete(name))
    : keyring.set(name, desiredValue);
}

function verifiedMutation(
  keyring: KeyringServiceShape,
  name: ScopedSecretName | AuthIndexSecretName,
  previousValue: string | null,
  desiredValue: string | null
): Effect.Effect<VerifiedMutationOutcome> {
  return Effect.gen(function* () {
    const mutation = yield* Effect.either(
      mutateKeyringValue(keyring, name, desiredValue)
    );
    if (mutation._tag === 'Right') return { kind: 'desired' };

    const observed = yield* Effect.either(keyring.get(name));
    if (observed._tag === 'Left') {
      return { kind: 'unknown', error: mutation.left };
    }
    if (observed.right === desiredValue) return { kind: 'desired' };
    if (observed.right === previousValue) {
      return { kind: 'previous', error: mutation.left };
    }
    return { kind: 'unknown', error: mutation.left };
  });
}

function mutateWithoutAssumingOutcome(
  keyring: KeyringServiceShape,
  name: ScopedSecretName | AuthIndexSecretName,
  desiredValue: string | null
): Effect.Effect<void> {
  return Effect.asVoid(
    Effect.either(mutateKeyringValue(keyring, name, desiredValue))
  );
}

function readMatches(
  keyring: KeyringServiceShape,
  name: ScopedSecretName | AuthIndexSecretName,
  expectedValue: string | null
): Effect.Effect<boolean> {
  return Effect.match(keyring.get(name), {
    onFailure: () => false,
    onSuccess: (value) => value === expectedValue,
  });
}

function reconcileAuthSnapshot(
  keyring: KeyringServiceShape,
  target: AuthTransactionSnapshot,
  mutateCredential: boolean,
  mutateIndex: boolean,
  verifiedResidualState: Exclude<AuthIndexResidualState, 'unknown'> = 'none'
): Effect.Effect<ReconciliationResult> {
  return Effect.gen(function* () {
    if (mutateCredential) {
      yield* mutateWithoutAssumingOutcome(
        keyring,
        target.credentialName,
        target.credentialValue
      );
    }
    if (mutateIndex) {
      yield* mutateWithoutAssumingOutcome(
        keyring,
        target.indexName,
        target.indexValue
      );
    }

    const credentialMatches = yield* readMatches(
      keyring,
      target.credentialName,
      target.credentialValue
    );
    const indexMatches = yield* readMatches(
      keyring,
      target.indexName,
      target.indexValue
    );
    return credentialMatches && indexMatches
      ? { rollback: 'succeeded', residualState: verifiedResidualState }
      : { rollback: 'failed', residualState: 'unknown' };
  });
}

function consistencyError(options: {
  readonly operation: AuthIndexConsistencyOperation;
  readonly phase: AuthIndexConsistencyPhase;
  readonly providerId: string;
  readonly rollback: AuthIndexRollback;
  readonly residualState: AuthIndexResidualState;
  readonly cause?: unknown;
}): AuthIndexConsistencyError {
  return new AuthIndexConsistencyError(options);
}

function writeScopedAuthSecret(
  keyring: KeyringServiceShape,
  target: AuthSecretReference & {
    readonly kind: 'scoped';
    readonly name: ScopedSecretName;
    readonly scope: NormalizedAuthStoreScope;
  },
  value: string
): Effect.Effect<
  AuthSecretReference,
  AuthIndexDocumentError | KeyringUnavailableError | AuthIndexConsistencyError
> {
  return Effect.gen(function* () {
    const providerId = target.providerId;
    const state = yield* readAuthIndexState(providerId, keyring);
    const previousCredential = yield* keyring.get(target.name);
    const nextDocument = upsertAuthIndexScope(state.document, target.scope);
    const previousIndex = state.raw;
    const nextIndex = serializeAuthIndexDocument(nextDocument);
    const indexChanges =
      nextIndex !== serializeAuthIndexDocument(state.document);
    const snapshot: AuthTransactionSnapshot = {
      credentialName: target.name,
      credentialValue: previousCredential,
      indexName: authIndexSecretName(providerId),
      indexValue: previousIndex,
    };

    if (!indexChanges) {
      const credentialWrite = yield* verifiedMutation(
        keyring,
        target.name,
        previousCredential,
        value
      );
      if (credentialWrite.kind === 'desired') return target;
      if (credentialWrite.kind === 'previous') {
        return yield* Effect.fail(credentialWrite.error);
      }

      const reconciliationTarget =
        previousCredential === null
          ? {
              ...snapshot,
              indexValue: serializeAuthIndexDocument(
                removeAuthIndexScope(state.document, target.scope)
              ),
            }
          : snapshot;
      const reconciliation = yield* reconcileAuthSnapshot(
        keyring,
        reconciliationTarget,
        true,
        previousCredential === null
      );
      return yield* Effect.fail(
        consistencyError({
          operation: 'write',
          phase: 'credential-write',
          providerId,
          ...reconciliation,
        })
      );
    }

    if (previousCredential === null) {
      const indexWrite = yield* verifiedMutation(
        keyring,
        snapshot.indexName,
        previousIndex,
        nextIndex
      );
      if (indexWrite.kind === 'previous') {
        return yield* Effect.fail(indexWrite.error);
      }
      if (indexWrite.kind === 'unknown') {
        const reconciliation = yield* reconcileAuthSnapshot(
          keyring,
          snapshot,
          false,
          true
        );
        return yield* Effect.fail(
          consistencyError({
            operation: 'write',
            phase: 'index-update',
            providerId,
            ...reconciliation,
          })
        );
      }

      const credentialWrite = yield* verifiedMutation(
        keyring,
        target.name,
        null,
        value
      );
      if (credentialWrite.kind === 'desired') return target;
      const reconciliation = yield* reconcileAuthSnapshot(
        keyring,
        snapshot,
        credentialWrite.kind === 'unknown',
        true
      );
      return yield* Effect.fail(
        consistencyError({
          operation: 'write',
          phase: 'credential-write',
          providerId,
          ...reconciliation,
        })
      );
    }

    const credentialWrite = yield* verifiedMutation(
      keyring,
      target.name,
      previousCredential,
      value
    );
    if (credentialWrite.kind === 'previous') {
      return yield* Effect.fail(credentialWrite.error);
    }
    if (credentialWrite.kind === 'unknown') {
      const reconciliation = yield* reconcileAuthSnapshot(
        keyring,
        snapshot,
        true,
        false
      );
      return yield* Effect.fail(
        consistencyError({
          operation: 'write',
          phase: 'credential-write',
          providerId,
          ...reconciliation,
        })
      );
    }

    const indexWrite = yield* verifiedMutation(
      keyring,
      snapshot.indexName,
      previousIndex,
      nextIndex
    );
    if (indexWrite.kind === 'desired') return target;
    const reconciliation = yield* reconcileAuthSnapshot(
      keyring,
      snapshot,
      true,
      indexWrite.kind === 'unknown'
    );
    return yield* Effect.fail(
      consistencyError({
        operation: 'write',
        phase: 'index-update',
        providerId,
        ...reconciliation,
      })
    );
  });
}

function deleteScopedAuthSecret(
  keyring: KeyringServiceShape,
  target: AuthSecretReference & {
    readonly kind: 'scoped';
    readonly name: ScopedSecretName;
    readonly scope: NormalizedAuthStoreScope;
  }
): Effect.Effect<
  boolean,
  AuthIndexDocumentError | KeyringUnavailableError | AuthIndexConsistencyError
> {
  return Effect.gen(function* () {
    const providerId = target.providerId;
    const state = yield* readAuthIndexState(providerId, keyring);
    const previousCredential = yield* keyring.get(target.name);
    const nextDocument = removeAuthIndexScope(state.document, target.scope);
    const previousIndex = state.raw;
    const nextIndex = serializeAuthIndexDocument(nextDocument);
    const indexChanges =
      nextIndex !== serializeAuthIndexDocument(state.document);
    const snapshot: AuthTransactionSnapshot = {
      credentialName: target.name,
      credentialValue: previousCredential,
      indexName: authIndexSecretName(providerId),
      indexValue: previousIndex,
    };

    let deleted = false;
    if (previousCredential !== null) {
      const credentialDelete = yield* verifiedMutation(
        keyring,
        target.name,
        previousCredential,
        null
      );
      if (credentialDelete.kind === 'previous') {
        return yield* Effect.fail(credentialDelete.error);
      }
      if (credentialDelete.kind === 'unknown') {
        const reconciliation = yield* reconcileAuthSnapshot(
          keyring,
          snapshot,
          true,
          false
        );
        return yield* Effect.fail(
          consistencyError({
            operation: 'delete',
            phase: 'credential-delete',
            providerId,
            ...reconciliation,
          })
        );
      }
      deleted = true;
    }
    if (!indexChanges) return deleted;

    const indexCleanup = yield* verifiedMutation(
      keyring,
      snapshot.indexName,
      previousIndex,
      nextIndex
    );
    if (indexCleanup.kind === 'desired') return deleted;
    if (indexCleanup.kind === 'previous' && !deleted) {
      return yield* Effect.fail(indexCleanup.error);
    }
    if (!deleted) {
      return yield* Effect.fail(
        consistencyError({
          operation: 'delete',
          phase: 'index-cleanup',
          providerId,
          rollback: 'not-needed',
          residualState: 'unknown',
        })
      );
    }

    const reconciliation = yield* reconcileAuthSnapshot(
      keyring,
      snapshot,
      true,
      indexCleanup.kind === 'unknown'
    );
    return yield* Effect.fail(
      consistencyError({
        operation: 'delete',
        phase: 'index-cleanup',
        providerId,
        ...reconciliation,
      })
    );
  });
}

function capturedEntryScopes(
  entries: readonly CapturedAuthProviderCatalogEntry[]
): readonly NormalizedAuthStoreScope[] {
  const scopes: NormalizedAuthStoreScope[] = [];
  const entryCount = ownHostArrayLength(entries);
  if (entryCount === undefined) {
    throw new TypeError('Invalid host captured auth entries');
  }
  for (let index = 0; index < entryCount; index += 1) {
    const entry = ownHostArrayValue<CapturedAuthProviderCatalogEntry>(
      entries,
      index
    );
    if (entry === undefined) {
      throw new TypeError('Invalid host captured auth entry');
    }
    appendHostArrayValue(scopes, entry.scope);
  }
  return objectFreeze(scopes);
}

function captureIndexedAuthTargets(
  providerId: string,
  keyring: KeyringServiceShape
): Effect.Effect<
  readonly CapturedAuthProviderCatalogEntry[],
  AuthIndexDocumentError | KeyringUnavailableError | AuthIndexConsistencyError
> {
  return Effect.gen(function* () {
    const state = yield* readAuthIndexState(providerId, keyring);
    const liveEntries: CapturedAuthProviderCatalogEntry[] = [];
    const scopeCount = ownHostArrayLength(state.document.scopes);
    if (scopeCount === undefined) {
      throw new TypeError('Invalid host auth index scopes');
    }
    for (let index = 0; index < scopeCount; index += 1) {
      const scope = ownHostArrayValue<NormalizedAuthStoreScope>(
        state.document.scopes,
        index
      );
      if (scope === undefined) {
        throw new TypeError('Invalid host auth index scope');
      }
      const value = yield* keyring.get(authIndexScopeName(scope));
      if (value !== null) {
        appendHostArrayValue(liveEntries, objectFreeze({ scope, value }));
      }
    }

    if (liveEntries.length !== state.document.scopes.length) {
      const indexName = authIndexSecretName(providerId);
      const repairedValue = serializeAuthIndexDocument(
        makeAuthIndexDocument(providerId, capturedEntryScopes(liveEntries))
      );
      const repair = yield* verifiedMutation(
        keyring,
        indexName,
        state.raw,
        repairedValue
      );
      if (repair.kind === 'previous') return yield* Effect.fail(repair.error);
      if (repair.kind === 'unknown') {
        return yield* Effect.fail(
          consistencyError({
            operation: 'repair',
            phase: 'index-cleanup',
            providerId,
            rollback: 'not-needed',
            residualState: 'unknown',
          })
        );
      }
    }
    return objectFreeze(liveEntries);
  });
}

function enumerateIndexedAuthScopes(
  providerId: string,
  keyring: KeyringServiceShape
): Effect.Effect<
  readonly NormalizedAuthStoreScope[],
  AuthIndexDocumentError | KeyringUnavailableError | AuthIndexConsistencyError
> {
  return Effect.map(
    captureIndexedAuthTargets(providerId, keyring),
    capturedEntryScopes
  );
}

function captureAuthProviderCatalog(
  providerId: string,
  keyring: KeyringServiceShape
): Effect.Effect<
  CapturedAuthProviderCatalog,
  AuthIndexDocumentError | KeyringUnavailableError | AuthIndexConsistencyError
> {
  return Effect.gen(function* () {
    const entries = yield* captureIndexedAuthTargets(providerId, keyring);
    const legacyName = legacyAuthSecretName(providerId);
    const legacyValue =
      legacyName === null ? null : yield* keyring.get(legacyName);
    return new CapturedAuthProviderCatalog(legacyValue, entries);
  });
}

/**
 * @internal Trusted built-in provider discovery only.
 *
 * Captures the provider index, every live indexed payload, and the separate
 * legacy payload while holding one provider-scoped cross-process lease. Aide-
 * managed scoped writers use the same lease and therefore linearize strictly
 * before or after this capture. Payload parsing must happen only after this
 * Effect returns and releases the lease.
 */
export function captureAuthProviderCatalogEffect(
  providerId: AuthProviderId
): Effect.Effect<
  CapturedAuthProviderCatalog,
  AuthIndexReadError,
  KeyringService
> {
  const normalizedProviderId = normalizeAuthProviderId(providerId);
  if (normalizedProviderId === undefined) {
    return Effect.fail(new AuthIndexProviderError());
  }
  return Effect.flatMap(KeyringService, (keyring) =>
    withAuthIndexLock(
      normalizedProviderId,
      Effect.uninterruptible(
        captureAuthProviderCatalog(normalizedProviderId, keyring)
      )
    )
  );
}

export function listIndexedAuthScopesEffect(
  providerId: AuthProviderId
): Effect.Effect<
  readonly NormalizedAuthStoreScope[],
  AuthIndexReadError,
  KeyringService
> {
  const normalizedProviderId = normalizeAuthProviderId(providerId);
  if (normalizedProviderId === undefined) {
    return Effect.fail(new AuthIndexProviderError());
  }
  return Effect.flatMap(KeyringService, (keyring) =>
    withAuthIndexLock(
      normalizedProviderId,
      Effect.uninterruptible(
        enumerateIndexedAuthScopes(normalizedProviderId, keyring)
      )
    )
  );
}

type AuthSecretReferencePropertySnapshot =
  | { readonly kind: 'data'; readonly value: unknown }
  | { readonly kind: 'absent' }
  | { readonly kind: 'invalid' };

function snapshotAuthSecretReferenceProperty(
  reference: object,
  name: keyof AuthSecretReference
): AuthSecretReferencePropertySnapshot {
  try {
    const descriptor = objectGetOwnPropertyDescriptor(reference, name);
    if (descriptor === undefined) return { kind: 'absent' };
    if (!objectHasOwn(descriptor, 'value')) return { kind: 'invalid' };
    return { kind: 'data', value: descriptor.value };
  } catch {
    return { kind: 'invalid' };
  }
}

function validateAuthSecretReference(
  reference: AuthSecretReference
): AuthSecretReference | AuthIndexProviderError | AuthSecretReferenceError {
  if (
    typeof reference !== 'object' ||
    reference === null ||
    isProxy(reference) ||
    arrayIsArray(reference)
  ) {
    return new AuthSecretReferenceError('invalid-reference');
  }

  const providerProperty = snapshotAuthSecretReferenceProperty(
    reference,
    'providerId'
  );
  if (providerProperty.kind !== 'data') {
    return new AuthSecretReferenceError('invalid-reference');
  }
  if (typeof providerProperty.value !== 'string') {
    return new AuthIndexProviderError();
  }
  const providerId = normalizeAuthProviderId(providerProperty.value);
  if (providerId === undefined) return new AuthIndexProviderError();

  const nameProperty = snapshotAuthSecretReferenceProperty(reference, 'name');
  const kindProperty = snapshotAuthSecretReferenceProperty(reference, 'kind');
  const scopeProperty = snapshotAuthSecretReferenceProperty(reference, 'scope');
  if (
    nameProperty.kind !== 'data' ||
    typeof nameProperty.value !== 'string' ||
    kindProperty.kind !== 'data' ||
    (kindProperty.value !== 'legacy' && kindProperty.value !== 'scoped') ||
    scopeProperty.kind === 'invalid'
  ) {
    return new AuthSecretReferenceError('invalid-reference', providerId);
  }

  const scope = scopeProperty.kind === 'data' ? scopeProperty.value : undefined;
  if (
    (kindProperty.value === 'legacy' && scope !== undefined) ||
    (kindProperty.value === 'scoped' &&
      (typeof scope !== 'object' || scope === null))
  ) {
    return new AuthSecretReferenceError('invalid-reference', providerId);
  }

  const expected = authSecretTarget(
    providerId,
    kindProperty.value === 'scoped' ? (scope as AuthStoreScope) : undefined
  );
  if (
    expected === null ||
    expected.kind !== kindProperty.value ||
    expected.name !== nameProperty.value
  ) {
    return new AuthSecretReferenceError('reference-mismatch', providerId);
  }
  return expected;
}

export function readAuthSecretEffect(
  reference: AuthSecretReference
): Effect.Effect<
  ResolvedAuthSecret | null,
  AuthIndexProviderError | AuthSecretReferenceError | KeyringUnavailableError,
  KeyringService
> {
  const validated = validateAuthSecretReference(reference);
  if (
    validated instanceof AuthIndexProviderError ||
    validated instanceof AuthSecretReferenceError
  ) {
    return Effect.fail(validated);
  }
  return Effect.flatMap(KeyringService, (keyring) =>
    Effect.map(keyring.get(validated.name), (value) =>
      value === null ? null : { ...validated, value }
    )
  );
}

export function resolveAuthSecretEffect(
  providerId: AuthProviderId,
  scope?: AuthStoreScope
): Effect.Effect<
  ResolvedAuthSecret | null,
  AuthIndexProviderError | AuthStoreValidationError | KeyringUnavailableError,
  KeyringService
> {
  const normalizedProviderId = normalizeAuthProviderId(providerId);
  if (normalizedProviderId === undefined) {
    return Effect.fail(new AuthIndexProviderError());
  }
  const candidates = authSecretCandidates(normalizedProviderId, scope);
  if (scope !== undefined && candidates.length === 0) {
    return Effect.fail(
      new AuthStoreValidationError('invalid-target', normalizedProviderId)
    );
  }
  return Effect.flatMap(KeyringService, (keyring) =>
    Effect.gen(function* () {
      const candidateCount = ownHostArrayLength(candidates);
      if (candidateCount === undefined) {
        return yield* Effect.fail(
          new AuthStoreValidationError('invalid-target', normalizedProviderId)
        );
      }
      for (let index = 0; index < candidateCount; index += 1) {
        const candidate = ownHostArrayValue<AuthSecretReference>(
          candidates,
          index
        );
        if (candidate === undefined) {
          return yield* Effect.fail(
            new AuthStoreValidationError('invalid-target', normalizedProviderId)
          );
        }
        const value = yield* keyring.get(candidate.name);
        if (value !== null) return { ...candidate, value };
      }
      return null;
    })
  );
}

export function listAuthSecretsEffect(
  providerId: AuthProviderId,
  scope?: AuthStoreScope
): Effect.Effect<
  readonly ResolvedAuthSecret[],
  AuthIndexProviderError | AuthStoreValidationError | KeyringUnavailableError,
  KeyringService
> {
  const normalizedProviderId = normalizeAuthProviderId(providerId);
  if (normalizedProviderId === undefined) {
    return Effect.fail(new AuthIndexProviderError());
  }
  const candidates = authSecretCandidates(normalizedProviderId, scope);
  if (scope !== undefined && candidates.length === 0) {
    return Effect.fail(
      new AuthStoreValidationError('invalid-target', normalizedProviderId)
    );
  }
  return Effect.flatMap(KeyringService, (keyring) =>
    Effect.gen(function* () {
      const resolved: ResolvedAuthSecret[] = [];
      const candidateCount = ownHostArrayLength(candidates);
      if (candidateCount === undefined) {
        return yield* Effect.fail(
          new AuthStoreValidationError('invalid-target', normalizedProviderId)
        );
      }
      for (let index = 0; index < candidateCount; index += 1) {
        const candidate = ownHostArrayValue<AuthSecretReference>(
          candidates,
          index
        );
        if (candidate === undefined) {
          return yield* Effect.fail(
            new AuthStoreValidationError('invalid-target', normalizedProviderId)
          );
        }
        const value = yield* keyring.get(candidate.name);
        if (value !== null) {
          appendHostArrayValue(resolved, { ...candidate, value });
        }
      }
      return objectFreeze(resolved);
    })
  );
}

export function writeAuthSecretEffect(
  providerId: AuthProviderId,
  value: string,
  scope?: AuthStoreScope
): Effect.Effect<AuthSecretReference, AuthIndexMutationError, KeyringService> {
  const normalizedProviderId = normalizeAuthProviderId(providerId);
  if (normalizedProviderId === undefined) {
    return Effect.fail(new AuthIndexProviderError());
  }
  const target = authSecretTarget(normalizedProviderId, scope);
  if (target === null) {
    return Effect.fail(
      new AuthStoreValidationError('invalid-target', normalizedProviderId)
    );
  }
  if (target.kind === 'legacy') {
    return Effect.flatMap(KeyringService, (keyring) =>
      Effect.as(keyring.set(target.name, value), target)
    );
  }
  if (target.scope === undefined) {
    return Effect.fail(
      new AuthStoreValidationError('invalid-index-scope', normalizedProviderId)
    );
  }
  const targetScope = target.scope;
  return Effect.flatMap(KeyringService, (keyring) =>
    withAuthIndexLock(
      target.providerId,
      Effect.uninterruptible(
        writeScopedAuthSecret(
          keyring,
          {
            ...target,
            kind: 'scoped',
            name: authIndexScopeName(targetScope),
            scope: targetScope,
          },
          value
        )
      )
    )
  );
}

export function deleteAuthSecretEffect(
  providerId: AuthProviderId,
  scope?: AuthStoreScope
): Effect.Effect<boolean, AuthIndexMutationError, KeyringService> {
  const normalizedProviderId = normalizeAuthProviderId(providerId);
  if (normalizedProviderId === undefined) {
    return Effect.fail(new AuthIndexProviderError());
  }
  const target = authSecretTarget(normalizedProviderId, scope);
  if (target === null) {
    return Effect.fail(
      new AuthStoreValidationError('invalid-target', normalizedProviderId)
    );
  }
  if (target.kind === 'legacy') {
    return Effect.flatMap(KeyringService, (keyring) =>
      keyring.delete(target.name)
    );
  }
  if (target.scope === undefined) {
    return Effect.fail(
      new AuthStoreValidationError('invalid-index-scope', normalizedProviderId)
    );
  }
  const targetScope = target.scope;
  return Effect.flatMap(KeyringService, (keyring) =>
    withAuthIndexLock(
      target.providerId,
      Effect.uninterruptible(
        deleteScopedAuthSecret(keyring, {
          ...target,
          kind: 'scoped',
          name: authIndexScopeName(targetScope),
          scope: targetScope,
        })
      )
    )
  );
}

function provideLive<A, E>(
  effect: Effect.Effect<A, E, KeyringService>
): Effect.Effect<A, E> {
  return effect.pipe(Effect.provide(KeyringLive));
}

/** @deprecated Live compatibility adapter. Use listIndexedAuthScopesEffect. */
export function listIndexedAuthScopes(
  providerId: AuthProviderId
): Effect.Effect<readonly NormalizedAuthStoreScope[], AuthIndexReadError> {
  return provideLive(listIndexedAuthScopesEffect(providerId));
}

/** @deprecated Live compatibility adapter. Use readAuthSecretEffect. */
export function readAuthSecret(
  reference: AuthSecretReference
): Effect.Effect<
  ResolvedAuthSecret | null,
  AuthIndexProviderError | AuthSecretReferenceError | KeyringUnavailableError
> {
  return provideLive(readAuthSecretEffect(reference));
}

/** @deprecated Live compatibility adapter. Use resolveAuthSecretEffect. */
export function resolveAuthSecret(
  providerId: AuthProviderId,
  scope?: AuthStoreScope
): Effect.Effect<
  ResolvedAuthSecret | null,
  AuthIndexProviderError | AuthStoreValidationError | KeyringUnavailableError
> {
  return provideLive(resolveAuthSecretEffect(providerId, scope));
}

/** @deprecated Live compatibility adapter. Use listAuthSecretsEffect. */
export function listAuthSecrets(
  providerId: AuthProviderId,
  scope?: AuthStoreScope
): Effect.Effect<
  readonly ResolvedAuthSecret[],
  AuthIndexProviderError | AuthStoreValidationError | KeyringUnavailableError
> {
  return provideLive(listAuthSecretsEffect(providerId, scope));
}

/** @deprecated Live compatibility adapter. Use writeAuthSecretEffect. */
export function writeAuthSecret(
  providerId: AuthProviderId,
  value: string,
  scope?: AuthStoreScope
): Effect.Effect<AuthSecretReference, AuthIndexMutationError> {
  return provideLive(writeAuthSecretEffect(providerId, value, scope));
}

/** @deprecated Live compatibility adapter. Use deleteAuthSecretEffect. */
export function deleteAuthSecret(
  providerId: AuthProviderId,
  scope?: AuthStoreScope
): Effect.Effect<boolean, AuthIndexMutationError> {
  return provideLive(deleteAuthSecretEffect(providerId, scope));
}

/** @deprecated Live compatibility adapter. Use listIndexedAuthScopesEffect. */
export async function listIndexedAuthScopesPromise(
  providerId: AuthProviderId
): Promise<readonly NormalizedAuthStoreScope[]> {
  const result = await Effect.runPromise(
    Effect.either(
      listIndexedAuthScopesEffect(providerId).pipe(Effect.provide(KeyringLive))
    )
  );
  if (result._tag === 'Left') throw result.left;
  return result.right;
}

/** @deprecated Live compatibility adapter. Use resolveAuthSecretEffect. */
export async function resolveAuthSecretPromise(
  providerId: AuthProviderId,
  scope?: AuthStoreScope
): Promise<ResolvedAuthSecret | null> {
  const result = await Effect.runPromise(
    Effect.either(
      resolveAuthSecretEffect(providerId, scope).pipe(
        Effect.provide(KeyringLive)
      )
    )
  );
  if (result._tag === 'Left') throw result.left;
  return result.right;
}
