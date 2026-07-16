import { Cause, Effect, Exit, Layer, Option } from 'effect';

import {
  defineAideCommand,
  defineAidePlugin,
  emptyResult,
} from '@aide/plugin-api';
import { createKeyringCommandRegistry } from '@cli/host/command-registry.js';
import { defineImmutableBuiltinPlugin } from '@cli/host/immutable-builtin-plugin.js';
import { invokePublicCommandEffect } from '@cli/host/public-command-invocation.js';
import { pullRequestProviderErrorMessage } from '@cli/host/pull-request-provider-resolver.js';
import {
  AideHostServicesTag,
  createAideHostServices,
  createAideInternalHostServices,
} from '@cli/host/runtime-context.js';
import { createGitHubPlugin } from '@cli/plugins/github/plugin.js';
import { KeyringService } from '@lib/auth-keyring.js';
import { resolveGitHubAuthRequest } from '@lib/github-auth.js';
import { testGitHubAuthCatalogLayer } from '@lib/github-auth-catalog.test-helper.js';
import { resolveGitHubCredentialEffect } from '@lib/github-credential-resolver.js';

type Mode =
  | 'request-own-scope'
  | 'request-own-selector'
  | 'request-accessor-scope'
  | 'request-accessor-selector'
  | 'request-live-proxy'
  | 'request-revoked-proxy'
  | 'options-own-scope'
  | 'options-own-selector'
  | 'options-accessor-scope'
  | 'options-accessor-selector'
  | 'options-live-proxy'
  | 'options-revoked-proxy'
  | 'request-inherited-scope'
  | 'request-inherited-selector'
  | 'options-inherited-scope'
  | 'options-inherited-selector'
  | 'prototype-selector-return'
  | 'prototype-selector-throw'
  | 'prototype-selector-slow'
  | 'prototype-auth-scope'
  | 'prototype-auth-scope-getter'
  | 'prototype-selection-timeout'
  | 'prototype-preferred'
  | 'prototype-matcher-timeout'
  | 'prototype-resolution-own-control'
  | 'prototype-identity';

type Surface =
  | 'initial'
  | 'bound'
  | 'resolve-remote'
  | 'resolve-url'
  | 'resolve-repository'
  | 'resolve-repository-input'
  | 'builtin-github'
  | 'builtin-github-control'
  | 'ambient-nine-public'
  | 'ambient-nine-selected'
  | 'ambient-bound-all';

const surface = process.argv[2] as Surface;
const mode = process.argv[3] as Mode;
const guessedScope = Object.freeze({
  id: 'github:host:github.com:account:guessed-account',
  providerId: 'github',
  host: 'github.com',
  account: 'guessed-account',
});
const repository = Object.freeze({
  kind: 'external' as const,
  providerId: 'public-boundary',
  displayName: 'Public boundary',
});
const pullRequest = Object.freeze({ number: 17 });
let trapReads = 0;
let matcherCallbacks = 0;
let providerCallbacks = 0;
let clientCallbacks = 0;
let networkCallbacks = 0;
let exactAccountKeyReads = 0;
let broadDiscoveryCallbacks = 0;
let preferredCallbacks = 0;
let prototypeSelectorCalls = 0;
let prototypeGetterReads = 0;
let ambientScopeObservations = 0;
let ambientIdentityObservations = 0;
let nonNullPrototypeSnapshots = 0;
let resolvedLookalikeObservations = 0;
let contextLookalikeObservations = 0;
let nestedMatchLookalikeObservations = 0;
let nestedRepositoryLookalikeObservations = 0;
let nestedPullRequestLookalikeObservations = 0;
let nestedCanonicalFieldFailures = 0;
let selectorCalls = 0;
const operationNames = new Set<string>();

const ambientScope = Object.freeze({
  id: 'ambient:host:attacker.invalid:account:prototype',
  providerId: 'ambient',
  host: 'attacker.invalid',
  account: 'prototype',
});
const ambientIdentity = Object.freeze({
  providerId: 'ambient-provider',
  host: 'ambient.invalid',
  org: 'ambient-org',
  account: 'ambient-account',
});

