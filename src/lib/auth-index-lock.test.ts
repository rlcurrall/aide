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
import { inspect } from 'node:util';
import { fileURLToPath } from 'node:url';

import { Cause, Effect, Exit, Fiber, Match, Option } from 'effect';

import { renderTopLevelError } from '../cli/index.js';
import {
  AuthIndexLockCompromisedFatalError,
  AuthIndexLockError,
  withAuthIndexLock,
  type AuthIndexLockReason,
} from './auth-index-lock.js';
import {
  backendFailureSentinels,
  exportedErrorText,
  maliciousBackendFailure,
  reachableOwnDataText,
} from './error-redaction.test-helper.js';

const temporaryDirectories = new Set<string>();
const normalizationFixturePath = fileURLToPath(
  new URL('./auth-index-lock-normalization.fixture.ts', import.meta.url)
);
const finalClassFixturePath = fileURLToPath(
  new URL('./auth-index-lock-final-class.fixture.ts', import.meta.url)
);

const validLockErrorOptions = Object.freeze({
  reason: 'acquire-failed' as const,
  code: 'unavailable' as const,
  phase: 'acquire' as const,
  providerId: 'github',
  protectedOperationOutcome: 'not-started' as const,
});

function constructLockError(options: unknown): AuthIndexLockError {
  return new AuthIndexLockError(
    options as ConstructorParameters<typeof AuthIndexLockError>[0]
  );
}

function captureConstructorDefect(options: unknown): TypeError {
  try {
    constructLockError(options);
  } catch (error) {
    expect(error).toBeInstanceOf(TypeError);
    return error as TypeError;
  }
  throw new Error('expected AuthIndexLockError constructor to reject input');
}

