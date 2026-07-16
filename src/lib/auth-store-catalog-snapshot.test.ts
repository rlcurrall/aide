import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';

import { Cause, Deferred, Effect, Exit, Fiber, Layer } from 'effect';

import {
  AuthIndexDocumentError,
  authIndexScopeName,
  authIndexSecretName,
  captureAuthProviderCatalogEffect,
  deleteAuthSecretEffect,
  listIndexedAuthScopesEffect,
  makeAuthIndexDocument,
  normalizeAuthStoreScope,
  serializeAuthIndexDocument,
  writeAuthSecretEffect,
  type AuthProviderId,
  type AuthStoreScope,
  type NormalizedAuthStoreScope,
} from './auth-store.js';
import { AuthIndexLockError, withAuthIndexLock } from './auth-index-lock.js';
import {
  KeyringService,
  KeyringUnavailableError,
  type KeyringSecretName,
  type KeyringServiceShape,
} from './auth-keyring.js';
import {
  makeTestKeyring,
  type TestKeyring,
  type TestKeyringCall,
} from './auth-keyring.test-helper.js';
import {
  backendFailureSentinels,
  maliciousBackendFailure,
} from './error-redaction.test-helper.js';

function normalized(
  providerId: AuthProviderId,
  scope: AuthStoreScope
): NormalizedAuthStoreScope {
  const value = normalizeAuthStoreScope(providerId, scope);
  if (value === null) throw new Error('invalid test scope');
  return value;
}

function rendered(error: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(error);
  } catch {
    json = '<unserializable>';
  }
  return [
    String(error),
    Cause.pretty(Cause.fail(error)),
    inspect(error, { showHidden: true }),
    json,
  ].join('\n');
}