globalThis.fetch = (() => {
  networkCallbacks += 1;
  throw new Error('Network is disabled in the public PR boundary fixture.');
}) as unknown as typeof globalThis.fetch;

const selector = () => {
  broadDiscoveryCallbacks += 1;
  return Effect.succeed(guessedScope);
};

function withOwnData(
  base: Readonly<Record<string, unknown>>,
  field: string,
  value: unknown
): object {
  return Object.assign(Object.create(null), base, { [field]: value });
}

function accessorObject(
  base: Readonly<Record<string, unknown>>,
  field: string,
  value: unknown
): object {
  const object = Object.assign(Object.create(null), base) as Record<
    string,
    unknown
  >;
  Object.defineProperty(object, field, {
    get() {
      trapReads += 1;
      return value;
    },
  });
  return object;
}

function hostileProxy(base: Readonly<Record<string, unknown>>): object {
  return new Proxy(Object.assign(Object.create(null), base), {
    get() {
      trapReads += 1;
      throw new Error('SECRET-PUBLIC-PR-AUTH-PROXY');
    },
    getOwnPropertyDescriptor() {
      trapReads += 1;
      throw new Error('SECRET-PUBLIC-PR-AUTH-PROXY');
    },
    getPrototypeOf() {
      trapReads += 1;
      throw new Error('SECRET-PUBLIC-PR-AUTH-PROXY');
    },
    ownKeys() {
      trapReads += 1;
      throw new Error('SECRET-PUBLIC-PR-AUTH-PROXY');
    },
  });
}

function revokedProxy(base: Readonly<Record<string, unknown>>): object {
  const { proxy, revoke } = Proxy.revocable(
    Object.assign(Object.create(null), base),
    {
      get() {
        trapReads += 1;
        throw new Error('SECRET-PUBLIC-PR-AUTH-REVOKED-PROXY');
      },
      getOwnPropertyDescriptor() {
        trapReads += 1;
        throw new Error('SECRET-PUBLIC-PR-AUTH-REVOKED-PROXY');
      },
      getPrototypeOf() {
        trapReads += 1;
        throw new Error('SECRET-PUBLIC-PR-AUTH-REVOKED-PROXY');
      },
      ownKeys() {
        trapReads += 1;
        throw new Error('SECRET-PUBLIC-PR-AUTH-REVOKED-PROXY');
      },
    }
  );
  revoke();
  return proxy;
}

function inheritedObject(
  base: Readonly<Record<string, unknown>>,
  field: string,
  value: unknown
): object {
  return Object.assign(Object.create({ [field]: value }), base);
}

function inputs(
  requestBase: Readonly<Record<string, unknown>> = {},
  optionsBase: Readonly<Record<string, unknown>> = {}
): { readonly request: object; readonly options: object } {
  switch (mode) {
    case 'request-own-scope':
      return {
        request: withOwnData(requestBase, 'authScope', guessedScope),
        options: optionsBase,
      };
    case 'request-own-selector':
      return {
        request: withOwnData(requestBase, 'authScopeSelector', selector),
        options: optionsBase,
      };
    case 'request-accessor-scope':
      return {
        request: accessorObject(requestBase, 'authScope', guessedScope),
        options: optionsBase,
      };
    case 'request-accessor-selector':
      return {
        request: accessorObject(requestBase, 'authScopeSelector', selector),
        options: optionsBase,
      };
    case 'request-live-proxy':
      return { request: hostileProxy(requestBase), options: optionsBase };
    case 'request-revoked-proxy':
      return { request: revokedProxy(requestBase), options: optionsBase };
    case 'options-own-scope':
      return {
        request: requestBase,
        options: withOwnData(optionsBase, 'authScope', guessedScope),
      };
    case 'options-own-selector':
      return {
        request: requestBase,
        options: withOwnData(optionsBase, 'authScopeSelector', selector),
      };
    case 'options-accessor-scope':
      return {
        request: requestBase,
        options: accessorObject(optionsBase, 'authScope', guessedScope),
      };
    case 'options-accessor-selector':
      return {
        request: requestBase,
        options: accessorObject(optionsBase, 'authScopeSelector', selector),
      };
    case 'options-live-proxy':
      return { request: requestBase, options: hostileProxy(optionsBase) };
    case 'options-revoked-proxy':
      return { request: requestBase, options: revokedProxy(optionsBase) };
    case 'request-inherited-scope':
      return {
        request: inheritedObject(requestBase, 'authScope', guessedScope),
        options: optionsBase,
      };
    case 'request-inherited-selector':
      return {
        request: inheritedObject(requestBase, 'authScopeSelector', selector),
        options: optionsBase,
      };
    case 'options-inherited-scope':
      return {
        request: requestBase,
        options: inheritedObject(optionsBase, 'authScope', guessedScope),
      };
    case 'options-inherited-selector':
      return {
        request: requestBase,
        options: inheritedObject(optionsBase, 'authScopeSelector', selector),
      };
    default:
      return { request: requestBase, options: optionsBase };
  }
}

