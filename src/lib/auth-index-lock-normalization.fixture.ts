import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { mock } from 'bun:test';
import { Cause, Effect, Exit, Option } from 'effect';

const secret = 'AUTH_LOCK_NORMALIZATION_SECRET_6a42';
const noRejection = Symbol('no-rejection');
let acquireRejection: unknown | typeof noRejection = noRejection;
let releaseRejection: unknown | typeof noRejection = noRejection;

mock.module('proper-lockfile', () => ({
  lock: async () => {
    if (acquireRejection !== noRejection) {
      const rejection = acquireRejection;
      acquireRejection = noRejection;
      throw rejection;
    }
    return async () => {
      if (releaseRejection !== noRejection) {
        const rejection = releaseRejection;
        releaseRejection = noRejection;
        throw rejection;
      }
    };
  },
}));

const { AuthIndexLockError, withAuthIndexLock } =
  await import('./auth-index-lock.js');
type LockError = InstanceType<typeof AuthIndexLockError>;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function failureFromExit(exit: Exit.Exit<unknown, unknown>): LockError {
  assert(Exit.isFailure(exit), 'expected failure Exit');
  const failure = Cause.failureOption(exit.cause);
  assert(Option.isSome(failure), 'expected typed failure');
  assert(
    failure.value instanceof AuthIndexLockError,
    'expected AuthIndexLockError'
  );
  return failure.value;
}

async function acquireFailure(rejection: unknown): Promise<LockError> {
  acquireRejection = rejection;
  return failureFromExit(
    await Effect.runPromiseExit(
      withAuthIndexLock('github', Effect.succeed('protected'))
    )
  );
}

async function releaseFailure(rejection: unknown): Promise<LockError> {
  releaseRejection = rejection;
  return failureFromExit(
    await Effect.runPromiseExit(
      withAuthIndexLock('github', Effect.succeed('protected'))
    )
  );
}

const root = await mkdtemp(join(tmpdir(), 'aide-auth-lock-normalization-'));
await chmod(root, 0o700);
Bun.env.AIDE_AUTH_INDEX_LOCK_ROOT = join(root, 'locks');

