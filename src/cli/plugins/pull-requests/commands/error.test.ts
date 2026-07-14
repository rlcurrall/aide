import { describe, expect, test } from 'bun:test';
import { Cause, Effect, FiberId } from 'effect';
import { inspect } from 'node:util';

import { createKeyringCommandRegistry } from '@cli/host/command-registry.js';
import {
  defineAidePlugin,
  type AidePullRequestProviderCapability,
} from '@cli/host/plugin-descriptor.js';
import {
  AmbiguousPullRequestProviderError,
  InvalidPullRequestProviderMatchError,
  InvalidPullRequestProviderOperationResultError,
  PullRequestProviderMutationIndeterminateError,
  PullRequestProviderInvocationError,
  PullRequestProviderOperationError,
  PullRequestProviderOperationTimeoutError,
  PullRequestProviderTimeoutError,
  resolvePullRequestProviderForRemote,
  UnsupportedPullRequestProviderError,
  UnsupportedPullRequestProviderOperationError,
} from '@cli/host/pull-request-provider-resolver.js';
import { createAideHostServices } from '@cli/host/runtime-context.js';
import { renderTopLevelError } from '@cli/index.js';

import {
  pullRequestCommandError,
  runPullRequestCommandEffect,
} from './error.js';

async function rejectedBy<A, E>(effect: Effect.Effect<A, E, never>) {
  try {
    await runPullRequestCommandEffect(effect);
  } catch (error) {
    return error;
  }
  throw new Error('Expected pull request command Effect to reject');
}

function expectHostBoundaryError(
  error: unknown,
  message = 'Pull request provider execution failed'
) {
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).name).toBe('PullRequestCommandEffectError');
  expect((error as Error).message).toBe(message);
  expect(renderTopLevelError(error)).toBe(`Error: ${message}`);
  expect(Object.prototype.hasOwnProperty.call(error, 'cause')).toBe(false);
}

async function authoritativeUnsupportedFailure() {
  return Effect.runPromise(
    Effect.flip(
      resolvePullRequestProviderForRemote(
        [],
        'ssh://prototype-snapshot.example/aide.git'
      )
    )
  );
}