function defineAmbientData(field: string, value: unknown): void {
  Object.defineProperty(Object.prototype, field, {
    configurable: true,
    enumerable: false,
    writable: true,
    value,
  });
}

function defineAmbientGetter(field: string, value: unknown): void {
  Object.defineProperty(Object.prototype, field, {
    configurable: true,
    enumerable: false,
    get() {
      prototypeGetterReads += 1;
      return value;
    },
  });
}

function installAmbientPrototypeLookalike(): void {
  switch (mode) {
    case 'prototype-selector-return':
      defineAmbientData('authScopeSelector', () => {
        prototypeSelectorCalls += 1;
        return Effect.succeed(ambientScope);
      });
      break;
    case 'prototype-selector-throw':
      defineAmbientData('authScopeSelector', () => {
        prototypeSelectorCalls += 1;
        throw new Error('SECRET-AMBIENT-SELECTOR-THROW');
      });
      break;
    case 'prototype-selector-slow':
      defineAmbientData('authScopeSelector', () => {
        prototypeSelectorCalls += 1;
        return Effect.never;
      });
      defineAmbientData('selectionTimeout', '5 millis');
      break;
    case 'prototype-auth-scope':
      defineAmbientData('authScope', ambientScope);
      break;
    case 'prototype-auth-scope-getter':
      defineAmbientGetter('authScope', ambientScope);
      break;
    case 'prototype-selection-timeout':
      defineAmbientData('selectionTimeout', '1 millis');
      break;
    case 'prototype-preferred':
      defineAmbientData('preferred', () => {
        preferredCallbacks += 1;
        return false;
      });
      break;
    case 'prototype-matcher-timeout':
      defineAmbientGetter('matcherTimeout', '1 second');
      break;
    case 'prototype-resolution-own-control':
      defineAmbientData('preferred', () => {
        prototypeSelectorCalls += 1;
        return false;
      });
      defineAmbientGetter('matcherTimeout', '1 millis');
      break;
    case 'prototype-identity':
      defineAmbientData('authScope', ambientScope);
      for (const field of ['providerId', 'host', 'org', 'account'] as const) {
        defineAmbientData(field, ambientIdentity[field]);
      }
      break;
    default:
      break;
  }
}

function resetCallbackCounts(): void {
  matcherCallbacks = 0;
  providerCallbacks = 0;
  clientCallbacks = 0;
  networkCallbacks = 0;
  exactAccountKeyReads = 0;
  broadDiscoveryCallbacks = 0;
  preferredCallbacks = 0;
  prototypeSelectorCalls = 0;
  prototypeGetterReads = 0;
  ambientScopeObservations = 0;
  ambientIdentityObservations = 0;
  nonNullPrototypeSnapshots = 0;
  resolvedLookalikeObservations = 0;
  contextLookalikeObservations = 0;
  nestedMatchLookalikeObservations = 0;
  nestedRepositoryLookalikeObservations = 0;
  nestedPullRequestLookalikeObservations = 0;
  nestedCanonicalFieldFailures = 0;
  selectorCalls = 0;
  operationNames.clear();
}