function ownDataOptions(
  prototype: object | null = Object.prototype
): Record<string, unknown> {
  const options = Object.create(prototype) as Record<string, unknown>;
  for (const [key, value] of Object.entries(validLockErrorOptions)) {
    Object.defineProperty(options, key, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    });
  }
  return options;
}

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

  test('supports idiomatic catchTag and Match handling with a stable acquire reason', async () => {
    const parent = await secureTemporaryDirectory();
    Bun.env.AIDE_AUTH_INDEX_LOCK_ROOT = join(parent, 'missing-parent', 'locks');

    const recovered: Effect.Effect<string | AuthIndexLockReason, never, never> =
      withAuthIndexLock('github', Effect.succeed('protected')).pipe(
        Effect.catchTag('AuthIndexLockError', (error) =>
          Effect.succeed(error.reason)
        )
      );
    const reason = await Effect.runPromise(recovered);
    const matchReason = Match.type<AuthIndexLockError>().pipe(
      Match.tag('AuthIndexLockError', (error) => error.reason),
      Match.exhaustive
    );
    const error = new AuthIndexLockError({
      reason: 'acquire-failed',
      code: 'unavailable',
      phase: 'acquire',
      providerId: 'github',
      protectedOperationOutcome: 'not-started',
    });

    expect(reason).toBe('acquire-failed');
    expect(matchReason(error)).toBe('acquire-failed');
    expect(error).toMatchObject({
      _tag: 'AuthIndexLockError',
      name: 'AuthIndexLockError',
      reason: 'acquire-failed',
    });
    expect(error).toBeInstanceOf(AuthIndexLockError);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('AuthIndexLockError');
    expect(error.message).toBe(
      'Auth index coordination acquire failed (unavailable); protected operation not-started.'
    );
    expect(String(error)).toBe(
      'AuthIndexLockError: Auth index coordination acquire failed (unavailable); protected operation not-started.'
    );
    const expectedJson = {
      reason: 'acquire-failed',
      code: 'unavailable',
      phase: 'acquire',
      providerId: 'github',
      protectedOperationOutcome: 'not-started',
      _tag: 'AuthIndexLockError',
    } as const;
    const firstJson = error.toJSON();
    const secondJson = error.toJSON();
    expect(firstJson).toEqual(expectedJson);
    expect(secondJson).toEqual(expectedJson);
    expect(firstJson).not.toBe(secondJson);
    expect(Object.isFrozen(firstJson)).toBe(true);
    expect(inspect(error)).toBe(inspect(expectedJson));
  });

  test('constructs from ordinary, null-prototype, and custom-prototype own data only', () => {
    let inheritedReads = 0;
    const customPrototype = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(validLockErrorOptions)) {
      Object.defineProperty(customPrototype, key, {
        get() {
          inheritedReads += 1;
          throw new Error('inherited constructor hook ran');
        },
      });
    }

    for (const options of [
      ownDataOptions(),
      ownDataOptions(null),
      ownDataOptions(customPrototype),
    ]) {
      const error = constructLockError(options);
      const literalTag: 'AuthIndexLockError' = error._tag;
      expect(literalTag).toBe('AuthIndexLockError');
      expect(error).toMatchObject(validLockErrorOptions);
      expect(error.name).toBe('AuthIndexLockError');
      expect(error).toBeInstanceOf(AuthIndexLockError);
      expect(error).toBeInstanceOf(Error);
    }
    expect(inheritedReads).toBe(0);
  });

  test('rejects inherited fields, accessors, Proxies, hostile values, and malformed primitives with one fixed fresh defect', () => {
    const secret = 'AUTH_LOCK_INVALID_INPUT_SECRET_638e';
    let hooks = 0;
    const hostileValue = {
      get secret() {
        hooks += 1;
        return secret;
      },
      toJSON() {
        hooks += 1;
        return secret;
      },
      toString() {
        hooks += 1;
        return secret;
      },
      valueOf() {
        hooks += 1;
        return secret;
      },
      [inspect.custom]() {
        hooks += 1;
        return secret;
      },
    };

    const inherited = Object.create(null) as Record<string, unknown>;
    for (const [key, value] of Object.entries(validLockErrorOptions)) {
      Object.defineProperty(inherited, key, {
        get() {
          hooks += 1;
          return value;
        },
      });
    }

    const ownAccessors = Object.create(null) as Record<string, unknown>;
    for (const [key, value] of Object.entries(validLockErrorOptions)) {
      Object.defineProperty(ownAccessors, key, {
        enumerable: true,
        get() {
          hooks += 1;
          return value;
        },
      });
    }

    const proxyTarget = ownDataOptions();
    Object.defineProperty(proxyTarget, 'secret', { value: secret });
    const proxied = new Proxy(proxyTarget, {
      get() {
        hooks += 1;
        throw new Error('proxy get trap ran');
      },
      getOwnPropertyDescriptor() {
        hooks += 1;
        throw new Error('proxy descriptor trap ran');
      },
      getPrototypeOf() {
        hooks += 1;
        throw new Error('proxy prototype trap ran');
      },
      ownKeys() {
        hooks += 1;
        throw new Error('proxy ownKeys trap ran');
      },
    });
    const revoked = Proxy.revocable(proxyTarget, {});
    revoked.revoke();

    const invalid: unknown[] = [
      null,
      undefined,
      true,
      'options',
      Object.create(inherited),
      ownAccessors,
      proxied,
      revoked.proxy,
      ...Object.keys(validLockErrorOptions).map((missing) => {
        const options = ownDataOptions(null);
        Reflect.deleteProperty(options, missing);
        return options;
      }),
      { ...validLockErrorOptions, reason: 'unknown-reason' },
      { ...validLockErrorOptions, code: 'ELOCKED' },
      { ...validLockErrorOptions, phase: 'cleanup' },
      { ...validLockErrorOptions, protectedOperationOutcome: 'unknown' },
      { ...validLockErrorOptions, providerId: ' ado ' },
      { ...validLockErrorOptions, providerId: 'ado' },
      { ...validLockErrorOptions, providerId: 'GitHub' },
      { ...validLockErrorOptions, providerId: '__proto__' },
      { ...validLockErrorOptions, providerId: `${'a'.repeat(64)}b` },
      { ...validLockErrorOptions, providerId: 'github\ud800' },
      ...Object.keys(validLockErrorOptions).map((field) => ({
        ...validLockErrorOptions,
        [field]: hostileValue,
      })),
    ];

    const defects = invalid.map(captureConstructorDefect);
    expect(new Set(defects.map((error) => error.message)).size).toBe(1);
    expect(defects[0]?.message).toBeTruthy();
    expect(new Set(defects).size).toBe(defects.length);
    for (const defect of defects) {
      expect(Object.hasOwn(defect, 'cause')).toBe(false);
      expect(reachableOwnDataText(defect)).not.toContain(secret);
    }
    expect(hooks).toBe(0);
  });

  test('ignores hostile extras and freezes every exported and Effect payload surface', async () => {
    const secret = 'AUTH_LOCK_IMMUTABILITY_SECRET_1f7b';
    let hooks = 0;
    const hostile = Object.create(null) as Record<PropertyKey, unknown>;
    hostile.self = hostile;
    hostile.secret = secret;
    hostile.toJSON = () => {
      hooks += 1;
      return secret;
    };
    hostile.toString = () => {
      hooks += 1;
      return secret;
    };
    hostile.valueOf = () => {
      hooks += 1;
      return secret;
    };
    hostile[inspect.custom] = () => {
      hooks += 1;
      return secret;
    };

    const ignoredSymbol = Symbol(secret);
    const options = ownDataOptions(null);
    Object.defineProperties(options, {
      cause: { value: hostile },
      extra: { enumerable: true, value: hostile },
      hidden: { value: hostile },
      accessorExtra: {
        get() {
          hooks += 1;
          return hostile;
        },
      },
    });
    Object.defineProperty(options, ignoredSymbol, {
      enumerable: true,
      value: hostile,
    });

    const error = constructLockError(options);
    options.providerId = 'attacker';
    options.reason = 'release-failed';
    hostile.later = 'AUTH_LOCK_LATE_MUTATION_SECRET_23ac';

    expect(error).toMatchObject(validLockErrorOptions);
    expect(Object.isFrozen(error)).toBe(true);
    expect(Object.isExtensible(error)).toBe(false);

    for (const field of [
      '_tag',
      'reason',
      'code',
      'phase',
      'providerId',
      'protectedOperationOutcome',
      'stack',
    ]) {
      const descriptor = Object.getOwnPropertyDescriptor(error, field);
      expect(descriptor).toBeDefined();
      expect(descriptor?.configurable).toBe(false);
      expect(descriptor?.writable).toBe(false);
    }
    expect(Object.hasOwn(error, 'message')).toBe(false);

    const plainArgsSymbol = Object.getOwnPropertySymbols(error).find((symbol) =>
      String(symbol).includes('effect/Data/Error/plainArgs')
    );
    expect(plainArgsSymbol).toBeDefined();
    const plainArgs =
      plainArgsSymbol === undefined
        ? undefined
        : Object.getOwnPropertyDescriptor(error, plainArgsSymbol)?.value;
    expect(plainArgs).toBeDefined();
    expect(plainArgs).not.toBe(options);
    expect(Object.isFrozen(plainArgs)).toBe(true);
    expect(Reflect.ownKeys(plainArgs as object).sort()).toEqual(
      Object.keys(validLockErrorOptions).sort()
    );
    for (const value of Object.values(plainArgs as object)) {
      expect(['string', 'number', 'boolean', 'undefined']).toContain(
        typeof value
      );
    }

    const safeBefore = [
      exportedErrorText(error),
      renderTopLevelError(error),
      inspect(Cause.fail(error), {
        depth: 20,
        getters: false,
        showHidden: true,
      }),
    ].join('\n');
    expect(safeBefore).not.toContain(secret);
    expect(safeBefore).not.toContain('AUTH_LOCK_LATE_MUTATION_SECRET_23ac');
    expect(hooks).toBe(0);

    const mutationSymbol = Symbol('AUTH_LOCK_MUTATION_SYMBOL_99de');
    expect(Reflect.set(error, 'providerId', secret)).toBe(false);
    expect(Reflect.set(error, '_tag', secret)).toBe(false);
    expect(Reflect.set(error, mutationSymbol, secret)).toBe(false);
    expect(
      Reflect.defineProperty(error, 'hiddenMutation', { value: secret })
    ).toBe(false);
    expect(Reflect.defineProperty(error, 'message', { value: secret })).toBe(
      false
    );
    expect(Reflect.deleteProperty(error, 'reason')).toBe(false);
    expect(Reflect.set(plainArgs as object, 'providerId', secret)).toBe(false);
    expect(Reflect.set(plainArgs as object, 'secret', secret)).toBe(false);

    const exit = await Effect.runPromiseExit(Effect.fail(error));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isSuccess(exit)) throw new Error('expected typed lock failure');
    expect(Cause.failureOption(exit.cause)).toEqual(Option.some(error));

    const safeAfter = [
      exportedErrorText(error),
      renderTopLevelError(error),
      inspect(exit.cause, { depth: 20, getters: false, showHidden: true }),
    ].join('\n');
    expect(safeAfter).toBe(safeBefore);
    expect(safeAfter).not.toContain(secret);
    expect(hooks).toBe(0);
  });

  test('keeps the exported constructor and prototype final after an instance exists', async () => {
    const inheritedEnvironment = { ...Bun.env };
    delete inheritedEnvironment.FORCE_COLOR;
    delete inheritedEnvironment.NO_COLOR;
    const child = Bun.spawn({
      cmd: [process.execPath, 'run', finalClassFixturePath],
      cwd: import.meta.dir,
      env: inheritedEnvironment,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout as ReadableStream<Uint8Array>).text(),
      new Response(child.stderr as ReadableStream<Uint8Array>).text(),
    ]);

    expect(`${stdout}\n${stderr}`).not.toContain(
      'AUTH_LOCK_PROTOTYPE_MUTATION_SECRET_7f31'
    );
    expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
  });

  test('rejects hostile subclass construction with fixed fresh defects', () => {
    const secret = 'AUTH_LOCK_HOSTILE_SUBCLASS_SECRET_11c4';
    class HostileSubclass extends AuthIndexLockError {
      override get name(): string {
        return secret;
      }

      override get message(): string {
        return secret;
      }

      override toJSON() {
        return {
          ...validLockErrorOptions,
          providerId: secret,
          _tag: 'AuthIndexLockError' as const,
        };
      }

      override toString(): string {
        return secret;
      }

      override [inspect.custom]() {
        return this.toJSON();
      }
    }

    const instances: HostileSubclass[] = [];
    const defects: unknown[] = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        instances.push(new HostileSubclass(validLockErrorOptions));
      } catch (error) {
        defects.push(error);
      }
    }
    const exposed = instances
      .flatMap((instance) => [
        JSON.stringify(instance),
        inspect(instance),
        inspect(Cause.fail(instance)),
        renderTopLevelError(instance),
        String(instance),
        instance.name,
        instance.message,
        reachableOwnDataText(instance),
      ])
      .join('\n');

    expect(instances).toHaveLength(0);
    expect(defects).toHaveLength(2);
    expect(new Set(defects).size).toBe(2);
    expect(new Set(defects.map((defect) => String(defect))).size).toBe(1);
    for (const defect of defects) {
      expect(defect).toBeInstanceOf(TypeError);
      if (!(defect instanceof TypeError)) throw new Error('wrong defect type');
      expect(defect.message).toBe(
        'Invalid AuthIndexLockError constructor options.'
      );
      expect(Object.hasOwn(defect, 'cause')).toBe(false);
      expect(exportedErrorText(defect)).not.toContain(secret);
      expect(renderTopLevelError(defect)).not.toContain(secret);
      expect(inspect(Cause.die(defect))).not.toContain(secret);
      expect(reachableOwnDataText(defect)).not.toContain(secret);
    }
    expect(exposed).not.toContain(secret);
  });

  test('normalizes arbitrary Promise-library rejections without traps or identity escape', async () => {
    const inheritedEnvironment = { ...Bun.env };
    delete inheritedEnvironment.FORCE_COLOR;
    delete inheritedEnvironment.NO_COLOR;
    const child = Bun.spawn({
      cmd: [process.execPath, 'run', normalizationFixturePath],
      cwd: import.meta.dir,
      env: inheritedEnvironment,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout as ReadableStream<Uint8Array>).text(),
      new Response(child.stderr as ReadableStream<Uint8Array>).text(),
    ]);

    expect(`${stdout}\n${stderr}`).not.toContain(
      'AUTH_LOCK_NORMALIZATION_SECRET_6a42'
    );
    expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
  });

  test('does not retain hostile causes or caller extras on any exported or CLI surface', () => {
    const path = '/private/tmp/AUTH_LOCK_PATH_SENTINEL_8d51';
    const credential = 'AUTH_LOCK_CREDENTIAL_SENTINEL_9c2e';
    const account = 'AUTH_LOCK_ACCOUNT_SENTINEL_a117';
    const token = 'AUTH_LOCK_TOKEN_SENTINEL_f043';
    const environment = 'AUTH_LOCK_ENV_SENTINEL_74bb';
    const fixture = maliciousBackendFailure([
      path,
      credential,
      account,
      token,
      environment,
    ]);
    const hostileOptions = {
      reason: 'acquire-failed' as const,
      code: 'unavailable' as const,
      phase: 'acquire' as const,
      providerId: 'github',
      protectedOperationOutcome: 'not-started' as const,
      cause: fixture.failure,
      path,
      credential,
      account,
      token,
      environment,
    };

    const error = new AuthIndexLockError(hostileOptions);
    const surfaces = `${exportedErrorText(error)}\n${renderTopLevelError(error)}`;
    for (const secret of [
      ...backendFailureSentinels,
      path,
      credential,
      account,
      token,
      environment,
    ]) {
      expect(surfaces).not.toContain(secret);
    }
    expect(fixture.getterReads()).toBe(0);
  });

  test('keeps fatal ownership compromise outside ordinary tagged recovery', async () => {
    const fatal = new AuthIndexLockCompromisedFatalError();
    const fatalProgram: Effect.Effect<never, AuthIndexLockError, never> =
      Effect.die(fatal);
    const exit = await Effect.runPromiseExit(
      fatalProgram.pipe(
        Effect.catchTag('AuthIndexLockError', () => Effect.succeed('recovered'))
      )
    );

    expect(fatal).not.toBeInstanceOf(AuthIndexLockError);
    expect(Object.hasOwn(fatal, '_tag')).toBe(false);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isSuccess(exit)) throw new Error('expected fatal defect');
    expect(Cause.dieOption(exit.cause)).toEqual(Option.some(fatal));
    expect(Option.isNone(Cause.failureOption(exit.cause))).toBe(true);
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
      _tag: 'AuthIndexLockError',
      reason: 'release-failed',
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

    const exit = await Effect.runPromiseExit(
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
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isSuccess(exit)) throw new Error('expected release failure');
    const failure = Cause.failureOption(exit.cause);
    expect(Option.isSome(failure)).toBe(true);
    if (Option.isNone(failure)) throw new Error('expected typed lock failure');
    expect(failure.value).toBeInstanceOf(AuthIndexLockError);
    expect(failure.value).toMatchObject({
      _tag: 'AuthIndexLockError',
      reason: 'release-failed',
      code: 'unavailable',
      phase: 'release',
      providerId: 'github',
      protectedOperationOutcome: 'failed',
    });
    expect(failure.value).not.toBe(useFailure);
    expect(Array.from(Cause.failures(exit.cause))).toEqual([failure.value]);
    expect(Array.from(Cause.defects(exit.cause))).toEqual([]);
    expect(String(failure.value)).not.toContain(parent);
  });

  test('keeps a protected defect behind the primary release failure', async () => {
    const parent = await secureTemporaryDirectory();
    const root = join(parent, 'locks');
    Bun.env.AIDE_AUTH_INDEX_LOCK_ROOT = root;
    const defect = new Error('protected programmer defect sentinel');

    const exit = await Effect.runPromiseExit(
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
          return yield* Effect.die(defect);
        })
      )
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isSuccess(exit)) throw new Error('expected release failure');
    const failure = Cause.failureOption(exit.cause);
    expect(Option.isSome(failure)).toBe(true);
    if (Option.isNone(failure)) throw new Error('expected typed lock failure');
    expect(failure.value).toMatchObject({
      _tag: 'AuthIndexLockError',
      reason: 'release-failed',
      code: 'unavailable',
      phase: 'release',
      providerId: 'github',
      protectedOperationOutcome: 'failed',
    });
    expect(Array.from(Cause.failures(exit.cause))).toEqual([failure.value]);
    expect(Array.from(Cause.defects(exit.cause))).toEqual([defect]);
    expect(Cause.isInterrupted(exit.cause)).toBe(false);
    expect(Cause.isSequentialType(exit.cause)).toBe(true);
    if (!Cause.isSequentialType(exit.cause)) {
      throw new Error('expected release-first sequential Cause');
    }
    expect(Cause.failureOption(exit.cause.left)).toEqual(
      Option.some(failure.value)
    );
    expect(Array.from(Cause.defects(exit.cause.right))).toEqual([defect]);
  });

  test('reports a finalizer cleanup failure without swallowing interruption semantics', async () => {
    const parent = await secureTemporaryDirectory();
    const root = join(parent, 'locks');
    Bun.env.AIDE_AUTH_INDEX_LOCK_ROOT = root;

    const holder = Effect.runFork(withAuthIndexLock('github', Effect.never));
    const lockDirectory = await waitForLockDirectory(root);
    await writeFile(join(lockDirectory, 'prevent-release'), 'x');
    const exit = await Effect.runPromise(Fiber.interrupt(holder));

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isSuccess(exit)) throw new Error('expected interrupted cleanup');
    const failure = Cause.failureOption(exit.cause);
    expect(Option.isSome(failure)).toBe(true);
    if (Option.isNone(failure)) throw new Error('expected cleanup failure');
    expect(failure.value).toMatchObject({
      _tag: 'AuthIndexLockError',
      reason: 'cleanup-failed',
      phase: 'release',
      protectedOperationOutcome: 'failed',
    });
    expect(Cause.isInterrupted(exit.cause)).toBe(true);
    expect(String(failure.value)).not.toContain(parent);
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
      _tag: 'AuthIndexLockError',
      reason: 'contention-timeout',
      code: 'timeout',
      phase: 'acquire',
      protectedOperationOutcome: 'not-started',
    });
    expect(elapsed).toBeGreaterThan(1_000);
    expect(elapsed).toBeLessThan(10_000);
  }, 15_000);
});