try {
  class HostileSubclass extends AuthIndexLockError {
    override get name(): string {
      return secret;
    }

    override get message(): string {
      return secret;
    }

    override toJSON() {
      return {
        reason: 'acquire-failed' as const,
        code: 'unsafe-location' as const,
        phase: 'acquire' as const,
        providerId: secret,
        protectedOperationOutcome: 'not-started' as const,
        _tag: 'AuthIndexLockError' as const,
      };
    }

    override toString(): string {
      return secret;
    }
  }

  const subclassDefects: unknown[] = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      new HostileSubclass({
        reason: 'acquire-failed',
        code: 'unsafe-location',
        phase: 'acquire',
        providerId: 'github',
        protectedOperationOutcome: 'not-started',
      });
    } catch (error) {
      subclassDefects.push(error);
    }
  }
  assert(
    subclassDefects.length === 2,
    'hostile subclass construction succeeded'
  );
  assert(
    subclassDefects[0] !== subclassDefects[1],
    'hostile subclass defects were not fresh'
  );
  for (const defect of subclassDefects) {
    assert(defect instanceof TypeError, 'wrong hostile subclass defect type');
    assert(
      defect.message === 'Invalid AuthIndexLockError constructor options.',
      'wrong hostile subclass defect message'
    );
    assert(!Object.hasOwn(defect, 'cause'), 'hostile subclass input retained');
  }

  for (const rejection of [
    undefined,
    null,
    true,
    42,
    secret,
    Symbol(secret),
    () => secret,
    { nested: { secret } },
  ]) {
    const normalized = await acquireFailure(rejection);
    assert(normalized.reason === 'acquire-failed', 'wrong acquire reason');
    assert(normalized.code === 'unavailable', 'wrong acquire code');
    assert(
      !Object.is(normalized, rejection),
      'arbitrary rejection escaped by identity'
    );
    assert(Object.isFrozen(normalized), 'normalized error is mutable');
  }

  let accessorReads = 0;
  const accessorRejection = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(accessorRejection, 'code', {
    get() {
      accessorReads += 1;
      throw new Error(secret);
    },
  });
  const accessorNormalized = await acquireFailure(accessorRejection);
  assert(accessorReads === 0, 'acquire code accessor ran');
  assert(accessorNormalized.code === 'unavailable', 'accessor code escaped');

  let proxyTraps = 0;
  const proxyRejection = new Proxy(
    { code: 'ELOCKED', secret },
    {
      get() {
        proxyTraps += 1;
        throw new Error(secret);
      },
      getOwnPropertyDescriptor() {
        proxyTraps += 1;
        throw new Error(secret);
      },
      getPrototypeOf() {
        proxyTraps += 1;
        throw new Error(secret);
      },
      ownKeys() {
        proxyTraps += 1;
        throw new Error(secret);
      },
    }
  );
  const proxyNormalized = await acquireFailure(proxyRejection);
  assert(proxyTraps === 0, 'acquire rejection Proxy trap ran');
  assert(proxyNormalized.code === 'unavailable', 'Proxy code was reflected');
  assert(
    !Object.is(proxyNormalized, proxyRejection),
    'Proxy escaped by identity'
  );

  const revoked = Proxy.revocable({ code: 'ELOCKED', secret }, {});
  revoked.revoke();
  const revokedNormalized = await acquireFailure(revoked.proxy);
  assert(
    revokedNormalized.code === 'unavailable',
    'revoked Proxy code escaped'
  );
  assert(
    !Object.is(revokedNormalized, revoked.proxy),
    'revoked Proxy escaped by identity'
  );

  const externalTyped = new AuthIndexLockError({
    reason: 'acquire-failed',
    code: 'unsafe-location',
    phase: 'acquire',
    providerId: 'github',
    protectedOperationOutcome: 'not-started',
  });
  const externalTypedNormalized = await acquireFailure(externalTyped);
  assert(
    externalTypedNormalized !== externalTyped,
    'attacker-created AuthIndexLockError escaped by identity'
  );
  assert(
    externalTypedNormalized.code === 'unsafe-location' &&
      externalTypedNormalized.reason === 'acquire-failed',
    'safe operational fields were not preserved'
  );

  const forged = Object.create(AuthIndexLockError.prototype) as Record<
    string,
    unknown
  >;
  Object.defineProperties(forged, {
    _tag: { enumerable: true, value: 'AuthIndexLockError' },
    reason: { enumerable: true, value: 'release-failed' },
    code: { enumerable: true, value: 'unsafe-location' },
    phase: { enumerable: true, value: 'release' },
    providerId: { enumerable: true, value: secret },
    protectedOperationOutcome: { enumerable: true, value: 'failed' },
    hidden: { value: secret },
  });
  const forgedNormalized = await acquireFailure(forged);
  assert(
    !Object.is(forgedNormalized, forged),
    'forged error escaped by identity'
  );
  assert(
    forgedNormalized.reason === 'acquire-failed' &&
      forgedNormalized.code === 'unavailable' &&
      forgedNormalized.providerId === 'github',
    'forged fields escaped normalization'
  );

  let releaseProxyTraps = 0;
  const releaseProxy = new Proxy(
    { code: 'ERELEASED', secret },
    {
      get() {
        releaseProxyTraps += 1;
        throw new Error(secret);
      },
      getOwnPropertyDescriptor() {
        releaseProxyTraps += 1;
        throw new Error(secret);
      },
      getPrototypeOf() {
        releaseProxyTraps += 1;
        throw new Error(secret);
      },
      ownKeys() {
        releaseProxyTraps += 1;
        throw new Error(secret);
      },
    }
  );
  const releaseProxyNormalized = await releaseFailure(releaseProxy);
  assert(releaseProxyTraps === 0, 'release rejection Proxy trap ran');
  assert(
    releaseProxyNormalized.reason === 'release-failed' &&
      releaseProxyNormalized.code === 'unavailable' &&
      releaseProxyNormalized.providerId === 'github',
    'release rejection did not collapse to host fields'
  );
  assert(
    !Object.is(releaseProxyNormalized, releaseProxy),
    'release Proxy escaped by identity'
  );

  const revokedRelease = Proxy.revocable({ secret }, {});
  revokedRelease.revoke();
  const revokedReleaseNormalized = await releaseFailure(revokedRelease.proxy);
  assert(
    revokedReleaseNormalized.reason === 'release-failed',
    'revoked release Proxy escaped'
  );
  assert(
    !Object.is(revokedReleaseNormalized, revokedRelease.proxy),
    'revoked release Proxy escaped by identity'
  );
} finally {
  delete Bun.env.AIDE_AUTH_INDEX_LOCK_ROOT;
  mock.restore();
  await rm(root, { force: true, recursive: true });
}