function resolutionInputs(): ReturnType<typeof inputs> {
  if (mode === 'prototype-preferred') {
    return inputs({}, { matcherTimeout: '1 second' });
  }
  if (mode === 'prototype-matcher-timeout') {
    return inputs({});
  }
  return inputs(
    {},
    {
      preferred: () => {
        preferredCallbacks += 1;
        return true;
      },
      matcherTimeout: '1 second',
    }
  );
}

function observeProviderRequest(name: string, request: object): void {
  providerCallbacks += 1;
  clientCallbacks += 1;
  networkCallbacks += 1;
  operationNames.add(name);
  if (Object.getPrototypeOf(request) !== null) {
    nonNullPrototypeSnapshots += 1;
  }
  const requestScope = (request as { readonly authScope?: unknown }).authScope;
  if (requestScope === ambientScope) {
    ambientScopeObservations += 1;
  }
  if (typeof requestScope === 'object' && requestScope !== null) {
    if (Object.getPrototypeOf(requestScope) !== null) {
      nonNullPrototypeSnapshots += 1;
    }
    const identity = requestScope as Record<string, unknown>;
    if (
      identity.providerId === ambientIdentity.providerId ||
      identity.host === ambientIdentity.host ||
      identity.org === ambientIdentity.org ||
      identity.account === ambientIdentity.account
    ) {
      ambientIdentityObservations += 1;
    }
  }
  observeProviderMatchSnapshot((request as { readonly match?: unknown }).match);
}

function observeProviderMatchSnapshot(value: unknown): void {
  if (typeof value !== 'object' || value === null) {
    nestedCanonicalFieldFailures += 1;
    return;
  }
  if (Object.getPrototypeOf(value) !== null) {
    nonNullPrototypeSnapshots += 1;
  }
  const match = value as Record<string, unknown>;
  if (match.authScope === ambientScope) {
    nestedMatchLookalikeObservations += 1;
  }
  if (
    match.source !== 'git-remote' &&
    match.source !== 'repository-ref' &&
    match.source !== 'pull-request-url'
  ) {
    nestedCanonicalFieldFailures += 1;
  }

  const repositorySnapshot = match.repository;
  if (typeof repositorySnapshot !== 'object' || repositorySnapshot === null) {
    nestedCanonicalFieldFailures += 1;
  } else {
    if (Object.getPrototypeOf(repositorySnapshot) !== null) {
      nonNullPrototypeSnapshots += 1;
    }
    const nestedRepository = repositorySnapshot as Record<string, unknown>;
    if (nestedRepository.authScope === ambientScope) {
      nestedRepositoryLookalikeObservations += 1;
    }
    if (
      nestedRepository.kind !== repository.kind ||
      nestedRepository.providerId !== repository.providerId ||
      nestedRepository.displayName !== repository.displayName
    ) {
      nestedCanonicalFieldFailures += 1;
    }
  }

  const hasPullRequest = Object.hasOwn(match, 'pullRequest');
  if (match.source === 'pull-request-url') {
    const pullRequestSnapshot = match.pullRequest;
    if (
      !hasPullRequest ||
      typeof pullRequestSnapshot !== 'object' ||
      pullRequestSnapshot === null
    ) {
      nestedCanonicalFieldFailures += 1;
      return;
    }
    if (Object.getPrototypeOf(pullRequestSnapshot) !== null) {
      nonNullPrototypeSnapshots += 1;
    }
    const nestedPullRequest = pullRequestSnapshot as Record<string, unknown>;
    if (nestedPullRequest.authScope === ambientScope) {
      nestedPullRequestLookalikeObservations += 1;
    }
    if (nestedPullRequest.number !== pullRequest.number) {
      nestedCanonicalFieldFailures += 1;
    }
  } else if (hasPullRequest) {
    nestedCanonicalFieldFailures += 1;
  }
}

function pullRequestItem(sourceBranch = 'feature/prototype') {
  return {
    id: pullRequest.number,
    title: 'Public boundary probe',
    status: 'active' as const,
    createdAt: '2026-07-16T00:00:00.000Z',
    author: { displayName: 'Boundary fixture' },
    sourceBranch,
    targetBranch: 'main',
  };
}

function viewResult(request: {
  readonly pullRequest: { readonly number: number };
}) {
  return {
    repository,
    pullRequest: {
      ...pullRequestItem(),
      id: request.pullRequest.number,
    },
  };
}

