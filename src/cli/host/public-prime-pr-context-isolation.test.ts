import { describe, expect, test } from 'bun:test';
import {
  Cause,
  Deferred,
  Effect,
  Effectable,
  Exit,
  Fiber,
  FiberRef,
  Option,
} from 'effect';

import {
  AIDE_PLUGIN_API_VERSION,
  PrimeContributionError,
  defineAidePlugin as definePublicAidePlugin,
} from '@aide/plugin-api';
import {
  createKeyringCommandRegistry,
  type KeyringCommandRegistry,
} from '@cli/host/command-registry.js';
import {
  AideInternalHostServicesTag,
  createAideHostServices,
  createAideInternalHostServices,
} from '@cli/host/runtime-context.js';
import { testGitHubAuthCatalogLayer } from '@lib/github-auth-catalog.test-helper.js';
import type {
  AidePluginAuthStatus,
  AidePrimeSection,
  AidePullRequestAddCommentRequest,
  AidePullRequestBranchLookupRequest,
  AidePullRequestCommentMutationResult,
  AidePullRequestCommentsRequest,
  AidePullRequestCommentsResult,
  AidePullRequestCreateRequest,
  AidePullRequestCreateResult,
  AidePullRequestDiffRequest,
  AidePullRequestDiffResult,
  AidePullRequestListRequest,
  AidePullRequestListResult,
  AidePullRequestProviderCapability,
  AidePullRequestReplyCommentRequest,
  AidePullRequestRepositoryInput,
  AidePullRequestUpdateRequest,
  AidePullRequestUpdateResult,
  AidePullRequestViewRequest,
  AidePullRequestViewResult,
} from '@cli/host/plugin-descriptor.js';
import {
  InvalidPullRequestProviderMatchError,
  InvalidPullRequestProviderOperationResultError,
  PullRequestProviderInvocationError,
  PullRequestProviderOperationError,
} from '@cli/host/pull-request-provider-resolver.js';
import { renderTopLevelError } from '@cli/index.js';
import { KeyringService } from '@lib/auth-keyring.js';
import { makeTestKeyring } from '@lib/auth-keyring.test-helper.js';
import { exportedErrorText } from '@lib/error-redaction.test-helper.js';

const providerId = 'external-isolation';
const fakeSecret = 'FAKE-PR-SECRET';
const repository = Object.freeze({
  kind: 'external' as const,
  providerId,
  displayName: 'External Isolation',
  metadata: Object.freeze({ repository: 'widgets' }),
});
const pullRequest = Object.freeze({ number: 7 });

interface AuthorityObservation {
  readonly keyring: string | null;
  readonly internalHost: boolean;
}

function currentFiberRefValue<A>(
  fiberRef: FiberRef.FiberRef<A>
): A | undefined {
  const current = (
    globalThis as typeof globalThis & {
      readonly ['effect/FiberCurrent']?: {
        readonly getFiberRef: (ref: FiberRef.FiberRef<A>) => A;
      };
    }
  )['effect/FiberCurrent'];
  return current?.getFiberRef(fiberRef);
}

function externalManifest(id: string) {
  return {
    id,
    version: '1.0.0',
    aidePluginApiVersion: AIDE_PLUGIN_API_VERSION,
    capabilities: ['pull-request-provider'] as const,
  };
}

function ambientAuthority<A>(
  observations: Map<string, AuthorityObservation>,
  name: string,
  result: A
): Effect.Effect<A, never, never> {
  return Effect.gen(function* () {
    const keyring = yield* Effect.serviceOption(KeyringService);
    const internalHost = yield* Effect.serviceOption(
      AideInternalHostServicesTag
    );
    const secret = yield* Option.match(keyring, {
      onNone: () => Effect.succeed(null),
      onSome: (service) =>
        service.get('jira').pipe(Effect.orElseSucceed(() => null)),
    });
    observations.set(name, {
      keyring: secret,
      internalHost: Option.isSome(internalHost),
    });
    return result;
  }) as Effect.Effect<A, never, never>;
}

function pullRequestItem(sourceBranch = 'feature') {
  return {
    id: pullRequest.number,
    title: 'Isolation probe',
    status: 'active' as const,
    createdAt: '2026-07-11T00:00:00.000Z',
    author: { displayName: 'Ada Lovelace' },
    sourceBranch,
    targetBranch: 'main',
  };
}

function effectMarkerPrototypeDepth(value: object): number | null {
  let current: object | null = value;
  let depth = 0;
  while (current !== null) {
    if (
      Reflect.getOwnPropertyDescriptor(current, Effect.EffectTypeId) !==
      undefined
    ) {
      return depth;
    }
    current = Reflect.getPrototypeOf(current);
    depth += 1;
  }
  return null;
}

function effectableAtMarkerDepth<A>(
  markerDepth: number,
  value: A
): Effect.Effect<A> {
  class Base extends Effectable.Class<A> {
    commit(): Effect.Effect<A> {
      return Effect.succeed(value);
    }
  }

  let Current = Base;
  let effect = new Current();
  while ((effectMarkerPrototypeDepth(effect) ?? markerDepth) < markerDepth) {
    Current = class extends Current {};
    effect = new Current();
  }
  expect(effectMarkerPrototypeDepth(effect)).toBe(markerDepth);
  return effect;
}

function viewResult(
  request: Pick<AidePullRequestViewRequest, 'pullRequest'>
): AidePullRequestViewResult {
  return {
    repository,
    pullRequest: {
      ...pullRequestItem(),
      id: request.pullRequest.number,
    },
  };
}

function mutationResult(
  request:
    | Omit<AidePullRequestAddCommentRequest, 'match'>
    | Omit<AidePullRequestReplyCommentRequest, 'match'>
): AidePullRequestCommentMutationResult {
  return {
    repository,
    pullRequest: request.pullRequest,
    comment: {
      id: 91,
      kind: 'issue',
      author: { displayName: 'Ada Lovelace' },
      body: request.body,
      createdAt: '2026-07-11T00:00:00.000Z',
    },
  };
}

function makeExternalProvider(
  constructions: string[],
  observations: Map<string, AuthorityObservation>,
  authStatusCalls: { count: number },
  synchronousMatcherArguments: Map<string, readonly unknown[]> = new Map(),
  operationRequests: Map<string, unknown[]> = new Map()
): AidePullRequestProviderCapability {
  const constructed = <A>(name: string, result: A): Effect.Effect<A> => {
    constructions.push(name);
    return ambientAuthority(observations, name, result);
  };
  const observed = <A>(name: string, request: unknown, result: A) => {
    const requests = operationRequests.get(name) ?? [];
    requests.push(request);
    operationRequests.set(name, requests);
    return constructed(name, result);
  };

  return {
    providerId,
    priority: 100,
    features: {},
    authStatus: () => {
      authStatusCalls.count += 1;
      return constructed('authStatus', { state: 'configured' as const });
    },
    matchRemote: (...args: [string]) => {
      constructions.push('matchRemote');
      synchronousMatcherArguments.set('matchRemote', args);
      return { source: 'git-remote', repository };
    },
    matchRepository: (_input: AidePullRequestRepositoryInput) =>
      constructed('matchRepository', {
        source: 'repository-ref' as const,
        repository,
      }),
    matchPullRequestUrl: (...args: [string]) => {
      constructions.push('matchPullRequestUrl');
      synchronousMatcherArguments.set('matchPullRequestUrl', args);
      return {
        source: 'pull-request-url',
        repository,
        pullRequest,
      };
    },
    operations: {
      listPullRequests: (request: AidePullRequestListRequest) =>
        observed<AidePullRequestListResult>('listPullRequests', request, {
          repository: request.match.repository,
          pullRequests: [
            {
              id: pullRequest.number,
              title: 'Isolation probe',
              status: 'active' as const,
              createdAt: '2026-07-11T00:00:00.000Z',
              author: { displayName: 'Ada Lovelace' },
            },
          ],
        }),
      getPullRequest: (request: AidePullRequestViewRequest) =>
        observed('getPullRequest', request, viewResult(request)),
      createPullRequest: (request: AidePullRequestCreateRequest) =>
        observed<AidePullRequestCreateResult>('createPullRequest', request, {
          repository: request.match.repository,
          pullRequest: pullRequestItem(request.sourceBranch),
        }),
      updatePullRequest: (request: AidePullRequestUpdateRequest) =>
        observed<AidePullRequestUpdateResult>(
          'updatePullRequest',
          request,
          viewResult(request)
        ),
      getPullRequestDiff: (request: AidePullRequestDiffRequest) =>
        observed<AidePullRequestDiffResult>('getPullRequestDiff', request, {
          ...viewResult(request),
          files: [],
        }),
      listPullRequestComments: (request: AidePullRequestCommentsRequest) =>
        observed<AidePullRequestCommentsResult>(
          'listPullRequestComments',
          request,
          {
            repository: request.match.repository,
            pullRequest: request.pullRequest,
            threads: [],
          }
        ),
      addPullRequestComment: (request: AidePullRequestAddCommentRequest) =>
        observed('addPullRequestComment', request, mutationResult(request)),
      replyToPullRequestComment: (
        request: AidePullRequestReplyCommentRequest
      ) =>
        observed('replyToPullRequestComment', request, mutationResult(request)),
      findPullRequestForBranch: (request: AidePullRequestBranchLookupRequest) =>
        observed('findPullRequestForBranch', request, {
          branch: request.branch,
          repository: request.match.repository,
          pullRequest: pullRequestItem(request.branch),
        }),
    },
  };
}

