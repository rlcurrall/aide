import { describe, expect, test } from 'bun:test';
import {
  Cause,
  Effect,
  Exit,
  Fiber,
  Option,
  TestClock,
  TestContext,
} from 'effect';

import { createKeyringCommandRegistry } from './command-registry.js';
import {
  defineAidePlugin,
  type AideAuthScope,
  type AidePullRequestProviderCapability,
} from './plugin-descriptor.js';
import {
  PullRequestAuthScopeSelectionError,
  PullRequestProviderMutationIndeterminateError,
  certifiedPullRequestAuthScopeSelectionError,
  pullRequestProviderErrorMessage,
  type PullRequestProviderAuthScopeSelector,
} from './pull-request-provider-resolver.js';
import { createAideInternalHostServices } from './runtime-context.js';
import { runPullRequestCommandEffect } from '@cli/plugins/pull-requests/commands/error.js';
import { makeTestKeyring } from '@lib/auth-keyring.test-helper.js';
import { testGitHubAuthCatalogLayer } from '@lib/github-auth-catalog.test-helper.js';

const repository = Object.freeze({
  kind: 'external' as const,
  providerId: 'synthetic-selection',
  displayName: 'Synthetic selection',
});
const scope = Object.freeze({
  id: 'synthetic-selection:host:example.test:account:ada',
  providerId: 'synthetic-selection',
  host: 'example.test',
  account: 'ada',
});

function makeHarness() {
  const calls = { matcher: 0, operation: 0 };
  const observedScopes: unknown[] = [];
  const capability: AidePullRequestProviderCapability = {
    providerId: 'synthetic-selection',
    priority: 100,
    features: {},
    authStatus: () => Effect.succeed({ state: 'configured' }),
    matchRemote: () => {
      calls.matcher += 1;
      return { source: 'git-remote', repository };
    },
    matchPullRequestUrl: () => null,
    operations: {
      listPullRequests: (request) => {
        calls.operation += 1;
        observedScopes.push(request.authScope);
        return Effect.succeed({ repository, pullRequests: [] });
      },
    },
  };
  const registry = createKeyringCommandRegistry().registerPlugin(
    defineAidePlugin({
      id: 'synthetic-selection',
      summary: 'Synthetic selection provider',
      commands: [],
      capabilities: { pullRequestProvider: capability },
    })
  );
  const internal = createAideInternalHostServices(
    registry,
    makeTestKeyring().layer,
    testGitHubAuthCatalogLayer
  );
  return { calls, internal, observedScopes };
}

async function commandMessage(
  selector: PullRequestProviderAuthScopeSelector,
  selectionTimeout: '20 millis' | '1 second' = '1 second'
): Promise<{
  readonly message: string;
  readonly calls: ReturnType<typeof makeHarness>['calls'];
}> {
  const { calls, internal } = makeHarness();
  try {
    await runPullRequestCommandEffect(
      internal
        .withPullRequestAuthScopeSelector(selector, { selectionTimeout })
        .listPullRequestsForRemote('ssh://example.test/acme/widgets.git')
    );
    throw new Error('expected authentication selection to fail');
  } catch (error) {
    return { message: (error as Error).message, calls };
  }
}

function unsafeSelector(
  callback: () => unknown
): PullRequestProviderAuthScopeSelector {
  return callback as PullRequestProviderAuthScopeSelector;
}