function mutationResult(request: {
  readonly pullRequest: { readonly number: number };
  readonly body: string;
}) {
  return {
    repository,
    pullRequest: { number: request.pullRequest.number },
    comment: {
      id: 29,
      kind: 'issue' as const,
      author: { displayName: 'Boundary fixture' },
      body: request.body,
      createdAt: '2026-07-16T00:00:00.000Z',
    },
  };
}

function observeResolvedSnapshot(value: object): void {
  if (Object.getPrototypeOf(value) !== null) {
    nonNullPrototypeSnapshots += 1;
  }
  if ((value as { readonly authScope?: unknown }).authScope !== undefined) {
    resolvedLookalikeObservations += 1;
  }
  observeProviderMatchSnapshot((value as { readonly match?: unknown }).match);
}

function observeContextSnapshot(value: { readonly provider: object }): void {
  if (Object.getPrototypeOf(value) !== null) {
    nonNullPrototypeSnapshots += 1;
  }
  if ((value as { readonly authScope?: unknown }).authScope !== undefined) {
    contextLookalikeObservations += 1;
  }
  observeResolvedSnapshot(value.provider);
}

const registry = createKeyringCommandRegistry();
if (surface === 'builtin-github' || surface === 'builtin-github-control') {
  const exactAccountKey = 'auth:github:host:github.com:account:guessed-account';
  const keyringLayer = Layer.succeed(
    KeyringService,
    Object.freeze({
      get: (name: string) => {
        if (name === exactAccountKey) exactAccountKeyReads += 1;
        return Effect.succeed(null);
      },
      set: () => Effect.die('Test keyring writes are disabled.'),
      delete: () => Effect.die('Test keyring deletes are disabled.'),
    }) as never
  );
  registry.registerPlugin(
    defineImmutableBuiltinPlugin(
      createGitHubPlugin({
        probeConfig: async () => ({ kind: 'missing' }),
        ghAuthProbe: (request) => ({
          kind: 'unavailable',
          host: request.host,
        }),
        createClient: async () => {
          clientCallbacks += 1;
          const request = resolveGitHubAuthRequest({
            host: guessedScope.host,
            scope: {
              host: guessedScope.host,
              account: guessedScope.account,
            },
          });
          if (!request.ok) throw new Error('Invalid injected GitHub request.');
          await Effect.runPromise(
            resolveGitHubCredentialEffect(request, {
              env: Object.freeze({}),
              ghAuthProbe: (candidate) => ({
                kind: 'unavailable',
                host: candidate.host,
              }),
              spawn: (() => {
                networkCallbacks += 1;
                throw new Error('gh execution is disabled.');
              }) as never,
            }).pipe(Effect.provide(keyringLayer))
          );
          throw new Error('Injected GitHub client construction is denied.');
        },
      })
    )
  );
} else {
  registry.registerExternalPlugin(
    defineAidePlugin({
      id: 'public-boundary',
      summary: 'Public PR authentication selection boundary fixture',
      commands: [],
      capabilities: {
        pullRequestProvider: {
          providerId: 'public-boundary',
          priority: 100,
          features: {},
          authStatus: () => Effect.succeed({ state: 'configured' }),
          matchRemote: () => {
            matcherCallbacks += 1;
            return { source: 'git-remote', repository };
          },
          matchRepository: () => {
            matcherCallbacks += 1;
            return Effect.succeed({
              source: 'repository-ref' as const,
              repository,
            });
          },
          matchPullRequestUrl: () => {
            matcherCallbacks += 1;
            return {
              source: 'pull-request-url',
              repository,
              pullRequest,
            };
          },
          operations: {
            listPullRequests: (request) => {
              observeProviderRequest('listPullRequests', request);
              return Effect.succeed({ repository, pullRequests: [] });
            },
            getPullRequest: (request) => {
              observeProviderRequest('getPullRequest', request);
              return Effect.succeed(viewResult(request));
            },
            createPullRequest: (request) => {
              observeProviderRequest('createPullRequest', request);
              return Effect.succeed({
                repository,
                pullRequest: pullRequestItem(request.sourceBranch),
              });
            },
            updatePullRequest: (request) => {
              observeProviderRequest('updatePullRequest', request);
              return Effect.succeed(viewResult(request));
            },
            getPullRequestDiff: (request) => {
              observeProviderRequest('getPullRequestDiff', request);
              return Effect.succeed({
                ...viewResult(request),
                files: [],
              });
            },
            listPullRequestComments: (request) => {
              observeProviderRequest('listPullRequestComments', request);
              return Effect.succeed({
                repository,
                pullRequest: request.pullRequest,
                threads: [],
              });
            },
            addPullRequestComment: (request) => {
              observeProviderRequest('addPullRequestComment', request);
              return Effect.succeed(mutationResult(request));
            },
            replyToPullRequestComment: (request) => {
              observeProviderRequest('replyToPullRequestComment', request);
              return Effect.succeed(mutationResult(request));
            },
            findPullRequestForBranch: (request) => {
              observeProviderRequest('findPullRequestForBranch', request);
              return Effect.succeed({
                repository,
                branch: request.branch,
                pullRequest: pullRequestItem(request.branch),
              });
            },
          },
        },
      },
    }),
    {
      manifest: {
        id: 'public-boundary',
        version: '1.0.0',
        aidePluginApiVersion: 1,
        capabilities: ['pull-request-provider'],
      },
    }
  );
}

