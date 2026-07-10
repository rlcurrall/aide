import { constants, writeSync } from 'node:fs';
import { lstat, mkdir, open, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import { Effect, Exit } from 'effect';
import * as lockfile from 'proper-lockfile';

const AUTH_INDEX_LOCK_STALE_MS = 30_000;
const AUTH_INDEX_LOCK_UPDATE_MS = 5_000;

export type AuthIndexLockPhase = 'acquire' | 'release';
export type AuthIndexLockFailureCode =
  | 'invalid-location'
  | 'unsafe-location'
  | 'timeout'
  | 'unavailable';
export type AuthIndexProtectedOperationOutcome =
  | 'not-started'
  | 'succeeded'
  | 'failed';

/**
 * A redacted coordination failure. Filesystem paths and backend error text are
 * deliberately excluded because both can contain user-controlled data.
 */
export class AuthIndexLockError extends Error {
  override readonly name = 'AuthIndexLockError';
  readonly code: AuthIndexLockFailureCode;
  readonly phase: AuthIndexLockPhase;
  readonly providerId: string;
  readonly protectedOperationOutcome: AuthIndexProtectedOperationOutcome;

  constructor(options: {
    readonly code: AuthIndexLockFailureCode;
    readonly phase: AuthIndexLockPhase;
    readonly providerId: string;
    readonly protectedOperationOutcome: AuthIndexProtectedOperationOutcome;
  }) {
    super(
      `Auth index coordination ${options.phase} failed (${options.code}); protected operation ${options.protectedOperationOutcome}.`
    );
    this.code = options.code;
    this.phase = options.phase;
    this.providerId = options.providerId;
    this.protectedOperationOutcome = options.protectedOperationOutcome;
    Object.setPrototypeOf(this, AuthIndexLockError.prototype);
  }
}

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
  protectedOperationOutcome: AuthIndexProtectedOperationOutcome
): AuthIndexLockError {
  return new AuthIndexLockError({
    code,
    phase,
    providerId,
    protectedOperationOutcome,
  });
}

function currentUid(providerId: string): number {
  if (typeof process.getuid !== 'function') {
    throw lockError(providerId, 'acquire', 'unavailable', 'not-started');
  }
  return process.getuid();
}

function requestedLockRoot(providerId: string, uid: number): string {
  const override = Bun.env.AIDE_AUTH_INDEX_LOCK_ROOT;
  if (override !== undefined) {
    if (!isAbsolute(override)) {
      throw lockError(providerId, 'acquire', 'invalid-location', 'not-started');
    }
    return resolve(override);
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
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
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
  root: string,
  uid: number
): Promise<string> {
  const target = join(root, lockTargetName(providerId));
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
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
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

async function acquireAuthIndexLock(
  providerId: string
): Promise<AuthIndexLockLease> {
  try {
    const uid = currentUid(providerId);
    const root = await validateLockRoot(
      providerId,
      requestedLockRoot(providerId, uid),
      uid
    );
    const target = await ensureLockTarget(providerId, root, uid);
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
  } catch (error) {
    if (error instanceof AuthIndexLockError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    throw lockError(
      providerId,
      'acquire',
      code === 'ELOCKED' ? 'timeout' : 'unavailable',
      'not-started'
    );
  }
}

function releaseAuthIndexLock(
  providerId: string,
  lease: AuthIndexLockLease,
  protectedOperationOutcome: Exclude<
    AuthIndexProtectedOperationOutcome,
    'not-started'
  >
): Effect.Effect<void, AuthIndexLockError, never> {
  return Effect.tryPromise({
    try: lease.release,
    catch: () =>
      lockError(
        providerId,
        'release',
        'unavailable',
        protectedOperationOutcome
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
  return Effect.suspend(() => {
    let releaseFailure: AuthIndexLockError | undefined;
    let protectedOperationOutcome: 'succeeded' | 'failed' = 'failed';

    const managed: Effect.Effect<
      Exit.Exit<A, E>,
      AuthIndexLockError,
      R
    > = Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () => acquireAuthIndexLock(providerId),
        catch: (error) =>
          error instanceof AuthIndexLockError
            ? error
            : lockError(providerId, 'acquire', 'unavailable', 'not-started'),
      }),
      () =>
        Effect.exit(effect).pipe(
          Effect.tap((exit) =>
            Effect.sync(() => {
              protectedOperationOutcome = Exit.isSuccess(exit)
                ? 'succeeded'
                : 'failed';
            })
          )
        ),
      (lease) =>
        releaseAuthIndexLock(providerId, lease, protectedOperationOutcome).pipe(
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
        if (releaseFailure !== undefined) return Effect.fail(releaseFailure);
        if (Exit.isFailure(protectedExit)) {
          return Effect.failCause(protectedExit.cause);
        }
        return Effect.succeed(protectedExit.value);
      }
    );
  });
}
