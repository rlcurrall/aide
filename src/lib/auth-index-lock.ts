import { constants, writeSync } from 'node:fs';
import { lstat, mkdir, open, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { inspect } from 'node:util';
import { isProxy as nodeIsProxy } from 'node:util/types';

import { Cause, Data, Effect, Exit, Option } from 'effect';
import * as lockfile from 'proper-lockfile';

import { normalizeAuthProviderId } from './auth-index-codec.js';

const AUTH_INDEX_LOCK_STALE_MS = 30_000;
const AUTH_INDEX_LOCK_UPDATE_MS = 5_000;

export type AuthIndexLockPhase = 'acquire' | 'release';
export type AuthIndexLockReason =
  | 'contention-timeout'
  | 'acquire-failed'
  | 'release-failed'
  | 'cleanup-failed';
export type AuthIndexLockFailureCode =
  | 'invalid-location'
  | 'unsafe-location'
  | 'timeout'
  | 'unavailable';
export type AuthIndexProtectedOperationOutcome =
  | 'not-started'
  | 'succeeded'
  | 'failed';

interface AuthIndexLockErrorFields {
  readonly reason: AuthIndexLockReason;
  readonly code: AuthIndexLockFailureCode;
  readonly phase: AuthIndexLockPhase;
  readonly providerId: string;
  readonly protectedOperationOutcome: AuthIndexProtectedOperationOutcome;
}

const isProxy = nodeIsProxy;
const invalidLockErrorOptionsMessage =
  'Invalid AuthIndexLockError constructor options.';
const brandedLockErrors = new WeakSet<object>();

const lockErrorReasons: ReadonlySet<string> = new Set<AuthIndexLockReason>([
  'contention-timeout',
  'acquire-failed',
  'release-failed',
  'cleanup-failed',
]);
const lockErrorCodes: ReadonlySet<string> = new Set<AuthIndexLockFailureCode>([
  'invalid-location',
  'unsafe-location',
  'timeout',
  'unavailable',
]);
const lockErrorPhases: ReadonlySet<string> = new Set<AuthIndexLockPhase>([
  'acquire',
  'release',
]);
const protectedOperationOutcomes: ReadonlySet<string> =
  new Set<AuthIndexProtectedOperationOutcome>([
    'not-started',
    'succeeded',
    'failed',
  ]);

function invalidLockErrorOptions(): TypeError {
  return new TypeError(invalidLockErrorOptionsMessage);
}

function ownDataValue(
  options: object,
  key: keyof AuthIndexLockErrorFields
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(options, key);
  if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
    throw invalidLockErrorOptions();
  }
  return descriptor.value;
}

function snapshotLockErrorFields(options: unknown): AuthIndexLockErrorFields {
  if (typeof options !== 'object' || options === null) {
    throw invalidLockErrorOptions();
  }

  try {
    if (isProxy(options)) throw invalidLockErrorOptions();

    const reason = ownDataValue(options, 'reason');
    const code = ownDataValue(options, 'code');
    const phase = ownDataValue(options, 'phase');
    const providerId = ownDataValue(options, 'providerId');
    const protectedOperationOutcome = ownDataValue(
      options,
      'protectedOperationOutcome'
    );

    if (
      typeof reason !== 'string' ||
      !lockErrorReasons.has(reason) ||
      typeof code !== 'string' ||
      !lockErrorCodes.has(code) ||
      typeof phase !== 'string' ||
      !lockErrorPhases.has(phase) ||
      typeof providerId !== 'string' ||
      normalizeAuthProviderId(providerId) !== providerId ||
      typeof protectedOperationOutcome !== 'string' ||
      !protectedOperationOutcomes.has(protectedOperationOutcome)
    ) {
      throw invalidLockErrorOptions();
    }

    return Object.freeze({
      reason: reason as AuthIndexLockReason,
      code: code as AuthIndexLockFailureCode,
      phase: phase as AuthIndexLockPhase,
      providerId,
      protectedOperationOutcome:
        protectedOperationOutcome as AuthIndexProtectedOperationOutcome,
    });
  } catch {
    throw invalidLockErrorOptions();
  }
}

function lockErrorMessage(fields: AuthIndexLockErrorFields): string {
  return `Auth index coordination ${fields.phase} failed (${fields.code}); protected operation ${fields.protectedOperationOutcome}.`;
}

function lockErrorJson(fields: AuthIndexLockErrorFields) {
  return Object.freeze({
    reason: fields.reason,
    code: fields.code,
    phase: fields.phase,
    providerId: fields.providerId,
    protectedOperationOutcome: fields.protectedOperationOutcome,
    _tag: 'AuthIndexLockError' as const,
  });
}

/**
 * A redacted coordination failure. Filesystem paths and backend error text are
 * deliberately excluded because both can contain user-controlled data.
 */