describe('pull request authentication selection diagnostics', () => {
  test('preserves only a module-certified domain diagnostic through the real internal wrapper and command runner', async () => {
    const diagnostic = 'Certified synthetic authentication selection failure.';
    const outcome = await commandMessage(() =>
      Effect.fail(certifiedPullRequestAuthScopeSelectionError(diagnostic))
    );

    expect(outcome.message).toBe(diagnostic);
    expect(outcome.calls).toEqual({ matcher: 1, operation: 0 });
  });

  test('normalizes foreign, forged, thrown, defective, interrupted, invalid, and finalization failures without reading attacker fields', async () => {
    const sentinel = 'SECRET-SELECTION-DIAGNOSTIC-SENTINEL';
    let trapReads = 0;
    const hostileFailure = Object.create(null) as Record<string, unknown>;
    for (const field of ['message', 'cause', '_tag', 'details']) {
      Object.defineProperty(hostileFailure, field, {
        get() {
          trapReads += 1;
          throw new Error(sentinel);
        },
      });
    }
    const hostileFailureProxy = new Proxy(hostileFailure, {
      get() {
        trapReads += 1;
        throw new Error(sentinel);
      },
      getOwnPropertyDescriptor() {
        trapReads += 1;
        throw new Error(sentinel);
      },
      getPrototypeOf() {
        trapReads += 1;
        throw new Error(sentinel);
      },
    });
    const hostileScope = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(hostileScope, 'id', {
      get() {
        trapReads += 1;
        throw new Error(sentinel);
      },
    });
    const hostileScopeProxy = new Proxy(scope, {
      get() {
        trapReads += 1;
        throw new Error(sentinel);
      },
      getOwnPropertyDescriptor() {
        trapReads += 1;
        throw new Error(sentinel);
      },
      getPrototypeOf() {
        trapReads += 1;
        throw new Error(sentinel);
      },
    });
    const hostileReturnProxy = new Proxy(
      {},
      {
        get() {
          trapReads += 1;
          throw new Error(sentinel);
        },
        getOwnPropertyDescriptor() {
          trapReads += 1;
          throw new Error(sentinel);
        },
        getPrototypeOf() {
          trapReads += 1;
          throw new Error(sentinel);
        },
      }
    );
    class SelectionErrorSubclass extends PullRequestAuthScopeSelectionError {}
    const direct = new PullRequestAuthScopeSelectionError();
    const subclass = new SelectionErrorSubclass();
    const forged = Object.create(
      PullRequestAuthScopeSelectionError.prototype
    ) as PullRequestAuthScopeSelectionError;
    Object.defineProperty(forged, 'message', {
      get() {
        trapReads += 1;
        throw new Error(sentinel);
      },
    });

    const cases: readonly [string, PullRequestProviderAuthScopeSelector][] = [
      [
        'native failure',
        unsafeSelector(() => Effect.fail(new Error(sentinel))),
      ],
      ['foreign failure', unsafeSelector(() => Effect.fail(hostileFailure))],
      ['failure proxy', unsafeSelector(() => Effect.fail(hostileFailureProxy))],
      ['direct selection error', () => Effect.fail(direct)],
      ['selection error subclass', () => Effect.fail(subclass)],
      ['forged selection error', () => Effect.fail(forged)],
      [
        'callback throw',
        unsafeSelector(() => {
          throw new Error(sentinel);
        }),
      ],
      ['defect', () => Effect.die(new Error(sentinel))],
      ['interruption', () => Effect.interrupt],
      ['invalid return', unsafeSelector(() => ({ sentinel }))],
      ['hostile return proxy', unsafeSelector(() => hostileReturnProxy)],
      ['invalid success primitive', unsafeSelector(() => Effect.succeed(1))],
      [
        'invalid success provider mismatch',
        () => Effect.succeed({ ...scope, providerId: 'other-provider' }),
      ],
      [
        'invalid success accessor',
        unsafeSelector(() =>
          Effect.succeed(hostileScope as unknown as AideAuthScope)
        ),
      ],
      [
        'invalid success proxy',
        unsafeSelector(() => Effect.succeed(hostileScopeProxy)),
      ],
      [
        'finalization defect',
        () =>
          Effect.acquireUseRelease(
            Effect.void,
            () => Effect.succeed(scope),
            () => Effect.die(new Error(sentinel))
          ),
      ],
    ];

    for (const [name, selector] of cases) {
      const outcome = await commandMessage(selector);
      expect(outcome.message, name).toBe(
        'Pull request authentication selection failed.'
      );
      expect(outcome.message, name).not.toContain(sentinel);
      expect(outcome.calls, name).toEqual({ matcher: 1, operation: 0 });
    }
    expect(trapReads).toBe(0);
  });

  test('snapshots exact scope length boundaries and rejects malformed identity shapes table-first', async () => {
    const exactId = 'i'.repeat(1_024);
    const exactHost = 'h'.repeat(253);
    const exactOrg = 'o'.repeat(256);
    const exactAccount = 'a'.repeat(256);
    const nullPrototypeScope = Object.assign(Object.create(null), scope);
    const customPrototypeScope = Object.assign(
      Object.create({ marker: true }),
      scope
    );
    const sparseArrayScope: unknown[] = [];
    sparseArrayScope.length = 3;
    Object.assign(sparseArrayScope, scope);
    const inheritedIdentityScope = Object.create(scope);
    const revoked = Proxy.revocable(scope, {});
    revoked.revoke();

    const validCases = [
      ['maximum id length', { ...scope, id: exactId }],
      ['maximum host length', { ...scope, host: exactHost }],
      ['maximum org length', { ...scope, org: exactOrg }],
      ['maximum account length', { ...scope, account: exactAccount }],
      ['null prototype identity', nullPrototypeScope],
    ] as const;
    for (const [name, candidate] of validCases) {
      const { calls, internal, observedScopes } = makeHarness();
      const exit = await Effect.runPromiseExit(
        internal
          .withPullRequestAuthScopeSelector(
            unsafeSelector(() => Effect.succeed(candidate))
          )
          .listPullRequestsForRemote('ssh://example.test/acme/widgets.git')
      );
      expect(Exit.isSuccess(exit), name).toBe(true);
      expect(calls, name).toEqual({ matcher: 1, operation: 1 });
      expect(observedScopes, name).toHaveLength(1);
      expect(observedScopes[0], name).not.toBe(candidate);
      expect(Object.isFrozen(observedScopes[0]), name).toBe(true);
    }

    const malformedText = [
      ['lone high surrogate', '\ud800'],
      ['lone low surrogate', '\udc00'],
      ['nul', '\u0000'],
      ['c0 control', '\u001f'],
      ['delete', '\u007f'],
      ['c1 control', '\u009f'],
      ['left-to-right mark', '\u200e'],
      ['right-to-left mark', '\u200f'],
      ['line separator', '\u2028'],
      ['paragraph separator', '\u2029'],
      ['bidi embedding', '\u202a'],
      ['bidi override', '\u202e'],
      ['bidi isolate', '\u2066'],
      ['bidi isolate terminator', '\u2069'],
      ['byte order mark', '\ufeff'],
    ] as const;
    const invalidCases: readonly (readonly [string, unknown])[] = [
      ['overlong id', { ...scope, id: `${exactId}i` }],
      ['overlong host', { ...scope, host: `${exactHost}h` }],
      ['overlong org', { ...scope, org: `${exactOrg}o` }],
      ['overlong account', { ...scope, account: `${exactAccount}a` }],
      ...malformedText.map(
        ([name, text]) => [name, { ...scope, account: `ada${text}` }] as const
      ),
      ['custom prototype identity', customPrototypeScope],
      ['sparse array identity', sparseArrayScope],
      ['inherited identity fields', inheritedIdentityScope],
      ['revoked scope proxy', revoked.proxy],
    ];

    for (const [name, candidate] of invalidCases) {
      const { calls, internal, observedScopes } = makeHarness();
      const exit = await Effect.runPromiseExit(
        internal
          .withPullRequestAuthScopeSelector(
            unsafeSelector(() => Effect.succeed(candidate))
          )
          .listPullRequestsForRemote('ssh://example.test/acme/widgets.git')
      );
      expect(Exit.isFailure(exit), name).toBe(true);
      if (Exit.isSuccess(exit)) throw new Error(`expected ${name} to fail`);
      const failure = Cause.failureOption(exit.cause);
      expect(Option.isSome(failure), name).toBe(true);
      if (Option.isNone(failure)) {
        throw new Error(`expected typed ${name} failure`);
      }
      expect(pullRequestProviderErrorMessage(failure.value), name).toBe(
        'Pull request authentication selection failed.'
      );
      expect(calls, name).toEqual({ matcher: 1, operation: 0 });
      expect(observedScopes, name).toEqual([]);
    }
  });

  test('times out only selection and never reports a mutation-indeterminate error', async () => {
    const { calls, internal } = makeHarness();
    const effect = internal
      .withPullRequestAuthScopeSelector(() => Effect.never, {
        selectionTimeout: '20 millis',
      })
      .listPullRequestsForRemote('ssh://example.test/acme/widgets.git');
    const exit = await Effect.runPromiseExit(effect);

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isSuccess(exit)) throw new Error('expected selection timeout');
    const failure = Cause.failureOption(exit.cause);
    expect(Option.isSome(failure)).toBe(true);
    if (Option.isNone(failure))
      throw new Error('expected typed selection failure');
    expect(failure.value).toBeInstanceOf(PullRequestAuthScopeSelectionError);
    expect(failure.value).not.toBeInstanceOf(
      PullRequestProviderMutationIndeterminateError
    );
    expect(pullRequestProviderErrorMessage(failure.value)).toBe(
      'Pull request authentication selection timed out.'
    );
    expect(calls).toEqual({ matcher: 1, operation: 0 });

    const commandOutcome = await commandMessage(
      () => Effect.never,
      '20 millis'
    );
    expect(commandOutcome.message).toBe(
      'Pull request authentication selection timed out.'
    );
    expect(commandOutcome.calls).toEqual({ matcher: 1, operation: 0 });
  });

  test('uses the default ten-second selection timeout without wall-clock waiting', async () => {
    const { calls, internal } = makeHarness();
    const program = Effect.gen(function* () {
      const fiber = yield* Effect.fork(
        internal
          .withPullRequestAuthScopeSelector(() => Effect.never)
          .listPullRequestsForRemote('ssh://example.test/acme/widgets.git')
      );
      yield* Effect.yieldNow();
      yield* TestClock.adjust('9999 millis');
      const beforeDeadline = yield* Fiber.poll(fiber);
      yield* TestClock.adjust('1 millis');
      const atDeadline = yield* Fiber.await(fiber);
      return { atDeadline, beforeDeadline };
    }).pipe(Effect.provide(TestContext.TestContext));

    const { atDeadline, beforeDeadline } = await Effect.runPromise(program);
    expect(Option.isNone(beforeDeadline)).toBe(true);
    expect(Exit.isFailure(atDeadline)).toBe(true);
    if (Exit.isSuccess(atDeadline)) {
      throw new Error('expected default selection timeout');
    }
    const failure = Cause.failureOption(atDeadline.cause);
    expect(Option.isSome(failure)).toBe(true);
    if (Option.isNone(failure)) {
      throw new Error('expected typed default selection timeout');
    }
    expect(pullRequestProviderErrorMessage(failure.value)).toBe(
      'Pull request authentication selection timed out.'
    );
    expect(calls).toEqual({ matcher: 1, operation: 0 });
  });
});