function registerExternalProvider(
  registry: KeyringCommandRegistry,
  constructions: string[],
  observations: Map<string, AuthorityObservation>,
  authStatusCalls: { count: number },
  synchronousMatcherArguments: Map<string, readonly unknown[]>
): void {
  registry.registerExternalPlugin(
    definePublicAidePlugin({
      id: 'external-pr-isolation',
      summary: 'External PR isolation probe',
      commands: [],
      capabilities: {
        pullRequestProvider: makeExternalProvider(
          constructions,
          observations,
          authStatusCalls,
          synchronousMatcherArguments
        ),
      },
    }),
    { manifest: externalManifest('external-pr-isolation') }
  );
}

function registerTrustedNonMatchingProvider(
  registry: KeyringCommandRegistry,
  authStatusCalls: { count: number }
): void {
  registry.registerPlugin({
    id: 'trusted-pr-isolation',
    summary: 'Trusted non-matching PR isolation probe',
    commands: [],
    capabilities: {
      pullRequestProvider: {
        providerId: 'trusted-isolation',
        priority: 200,
        features: {},
        authStatus: () => {
          authStatusCalls.count += 1;
          return Effect.flatMap(KeyringService, () =>
            Effect.succeed<AidePluginAuthStatus>({ state: 'configured' })
          );
        },
        matchRemote: () => null,
        matchRepository: () => Effect.succeed(null),
        matchPullRequestUrl: () => null,
      },
    },
  });
}

function makeAmbientRunner() {
  const keyring = makeTestKeyring(new Map([['aide:jira', fakeSecret]]));
  const internalServices = createAideInternalHostServices(
    createKeyringCommandRegistry(),
    keyring.layer,
    testGitHubAuthCatalogLayer
  );
  return <A, E>(effect: Effect.Effect<A, E, never>) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provideService(AideInternalHostServicesTag, internalServices),
        Effect.provide(keyring.layer)
      )
    );
}

interface HostileEffectReturnCase {
  readonly name: string;
  readonly value: unknown;
  readonly secrets: readonly string[];
  readonly attacker?: unknown;
}

function forgedPrimeRecognitionFailure(): {
  readonly error: PrimeContributionError;
  readonly secrets: readonly string[];
} {
  const secret = 'SECRET-FORGED-PRIME-RECOGNITION';
  const secretKey = `attacker-${secret}`;
  const error = new PrimeContributionError({
    pluginId: 'attacker-prime-recognition',
    contribution: 'sections',
    reason: 'invalid-result',
  });
  Object.assign(error as unknown as Record<string, unknown>, {
    pluginId: secret,
    reason: secret,
    diagnostic: secret,
    cause: new Error(secret),
    [secretKey]: { nested: secret },
  });
  Object.defineProperty(error, `accessor-${secret}`, {
    enumerable: true,
    get: () => secret,
  });
  return { error, secrets: [secret, secretKey] };
}

function hostileEffectReturnCases(
  genuineEffect: Effect.Effect<unknown>,
  forgedPrimeError?: ReturnType<typeof forgedPrimeRecognitionFailure>
): readonly HostileEffectReturnCase[] {
  const ordinaryRecognitionSecret = 'SECRET-HAS-TRAP-RECOGNITION';
  const revokedSecret = 'SECRET-REVOKED-EFFECT-RECOGNITION';
  const pipeAccessSecret = 'SECRET-EFFECT-PIPE-ACCESS';
  const pipeInvocationSecret = 'SECRET-EFFECT-PIPE-INVOCATION';
  const { proxy: revoked, revoke } = Proxy.revocable({}, {});
  revoke();
  const cases: HostileEffectReturnCase[] = [
    {
      name: 'ordinary recognition throw',
      value: new Proxy(
        {},
        {
          has() {
            throw new Error(ordinaryRecognitionSecret);
          },
        }
      ),
      secrets: [ordinaryRecognitionSecret],
    },
  ];
  if (forgedPrimeError !== undefined) {
    cases.push({
      name: 'forged Prime recognition throw',
      value: new Proxy(
        {},
        {
          has() {
            throw forgedPrimeError.error;
          },
        }
      ),
      secrets: forgedPrimeError.secrets,
      attacker: forgedPrimeError.error,
    });
  }
  cases.push(
    {
      name: 'revoked Proxy',
      value: revoked,
      secrets: [revokedSecret],
    },
    {
      name: 'genuine Effect with unreadable pipe',
      value: new Proxy(genuineEffect, {
        get(target, property, receiver) {
          if (property === 'pipe') throw new Error(pipeAccessSecret);
          return Reflect.get(target, property, receiver);
        },
      }),
      secrets: [pipeAccessSecret],
    },
    {
      name: 'genuine Effect with throwing pipe invocation',
      value: new Proxy(genuineEffect, {
        get(target, property, receiver) {
          if (property === 'pipe') {
            return () => {
              throw new Error(pipeInvocationSecret);
            };
          }
          return Reflect.get(target, property, receiver);
        },
      }),
      secrets: [pipeInvocationSecret],
    },
    { name: 'primitive baseline', value: 0, secrets: [] },
    { name: 'object baseline', value: {}, secrets: [] }
  );
  return cases;
}

function expectBoundedTypedFailure<E extends Error>(
  exit: Exit.Exit<unknown, E>,
  expected: abstract new (...args: never[]) => E,
  expectedFields: Readonly<Record<string, unknown>>,
  testCase: HostileEffectReturnCase
): E {
  expect(Exit.isFailure(exit), testCase.name).toBe(true);
  if (Exit.isSuccess(exit))
    throw new Error(`expected ${testCase.name} failure`);
  expect(Array.from(Cause.defects(exit.cause)), testCase.name).toEqual([]);
  const failure = Cause.failureOption(exit.cause);
  expect(Option.isSome(failure), testCase.name).toBe(true);
  if (Option.isNone(failure))
    throw new Error(`expected ${testCase.name} typed failure`);
  expect(failure.value, testCase.name).toBeInstanceOf(expected);
  expect(failure.value, testCase.name).toMatchObject(expectedFields);
  if (testCase.attacker !== undefined) {
    expect(failure.value, testCase.name).not.toBe(testCase.attacker);
  }
  const surfaces = [
    Cause.pretty(exit.cause),
    exportedErrorText(failure.value),
    renderTopLevelError(failure.value),
  ];
  for (const surface of surfaces) {
    for (const secret of testCase.secrets) {
      expect(surface, testCase.name).not.toContain(secret);
    }
  }
  return failure.value;
}