describe('runPullRequestCommandEffect Cause boundary', () => {
  test('renders a hostile pure Fail without inspecting it', async () => {
    let reads = 0;
    const failure = new Proxy(Object.create(null), {
      get() {
        reads += 1;
        throw new Error('hostile failure getter ran');
      },
      getPrototypeOf() {
        reads += 1;
        throw new Error('hostile failure prototype trap ran');
      },
    });
    const cause = Cause.fail(failure);
    expectHostBoundaryError(await rejectedBy(Effect.failCause(cause)));
    expect(reads).toBe(0);
  });

  test('renders a pure Die through the fixed public command boundary', async () => {
    const defect = Object.freeze({ kind: 'defect' });
    const cause = Cause.die(defect);
    expectHostBoundaryError(await rejectedBy(Effect.failCause(cause)));
  });

  test('runs cancellation finalizers before rendering pure interruption', async () => {
    const interruptor = FiberId.make(811, 23);
    const cause = Cause.interrupt(interruptor);
    let finalized = false;
    const error = await rejectedBy(
      Effect.failCause(cause).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            finalized = true;
          })
        )
      )
    );

    expect(finalized).toBe(true);
    expectHostBoundaryError(error);
  });

  for (const [topology, combine] of [
    ['Parallel', Cause.parallel],
    ['Sequential', Cause.sequential],
  ] as const) {
    test(`public rendering finds the exact authoritative Fail inside ${topology} Fail + Die + Interrupt topology`, async () => {
      const failure = await authoritativeUnsupportedFailure();
      const secret = `SECRET-${topology.toUpperCase()}-CAUSE-IDENTITY`;
      let messageReads = 0;
      Object.defineProperty(failure, 'message', {
        configurable: true,
        get() {
          messageReads += 1;
          throw new Error(secret);
        },
      });
      const defect = Object.freeze({ topology, kind: 'defect', secret });
      const interruptor = FiberId.make(topology === 'Parallel' ? 821 : 822, 29);
      const terminal = Cause.sequential(
        Cause.die(defect),
        Cause.interrupt(interruptor)
      );
      const cause = combine(Cause.fail(failure), terminal);
      const error = await rejectedBy(Effect.failCause(cause));
      const expected =
        'No pull request provider matched git-remote: ssh://prototype-snapshot.example/aide.git';

      expectHostBoundaryError(error, expected);
      expect(messageReads).toBe(0);
      expect(String((error as Error).stack)).not.toContain(secret);
      expect(inspect(error)).not.toContain(secret);
    });
  }

  test('public rendering retains authoritative identity ordering among multiple Fail leaves', async () => {
    const first = Object.freeze({ index: 1 });
    const authoritative = await authoritativeUnsupportedFailure();
    let reads = 0;
    Object.defineProperty(authoritative, 'message', {
      configurable: true,
      get() {
        reads += 1;
        throw new Error('SECRET-MULTI-FAIL-MESSAGE');
      },
    });
    const third = Object.freeze({ index: 3 });
    const cause = Cause.parallel(
      Cause.fail(first),
      Cause.sequential(Cause.fail(authoritative), Cause.fail(third))
    );

    expectHostBoundaryError(
      await rejectedBy(Effect.failCause(cause)),
      'No pull request provider matched git-remote: ssh://prototype-snapshot.example/aide.git'
    );
    expect(reads).toBe(0);
  });

  test('direct exported wrapper constructors have no display authority or live message reads', async () => {
    for (const behavior of ['return', 'throw'] as const) {
      let reads = 0;
      const failure = new PullRequestProviderOperationError({
        pluginId: 'attacker-plugin',
        providerId: 'attacker-provider',
        operation: 'updatePullRequest',
        cause: null,
      });
      Object.defineProperty(failure, 'message', {
        configurable: true,
        get() {
          reads += 1;
          if (behavior === 'throw') {
            throw new Error('SECRET-THROWING-WRAPPER-MESSAGE');
          }
          return 'SECRET-RETURNING-WRAPPER-MESSAGE';
        },
      });

      const error = await rejectedBy(Effect.fail(failure));
      expect((error as Error).message).toBe(
        'Pull request provider execution failed'
      );
      expect(renderTopLevelError(error)).toBe(
        'Error: Pull request provider execution failed'
      );
      expect(String((error as Error).stack)).not.toContain('SECRET');
      expect(inspect(error)).not.toContain('SECRET');
      expect(reads).toBe(0);
    }
  });

  test('subclass, changed prototype, Proxy, spread, clone, and lookalike wrappers stay generic', async () => {
    let reads = 0;
    class ForgedInvocationError extends PullRequestProviderInvocationError {
      override get message(): string {
        reads += 1;
        return 'SECRET-SUBCLASS-MESSAGE';
      }
    }

    const subclass = new ForgedInvocationError({
      source: 'git-remote',
      value: 'attacker',
      pluginId: 'attacker-plugin',
      providerId: 'attacker-provider',
      cause: null,
    });
    const prototypeChanged = new PullRequestProviderOperationError({
      pluginId: 'attacker-plugin',
      providerId: 'attacker-provider',
      operation: 'updatePullRequest',
      cause: null,
    });
    Object.setPrototypeOf(prototypeChanged, null);
    const direct = new PullRequestProviderOperationError({
      pluginId: 'attacker-plugin',
      providerId: 'attacker-provider',
      operation: 'updatePullRequest',
      cause: null,
    });
    const proxied = new Proxy(direct, {
      get() {
        reads += 1;
        throw new Error('SECRET-PROXY-GET');
      },
      getPrototypeOf() {
        reads += 1;
        throw new Error('SECRET-PROXY-PROTOTYPE');
      },
    });
    const spread = { ...direct };
    const clone = structuredClone(spread);
    const lookalike = Object.freeze({
      _tag: 'PullRequestProviderOperationError',
      message: 'SECRET-LOOKALIKE-MESSAGE',
    });

    for (const failure of [
      subclass,
      prototypeChanged,
      proxied,
      spread,
      clone,
      lookalike,
    ]) {
      const error = await rejectedBy(Effect.fail(failure));
      expect((error as Error).message).toBe(
        'Pull request provider execution failed'
      );
    }
    expect(reads).toBe(0);
  });

  test('all other exported host error constructors remain typed data without display authority', async () => {
    const directFailures: unknown[] = [
      new UnsupportedPullRequestProviderError({
        source: 'git-remote',
        value: 'attacker',
      }),
      new AmbiguousPullRequestProviderError({
        source: 'git-remote',
        value: 'attacker',
        priority: 100,
        candidates: [],
      }),
      new InvalidPullRequestProviderMatchError({
        source: 'git-remote',
        value: 'attacker',
        pluginId: 'attacker-plugin',
        providerId: 'attacker-provider',
        reason: 'attacker reason',
      }),
      new PullRequestProviderTimeoutError({
        source: 'git-remote',
        value: 'attacker',
        pluginId: 'attacker-plugin',
        providerId: 'attacker-provider',
      }),
      new UnsupportedPullRequestProviderOperationError({
        pluginId: 'attacker-plugin',
        providerId: 'attacker-provider',
        operation: 'listPullRequests',
      }),
      new InvalidPullRequestProviderOperationResultError({
        pluginId: 'attacker-plugin',
        providerId: 'attacker-provider',
        operation: 'getPullRequest',
        reason: 'attacker reason',
      }),
      new PullRequestProviderOperationTimeoutError({
        pluginId: 'attacker-plugin',
        providerId: 'attacker-provider',
        operation: 'getPullRequestDiff',
      }),
      new PullRequestProviderMutationIndeterminateError({
        pluginId: 'attacker-plugin',
        providerId: 'attacker-provider',
        operation: 'createPullRequest',
      }),
    ];
    let reads = 0;
    for (const failure of directFailures) {
      Object.defineProperty(failure, 'message', {
        configurable: true,
        get() {
          reads += 1;
          return 'SECRET-DIRECT-HOST-CONSTRUCTOR';
        },
      });
      const error = await rejectedBy(Effect.fail(failure));
      expect((error as Error).message).toBe(
        'Pull request provider execution failed'
      );
    }
    expect(reads).toBe(0);
  });

  test('command-local validation text is captured before later Error mutation', () => {
    const error = pullRequestCommandError(
      'Could not determine repository context.'
    );
    let reads = 0;
    Object.defineProperties(error, {
      message: {
        configurable: true,
        get() {
          reads += 1;
          throw new Error('SECRET-MUTATED-COMMAND-MESSAGE');
        },
      },
      name: {
        configurable: true,
        get() {
          reads += 1;
          throw new Error('SECRET-MUTATED-COMMAND-NAME');
        },
      },
    });
    expect(renderTopLevelError(error)).toBe(
      'Error: Could not determine repository context.'
    );
    expect(reads).toBe(0);
  });

  test('host-emitted wrapper keeps its captured text after message, name, and prototype mutation', async () => {
    const repository = Object.freeze({
      kind: 'external' as const,
      providerId: 'host-emitted-wrapper',
      displayName: 'Host emitted wrapper',
    });
    const capability: AidePullRequestProviderCapability = {
      providerId: repository.providerId,
      priority: 100,
      features: {},
      authStatus: () => Effect.succeed({ state: 'configured' }),
      matchRemote: () => null,
      matchRepository: () =>
        Effect.succeed({ source: 'repository-ref', repository }),
      matchPullRequestUrl: () => null,
      operations: {
        listPullRequests: () => Effect.fail(Object.freeze({ external: true })),
      },
    };
    const registry = createKeyringCommandRegistry().registerPlugin(
      defineAidePlugin({
        id: 'host-emitted-wrapper',
        summary: 'Host emitted wrapper probe',
        commands: [],
        capabilities: { pullRequestProvider: capability },
      })
    );
    const wrapper = await Effect.runPromise(
      Effect.flip(
        createAideHostServices(registry).listPullRequestsForRepository(
          repository
        )
      )
    );
    let reads = 0;
    Object.defineProperties(wrapper, {
      message: {
        configurable: true,
        get() {
          reads += 1;
          throw new Error('SECRET-MUTATED-HOST-MESSAGE');
        },
      },
      name: {
        configurable: true,
        get() {
          reads += 1;
          throw new Error('SECRET-MUTATED-HOST-NAME');
        },
      },
    });
    Object.setPrototypeOf(wrapper, null);

    const error = await rejectedBy(Effect.fail(wrapper));
    expect((error as Error).message).toBe(
      "Pull request provider 'host-emitted-wrapper' from plugin 'host-emitted-wrapper' failed during listPullRequests"
    );
    expect(renderTopLevelError(error)).toBe(
      "Error: Pull request provider 'host-emitted-wrapper' from plugin 'host-emitted-wrapper' failed during listPullRequests"
    );
    expect(reads).toBe(0);
  });
});