const descriptor = defineAideCommand({
  id: 'public-boundary:probe',
  route: 'public-boundary-probe',
  summary: 'Public PR authentication selection boundary probe',
  run: () =>
    Effect.gen(function* () {
      const services = yield* AideHostServicesTag;
      switch (surface) {
        case 'initial': {
          const { request, options } = inputs();
          yield* services.listPullRequestsForRemote(
            'ssh://example.test/acme/widgets.git',
            request as never,
            options as never
          );
          break;
        }
        case 'bound': {
          const context = yield* services.getPullRequestContextForRemote(
            'ssh://example.test/acme/widgets.git',
            { pullRequest }
          );
          resetCallbackCounts();
          const { request, options } = inputs({ pullRequest });
          yield* context.getPullRequestDiff(request as never, options as never);
          break;
        }
        case 'resolve-remote': {
          const { options } = resolutionInputs();
          const resolved = yield* services.resolvePullRequestProviderForRemote(
            'ssh://example.test/acme/widgets.git',
            options as never
          );
          observeResolvedSnapshot(resolved);
          break;
        }
        case 'resolve-url': {
          const { options } = resolutionInputs();
          const resolved = yield* services.resolvePullRequestProviderForUrl(
            'https://example.test/acme/widgets/pull/17',
            options as never
          );
          observeResolvedSnapshot(resolved);
          break;
        }
        case 'resolve-repository': {
          const { options } = resolutionInputs();
          const resolved =
            yield* services.resolvePullRequestProviderForRepository(
              repository,
              options as never
            );
          observeResolvedSnapshot(resolved);
          break;
        }
        case 'resolve-repository-input': {
          const { options } = resolutionInputs();
          const resolved =
            yield* services.resolvePullRequestProviderForRepositoryInput(
              { providerId: 'public-boundary', repo: 'widgets' },
              options as never
            );
          observeResolvedSnapshot(resolved);
          break;
        }
        case 'builtin-github': {
          const { request, options } = inputs();
          yield* services.listPullRequestsForRemote(
            'git@github.com:acme/widgets.git',
            request as never,
            options as never
          );
          break;
        }
        case 'builtin-github-control':
          yield* services.listPullRequestsForRemote(
            'git@github.com:acme/widgets.git'
          );
          break;
        case 'ambient-nine-public':
        case 'ambient-nine-selected': {
          const remote = 'ssh://example.test/acme/widgets.git';
          yield* services.listPullRequestsForRemote(remote);
          yield* services.getPullRequestForRemote(remote, { pullRequest });
          yield* services.createPullRequestForRemote(remote, {
            title: 'Ambient boundary',
            sourceBranch: 'feature/prototype',
            targetBranch: 'main',
          });
          yield* services.updatePullRequestForRemote(remote, {
            pullRequest,
            title: 'Ambient boundary update',
          });
          yield* services.getPullRequestDiffForRemote(remote, { pullRequest });
          yield* services.listPullRequestCommentsForRemote(remote, {
            pullRequest,
          });
          yield* services.addPullRequestCommentForRemote(remote, {
            pullRequest,
            body: 'Ambient boundary comment',
          });
          yield* services.replyToPullRequestCommentForRemote(remote, {
            pullRequest,
            threadId: 12,
            body: 'Ambient boundary reply',
          });
          yield* services.findPullRequestForBranchForRemote(remote, {
            branch: 'feature/prototype',
          });
          break;
        }
        case 'ambient-bound-all': {
          const context = yield* services.getPullRequestContextForRemote(
            'ssh://example.test/acme/widgets.git',
            { pullRequest }
          );
          observeContextSnapshot(context);
          yield* context.getPullRequestDiff({ pullRequest });
          yield* context.updatePullRequest({
            pullRequest,
            title: 'Ambient bound update',
          });
          yield* context.listPullRequestComments({ pullRequest });
          yield* context.addPullRequestComment({
            pullRequest,
            body: 'Ambient bound comment',
          });
          yield* context.replyToPullRequestComment({
            pullRequest,
            threadId: 12,
            body: 'Ambient bound reply',
          });
          break;
        }
      }
      return emptyResult;
    }),
});

