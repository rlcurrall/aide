import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Cause, Effect, Exit, Fiber, Option } from 'effect';

import { AuthIndexLockError, withAuthIndexLock } from './auth-index-lock.js';

const temporaryDirectories = new Set<string>();

async function secureTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'aide-auth-lock-'));
  await chmod(directory, 0o700);
  temporaryDirectories.add(directory);
  return directory;
}

async function waitForLockDirectory(root: string): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const entry = (await readdir(root)).find((name) =>
        name.endsWith('.lock')
      );
      if (entry !== undefined) return join(root, entry);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await Bun.sleep(10);
  }
  throw new Error('Timed out waiting for an auth index lock directory.');
}

afterEach(async () => {
  delete Bun.env.AIDE_AUTH_INDEX_LOCK_ROOT;
  await Promise.all(
    [...temporaryDirectories].map((directory) =>
      rm(directory, { force: true, recursive: true })
    )
  );
  temporaryDirectories.clear();
});

describe('auth index lock lifecycle', () => {
  test('creates a private root and provider target without retaining the lease', async () => {
    const parent = await secureTemporaryDirectory();
    const root = join(parent, 'locks');
    Bun.env.AIDE_AUTH_INDEX_LOCK_ROOT = root;

    expect(
      await Effect.runPromise(
        withAuthIndexLock('github', Effect.succeed('protected'))
      )
    ).toBe('protected');

    const rootInfo = await lstat(root);
    expect(rootInfo.isDirectory()).toBe(true);
    expect(rootInfo.mode & 0o777).toBe(0o700);
    const entries = await readdir(root);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatch(/^provider-[a-f0-9]{64}\.target$/);
    const targetInfo = await lstat(join(root, entries[0]!));
    expect(targetInfo.isFile()).toBe(true);
    expect(targetInfo.mode & 0o777).toBe(0o600);
  });

  test('rejects a symlinked lock root with a typed redacted error', async () => {
    const parent = await secureTemporaryDirectory();
    const destination = join(parent, 'destination');
    const root = join(parent, 'locks');
    await mkdir(destination, { mode: 0o700 });
    await symlink(destination, root);
    Bun.env.AIDE_AUTH_INDEX_LOCK_ROOT = root;

    const result = await Effect.runPromise(
      Effect.either(withAuthIndexLock('github', Effect.succeed('nope')))
    );

    expect(result._tag).toBe('Left');
    if (result._tag === 'Right') throw new Error('expected lock failure');
    expect(result.left).toBeInstanceOf(AuthIndexLockError);
    expect(result.left).toMatchObject({
      code: 'unsafe-location',
      phase: 'acquire',
      providerId: 'github',
      protectedOperationOutcome: 'not-started',
    });
    expect(String(result.left)).not.toContain(parent);
  });

  test('releases an acquired lock when the protected Effect is interrupted', async () => {
    const parent = await secureTemporaryDirectory();
    const root = join(parent, 'locks');
    Bun.env.AIDE_AUTH_INDEX_LOCK_ROOT = root;

    const holder = Effect.runFork(withAuthIndexLock('github', Effect.never));
    await waitForLockDirectory(root);
    await Effect.runPromise(Fiber.interrupt(holder));

    expect(
      await Effect.runPromise(
        withAuthIndexLock('github', Effect.succeed('reacquired'))
      )
    ).toBe('reacquired');
  });

  test('preserves a typed protected-operation failure', async () => {
    const parent = await secureTemporaryDirectory();
    Bun.env.AIDE_AUTH_INDEX_LOCK_ROOT = join(parent, 'locks');
    const useFailure = new Error('typed use failure');

    const result = await Effect.runPromise(
      Effect.either(withAuthIndexLock('github', Effect.fail(useFailure)))
    );

    expect(result._tag).toBe('Left');
    if (result._tag === 'Right') throw new Error('expected typed use failure');
    expect(result.left).toBe(useFailure);
  });

  test('preserves a protected-operation defect', async () => {
    const parent = await secureTemporaryDirectory();
    Bun.env.AIDE_AUTH_INDEX_LOCK_ROOT = join(parent, 'locks');
    const defect = new Error('protected defect');

    const exit = await Effect.runPromiseExit(
      withAuthIndexLock('github', Effect.die(defect))
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isSuccess(exit)) throw new Error('expected protected defect');
    const defectOption = Cause.dieOption(exit.cause);
    expect(Option.isSome(defectOption)).toBe(true);
    if (Option.isSome(defectOption)) expect(defectOption.value).toBe(defect);
  });

  test('reports release failure and the protected operation outcome without raw paths', async () => {
    const parent = await secureTemporaryDirectory();
    const root = join(parent, 'locks');
    Bun.env.AIDE_AUTH_INDEX_LOCK_ROOT = root;

    const result = await Effect.runPromise(
      Effect.either(
        withAuthIndexLock(
          'github',
          Effect.tryPromise({
            try: async () => {
              const lockDirectory = await waitForLockDirectory(root);
              await writeFile(join(lockDirectory, 'prevent-release'), 'x');
              return 'mutated';
            },
            catch: (error) => error,
          })
        )
      )
    );

    expect(result._tag).toBe('Left');
    if (result._tag === 'Right') throw new Error('expected release failure');
    expect(result.left).toBeInstanceOf(AuthIndexLockError);
    expect(result.left).toMatchObject({
      code: 'unavailable',
      phase: 'release',
      providerId: 'github',
      protectedOperationOutcome: 'succeeded',
    });
    expect(String(result.left)).not.toContain(parent);
  });

  test('gives a simultaneous release failure precedence over a protected failure', async () => {
    const parent = await secureTemporaryDirectory();
    const root = join(parent, 'locks');
    Bun.env.AIDE_AUTH_INDEX_LOCK_ROOT = root;
    const useFailure = new Error('protected failure sentinel');

    const result = await Effect.runPromise(
      Effect.either(
        withAuthIndexLock(
          'github',
          Effect.gen(function* () {
            yield* Effect.tryPromise({
              try: async () => {
                const lockDirectory = await waitForLockDirectory(root);
                await writeFile(join(lockDirectory, 'prevent-release'), 'x');
              },
              catch: (error) => error,
            });
            return yield* Effect.fail(useFailure);
          })
        )
      )
    );

    expect(result._tag).toBe('Left');
    if (result._tag === 'Right') throw new Error('expected release failure');
    expect(result.left).toBeInstanceOf(AuthIndexLockError);
    expect(result.left).toMatchObject({
      code: 'unavailable',
      phase: 'release',
      providerId: 'github',
      protectedOperationOutcome: 'failed',
    });
    expect(result.left).not.toBe(useFailure);
    expect(String(result.left)).not.toContain(parent);
  });

  test('cleans up acquisition that is interrupted during contention', async () => {
    const parent = await secureTemporaryDirectory();
    const root = join(parent, 'locks');
    Bun.env.AIDE_AUTH_INDEX_LOCK_ROOT = root;
    let contenderEntered = false;

    const holder = Effect.runFork(withAuthIndexLock('github', Effect.never));
    await waitForLockDirectory(root);
    const contender = Effect.runFork(
      withAuthIndexLock(
        'github',
        Effect.sync(() => {
          contenderEntered = true;
        })
      )
    );
    const interrupted = Effect.runPromise(Fiber.interrupt(contender));
    await Bun.sleep(100);

    expect(contenderEntered).toBe(false);
    await Effect.runPromise(Fiber.interrupt(holder));
    await interrupted;
    expect(contenderEntered).toBe(false);
    expect(
      await Effect.runPromise(
        withAuthIndexLock('github', Effect.succeed('reacquired'))
      )
    ).toBe('reacquired');
  }, 10_000);

  test('fails bounded same-provider contention with a typed timeout', async () => {
    const parent = await secureTemporaryDirectory();
    const root = join(parent, 'locks');
    Bun.env.AIDE_AUTH_INDEX_LOCK_ROOT = root;

    const holder = Effect.runFork(withAuthIndexLock('github', Effect.never));
    await waitForLockDirectory(root);
    const startedAt = Date.now();
    const contender = await Effect.runPromise(
      Effect.either(withAuthIndexLock('github', Effect.succeed('nope')))
    );
    const elapsed = Date.now() - startedAt;
    await Effect.runPromise(Fiber.interrupt(holder));

    expect(contender._tag).toBe('Left');
    if (contender._tag === 'Right') throw new Error('expected lock timeout');
    expect(contender.left).toMatchObject({
      code: 'timeout',
      phase: 'acquire',
      protectedOperationOutcome: 'not-started',
    });
    expect(elapsed).toBeGreaterThan(1_000);
    expect(elapsed).toBeLessThan(10_000);
  }, 15_000);
});