describe('public Prime and PR runtime context isolation', () => {
  test('admits deeply inherited Effectable Effects through real Prime and PR paths', async () => {
    const inheritedProviderId = 'external-inherited-effect-markers';
    const inheritedRepository = Object.freeze({
      kind: 'external' as const,
      providerId: inheritedProviderId,
      displayName: 'Inherited Effect Markers',
      metadata: Object.freeze({ repository: 'widgets' }),
    });
    const registry = createKeyringCommandRegistry();
    registry.registerExternalPlugin(
      definePublicAidePlugin({
        id: inheritedProviderId,
        summary: 'Official inherited Effect marker compatibility probe',
        commands: [],
        capabilities: {
          primeContribution: {
            sections: () =>
              effectableAtMarkerDepth(64, [
                {
                  id: 'inherited-effect-marker',
                  body: '## Inherited Effect Marker',
                },
              ]),
          },
          pullRequestProvider: {
            providerId: inheritedProviderId,
            priority: 1,
            features: {},
            authStatus: () => Effect.succeed({ state: 'configured' }),
            matchRemote: () => null,
            matchPullRequestUrl: () => null,
            matchRepository: () =>
              Option.some({
                source: 'repository-ref' as const,
                repository: inheritedRepository,
              }),
            operations: {
              listPullRequests: () =>
                effectableAtMarkerDepth(128, {
                  repository: inheritedRepository,
                  pullRequests: [],
                }),
            },
          },
        },
      }),
      {
        manifest: {
          id: inheritedProviderId,
          version: '1.0.0',
          aidePluginApiVersion: AIDE_PLUGIN_API_VERSION,
          capabilities: [
            'prime-contribution',
            'pull-request-provider',
          ] as const,
        },
      }
    );

    const services = createAideHostServices(registry);
    const sections =
      services.primeContributions()[0]?.capability.sections ??
      (() => Effect.die('missing sections'));

    await expect(Effect.runPromise(sections())).resolves.toEqual([
      {
        id: 'inherited-effect-marker',
        body: '## Inherited Effect Marker',
      },
    ]);
    await expect(
      Effect.runPromise(
        services.resolvePullRequestProviderForRepositoryInput({
          providerId: inheritedProviderId,
          repo: 'widgets',
        })
      )
    ).resolves.toMatchObject({
      pluginId: inheritedProviderId,
      providerId: inheritedProviderId,
      match: { repository: inheritedRepository },
    });
    await expect(
      Effect.runPromise(
        services.listPullRequestsForRepository(inheritedRepository)
      )
    ).resolves.toEqual({
      repository: inheritedRepository,
      pullRequests: [],
    });
  });

  test('runs real Prime and PR synchronous construction with initial FiberRefs', async () => {
    const fiberRef = FiberRef.unsafeMake('initial');
    const observations: string[] = [];

    const primeRegistry = createKeyringCommandRegistry();
    primeRegistry.registerExternalPlugin(
      definePublicAidePlugin({
        id: 'external-prime-fiberref-phases',
        summary: 'External Prime synchronous FiberRef phase probe',
        commands: [],
        capabilities: {
          primeContribution: {
            sections: () => {
              observations.push(
                `prime-callback:${currentFiberRefValue(fiberRef)}`
              );
              const section = Object.create(null) as AidePrimeSection;
              Object.defineProperties(section, {
                id: {
                  value: 'prime-fiberref-phases',
                },
                body: { value: '## Prime FiberRef Phases' },
                order: { value: 1 },
              });
              return Effect.succeed([section]);
            },
          },
        },
      }),
      {
        manifest: {
          id: 'external-prime-fiberref-phases',
          version: '1.0.0',
          aidePluginApiVersion: AIDE_PLUGIN_API_VERSION,
          capabilities: ['prime-contribution'],
        },
      }
    );
    const sections =
      createAideHostServices(primeRegistry).primeContributions()[0]!.capability
        .sections!;

    const prRegistry = createKeyringCommandRegistry();
    prRegistry.registerExternalPlugin(
      definePublicAidePlugin({
        id: 'external-pr-fiberref-phases',
        summary: 'External PR synchronous FiberRef phase probe',
        commands: [],
        capabilities: {
          pullRequestProvider: {
            providerId: 'external-pr-fiberref-phases',
            priority: 1,
            features: {},
            authStatus: () => Effect.succeed({ state: 'configured' }),
            matchRemote: () => null,
            matchPullRequestUrl: () => null,
            operations: {
              listPullRequests: () => {
                observations.push(
                  `pr-callback:${currentFiberRefValue(fiberRef)}`
                );
                const result = Object.create(null) as AidePullRequestListResult;
                Object.defineProperties(result, {
                  repository: {
                    value: {
                      kind: 'external' as const,
                      providerId: 'external-pr-fiberref-phases',
                      displayName: 'External PR FiberRef Phases',
                      metadata: { repository: 'widgets' },
                    },
                  },
                  pullRequests: { value: [] },
                });
                return Effect.succeed(result);
              },
            },
          },
        },
      }),
      {
        manifest: {
          id: 'external-pr-fiberref-phases',
          version: '1.0.0',
          aidePluginApiVersion: AIDE_PLUGIN_API_VERSION,
          capabilities: ['pull-request-provider'],
        },
      }
    );
    const prServices = createAideHostServices(prRegistry);
    const prRepository = Object.freeze({
      kind: 'external' as const,
      providerId: 'external-pr-fiberref-phases',
      displayName: 'External PR FiberRef Phases',
      metadata: Object.freeze({ repository: 'widgets' }),
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* FiberRef.set(fiberRef, 'ambient');
        yield* sections();
        yield* prServices.listPullRequestsForRepository(prRepository);
        expect(yield* FiberRef.get(fiberRef)).toBe('ambient');
      })
    );

    expect(observations).toEqual([
      'prime-callback:initial',
      'pr-callback:initial',
    ]);
  });

  test('mediates public Prime sections lazily beneath an empty context', async () => {
    const observations = new Map<string, AuthorityObservation>();
    const constructions: string[] = [];
    const sourceSection = {
      id: 'external-public-prime',
      order: 10,
      body: '## External Public Prime',
      commands: [{ name: 'caller-owned-command' }],
    };
    const sourceSections = [sourceSection];
    const registry = createKeyringCommandRegistry();
    registry.registerExternalPlugin(
      definePublicAidePlugin({
        id: 'external-public-prime',
        summary: 'External public Prime isolation probe',
        commands: [],
        capabilities: {
          primeContribution: {
            status: [
              {
                groupId: 'external-public-prime',
                groupLabel: 'External Public Prime',
                label: 'External Public Prime',
                status: () => Effect.succeed({ state: 'configured' }),
              },
            ],
            sections: () => {
              constructions.push('publicPrimeSections');
              return ambientAuthority(
                observations,
                'publicPrimeSections',
                sourceSections
              );
            },
          },
        },
      }),
      {
        manifest: {
          id: 'external-public-prime',
          version: '1.0.0',
          aidePluginApiVersion: AIDE_PLUGIN_API_VERSION,
          capabilities: ['prime-contribution'],
        },
      }
    );

    const snapshot = createAideHostServices(registry).primeContributions()[0];
    const sections = snapshot?.capability.sections;
    expect(sections).toBeDefined();
    expect('status' in (snapshot?.capability.status?.[0] ?? {})).toBe(false);

    const effect = sections!();
    expect(constructions).toEqual([]);
    const result = await makeAmbientRunner()(effect);

    expect(constructions).toEqual(['publicPrimeSections']);
    expect(observations.get('publicPrimeSections')).toEqual({
      keyring: null,
      internalHost: false,
    });
    expect(result).not.toBe(sourceSections);
    expect(result[0]).not.toBe(sourceSection);
    expect(result).toEqual([
      {
        id: 'external-public-prime',
        order: 10,
        body: '## External Public Prime',
      },
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result[0])).toBe(true);

    sourceSection.id = 'mutated-by-caller';
    sourceSection.order = 99;
    sourceSection.body = 'mutated by caller';
    sourceSection.commands[0]!.name = 'mutated-command';
    sourceSections.push({
      id: 'late-caller-section',
      order: 100,
      body: 'late caller section',
      commands: [],
    });
    expect(result).toEqual([
      {
        id: 'external-public-prime',
        order: 10,
        body: '## External Public Prime',
      },
    ]);
  });

  test('normalizes every public Prime section failure beneath isolation', async () => {
    let mode:
      | 'throw'
      | 'effect-failure'
      | 'non-effect'
      | 'malformed-array'
      | 'malformed-section' = 'throw';
    const registry = createKeyringCommandRegistry();
    registry.registerExternalPlugin(
      definePublicAidePlugin({
        id: 'external-invalid-public-prime',
        summary: 'External invalid public Prime callback probe',
        commands: [],
        capabilities: {
          primeContribution: {
            sections: (() => {
              if (mode === 'throw') {
                throw new Error('public Prime construction boom');
              }
              if (mode === 'effect-failure') {
                return Effect.fail(new Error('public Prime Effect boom'));
              }
              if (mode === 'non-effect') return [];
              if (mode === 'malformed-array') return Effect.succeed({});
              return Effect.succeed([
                {
                  id: 'invalid-section',
                  order: Number.NaN,
                  body: 'invalid order',
                },
              ]);
            }) as unknown as () => Effect.Effect<readonly never[]>,
          },
        },
      }),
      {
        manifest: {
          id: 'external-invalid-public-prime',
          version: '1.0.0',
          aidePluginApiVersion: AIDE_PLUGIN_API_VERSION,
          capabilities: ['prime-contribution'],
        },
      }
    );
    const sections =
      createAideHostServices(registry).primeContributions()[0]!.capability
        .sections!;

    const constructionError = await makeAmbientRunner()(
      sections().pipe(Effect.flip)
    );
    expect(constructionError).toMatchObject({
      _tag: 'PrimeContributionError',
      pluginId: 'external-invalid-public-prime',
      contribution: 'sections',
      reason: 'callback-threw',
    });
    expect(constructionError).toBeInstanceOf(PrimeContributionError);
    expect(Object.hasOwn(constructionError, 'cause')).toBe(false);

    mode = 'effect-failure';
    expect(
      await makeAmbientRunner()(sections().pipe(Effect.flip))
    ).toMatchObject({
      _tag: 'PrimeContributionError',
      pluginId: 'external-invalid-public-prime',
      contribution: 'sections',
      reason: 'effect-failed',
    });

    mode = 'non-effect';
    const nonEffectError = await makeAmbientRunner()(
      sections().pipe(Effect.flip)
    );
    expect(nonEffectError).toMatchObject({
      _tag: 'PrimeContributionError',
      pluginId: 'external-invalid-public-prime',
      contribution: 'sections',
      reason: 'non-effect-return',
    });

    mode = 'malformed-array';
    expect(
      await makeAmbientRunner()(sections().pipe(Effect.flip))
    ).toMatchObject({
      _tag: 'PrimeContributionError',
      pluginId: 'external-invalid-public-prime',
      contribution: 'sections',
      reason: 'invalid-result',
    });

    mode = 'malformed-section';
    expect(
      await makeAmbientRunner()(sections().pipe(Effect.flip))
    ).toMatchObject({
      _tag: 'PrimeContributionError',
      pluginId: 'external-invalid-public-prime',
      contribution: 'sections',
      reason: 'invalid-result',
    });
  });

  test('normalizes hostile public Prime Effect recognition and composition without attacker defects', async () => {
    let callbackResult: unknown = Effect.succeed([]);
    const registry = createKeyringCommandRegistry();
    registry.registerExternalPlugin(
      definePublicAidePlugin({
        id: 'external-hostile-prime-return',
        summary: 'External hostile Prime Effect-return probe',
        commands: [],
        capabilities: {
          primeContribution: {
            sections: (() => callbackResult) as unknown as () => Effect.Effect<
              readonly AidePrimeSection[]
            >,
          },
        },
      }),
      {
        manifest: {
          id: 'external-hostile-prime-return',
          version: '1.0.0',
          aidePluginApiVersion: AIDE_PLUGIN_API_VERSION,
          capabilities: ['prime-contribution'],
        },
      }
    );
    const sections =
      createAideHostServices(registry).primeContributions()[0]!.capability
        .sections!;
    const run = makeAmbientRunner();
    const forged = forgedPrimeRecognitionFailure();

    for (const testCase of hostileEffectReturnCases(
      Effect.succeed([]),
      forged
    )) {
      callbackResult = testCase.value;
      const exit = await run(Effect.exit(sections()));
      const failure = expectBoundedTypedFailure(
        exit,
        PrimeContributionError,
        {
          pluginId: 'external-hostile-prime-return',
          contribution: 'sections',
          reason: 'non-effect-return',
          diagnostic: 'callback-must-return-effect',
        },
        testCase
      );
      expect(Object.hasOwn(failure, 'cause'), testCase.name).toBe(false);
    }

    callbackResult = Effect.fail(new Error('typed Prime failure'));
    expect(await run(sections().pipe(Effect.flip))).toMatchObject({
      _tag: 'PrimeContributionError',
      reason: 'effect-failed',
    });
    const defect = new Error('genuine Prime defect');
    callbackResult = Effect.die(defect);
    const defectExit = await run(Effect.exit(sections()));
    expect(Exit.isFailure(defectExit)).toBe(true);
    if (Exit.isFailure(defectExit)) {
      expect(Cause.dieOption(defectExit.cause)).toEqual(Option.some(defect));
    }
    callbackResult = Effect.interrupt;
    const interruptionExit = await run(Effect.exit(sections()));
    expect(Exit.isFailure(interruptionExit)).toBe(true);
    if (Exit.isFailure(interruptionExit)) {
      expect(Cause.isInterruptedOnly(interruptionExit.cause)).toBe(true);
    }
  });

  test('strictly rejects sparse public Prime arrays instead of skipping holes', async () => {
    const sparse: AidePrimeSection[] = [];
    sparse.length = 2;
    sparse[0] = { id: 'before-hole', body: 'before hole' };
    const registry = createKeyringCommandRegistry();
    registry.registerExternalPlugin(
      definePublicAidePlugin({
        id: 'external-sparse-public-prime',
        summary: 'External sparse public Prime probe',
        commands: [],
        capabilities: {
          primeContribution: {
            sections: () => Effect.succeed(sparse),
          },
        },
      }),
      {
        manifest: {
          id: 'external-sparse-public-prime',
          version: '1.0.0',
          aidePluginApiVersion: AIDE_PLUGIN_API_VERSION,
          capabilities: ['prime-contribution'],
        },
      }
    );
    const sections =
      createAideHostServices(registry).primeContributions()[0]!.capability
        .sections!;
    const result = await makeAmbientRunner()(Effect.either(sections()));

    expect(result._tag).toBe('Left');
    if (result._tag === 'Right') throw new Error('expected strict rejection');
    expect(result.left).toMatchObject({
      _tag: 'PrimeContributionError',
      reason: 'invalid-result',
    });
  });

  test('rejects non-exact public Prime arrays without invoking their protocols and returns host-owned snapshots for exact arrays', async () => {
    let source: readonly AidePrimeSection[] = [];
    const registry = createKeyringCommandRegistry();
    registry.registerExternalPlugin(
      definePublicAidePlugin({
        id: 'external-hostile-public-prime',
        summary: 'External hostile public Prime probe',
        commands: [],
        capabilities: {
          primeContribution: {
            sections: () => Effect.succeed(source),
          },
        },
      }),
      {
        manifest: {
          id: 'external-hostile-public-prime',
          version: '1.0.0',
          aidePluginApiVersion: AIDE_PLUGIN_API_VERSION,
          capabilities: ['prime-contribution'],
        },
      }
    );
    const sections =
      createAideHostServices(registry).primeContributions()[0]!.capability
        .sections!;
    const invocations = { map: 0, flatMap: 0, iterator: 0 };
    const exact = [
      { id: 'host-owned-snapshot', body: 'host-owned snapshot' },
    ] as AidePrimeSection[];
    source = exact;

    const result = await makeAmbientRunner()(sections());

    expect(result).toEqual([
      { id: 'host-owned-snapshot', body: 'host-owned snapshot' },
    ]);
    expect(result).not.toBe(exact);
    expect(Array.isArray(result)).toBe(true);
    expect(Object.getPrototypeOf(result)).toBe(Array.prototype);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result[0])).toBe(true);

    const hostile = [
      { id: 'must-not-escape-hostile-array', body: 'must not escape' },
    ] as AidePrimeSection[];
    Object.defineProperties(hostile, {
      map: {
        value: () => {
          invocations.map += 1;
          return [{ id: 'attacker-map', body: 'attacker map' }];
        },
      },
      flatMap: {
        value: () => {
          invocations.flatMap += 1;
          throw new Error('attacker flatMap');
        },
      },
      [Symbol.iterator]: {
        value: () => {
          invocations.iterator += 1;
          throw new Error('attacker iterator');
        },
      },
    });
    source = hostile;

    const hostileResult = await makeAmbientRunner()(Effect.either(sections()));

    expect(invocations).toEqual({ map: 0, flatMap: 0, iterator: 0 });
    expect(hostileResult).toMatchObject({
      _tag: 'Left',
      left: {
        _tag: 'PrimeContributionError',
        reason: 'invalid-result',
        diagnostic: 'result-length-unreadable',
      },
    });

    const throwingMap = [
      { id: 'throwing-map-section', body: 'throwing map section' },
    ] as AidePrimeSection[];
    Object.defineProperty(throwingMap, 'map', {
      value: () => {
        invocations.map += 1;
        throw new Error('attacker throwing map');
      },
    });
    source = throwingMap;
    const throwingMapResult = await makeAmbientRunner()(
      Effect.either(sections())
    );
    expect(invocations).toEqual({ map: 0, flatMap: 0, iterator: 0 });
    expect(throwingMapResult).toMatchObject({
      _tag: 'Left',
      left: {
        _tag: 'PrimeContributionError',
        reason: 'invalid-result',
        diagnostic: 'result-length-unreadable',
      },
    });
  });

  test('snapshots exact Array subclasses and rejects proxies without invoking their property protocols', async () => {
    let source: readonly AidePrimeSection[] = [];
    const registry = createKeyringCommandRegistry();
    registry.registerExternalPlugin(
      definePublicAidePlugin({
        id: 'external-exotic-public-prime',
        summary: 'External exotic public Prime probe',
        commands: [],
        capabilities: {
          primeContribution: { sections: () => Effect.succeed(source) },
        },
      }),
      {
        manifest: {
          id: 'external-exotic-public-prime',
          version: '1.0.0',
          aidePluginApiVersion: AIDE_PLUGIN_API_VERSION,
          capabilities: ['prime-contribution'],
        },
      }
    );
    const sections =
      createAideHostServices(registry).primeContributions()[0]!.capability
        .sections!;

    class HostileSections extends Array<AidePrimeSection> {}
    const subclass = new HostileSections();
    subclass.push({ id: 'subclass-section', body: 'subclass section' });
    source = subclass;
    const subclassResult = await makeAmbientRunner()(sections());
    expect(Object.getPrototypeOf(subclassResult)).toBe(Array.prototype);

    let propertyReads = 0;
    const proxy = new Proxy([{ id: 'proxy-section', body: 'proxy section' }], {
      get(target, property, receiver) {
        propertyReads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    source = proxy;
    const proxyResult = await makeAmbientRunner()(Effect.either(sections()));
    expect(propertyReads).toBe(0);
    expect(proxyResult).toMatchObject({
      _tag: 'Left',
      left: {
        _tag: 'PrimeContributionError',
        reason: 'invalid-result',
        diagnostic: 'result-length-unreadable',
      },
    });
  });

  test('normalizes unreadable public Prime length, entry, proxy, and getter failures', async () => {
    let source: readonly AidePrimeSection[] = [];
    const registry = createKeyringCommandRegistry();
    registry.registerExternalPlugin(
      definePublicAidePlugin({
        id: 'external-unreadable-public-prime',
        summary: 'External unreadable public Prime probe',
        commands: [],
        capabilities: {
          primeContribution: { sections: () => Effect.succeed(source) },
        },
      }),
      {
        manifest: {
          id: 'external-unreadable-public-prime',
          version: '1.0.0',
          aidePluginApiVersion: AIDE_PLUGIN_API_VERSION,
          capabilities: ['prime-contribution'],
        },
      }
    );
    const sections =
      createAideHostServices(registry).primeContributions()[0]!.capability
        .sections!;
    const expectInvalid = async (value: readonly AidePrimeSection[]) => {
      source = value;
      const result = await makeAmbientRunner()(Effect.either(sections()));
      expect(result._tag).toBe('Left');
      if (result._tag === 'Right') throw new Error('expected invalid result');
      expect(result.left).toMatchObject({
        _tag: 'PrimeContributionError',
        reason: 'invalid-result',
      });
    };

    const throwingGetter: AidePrimeSection[] = [];
    throwingGetter.length = 1;
    Object.defineProperty(throwingGetter, '0', {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error('SECRET-GETTER-FAILURE');
      },
    });
    await expectInvalid(throwingGetter);

    const descriptorFailure = new Proxy(
      [{ id: 'proxy-entry', body: 'proxy entry' }],
      {
        getOwnPropertyDescriptor() {
          throw new Error('SECRET-PROXY-DESCRIPTOR-FAILURE');
        },
      }
    );
    await expectInvalid(descriptorFailure);

    const lengthFailure = new Proxy(
      [{ id: 'proxy-length', body: 'proxy length' }],
      {
        get(target, property, receiver) {
          if (property === 'length') {
            throw new Error('SECRET-PROXY-LENGTH-FAILURE');
          }
          return Reflect.get(target, property, receiver);
        },
      }
    );
    await expectInvalid(lengthFailure);

    const excessiveLength = new Proxy(
      [{ id: 'proxy-too-large', body: 'proxy too large' }],
      {
        get(target, property, receiver) {
          if (property === 'length') return 1_001;
          return Reflect.get(target, property, receiver);
        },
      }
    );
    await expectInvalid(excessiveLength);

    const { proxy: revoked, revoke } = Proxy.revocable(
      [{ id: 'revoked', body: 'revoked' }],
      {}
    );
    revoke();
    await expectInvalid(revoked);
  });

  test('isolates every public PR resolution, operation, and provider-bound context path', async () => {
    const constructions: string[] = [];
    const observations = new Map<string, AuthorityObservation>();
    const externalAuthStatusCalls = { count: 0 };
    const trustedAuthStatusCalls = { count: 0 };
    const synchronousMatcherArguments = new Map<string, readonly unknown[]>();
    const source = createKeyringCommandRegistry();
    registerExternalProvider(
      source,
      constructions,
      observations,
      externalAuthStatusCalls,
      synchronousMatcherArguments
    );
    const snapshot = source.plugins()[0]!;
    expect(snapshot.provenance).toBe('external');

    const registry = createKeyringCommandRegistry();
    registerTrustedNonMatchingProvider(registry, trustedAuthStatusCalls);
    registry.registerPlugin(snapshot);
    expect(
      registry.capabilities.pullRequestProviders().map((entry) =>
        Object.freeze({
          pluginId: entry.pluginId,
          provenance: entry.provenance,
        })
      )
    ).toEqual([
      { pluginId: 'trusted-pr-isolation', provenance: 'trusted' },
      { pluginId: 'external-pr-isolation', provenance: 'external' },
    ]);
    expect(() =>
      createKeyringCommandRegistry().registerPlugin({ ...snapshot })
    ).toThrow(/registry-owned plugin snapshot/i);

    const services = createAideHostServices(registry);
    const run = makeAmbientRunner();
    const remote = 'https://example.test/acme/widgets.git';
    const url = 'https://example.test/acme/widgets/pull/7';
    const repositoryInput = { providerId, repo: 'widgets' };
    const createRequest = {
      title: 'Isolation probe',
      sourceBranch: 'feature',
      targetBranch: 'main',
    };
    const updateRequest = { pullRequest, title: 'Updated isolation probe' };
    const commentRequest = { pullRequest, body: 'isolation comment' };
    const replyRequest = {
      pullRequest,
      threadId: 12,
      body: 'isolation reply',
    };
    const branchRequest = { branch: 'feature' };

    const remoteResolution =
      services.resolvePullRequestProviderForRemote(remote);
    const urlResolution = services.resolvePullRequestProviderForUrl(url);
    const repositoryInputResolution =
      services.resolvePullRequestProviderForRepositoryInput(repositoryInput);
    const repositoryResolution =
      services.resolvePullRequestProviderForRepository(repository);
    expect(constructions).toEqual([]);
    await run(remoteResolution);
    await run(urlResolution);
    await run(repositoryInputResolution);
    await run(repositoryResolution);
    expect(constructions).toEqual([
      'matchRemote',
      'matchPullRequestUrl',
      'matchRepository',
    ]);
    expect(synchronousMatcherArguments.get('matchRemote')).toEqual([remote]);
    expect(synchronousMatcherArguments.get('matchPullRequestUrl')).toEqual([
      url,
    ]);
    expect(synchronousMatcherArguments.get('matchRemote')).toHaveLength(1);
    expect(synchronousMatcherArguments.get('matchPullRequestUrl')).toHaveLength(
      1
    );

    await run(services.listPullRequestsForRemote(remote));
    await run(services.listPullRequestsForRepository(repository));
    await run(services.getPullRequestForRemote(remote, { pullRequest }));
    await run(
      services.getPullRequestForRepository(repository, { pullRequest })
    );
    await run(services.getPullRequestForUrl(url));
    await run(services.createPullRequestForRemote(remote, createRequest));
    await run(
      services.createPullRequestForRepository(repository, createRequest)
    );
    await run(services.updatePullRequestForRemote(remote, updateRequest));
    await run(
      services.updatePullRequestForRepository(repository, updateRequest)
    );
    await run(
      services.updatePullRequestForUrl(url, {
        title: updateRequest.title,
      })
    );
    await run(services.getPullRequestDiffForRemote(remote, { pullRequest }));
    await run(
      services.getPullRequestDiffForRepository(repository, { pullRequest })
    );
    await run(services.getPullRequestDiffForUrl(url));
    await run(
      services.listPullRequestCommentsForRemote(remote, { pullRequest })
    );
    await run(
      services.listPullRequestCommentsForRepository(repository, { pullRequest })
    );
    await run(services.listPullRequestCommentsForUrl(url));
    await run(services.addPullRequestCommentForRemote(remote, commentRequest));
    await run(
      services.addPullRequestCommentForRepository(repository, commentRequest)
    );
    await run(
      services.addPullRequestCommentForUrl(url, { body: commentRequest.body })
    );
    await run(
      services.replyToPullRequestCommentForRemote(remote, replyRequest)
    );
    await run(
      services.replyToPullRequestCommentForRepository(repository, replyRequest)
    );
    await run(
      services.replyToPullRequestCommentForUrl(url, {
        threadId: replyRequest.threadId,
        body: replyRequest.body,
      })
    );
    await run(
      services.findPullRequestForBranchForRemote(remote, branchRequest)
    );
    await run(
      services.findPullRequestForBranchForRepository(repository, branchRequest)
    );

    const remoteContext = await run(
      services.getPullRequestContextForRemote(remote, { pullRequest })
    );
    const repositoryContext = await run(
      services.getPullRequestContextForRepository(repository, { pullRequest })
    );
    const urlContext = await run(services.getPullRequestContextForUrl(url));
    const remoteBranchContext = await run(
      services.findPullRequestForBranchContextForRemote(remote, branchRequest)
    );
    const repositoryBranchContext = await run(
      services.findPullRequestForBranchContextForRepository(
        repository,
        branchRequest
      )
    );

    await run(remoteContext.getPullRequestDiff({ pullRequest }));
    await run(repositoryContext.updatePullRequest(updateRequest));
    await run(urlContext.listPullRequestComments({ pullRequest }));
    await run(remoteBranchContext.addPullRequestComment(commentRequest));
    await run(repositoryBranchContext.replyToPullRequestComment(replyRequest));

    expect(externalAuthStatusCalls.count).toBe(0);
    expect(trustedAuthStatusCalls.count).toBe(0);
    expect(observations.has('authStatus')).toBe(false);
    expect([...observations.entries()]).toEqual(
      [...observations.keys()].map((name) => [
        name,
        { keyring: null, internalHost: false },
      ])
    );
    expect(new Set(observations.keys())).toEqual(
      new Set([
        'matchRepository',
        'listPullRequests',
        'getPullRequest',
        'createPullRequest',
        'updatePullRequest',
        'getPullRequestDiff',
        'listPullRequestComments',
        'addPullRequestComment',
        'replyToPullRequestComment',
        'findPullRequestForBranch',
      ])
    );
  });

  test('lets an external provider observe only detached identity scopes on all nine request shapes and reuses the bound scope', async () => {
    const constructions: string[] = [];
    const observations = new Map<string, AuthorityObservation>();
    const operationRequests = new Map<string, unknown[]>();
    const registry = createKeyringCommandRegistry();
    registry.registerExternalPlugin(
      definePublicAidePlugin({
        id: 'external-pr-selected-scope',
        summary: 'External selected-scope observation probe',
        commands: [],
        capabilities: {
          pullRequestProvider: makeExternalProvider(
            constructions,
            observations,
            { count: 0 },
            new Map(),
            operationRequests
          ),
        },
      }),
      { manifest: externalManifest('external-pr-selected-scope') }
    );
    const internal = createAideInternalHostServices(
      registry,
      makeTestKeyring().layer,
      testGitHubAuthCatalogLayer
    );
    let selectorCalls = 0;
    const rawScope = {
      id: 'external-isolation:host:example.test:org:acme:account:ada',
      providerId,
      host: 'example.test',
      org: 'acme',
      account: 'ada',
      label: 'must not cross the provider boundary',
      sourceKind: 'external' as const,
      metadata: { secretPresentationField: 'must not cross' },
    };
    const services = internal.withPullRequestAuthScopeSelector((resolved) => {
      selectorCalls += 1;
      expect(resolved.providerId).toBe(providerId);
      expect(Object.isFrozen(resolved)).toBe(true);
      expect('capability' in resolved).toBe(false);
      expect('authScope' in resolved).toBe(false);
      return Effect.succeed(rawScope);
    });
    const run = <A, E>(effect: Effect.Effect<A, E, never>) =>
      Effect.runPromise(effect);
    const remote = 'https://example.test/acme/widgets.git';
    const createRequest = {
      title: 'Selected scope',
      sourceBranch: 'feature',
      targetBranch: 'main',
    };
    const updateRequest = { pullRequest, title: 'Updated selected scope' };
    const commentRequest = { pullRequest, body: 'selected scope comment' };
    const replyRequest = {
      pullRequest,
      threadId: 12,
      body: 'selected scope reply',
    };
    const branchRequest = { branch: 'feature' };

    await run(services.listPullRequestsForRemote(remote));
    await run(services.getPullRequestForRemote(remote, { pullRequest }));
    await run(services.createPullRequestForRemote(remote, createRequest));
    await run(services.updatePullRequestForRemote(remote, updateRequest));
    await run(services.getPullRequestDiffForRemote(remote, { pullRequest }));
    await run(
      services.listPullRequestCommentsForRemote(remote, { pullRequest })
    );
    await run(services.addPullRequestCommentForRemote(remote, commentRequest));
    await run(
      services.replyToPullRequestCommentForRemote(remote, replyRequest)
    );
    await run(
      services.findPullRequestForBranchForRemote(remote, branchRequest)
    );

    rawScope.label = 'mutated after the first snapshots';
    rawScope.metadata.secretPresentationField = 'mutated';
    const context = await run(
      services.getPullRequestContextForRemote(remote, { pullRequest })
    );
    expect('authScope' in context).toBe(false);
    expect('authScopeSelector' in context).toBe(false);
    await run(context.getPullRequestDiff({ pullRequest }));
    await run(context.updatePullRequest(updateRequest));
    await run(context.listPullRequestComments({ pullRequest }));
    await run(context.addPullRequestComment(commentRequest));
    await run(context.replyToPullRequestComment(replyRequest));

    expect(selectorCalls).toBe(10);
    expect(new Set(operationRequests.keys())).toEqual(
      new Set([
        'listPullRequests',
        'getPullRequest',
        'createPullRequest',
        'updatePullRequest',
        'getPullRequestDiff',
        'listPullRequestComments',
        'addPullRequestComment',
        'replyToPullRequestComment',
        'findPullRequestForBranch',
      ])
    );
    const requests = [...operationRequests.values()].flat() as Array<{
      readonly authScope?: object;
    }>;
    expect(requests).toHaveLength(15);
    for (const request of requests) {
      expect(Object.isFrozen(request)).toBe(true);
      expect(request.authScope).toEqual({
        id: rawScope.id,
        providerId,
        host: 'example.test',
        org: 'acme',
        account: 'ada',
      });
      expect(request.authScope).not.toBe(rawScope);
      expect(Object.isFrozen(request.authScope)).toBe(true);
      expect(Reflect.ownKeys(request.authScope ?? {})).toEqual([
        'id',
        'providerId',
        'host',
        'org',
        'account',
      ]);
    }

    const contextRequest = operationRequests.get('getPullRequest')?.at(-1);
    expect(contextRequest).toBeDefined();
    const contextScope = (contextRequest as { readonly authScope: object })
      .authScope;
    for (const operation of [
      'getPullRequestDiff',
      'updatePullRequest',
      'listPullRequestComments',
      'addPullRequestComment',
      'replyToPullRequestComment',
    ]) {
      const bound = operationRequests.get(operation)?.at(-1) as {
        readonly authScope: object;
      };
      expect(bound.authScope, operation).toBe(contextScope);
    }
  });

  test('runs PR acquisition and release under empty context and restores caller context after interruption', async () => {
    const lifecycle: string[] = [];
    const observations = new Map<string, AuthorityObservation>();
    await makeAmbientRunner()(
      Effect.gen(function* () {
        const acquired = yield* Deferred.make<void>();
        const base = makeExternalProvider([], observations, { count: 0 });
        const registry = createKeyringCommandRegistry();
        registry.registerExternalPlugin(
          definePublicAidePlugin({
            id: 'external-pr-finalizer-isolation',
            summary: 'External PR finalizer isolation probe',
            commands: [],
            capabilities: {
              pullRequestProvider: {
                ...base,
                operations: {
                  ...base.operations,
                  listPullRequests: () =>
                    Effect.acquireUseRelease(
                      ambientAuthority(
                        observations,
                        'prAcquire',
                        undefined
                      ).pipe(
                        Effect.tap(() =>
                          Effect.sync(() => lifecycle.push('acquire'))
                        ),
                        Effect.tap(() => Deferred.succeed(acquired, undefined))
                      ),
                      () => Effect.never,
                      () =>
                        ambientAuthority(
                          observations,
                          'prRelease',
                          undefined
                        ).pipe(
                          Effect.tap(() =>
                            Effect.sync(() => lifecycle.push('release'))
                          )
                        )
                    ),
                },
              },
            },
          }),
          { manifest: externalManifest('external-pr-finalizer-isolation') }
        );
        const services = createAideHostServices(registry);
        const fiber = yield* Effect.fork(
          services.listPullRequestsForRepository(repository)
        );
        yield* Deferred.await(acquired);
        yield* Fiber.interrupt(fiber);
        yield* ambientAuthority(
          observations,
          'callerAfterInterrupt',
          undefined
        );
      })
    );

    expect(lifecycle).toEqual(['acquire', 'release']);
    expect(observations.get('prAcquire')).toEqual({
      keyring: null,
      internalHost: false,
    });
    expect(observations.get('prRelease')).toEqual({
      keyring: null,
      internalHost: false,
    });
    expect(observations.get('callerAfterInterrupt')).toEqual({
      keyring: fakeSecret,
      internalHost: true,
    });
  });

  test('normalizes synchronous throws and non-Effect returns beneath public PR boundaries', async () => {
    const invalidProvider = (
      overrides: Partial<AidePullRequestProviderCapability>
    ) => ({
      ...makeExternalProvider([], new Map(), { count: 0 }),
      ...overrides,
    });
    const servicesFor = (capability: AidePullRequestProviderCapability) => {
      const registry = createKeyringCommandRegistry();
      registry.registerExternalPlugin(
        definePublicAidePlugin({
          id: 'external-invalid-pr',
          summary: 'External invalid PR callback probe',
          commands: [],
          capabilities: { pullRequestProvider: capability },
        }),
        { manifest: externalManifest('external-invalid-pr') }
      );
      return createAideHostServices(registry);
    };
    const run = makeAmbientRunner();

    const matcherSecret = 'SECRET-REPOSITORY-CALLBACK-THROW';
    const matcherAttacker = new Error(matcherSecret);
    const throwingMatcher = servicesFor(
      invalidProvider({
        matchRepository: () => {
          throw matcherAttacker;
        },
      })
    );
    const matcherError = await run(
      throwingMatcher
        .resolvePullRequestProviderForRepositoryInput({
          providerId,
          repo: 'widgets',
        })
        .pipe(Effect.flip)
    );
    expect(matcherError).toBeInstanceOf(PullRequestProviderInvocationError);
    if (!(matcherError instanceof PullRequestProviderInvocationError)) {
      throw new Error('expected matcher invocation error');
    }
    expect(matcherError.cause).not.toBe(matcherAttacker);
    expect(matcherError.cause).toBeInstanceOf(Error);
    expect((matcherError.cause as Error).message).toBe(
      'matchRepository callback threw'
    );
    expect(exportedErrorText(matcherError)).not.toContain(matcherSecret);
    expect(renderTopLevelError(matcherError)).not.toContain(matcherSecret);
    expect(matcherError.cause).toBeInstanceOf(Error);
    expect(matcherError.message).not.toContain(matcherSecret);

    const remoteMatcherSecret = 'SECRET-REMOTE-MATCHER';
    const remoteMatcherAttacker = new Error(remoteMatcherSecret);
    const throwingRemoteMatcher = servicesFor(
      invalidProvider({
        matchRemote: () => {
          throw remoteMatcherAttacker;
        },
      })
    );
    const remoteMatcherError = await run(
      throwingRemoteMatcher
        .resolvePullRequestProviderForRemote('https://example.test/repo')
        .pipe(Effect.flip)
    );
    expect(remoteMatcherError).toBeInstanceOf(
      PullRequestProviderInvocationError
    );
    if (!(remoteMatcherError instanceof PullRequestProviderInvocationError)) {
      throw new Error('expected remote matcher invocation error');
    }
    expect(remoteMatcherError.cause).not.toBe(remoteMatcherAttacker);
    expect(remoteMatcherError.cause).toBeInstanceOf(Error);
    expect(remoteMatcherError.cause).not.toBe(remoteMatcherAttacker);
    expect(remoteMatcherError.message).not.toContain(remoteMatcherSecret);
    expect(exportedErrorText(remoteMatcherError)).not.toContain(
      remoteMatcherSecret
    );
    expect(renderTopLevelError(remoteMatcherError)).not.toContain(
      remoteMatcherSecret
    );
    expect(remoteMatcherError.cause instanceof Error).toBe(true);
    expect((remoteMatcherError.cause as Error).message).toBe(
      'matchRemote callback threw'
    );

    const urlMatcherSecret = 'SECRET-URL-MATCHER';
    const urlMatcherAttacker = new Error(urlMatcherSecret);
    const throwingUrlMatcher = servicesFor(
      invalidProvider({
        matchPullRequestUrl: () => {
          throw urlMatcherAttacker;
        },
      })
    );
    const urlMatcherError = await run(
      throwingUrlMatcher
        .resolvePullRequestProviderForUrl('https://example.test/repo')
        .pipe(Effect.flip)
    );
    expect(urlMatcherError).toBeInstanceOf(PullRequestProviderInvocationError);
    if (!(urlMatcherError instanceof PullRequestProviderInvocationError)) {
      throw new Error('expected URL matcher invocation error');
    }
    expect(urlMatcherError.cause).not.toBe(urlMatcherAttacker);
    expect(urlMatcherError.cause).toBeInstanceOf(Error);
    expect(urlMatcherError.message).not.toContain(urlMatcherSecret);
    expect(exportedErrorText(urlMatcherError)).not.toContain(urlMatcherSecret);
    expect(renderTopLevelError(urlMatcherError)).not.toContain(
      urlMatcherSecret
    );
    expect((urlMatcherError.cause as Error).message).toBe(
      'matchPullRequestUrl callback threw'
    );

    const nonEffectMatcher = servicesFor(
      invalidProvider({
        matchRepository: (() => ({
          source: 'repository-ref',
          repository,
        })) as unknown as AidePullRequestProviderCapability['matchRepository'],
      })
    );
    expect(
      await run(
        nonEffectMatcher
          .resolvePullRequestProviderForRepositoryInput({
            providerId,
            repo: 'widgets',
          })
          .pipe(Effect.flip)
      )
    ).toBeInstanceOf(InvalidPullRequestProviderMatchError);

    const operationSecret = 'SECRET-OPERATION-CALLBACK-THROW';
    const operationAttacker = new Error(operationSecret);
    const throwingOperation = servicesFor(
      invalidProvider({
        operations: {
          listPullRequests: () => {
            throw operationAttacker;
          },
        },
      })
    );
    const operationError = await run(
      throwingOperation
        .listPullRequestsForRepository(repository)
        .pipe(Effect.flip)
    );
    expect(operationError).toBeInstanceOf(PullRequestProviderOperationError);
    if (!(operationError instanceof PullRequestProviderOperationError)) {
      throw new Error('expected operation invocation error');
    }
    expect(operationError.cause).not.toBe(operationAttacker);
    expect(operationError.cause).toBeInstanceOf(Error);
    expect((operationError.cause as Error).message).toBe(
      'provider operation callback threw'
    );
    expect(exportedErrorText(operationError)).not.toContain(operationSecret);
    expect(renderTopLevelError(operationError)).not.toContain(operationSecret);

    const nonEffectOperation = servicesFor(
      invalidProvider({
        operations: {
          listPullRequests: (() => ({
            repository,
            pullRequests: [],
          })) as unknown as NonNullable<
            AidePullRequestProviderCapability['operations']
          >['listPullRequests'],
        },
      })
    );
    expect(
      await run(
        nonEffectOperation
          .listPullRequestsForRepository(repository)
          .pipe(Effect.flip)
      )
    ).toBeInstanceOf(InvalidPullRequestProviderOperationResultError);
  });

  test('normalizes hostile public PR matcher and operation Effect returns without attacker defects', async () => {
    const invalidProvider = (
      overrides: Partial<AidePullRequestProviderCapability>
    ) => ({
      ...makeExternalProvider([], new Map(), { count: 0 }),
      ...overrides,
    });
    const servicesFor = (capability: AidePullRequestProviderCapability) => {
      const registry = createKeyringCommandRegistry();
      registry.registerExternalPlugin(
        definePublicAidePlugin({
          id: 'external-hostile-pr-return',
          summary: 'External hostile PR Effect-return probe',
          commands: [],
          capabilities: { pullRequestProvider: capability },
        }),
        { manifest: externalManifest('external-hostile-pr-return') }
      );
      return createAideHostServices(registry);
    };
    const run = makeAmbientRunner();
    let matcherResult: unknown = Effect.succeed(null);
    const matcherServices = servicesFor(
      invalidProvider({
        matchRepository: (() => matcherResult) as unknown as NonNullable<
          AidePullRequestProviderCapability['matchRepository']
        >,
      })
    );

    for (const testCase of hostileEffectReturnCases(
      Effect.succeed(null),
      forgedPrimeRecognitionFailure()
    )) {
      matcherResult = testCase.value;
      const exit = await run(
        Effect.exit(
          matcherServices.resolvePullRequestProviderForRepositoryInput({
            providerId,
            repo: 'widgets',
          })
        )
      );
      expectBoundedTypedFailure(
        exit,
        InvalidPullRequestProviderMatchError,
        {
          pluginId: 'external-hostile-pr-return',
          providerId,
          reason: 'matchRepository must return an Effect',
        },
        testCase
      );
    }

    matcherResult = Effect.fail(new Error('typed matcher failure'));
    expect(
      await run(
        matcherServices
          .resolvePullRequestProviderForRepositoryInput({
            providerId,
            repo: 'widgets',
          })
          .pipe(Effect.flip)
      )
    ).toBeInstanceOf(PullRequestProviderInvocationError);
    const matcherDefect = new Error('genuine matcher defect');
    matcherResult = Effect.die(matcherDefect);
    const matcherDefectExit = await run(
      Effect.exit(
        matcherServices.resolvePullRequestProviderForRepositoryInput({
          providerId,
          repo: 'widgets',
        })
      )
    );
    expect(Exit.isFailure(matcherDefectExit)).toBe(true);
    if (Exit.isFailure(matcherDefectExit)) {
      expect(Cause.dieOption(matcherDefectExit.cause)).toEqual(
        Option.some(matcherDefect)
      );
    }
    matcherResult = Effect.interrupt;
    const matcherInterruptionExit = await run(
      Effect.exit(
        matcherServices.resolvePullRequestProviderForRepositoryInput({
          providerId,
          repo: 'widgets',
        })
      )
    );
    expect(Exit.isFailure(matcherInterruptionExit)).toBe(true);
    if (Exit.isFailure(matcherInterruptionExit)) {
      expect(Cause.isInterruptedOnly(matcherInterruptionExit.cause)).toBe(true);
    }

    let operationResult: unknown = Effect.succeed({
      repository,
      pullRequests: [],
    });
    const operationServices = servicesFor(
      invalidProvider({
        operations: {
          listPullRequests: (() => operationResult) as unknown as NonNullable<
            AidePullRequestProviderCapability['operations']
          >['listPullRequests'],
        },
      })
    );
    for (const testCase of hostileEffectReturnCases(
      Effect.succeed({ repository, pullRequests: [] }),
      forgedPrimeRecognitionFailure()
    )) {
      operationResult = testCase.value;
      const exit = await run(
        Effect.exit(operationServices.listPullRequestsForRepository(repository))
      );
      expectBoundedTypedFailure(
        exit,
        InvalidPullRequestProviderOperationResultError,
        {
          pluginId: 'external-hostile-pr-return',
          providerId,
          operation: 'listPullRequests',
          reason: 'operation must return an Effect',
        },
        testCase
      );
    }

    operationResult = Effect.fail(new Error('typed operation failure'));
    expect(
      await run(
        operationServices
          .listPullRequestsForRepository(repository)
          .pipe(Effect.flip)
      )
    ).toBeInstanceOf(PullRequestProviderOperationError);
    const operationDefect = new Error('genuine operation defect');
    operationResult = Effect.die(operationDefect);
    const operationDefectExit = await run(
      Effect.exit(operationServices.listPullRequestsForRepository(repository))
    );
    expect(Exit.isFailure(operationDefectExit)).toBe(true);
    if (Exit.isFailure(operationDefectExit)) {
      expect(Cause.dieOption(operationDefectExit.cause)).toEqual(
        Option.some(operationDefect)
      );
    }
    operationResult = Effect.interrupt;
    const operationInterruptionExit = await run(
      Effect.exit(operationServices.listPullRequestsForRepository(repository))
    );
    expect(Exit.isFailure(operationInterruptionExit)).toBe(true);
    if (Exit.isFailure(operationInterruptionExit)) {
      expect(Cause.isInterruptedOnly(operationInterruptionExit.cause)).toBe(
        true
      );
    }
  });
});