export class AuthIndexLockError extends Data.TaggedError(
  'AuthIndexLockError'
)<AuthIndexLockErrorFields> {
  constructor(options: AuthIndexLockErrorFields) {
    if (new.target !== AuthIndexLockError) throw invalidLockErrorOptions();
    const fields = snapshotLockErrorFields(options);
    super(fields);
    Object.freeze(this);
    brandedLockErrors.add(this);
  }

  override get name(): string {
    return 'AuthIndexLockError';
  }

  override get message(): string {
    return lockErrorMessage(this);
  }

  override toJSON() {
    return lockErrorJson(this);
  }

  override toString(): string {
    return `AuthIndexLockError: ${lockErrorMessage(this)}`;
  }

  [inspect.custom]() {
    return lockErrorJson(this);
  }
}

Object.freeze(AuthIndexLockError.prototype);
Object.freeze(AuthIndexLockError);

/**
 * An ownership compromise is not recoverable inside the current process:
 * already-started keyring promises cannot be cancelled safely. The heartbeat
 * callback reports only this redacted error and exits synchronously, making
 * compromise a fail-stop event instead of an ordinary Effect failure.
 */
export class AuthIndexLockCompromisedFatalError extends Error {
  override readonly name = 'AuthIndexLockCompromisedFatalError';

  constructor() {
    super('Auth index lock ownership was compromised; terminating safely.');
    Object.setPrototypeOf(this, AuthIndexLockCompromisedFatalError.prototype);
  }
}

function failStopCompromisedLock(): never {
  const fatalError = new AuthIndexLockCompromisedFatalError();
  try {
    writeSync(2, `${fatalError.name}: ${fatalError.message}\n`);
  } catch {
    // A broken stderr must not delay termination after ownership is lost.
  }
  process.exit(1);
}

interface AuthIndexLockLease {
  readonly release: () => Promise<void>;
}

function lockError(
  providerId: string,
  phase: AuthIndexLockPhase,
  code: AuthIndexLockFailureCode,
  protectedOperationOutcome: AuthIndexProtectedOperationOutcome,
  reason: AuthIndexLockReason = phase === 'release'
    ? 'release-failed'
    : code === 'timeout'
      ? 'contention-timeout'
      : 'acquire-failed'
): AuthIndexLockError {
  return new AuthIndexLockError({
    reason,
    code,
    phase,
    providerId,
    protectedOperationOutcome,
  });
}

function currentUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

function requestedLockRoot(uid: number): string | undefined {
  const override = Bun.env.AIDE_AUTH_INDEX_LOCK_ROOT;
  if (override !== undefined) {
    return isAbsolute(override) ? resolve(override) : undefined;
  }
  return join('/tmp', `aide-auth-index-locks-${uid}`);
}

function isSecureParent(
  ownerUid: number,
  mode: number,
  currentUserUid: number
): boolean {
  const groupOrOtherWritable = (mode & 0o022) !== 0;
  if (ownerUid === currentUserUid && !groupOrOtherWritable) return true;

  const rootOwnedStickyDirectory =
    ownerUid === 0 && (mode & 0o1000) !== 0 && (mode & 0o002) !== 0;
  return rootOwnedStickyDirectory;
}

async function validateLockRoot(
  providerId: string,
  requestedRoot: string,
  uid: number
): Promise<string> {
  const parent = await realpath(dirname(requestedRoot));
  const root = join(parent, basename(requestedRoot));
  const parentInfo = await stat(parent);
  if (
    !parentInfo.isDirectory() ||
    !isSecureParent(parentInfo.uid, parentInfo.mode, uid)
  ) {
    throw lockError(providerId, 'acquire', 'unsafe-location', 'not-started');
  }

  try {
    await mkdir(root, { mode: 0o700 });
  } catch (error) {
    if (ordinaryErrorCode(error) !== 'EEXIST') throw error;
  }

  const rootInfo = await lstat(root);
  if (
    !rootInfo.isDirectory() ||
    rootInfo.isSymbolicLink() ||
    rootInfo.uid !== uid ||
    (rootInfo.mode & 0o777) !== 0o700
  ) {
    throw lockError(providerId, 'acquire', 'unsafe-location', 'not-started');
  }
  return root;
}

function lockTargetName(providerId: string): string {
  const digest = createHash('sha256').update(providerId, 'utf8').digest('hex');
  return `provider-${digest}.target`;
}

async function ensureLockTarget(
  providerId: string,
  targetName: string,
  root: string,
  uid: number
): Promise<string> {
  const target = join(root, targetName);
  try {
    const handle = await open(
      target,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600
    );
    await handle.close();
  } catch (error) {
    if (ordinaryErrorCode(error) !== 'EEXIST') throw error;
  }

  const targetInfo = await lstat(target);
  if (
    !targetInfo.isFile() ||
    targetInfo.isSymbolicLink() ||
    targetInfo.uid !== uid ||
    (targetInfo.mode & 0o777) !== 0o600
  ) {
    throw lockError(providerId, 'acquire', 'unsafe-location', 'not-started');
  }
  return target;
}

function snapshotBrandedLockError(
  error: unknown
): AuthIndexLockError | undefined {
  if (
    (typeof error !== 'object' && typeof error !== 'function') ||
    error === null
  ) {
    return undefined;
  }
  try {
    if (isProxy(error) || !brandedLockErrors.has(error)) return undefined;
    return new AuthIndexLockError(snapshotLockErrorFields(error));
  } catch {
    return undefined;
  }
}