describe('auth provider catalog snapshot', () => {
  let store: Map<string, string>;
  let keyring: TestKeyring;
  let temporaryDirectory: string;
  let previousLockRoot: string | undefined;

  beforeEach(async () => {
    store = new Map();
    keyring = makeTestKeyring(store);
    temporaryDirectory = await mkdtemp(
      join(tmpdir(), 'aide-catalog-snapshot-')
    );
    await chmod(temporaryDirectory, 0o700);
    previousLockRoot = Bun.env.AIDE_AUTH_INDEX_LOCK_ROOT;
    Bun.env.AIDE_AUTH_INDEX_LOCK_ROOT = join(temporaryDirectory, 'locks');
  });

  afterEach(async () => {
    if (previousLockRoot === undefined) {
      delete Bun.env.AIDE_AUTH_INDEX_LOCK_ROOT;
    } else {
      Bun.env.AIDE_AUTH_INDEX_LOCK_ROOT = previousLockRoot;
    }
    await rm(temporaryDirectory, { force: true, recursive: true });
  });

  function provided<A, E>(
    effect: Effect.Effect<A, E, KeyringService>
  ): Effect.Effect<A, E> {
    return effect.pipe(Effect.provide(keyring.layer));
  }

  function seedIndex(
    providerId: AuthProviderId,
    scopes: readonly AuthStoreScope[]
  ): void {
    store.set(
      `aide:${authIndexSecretName(providerId)}`,
      serializeAuthIndexDocument(
        makeAuthIndexDocument(
          providerId,
          scopes.map((scope) => normalized(providerId, scope))
        )
      )
    );
  }

  test('returns a detached deeply frozen snapshot of canonical scopes, captured payloads, and the separate legacy value', async () => {
    const scope = {
      providerId: 'jira',
      host: 'team.atlassian.net',
      account: 'dev@example.com',
    } as const;
    const target = authIndexScopeName(normalized('jira', scope));
    seedIndex('jira', [scope]);
    store.set(`aide:${target}`, 'SCOPED_CAPTURED_VALUE');
    store.set('aide:jira', 'LEGACY_CAPTURED_VALUE');

    const snapshot = await Effect.runPromise(
      provided(captureAuthProviderCatalogEffect('jira'))
    );
    store.set(`aide:${target}`, 'SCOPED_LATER_VALUE');
    store.set('aide:jira', 'LEGACY_LATER_VALUE');
    const parsed = snapshot.parse((value, capturedScope) => ({
      kind:
        capturedScope === undefined ? ('legacy' as const) : ('scoped' as const),
      captured:
        value ===
        (capturedScope === undefined
          ? 'LEGACY_CAPTURED_VALUE'
          : 'SCOPED_CAPTURED_VALUE'),
      ...(capturedScope === undefined ? {} : { scope: capturedScope }),
    }));

    expect(parsed).toEqual({
      legacy: { kind: 'legacy', captured: true },
      indexed: [
        { kind: 'scoped', captured: true, scope: normalized('jira', scope) },
      ],
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.indexed)).toBe(true);
    expect(Object.isFrozen(parsed.indexed[0]?.scope)).toBe(true);
    expect(rendered(snapshot)).not.toContain('SCOPED_CAPTURED_VALUE');
    expect(rendered(snapshot)).not.toContain('LEGACY_CAPTURED_VALUE');
  });

  test('holds one provider lease across index, indexed payload, legacy capture, and stale reconciliation while a scoped writer blocks', async () => {
    const existing = {
      providerId: 'jira',
      host: 'existing.atlassian.net',
      account: 'existing@example.com',
    } as const;
    const inserted = {
      providerId: 'jira',
      host: 'inserted.atlassian.net',
      account: 'inserted@example.com',
    } as const;
    const existingTarget = authIndexScopeName(normalized('jira', existing));
    seedIndex('jira', [existing]);
    store.set(`aide:${existingTarget}`, 'EXISTING_CAPTURED_VALUE');

    const started = await Effect.runPromise(Deferred.make<void>());
    const release = await Effect.runPromise(Deferred.make<void>());
    const calls: TestKeyringCall[] = [];
    const service = {
      get: (name: KeyringSecretName) =>
        Effect.gen(function* () {
          calls.push({ operation: 'get', name });
          const value = store.get(`aide:${name}`) ?? null;
          if (name === 'jira') {
            yield* Effect.asVoid(Deferred.succeed(started, undefined));
            yield* Deferred.await(release);
          }
          return value;
        }),
      set: (name: KeyringSecretName, value: string) =>
        Effect.sync(() => {
          calls.push({ operation: 'set', name, value });
          store.set(`aide:${name}`, value);
        }),
      delete: (name: KeyringSecretName) =>
        Effect.sync(() => {
          calls.push({ operation: 'delete', name });
          return store.delete(`aide:${name}`);
        }),
    } satisfies KeyringServiceShape;
    keyring = {
      store,
      layer: Layer.succeed(KeyringService, service),
      replace: () => calls,
    };

    const snapshotFiber = Effect.runFork(
      provided(captureAuthProviderCatalogEffect('jira'))
    );
    await Effect.runPromise(Deferred.await(started));
    let writerCompleted = false;
    const writerFiber = Effect.runFork(
      provided(
        writeAuthSecretEffect('jira', 'INSERTED_VALUE', inserted).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              writerCompleted = true;
            })
          )
        )
      )
    );
    await Bun.sleep(75);
    const completedBeforeRelease = writerCompleted;
    const mutationsBeforeRelease = calls.filter(
      (call) => call.operation !== 'get'
    );
    await Effect.runPromise(Deferred.succeed(release, undefined));
    const snapshot = await Effect.runPromise(Fiber.join(snapshotFiber));
    await Effect.runPromise(Fiber.join(writerFiber));

    expect(completedBeforeRelease).toBe(false);
    expect(mutationsBeforeRelease).toEqual([]);
    expect(snapshot.parse((_value, scope) => scope).indexed).toEqual([
      normalized('jira', existing),
    ]);
    expect(writerCompleted).toBe(true);
  }, 10_000);

  test('reconciles stale indexed targets once and keeps listIndexedAuthScopesEffect behavior stable through the shared primitive', async () => {
    const live = {
      providerId: 'github',
      host: 'github.com',
      account: 'live',
    } as const;
    const stale = {
      providerId: 'github',
      host: 'github.com',
      account: 'stale',
    } as const;
    seedIndex('github', [stale, live]);
    store.set(
      `aide:${authIndexScopeName(normalized('github', live))}`,
      'LIVE_VALUE'
    );

    const snapshot = await Effect.runPromise(
      provided(captureAuthProviderCatalogEffect('github'))
    );
    const listed = await Effect.runPromise(
      provided(listIndexedAuthScopesEffect('github'))
    );

    expect(
      snapshot.parse((value, scope) => ({
        scope,
        live: value === 'LIVE_VALUE',
      })).indexed
    ).toEqual([{ scope: normalized('github', live), live: true }]);
    expect(listed).toEqual([normalized('github', live)]);
    expect(store.get(`aide:${authIndexSecretName('github')}`)).toBe(
      serializeAuthIndexDocument(
        makeAuthIndexDocument('github', [normalized('github', live)])
      )
    );
  });

  test('releases the provider lease after successful capture', async () => {
    const snapshot = await Effect.runPromise(
      provided(captureAuthProviderCatalogEffect('github'))
    );

    expect(
      snapshot.parse((value, scope) => ({
        missing: value === null,
        indexed: scope !== undefined,
      }))
    ).toEqual({ legacy: { missing: true, indexed: false }, indexed: [] });
    expect(
      await Effect.runPromise(
        withAuthIndexLock('github', Effect.succeed('reacquired'))
      )
    ).toBe('reacquired');
  });

  test('releases the provider lease after a typed capture failure', async () => {
    keyring.replace({
      fail: (call) => call.name === authIndexSecretName('github'),
    });

    const result = await Effect.runPromise(
      Effect.either(provided(captureAuthProviderCatalogEffect('github')))
    );

    expect(result._tag).toBe('Left');
    if (result._tag === 'Right') throw new Error('expected capture failure');
    expect(result.left).toBeInstanceOf(KeyringUnavailableError);
    expect(
      await Effect.runPromise(
        withAuthIndexLock('github', Effect.succeed('reacquired'))
      )
    ).toBe('reacquired');
  });

  test('releases the provider lease when capture is interrupted', async () => {
    const started = await Effect.runPromise(Deferred.make<void>());
    const release = await Effect.runPromise(Deferred.make<void>());
    const service = {
      get: (name: KeyringSecretName) =>
        name === authIndexSecretName('github')
          ? Effect.zipRight(
              Effect.asVoid(Deferred.succeed(started, undefined)),
              Effect.as(Deferred.await(release), null)
            )
          : Effect.succeed(null),
      set: () => Effect.void,
      delete: () => Effect.succeed(false),
    } satisfies KeyringServiceShape;
    keyring = {
      store,
      layer: Layer.succeed(KeyringService, service),
      replace: () => [],
    };
    const fiber = Effect.runFork(
      provided(captureAuthProviderCatalogEffect('github'))
    );
    await Effect.runPromise(Deferred.await(started));
    const interrupted = Effect.runPromise(Fiber.interrupt(fiber));
    await Bun.sleep(50);
    await Effect.runPromise(Deferred.succeed(release, undefined));
    const exit = await interrupted;

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isSuccess(exit)) throw new Error('expected interrupted capture');
    expect(Cause.isInterrupted(exit.cause)).toBe(true);
    expect(
      await Effect.runPromise(
        withAuthIndexLock('github', Effect.succeed('reacquired'))
      )
    ).toBe('reacquired');
  });

  test('uses only existing fixed typed index, keyring, and lock failures without retaining raw catalog values', async () => {
    const indexSentinel = 'RAW_INDEX_PAYLOAD_SENTINEL_5d17';
    const credentialSentinel = 'RAW_CREDENTIAL_PAYLOAD_SENTINEL_2a91';
    const backend = maliciousBackendFailure([
      indexSentinel,
      credentialSentinel,
    ]);

    store.set(`aide:${authIndexSecretName('github')}`, `{"${indexSentinel}":`);
    let result = await Effect.runPromise(
      Effect.either(provided(captureAuthProviderCatalogEffect('github')))
    );
    expect(result._tag).toBe('Left');
    if (result._tag === 'Right') throw new Error('expected malformed index');
    expect(result.left).toBeInstanceOf(AuthIndexDocumentError);
    expect(rendered(result.left)).not.toContain(indexSentinel);
    expect(rendered(result.left)).not.toContain(credentialSentinel);

    store.clear();
    keyring.replace({ fail: () => true, rejection: backend.failure });
    result = await Effect.runPromise(
      Effect.either(provided(captureAuthProviderCatalogEffect('github')))
    );
    expect(result._tag).toBe('Left');
    if (result._tag === 'Right') throw new Error('expected keyring failure');
    expect(result.left).toBeInstanceOf(KeyringUnavailableError);
    for (const secret of backendFailureSentinels) {
      expect(rendered(result.left)).not.toContain(secret);
    }
    expect(backend.getterReads()).toBe(0);

    Bun.env.AIDE_AUTH_INDEX_LOCK_ROOT = 'relative-lock-root';
    result = await Effect.runPromise(
      Effect.either(provided(captureAuthProviderCatalogEffect('github')))
    );
    expect(result._tag).toBe('Left');
    if (result._tag === 'Right') throw new Error('expected lock failure');
    expect(result.left).toBeInstanceOf(AuthIndexLockError);
    expect(rendered(result.left)).not.toContain(indexSentinel);
    expect(rendered(result.left)).not.toContain(credentialSentinel);
  });

  test('a scoped delete also blocks behind capture and cannot change its in-memory result', async () => {
    const scope = {
      providerId: 'github',
      host: 'github.com',
      account: 'octocat',
    } as const;
    const target = authIndexScopeName(normalized('github', scope));
    seedIndex('github', [scope]);
    store.set(`aide:${target}`, 'CAPTURED_VALUE');
    const started = await Effect.runPromise(Deferred.make<void>());
    const release = await Effect.runPromise(Deferred.make<void>());
    const calls: TestKeyringCall[] = [];
    const service = {
      get: (name: KeyringSecretName) =>
        Effect.gen(function* () {
          calls.push({ operation: 'get', name });
          const value = store.get(`aide:${name}`) ?? null;
          if (name === 'github') {
            yield* Effect.asVoid(Deferred.succeed(started, undefined));
            yield* Deferred.await(release);
          }
          return value;
        }),
      set: (name: KeyringSecretName, value: string) =>
        Effect.sync(() => {
          calls.push({ operation: 'set', name, value });
          store.set(`aide:${name}`, value);
        }),
      delete: (name: KeyringSecretName) =>
        Effect.sync(() => {
          calls.push({ operation: 'delete', name });
          return store.delete(`aide:${name}`);
        }),
    } satisfies KeyringServiceShape;
    keyring = {
      store,
      layer: Layer.succeed(KeyringService, service),
      replace: () => calls,
    };
    const snapshotFiber = Effect.runFork(
      provided(captureAuthProviderCatalogEffect('github'))
    );
    await Effect.runPromise(Deferred.await(started));
    let deleteCompleted = false;
    const deleteFiber = Effect.runFork(
      provided(
        deleteAuthSecretEffect('github', scope).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              deleteCompleted = true;
            })
          )
        )
      )
    );
    await Bun.sleep(75);
    const completedBeforeRelease = deleteCompleted;
    await Effect.runPromise(Deferred.succeed(release, undefined));
    const snapshot = await Effect.runPromise(Fiber.join(snapshotFiber));
    await Effect.runPromise(Fiber.join(deleteFiber));

    expect(completedBeforeRelease).toBe(false);
    expect(
      snapshot.parse((value, capturedScope) => ({
        scope: capturedScope,
        captured: value === 'CAPTURED_VALUE',
      })).indexed
    ).toEqual([{ scope: normalized('github', scope), captured: true }]);
    expect(deleteCompleted).toBe(true);
  }, 10_000);
});