let hostServices = createAideHostServices(registry);
if (surface === 'ambient-nine-selected') {
  const internal = createAideInternalHostServices(
    registry,
    Layer.succeed(
      KeyringService,
      Object.freeze({
        get: () => Effect.succeed(null),
        set: () => Effect.die('Test keyring writes are disabled.'),
        delete: () => Effect.die('Test keyring deletes are disabled.'),
      }) as never
    ),
    testGitHubAuthCatalogLayer
  );
  const selectedScope = Object.freeze(
    Object.assign(Object.create(null), {
      id: 'public-boundary:host:example.test:account:selected',
    })
  );
  hostServices = internal.withPullRequestAuthScopeSelector((resolved) => {
    selectorCalls += 1;
    observeResolvedSnapshot(resolved);
    return mode === 'prototype-selection-timeout'
      ? Effect.sleep('10 millis').pipe(Effect.as(selectedScope))
      : Effect.succeed(selectedScope);
  });
}
installAmbientPrototypeLookalike();
const exit = await Effect.runPromise(
  Effect.exit(invokePublicCommandEffect(descriptor, {}, hostServices))
);
const inherited = mode.includes('inherited');
const ambient = mode.startsWith('prototype-');
let diagnostic: string | undefined;
let failureTag: string | undefined;
if (Exit.isFailure(exit)) {
  const failure = Cause.failureOption(exit.cause);
  if (Option.isSome(failure)) {
    diagnostic = pullRequestProviderErrorMessage(failure.value);
    if (typeof failure.value === 'object' && failure.value !== null) {
      failureTag = Reflect.getOwnPropertyDescriptor(
        failure.value,
        '_tag'
      )?.value;
    }
  }
}

console.log(
  JSON.stringify({
    ok: inherited || ambient ? Exit.isSuccess(exit) : Exit.isFailure(exit),
    surface,
    mode,
    inherited,
    diagnostic,
    failureTag,
    trapReads,
    matcherCallbacks,
    providerCallbacks,
    clientCallbacks,
    networkCallbacks,
    exactAccountKeyReads,
    broadDiscoveryCallbacks,
    preferredCallbacks,
    ...(ambient
      ? {
          prototypeSelectorCalls,
          prototypeGetterReads,
          ambientScopeObservations,
          ambientIdentityObservations,
          nonNullPrototypeSnapshots,
          resolvedLookalikeObservations,
          contextLookalikeObservations,
          nestedMatchLookalikeObservations,
          nestedRepositoryLookalikeObservations,
          nestedPullRequestLookalikeObservations,
          nestedCanonicalFieldFailures,
          selectorCalls,
          operationNames: [...operationNames].sort(),
        }
      : {}),
  })
);