function ordinaryErrorCode(error: unknown): string | undefined {
  if (
    (typeof error !== 'object' && typeof error !== 'function') ||
    error === null
  ) {
    return undefined;
  }
  try {
    if (isProxy(error)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
    if (
      descriptor === undefined ||
      !Object.hasOwn(descriptor, 'value') ||
      typeof descriptor.value !== 'string'
    ) {
      return undefined;
    }
    return descriptor.value;
  } catch {
    return undefined;
  }
}

function normalizeAcquireError(
  providerId: string,
  error: unknown
): AuthIndexLockError {
  const existing = snapshotBrandedLockError(error);
  if (existing !== undefined) return existing;
  return lockError(
    providerId,
    'acquire',
    ordinaryErrorCode(error) === 'ELOCKED' ? 'timeout' : 'unavailable',
    'not-started'
  );
}

function acquireAuthIndexLock(
  providerId: string
): Effect.Effect<AuthIndexLockLease, AuthIndexLockError> {
  return Effect.suspend(() => {
    const uid = currentUid();
    if (uid === undefined) {
      return Effect.fail(
        lockError(providerId, 'acquire', 'unavailable', 'not-started')
      );
    }
    const requestedRoot = requestedLockRoot(uid);
    if (requestedRoot === undefined) {
      return Effect.fail(
        lockError(providerId, 'acquire', 'invalid-location', 'not-started')
      );
    }
    const targetName = lockTargetName(providerId);

    return Effect.tryPromise({
      try: async () => {
        const root = await validateLockRoot(providerId, requestedRoot, uid);
        const target = await ensureLockTarget(
          providerId,
          targetName,
          root,
          uid
        );
        const release = await lockfile.lock(target, {
          realpath: true,
          stale: AUTH_INDEX_LOCK_STALE_MS,
          update: AUTH_INDEX_LOCK_UPDATE_MS,
          retries: {
            retries: 30,
            factor: 1.2,
            minTimeout: 25,
            maxTimeout: 250,
            randomize: true,
          },
          onCompromised: failStopCompromisedLock,
        });
        return { release };
      },
      catch: (error) => normalizeAcquireError(providerId, error),
    });
  });
}

function releaseAuthIndexLock(
  providerId: string,
  lease: AuthIndexLockLease,
  protectedOperationOutcome: Exclude<
    AuthIndexProtectedOperationOutcome,
    'not-started'
  >,
  reason: Extract<AuthIndexLockReason, 'release-failed' | 'cleanup-failed'>
): Effect.Effect<void, AuthIndexLockError, never> {
  return Effect.tryPromise({
    try: lease.release,
    catch: () =>
      lockError(
        providerId,
        'release',
        'unavailable',
        protectedOperationOutcome,
        reason
      ),
  });
}

/**
 * Acquire one canonical provider's cross-process lock, run the protected
 * Effect, and always release the lease. Release failures take precedence over
 * the protected result because callers must not mistake an unknown lock state
 * for a cleanly completed transaction.
 */
export function withAuthIndexLock<A, E, R>(
  providerId: string,
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E | AuthIndexLockError, R> {
  return Effect.uninterruptibleMask((restore) => {
    let releaseFailure: AuthIndexLockError | undefined;
    let protectedOperationOutcome: 'succeeded' | 'failed' = 'failed';
    let protectedOperationInterrupted = false;

    const managed: Effect.Effect<
      Exit.Exit<A, E>,
      AuthIndexLockError,
      R
    > = Effect.acquireUseRelease(
      acquireAuthIndexLock(providerId),
      () =>
        Effect.exit(restore(effect)).pipe(
          Effect.tap((exit) =>
            Effect.sync(() => {
              protectedOperationOutcome = Exit.isSuccess(exit)
                ? 'succeeded'
                : 'failed';
              protectedOperationInterrupted =
                Exit.isFailure(exit) && Cause.isInterrupted(exit.cause);
            })
          )
        ),
      (lease) =>
        releaseAuthIndexLock(
          providerId,
          lease,
          protectedOperationOutcome,
          protectedOperationInterrupted ? 'cleanup-failed' : 'release-failed'
        ).pipe(
          Effect.catchAll((error) =>
            Effect.sync(() => {
              releaseFailure = error;
            })
          )
        )
    );

    return Effect.flatMap(
      managed,
      (protectedExit): Effect.Effect<A, E | AuthIndexLockError, never> => {
        if (releaseFailure !== undefined) {
          if (Exit.isFailure(protectedExit)) {
            const protectedDefects = Cause.keepDefects(protectedExit.cause);
            if (Option.isSome(protectedDefects)) {
              return Effect.failCause(
                Cause.sequential(
                  Cause.fail(releaseFailure),
                  protectedDefects.value
                )
              );
            }
          }
          return Effect.fail(releaseFailure);
        }
        if (Exit.isFailure(protectedExit)) {
          return Effect.failCause(protectedExit.cause);
        }
        return Effect.succeed(protectedExit.value);
      }
    );
  });
}
