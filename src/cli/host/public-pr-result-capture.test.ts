import { describe, expect, test } from 'bun:test';
import { Cause, Effect, Exit, FiberId, Option } from 'effect';
import { inspect } from 'node:util';

import {
  AIDE_PLUGIN_API_VERSION,
  defineAidePlugin as definePublicAidePlugin,
} from '@aide/plugin-api';
import { createKeyringCommandRegistry } from './command-registry.js';
import type { AidePullRequestProviderCapability } from './plugin-descriptor.js';
import {
  addPullRequestCommentForRepository,
  createPullRequestForRepository,
  findPullRequestForBranchForRepository,
  getPullRequestDiffForRepository,
  getPullRequestForRepository,
  InvalidPullRequestProviderMatchError,
  InvalidPullRequestProviderOperationResultError,
  listPullRequestCommentsForRepository,
  listPullRequestsForRepository,
  PullRequestProviderInvocationError,
  PullRequestProviderOperationError,
  pullRequestProviderErrorMessage,
  replyToPullRequestCommentForRepository,
  UnsupportedPullRequestProviderError,
  resolvePullRequestProviderForRemote,
  resolvePullRequestProviderForRepositoryInput,
  resolvePullRequestProviderForUrl,
  updatePullRequestForRepository,
} from './pull-request-provider-resolver.js';
import {
  createAideHostServices,
  createAideInternalHostServices,
} from './runtime-context.js';
import { makeTestKeyring } from '@lib/auth-keyring.test-helper.js';
import { testGitHubAuthCatalogLayer } from '@lib/github-auth-catalog.test-helper.js';

const pluginId = 'external-pr-result-capture';
const providerId = 'external-pr-capture';
const pullRequest = Object.freeze({ number: 7 });
const threadId = 12;
const branch = 'feature/capture';

type MatcherName = 'matchRemote' | 'matchRepository' | 'matchPullRequestUrl';
type OperationName =
  | 'listPullRequests'
  | 'getPullRequest'
  | 'createPullRequest'
  | 'updatePullRequest'
  | 'getPullRequestDiff'
  | 'listPullRequestComments'
  | 'addPullRequestComment'
  | 'replyToPullRequestComment'
  | 'findPullRequestForBranch';

function sourceRepository(
  metadata: Readonly<Record<string, string | number | boolean>> = {}
) {
  return {
    kind: 'external' as const,
    providerId,
    displayName: 'Capture fixture',
    ...(Object.keys(metadata).length === 0 ? {} : { metadata }),
  };
}

function arbitraryMetadata() {
  const metadata = Object.create(null) as Record<
    string,
    string | number | boolean
  >;
  for (const [key, value] of [
    ['__proto__', 'legitimate'],
    ['constructor', 42],
    ['', false],
    ['ordinary', true],
  ] as const) {
    Object.defineProperty(metadata, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value,
    });
  }
  return metadata;
}

const repository = Object.freeze(sourceRepository());

function listItem() {
  return {
    id: pullRequest.number,
    title: 'Captured pull request',
    status: 'active' as const,
    createdAt: '2026-07-12T00:00:00.000Z',
    author: { displayName: 'Ada Lovelace' },
  };
}

function viewItem() {
  return {
    ...listItem(),
    sourceBranch: branch,
    targetBranch: 'main',
    labels: ['capture'],
  };
}

function comment() {
  return {
    id: 91,
    kind: 'issue' as const,
    author: { displayName: 'Ada Lovelace' },
    body: 'Captured comment',
    createdAt: '2026-07-12T00:00:00.000Z',
  };
}

function validMatcherResult(name: MatcherName): Record<string, unknown> {
  return {
    source:
      name === 'matchRemote'
        ? 'git-remote'
        : name === 'matchRepository'
          ? 'repository-ref'
          : 'pull-request-url',
    repository: sourceRepository(),
    ...(name === 'matchPullRequestUrl' ? { pullRequest } : {}),
  };
}

function validOperationResult(name: OperationName): Record<string, unknown> {
  const base = { repository: sourceRepository() };
  switch (name) {
    case 'listPullRequests':
      return { ...base, pullRequests: [listItem()] };
    case 'getPullRequest':
      return { ...base, pullRequest: viewItem() };
    case 'createPullRequest':
    case 'updatePullRequest':
      return { ...base, pullRequest: viewItem(), warnings: ['warning'] };
    case 'getPullRequestDiff':
      return {
        ...base,
        pullRequest: viewItem(),
        files: [{ path: 'src/capture.ts', status: 'modified' }],
      };
    case 'listPullRequestComments':
      return {
        ...base,
        pullRequest,
        threads: [{ id: threadId, replies: [comment()] }],
      };
    case 'addPullRequestComment':
      return { ...base, pullRequest, comment: comment() };
    case 'replyToPullRequestComment':
      return {
        ...base,
        pullRequest,
        comment: comment(),
        thread: { id: threadId, replies: [comment()] },
      };
    case 'findPullRequestForBranch':
      return { ...base, branch, pullRequest: viewItem() };
  }
}

function manifest() {
  return {
    id: pluginId,
    version: '1.0.0',
    aidePluginApiVersion: AIDE_PLUGIN_API_VERSION,
    capabilities: ['pull-request-provider'],
  } as const;
}

function capabilityHarness(
  features: unknown = {
    draftPullRequests: true,
    reviewComments: true,
    threadedComments: true,
    enterpriseHosts: true,
  }
) {
  const matcherValues = Object.fromEntries(
    (
      [
        'matchRemote',
        'matchRepository',
        'matchPullRequestUrl',
      ] satisfies readonly MatcherName[]
    ).map((name) => [name, validMatcherResult(name)])
  ) as Record<MatcherName, unknown>;
  const values = Object.fromEntries(
    (
      [
        'listPullRequests',
        'getPullRequest',
        'createPullRequest',
        'updatePullRequest',
        'getPullRequestDiff',
        'listPullRequestComments',
        'addPullRequestComment',
        'replyToPullRequestComment',
        'findPullRequestForBranch',
      ] satisfies readonly OperationName[]
    ).map((name) => [name, validOperationResult(name)])
  ) as Record<OperationName, unknown>;
  const capability: AidePullRequestProviderCapability = {
    providerId,
    priority: 100,
    features: features as never,
    authStatus: () => Effect.succeed({ state: 'configured' }),
    matchRemote: () => matcherValues.matchRemote as never,
    matchRepository: () =>
      Effect.succeed(matcherValues.matchRepository as never),
    matchPullRequestUrl: () => matcherValues.matchPullRequestUrl as never,
    operations: {
      listPullRequests: () => Effect.succeed(values.listPullRequests as never),
      getPullRequest: () => Effect.succeed(values.getPullRequest as never),
      createPullRequest: () =>
        Effect.succeed(values.createPullRequest as never),
      updatePullRequest: () =>
        Effect.succeed(values.updatePullRequest as never),
      getPullRequestDiff: () =>
        Effect.succeed(values.getPullRequestDiff as never),
      listPullRequestComments: () =>
        Effect.succeed(values.listPullRequestComments as never),
      addPullRequestComment: () =>
        Effect.succeed(values.addPullRequestComment as never),
      replyToPullRequestComment: () =>
        Effect.succeed(values.replyToPullRequestComment as never),
      findPullRequestForBranch: () =>
        Effect.succeed(values.findPullRequestForBranch as never),
    },
  };
  return { capability, matcherValues, values };
}

function directHarness(features?: unknown) {
  const harness = capabilityHarness(features);
  return {
    ...harness,
    providers: [{ pluginId, capability: harness.capability }],
  };
}

function registryHarness(features?: unknown) {
  const harness = capabilityHarness(features);
  const registry = createKeyringCommandRegistry();
  registry.registerExternalPlugin(
    definePublicAidePlugin({
      id: pluginId,
      summary: 'PR public result capture fixture',
      commands: [],
      capabilities: { pullRequestProvider: harness.capability },
    }),
    { manifest: manifest() }
  );
  return {
    registry,
    services: createAideHostServices(registry),
    matcherValues: harness.matcherValues,
    values: harness.values,
  };
}

type Harness = ReturnType<typeof registryHarness>;
type DirectHarness = ReturnType<typeof directHarness>;

const matcherCases: readonly {
  readonly name: MatcherName;
  readonly invoke: (harness: Harness) => Effect.Effect<unknown, unknown>;
}[] = [
  {
    name: 'matchRemote',
    invoke: ({ services }) =>
      services.resolvePullRequestProviderForRemote('ssh://capture/repo.git'),
  },
  {
    name: 'matchRepository',
    invoke: ({ services }) =>
      services.resolvePullRequestProviderForRepositoryInput({
        providerId,
        repo: 'capture',
      }),
  },
  {
    name: 'matchPullRequestUrl',
    invoke: ({ services }) =>
      services.resolvePullRequestProviderForUrl(
        'https://capture.test/repo/pull/7'
      ),
  },
];

const operationCases: readonly {
  readonly name: OperationName;
  readonly invoke: (harness: Harness) => Effect.Effect<unknown, unknown>;
}[] = [
  {
    name: 'listPullRequests',
    invoke: ({ services }) =>
      services.listPullRequestsForRepository(repository),
  },
  {
    name: 'getPullRequest',
    invoke: ({ services }) =>
      services.getPullRequestForRepository(repository, { pullRequest }),
  },
  {
    name: 'createPullRequest',
    invoke: ({ services }) =>
      services.createPullRequestForRepository(repository, {
        title: 'Capture',
        sourceBranch: branch,
        targetBranch: 'main',
      }),
  },
  {
    name: 'updatePullRequest',
    invoke: ({ services }) =>
      services.updatePullRequestForRepository(repository, {
        pullRequest,
        title: 'Updated capture',
      }),
  },
  {
    name: 'getPullRequestDiff',
    invoke: ({ services }) =>
      services.getPullRequestDiffForRepository(repository, { pullRequest }),
  },
  {
    name: 'listPullRequestComments',
    invoke: ({ services }) =>
      services.listPullRequestCommentsForRepository(repository, {
        pullRequest,
      }),
  },
  {
    name: 'addPullRequestComment',
    invoke: ({ services }) =>
      services.addPullRequestCommentForRepository(repository, {
        pullRequest,
        body: 'Capture',
      }),
  },
  {
    name: 'replyToPullRequestComment',
    invoke: ({ services }) =>
      services.replyToPullRequestCommentForRepository(repository, {
        pullRequest,
        threadId,
        body: 'Capture',
      }),
  },
  {
    name: 'findPullRequestForBranch',
    invoke: ({ services }) =>
      services.findPullRequestForBranchForRepository(repository, { branch }),
  },
];

const allCases = [...matcherCases, ...operationCases] as const;

function invokeDirectCase(
  name: MatcherName | OperationName,
  harness: DirectHarness
): Effect.Effect<unknown, unknown> {
  switch (name) {
    case 'matchRemote':
      return resolvePullRequestProviderForRemote(
        harness.providers,
        'ssh://capture/repo.git'
      );
    case 'matchRepository':
      return resolvePullRequestProviderForRepositoryInput(harness.providers, {
        providerId,
        repo: 'capture',
      });
    case 'matchPullRequestUrl':
      return resolvePullRequestProviderForUrl(
        harness.providers,
        'https://capture.test/repo/pull/7'
      );
    case 'listPullRequests':
      return listPullRequestsForRepository(harness.providers, repository);
    case 'getPullRequest':
      return getPullRequestForRepository(harness.providers, repository, {
        pullRequest,
      });
    case 'createPullRequest':
      return createPullRequestForRepository(harness.providers, repository, {
        title: 'Capture',
        sourceBranch: branch,
        targetBranch: 'main',
      });
    case 'updatePullRequest':
      return updatePullRequestForRepository(harness.providers, repository, {
        pullRequest,
        title: 'Updated capture',
      });
    case 'getPullRequestDiff':
      return getPullRequestDiffForRepository(harness.providers, repository, {
        pullRequest,
      });
    case 'listPullRequestComments':
      return listPullRequestCommentsForRepository(
        harness.providers,
        repository,
        { pullRequest }
      );
    case 'addPullRequestComment':
      return addPullRequestCommentForRepository(harness.providers, repository, {
        pullRequest,
        body: 'Capture',
      });
    case 'replyToPullRequestComment':
      return replyToPullRequestCommentForRepository(
        harness.providers,
        repository,
        { pullRequest, threadId, body: 'Capture' }
      );
    case 'findPullRequestForBranch':
      return findPullRequestForBranchForRepository(
        harness.providers,
        repository,
        { branch }
      );
  }
}

function invokeRegistryCase(
  name: MatcherName | OperationName,
  harness: Harness
): Effect.Effect<unknown, unknown> {
  const testCase = allCases.find((entry) => entry.name === name);
  if (testCase === undefined)
    throw new Error(`unknown public shape route ${name}`);
  return testCase.invoke(harness);
}

function expectedError(name: MatcherName | OperationName) {
  return name.startsWith('match')
    ? InvalidPullRequestProviderMatchError
    : InvalidPullRequestProviderOperationResultError;
}

function setCaseValue(
  harness: Harness | DirectHarness,
  name: MatcherName | OperationName,
  value: unknown
): void {
  if (name.startsWith('match')) {
    harness.matcherValues[name as MatcherName] = value;
  } else {
    harness.values[name as OperationName] = value;
  }
}

function validCaseValue(name: MatcherName | OperationName) {
  return name.startsWith('match')
    ? validMatcherResult(name as MatcherName)
    : validOperationResult(name as OperationName);
}

async function expectStructuralFailure(
  effect: Effect.Effect<unknown, unknown>,
  expected:
    | typeof InvalidPullRequestProviderMatchError
    | typeof InvalidPullRequestProviderOperationResultError,
  secret?: string,
  attacker?: unknown
) {
  const exit = await Effect.runPromiseExit(effect);
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isSuccess(exit)) throw new Error('expected structural failure');
  expect(Array.from(Cause.defects(exit.cause))).toEqual([]);
  const failure = Cause.failureOption(exit.cause);
  expect(Option.isSome(failure)).toBe(true);
  if (Option.isNone(failure)) throw new Error('expected typed failure');
  expect(failure.value).toBeInstanceOf(expected);
  if (attacker !== undefined) expect(failure.value).not.toBe(attacker);
  if (secret !== undefined) {
    expect(Cause.pretty(exit.cause)).not.toContain(secret);
    expect(String(failure.value)).not.toContain(secret);
  }
  return failure.value;
}

function recursivelyFrozen(value: unknown, seen = new Set<object>()): boolean {
  if (typeof value !== 'object' || value === null || seen.has(value))
    return true;
  seen.add(value);
  return (
    Object.isFrozen(value) &&
    Reflect.ownKeys(value).every((key) =>
      recursivelyFrozen(Reflect.get(value, key), seen)
    )
  );
}

function capturedStringUnits(value: unknown): number {
  if (typeof value === 'string') return value.length;
  if (typeof value !== 'object' || value === null) return 0;
  if (Array.isArray(value)) {
    return value.reduce(
      (total, entry, index) =>
        total + String(index).length + capturedStringUnits(entry),
      0
    );
  }
  return Reflect.ownKeys(value).reduce(
    (total, key) =>
      total +
      (typeof key === 'string' ? key.length : 0) +
      capturedStringUnits(Reflect.get(value, key)),
    0
  );
}

function capturedNodeCount(value: unknown): number {
  if (typeof value !== 'object' || value === null) return 1;
  if (Array.isArray(value)) {
    return (
      1 + value.reduce((total, entry) => total + capturedNodeCount(entry), 0)
    );
  }
  return (
    1 +
    Reflect.ownKeys(value).reduce(
      (total, key) => total + capturedNodeCount(Reflect.get(value, key)),
      0
    )
  );
}

function capturedDepth(value: unknown, depth = 0): number {
  if (typeof value !== 'object' || value === null) return depth;
  const entries = Array.isArray(value)
    ? value
    : Reflect.ownKeys(value).map((key) => Reflect.get(value, key));
  return entries.reduce(
    (maximum, entry) => Math.max(maximum, capturedDepth(entry, depth + 1)),
    depth
  );
}

const structuralContractSecret = 'SECRET-PR-STRUCTURAL-CONTRACT';
type PublicShapeRoute = 'features' | MatcherName | OperationName;

interface PublicShapeContractCase {
  readonly name: string;
  readonly route: PublicShapeRoute;
  readonly makeRoot: () => Record<string, unknown>;
  readonly focus: (root: Record<string, unknown>) => Record<string, unknown>;
  readonly requiredField?: string;
  readonly optionalField?: string;
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`expected record at ${label}`);
  }
  return value as Record<string, unknown>;
}

function arrayRecordEntry(
  value: unknown,
  index: number,
  label: string
): Record<string, unknown> {
  if (!Array.isArray(value)) throw new Error(`expected array at ${label}`);
  return recordValue(value[index], `${label}[${index}]`);
}

function contractMatchRoot(
  name: MatcherName,
  repositoryValue: Record<string, unknown> = sourceRepository()
): Record<string, unknown> {
  const match = validMatcherResult(name);
  return {
    ...match,
    repository: repositoryValue,
    ...(name === 'matchPullRequestUrl'
      ? { pullRequest: { number: pullRequest.number } }
      : {}),
    priority: 100,
    detail: structuralContractSecret,
  };
}

function contractOperationRoot(name: OperationName): Record<string, unknown> {
  const root = validOperationResult(name);
  root.repositoryLabel = structuralContractSecret;
  if (name === 'addPullRequestComment') {
    root.thread = { id: threadId, replies: [comment()] };
  }
  return root;
}

function operationShapeRoot(
  name: OperationName,
  prepare?: (root: Record<string, unknown>) => void
): Record<string, unknown> {
  const root = contractOperationRoot(name);
  prepare?.(root);
  return root;
}

const publicShapeContractCases: readonly PublicShapeContractCase[] = [
  {
    name: 'AidePullRequestRepositoryRef/github',
    route: 'matchRemote',
    makeRoot: () =>
      contractMatchRoot('matchRemote', {
        kind: 'github',
        host: 'github.example.test',
        owner: 'aide',
        repo: 'schema',
      }),
    focus: (root) => recordValue(root.repository, 'repository'),
    requiredField: 'host',
  },
  {
    name: 'AidePullRequestRepositoryRef/azure-devops',
    route: 'matchRemote',
    makeRoot: () =>
      contractMatchRoot('matchRemote', {
        kind: 'azure-devops',
        org: 'aide',
        project: 'schema',
        repo: 'capture',
      }),
    focus: (root) => recordValue(root.repository, 'repository'),
    requiredField: 'org',
  },
  {
    name: 'AidePullRequestRepositoryRef/external',
    route: 'matchRemote',
    makeRoot: () =>
      contractMatchRoot('matchRemote', sourceRepository({ contract: true })),
    focus: (root) => recordValue(root.repository, 'repository'),
    requiredField: 'providerId',
    optionalField: 'metadata',
  },
  {
    name: 'AidePullRequestRef',
    route: 'matchPullRequestUrl',
    makeRoot: () => contractMatchRoot('matchPullRequestUrl'),
    focus: (root) => recordValue(root.pullRequest, 'pullRequest'),
    requiredField: 'number',
  },
  {
    name: 'AidePullRequestRemoteMatch',
    route: 'matchRemote',
    makeRoot: () => ({
      ...contractMatchRoot('matchRemote'),
      pullRequest: undefined,
    }),
    focus: (root) => root,
    requiredField: 'source',
    optionalField: 'pullRequest',
  },
  {
    name: 'AidePullRequestRepositoryMatch',
    route: 'matchRepository',
    makeRoot: () => ({
      ...contractMatchRoot('matchRepository'),
      pullRequest: undefined,
    }),
    focus: (root) => root,
    requiredField: 'repository',
    optionalField: 'pullRequest',
  },
  {
    name: 'AidePullRequestUrlMatch',
    route: 'matchPullRequestUrl',
    makeRoot: () => contractMatchRoot('matchPullRequestUrl'),
    focus: (root) => root,
    requiredField: 'pullRequest',
    optionalField: 'detail',
  },
  {
    name: 'AidePullRequestProviderFeatures',
    route: 'features',
    makeRoot: () => ({ draftPullRequests: true }),
    focus: (root) => root,
    optionalField: 'draftPullRequests',
  },
  {
    name: 'AidePullRequestAuthor',
    route: 'listPullRequests',
    makeRoot: () =>
      operationShapeRoot('listPullRequests', (root) => {
        const item = arrayRecordEntry(root.pullRequests, 0, 'pullRequests');
        recordValue(item.author, 'pullRequests[0].author').username = 'ada';
      }),
    focus: (root) =>
      recordValue(
        arrayRecordEntry(root.pullRequests, 0, 'pullRequests').author,
        'pullRequests[0].author'
      ),
    requiredField: 'displayName',
    optionalField: 'username',
  },
  {
    name: 'AidePullRequestListItem',
    route: 'listPullRequests',
    makeRoot: () =>
      operationShapeRoot('listPullRequests', (root) => {
        arrayRecordEntry(root.pullRequests, 0, 'pullRequests').description =
          'Contract description';
      }),
    focus: (root) => arrayRecordEntry(root.pullRequests, 0, 'pullRequests'),
    requiredField: 'id',
    optionalField: 'description',
  },
  {
    name: 'AidePullRequestViewItem',
    route: 'getPullRequest',
    makeRoot: () => operationShapeRoot('getPullRequest'),
    focus: (root) => recordValue(root.pullRequest, 'pullRequest'),
    requiredField: 'title',
    optionalField: 'sourceBranch',
  },
  {
    name: 'AidePullRequestDiffFile',
    route: 'getPullRequestDiff',
    makeRoot: () =>
      operationShapeRoot('getPullRequestDiff', (root) => {
        arrayRecordEntry(root.files, 0, 'files').providerStatus = 'M';
      }),
    focus: (root) => arrayRecordEntry(root.files, 0, 'files'),
    requiredField: 'path',
    optionalField: 'providerStatus',
  },
  {
    name: 'AidePullRequestCommentAuthor',
    route: 'addPullRequestComment',
    makeRoot: () =>
      operationShapeRoot('addPullRequestComment', (root) => {
        recordValue(
          recordValue(root.comment, 'comment').author,
          'comment.author'
        ).username = 'ada';
      }),
    focus: (root) =>
      recordValue(
        recordValue(root.comment, 'comment').author,
        'comment.author'
      ),
    requiredField: 'displayName',
    optionalField: 'username',
  },
  {
    name: 'AidePullRequestComment',
    route: 'addPullRequestComment',
    makeRoot: () =>
      operationShapeRoot('addPullRequestComment', (root) => {
        recordValue(root.comment, 'comment').updatedAt =
          '2026-07-12T01:00:00.000Z';
      }),
    focus: (root) => recordValue(root.comment, 'comment'),
    requiredField: 'body',
    optionalField: 'updatedAt',
  },
  {
    name: 'AidePullRequestCommentThread',
    route: 'listPullRequestComments',
    makeRoot: () =>
      operationShapeRoot('listPullRequestComments', (root) => {
        arrayRecordEntry(root.threads, 0, 'threads').status = 'active';
      }),
    focus: (root) => arrayRecordEntry(root.threads, 0, 'threads'),
    requiredField: 'replies',
    optionalField: 'status',
  },
  {
    name: 'AidePullRequestListResult',
    route: 'listPullRequests',
    makeRoot: () => operationShapeRoot('listPullRequests'),
    focus: (root) => root,
    requiredField: 'pullRequests',
    optionalField: 'repositoryLabel',
  },
  {
    name: 'AidePullRequestViewResult',
    route: 'getPullRequest',
    makeRoot: () => operationShapeRoot('getPullRequest'),
    focus: (root) => root,
    requiredField: 'pullRequest',
    optionalField: 'repositoryLabel',
  },
  {
    name: 'AidePullRequestCreateResult',
    route: 'createPullRequest',
    makeRoot: () => operationShapeRoot('createPullRequest'),
    focus: (root) => root,
    requiredField: 'repository',
    optionalField: 'warnings',
  },
  {
    name: 'AidePullRequestUpdateResult',
    route: 'updatePullRequest',
    makeRoot: () => operationShapeRoot('updatePullRequest'),
    focus: (root) => root,
    requiredField: 'pullRequest',
    optionalField: 'warnings',
  },
  {
    name: 'AidePullRequestDiffResult',
    route: 'getPullRequestDiff',
    makeRoot: () => operationShapeRoot('getPullRequestDiff'),
    focus: (root) => root,
    requiredField: 'files',
    optionalField: 'repositoryLabel',
  },
  {
    name: 'AidePullRequestCommentsResult',
    route: 'listPullRequestComments',
    makeRoot: () => operationShapeRoot('listPullRequestComments'),
    focus: (root) => root,
    requiredField: 'threads',
    optionalField: 'repositoryLabel',
  },
  {
    name: 'AidePullRequestCommentMutationResult/add',
    route: 'addPullRequestComment',
    makeRoot: () => operationShapeRoot('addPullRequestComment'),
    focus: (root) => root,
    requiredField: 'comment',
    optionalField: 'thread',
  },
  {
    name: 'AidePullRequestCommentMutationResult/reply',
    route: 'replyToPullRequestComment',
    makeRoot: () => operationShapeRoot('replyToPullRequestComment'),
    focus: (root) => root,
    requiredField: 'pullRequest',
    optionalField: 'thread',
  },
  {
    name: 'AidePullRequestBranchLookupResult',
    route: 'findPullRequestForBranch',
    makeRoot: () => operationShapeRoot('findPullRequestForBranch'),
    focus: (root) => root,
    requiredField: 'branch',
    optionalField: 'repositoryLabel',
  },
];

type ContractBoundary = 'direct-resolver' | 'external-registry-host';

function invokeContractCandidate(
  boundary: ContractBoundary,
  testCase: PublicShapeContractCase,
  candidate: Record<string, unknown>
): Effect.Effect<unknown, unknown> {
  if (testCase.route === 'features') {
    if (boundary === 'direct-resolver') {
      const harness = directHarness(candidate);
      return resolvePullRequestProviderForRemote(
        harness.providers,
        'ssh://capture/repo.git'
      );
    }
    const harness = registryHarness(candidate);
    return matcherCases[0]!.invoke(harness);
  }
  if (boundary === 'direct-resolver') {
    const harness = directHarness();
    setCaseValue(harness, testCase.route, candidate);
    return invokeDirectCase(testCase.route, harness);
  }
  const harness = registryHarness();
  setCaseValue(harness, testCase.route, candidate);
  return invokeRegistryCase(testCase.route, harness);
}

function contractOutputRoot(
  route: PublicShapeRoute,
  value: unknown
): Record<string, unknown> {
  const output = recordValue(value, 'boundary output');
  if (route === 'features') return recordValue(output.features, 'features');
  return route.startsWith('match')
    ? recordValue(output.match, 'match')
    : output;
}

function ownDataContainsIdentity(
  value: unknown,
  target: unknown,
  seen = new Set<object>()
): boolean {
  if (value === target) return true;
  if (typeof value !== 'object' || value === null || seen.has(value)) {
    return false;
  }
  seen.add(value);
  return Reflect.ownKeys(value).some((key) => {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    return (
      descriptor !== undefined &&
      Object.hasOwn(descriptor, 'value') &&
      ownDataContainsIdentity(descriptor.value, target, seen)
    );
  });
}

async function expectContractFailure(
  boundary: ContractBoundary,
  testCase: PublicShapeContractCase,
  candidate: Record<string, unknown>
): Promise<unknown> {
  const exit = await Effect.runPromiseExit(
    invokeContractCandidate(boundary, testCase, candidate)
  );
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isSuccess(exit))
    throw new Error('expected structural contract failure');
  expect(exit.cause._tag).toBe('Fail');
  expect(Array.from(Cause.defects(exit.cause))).toEqual([]);
  const failure = Cause.failureOption(exit.cause);
  expect(Option.isSome(failure)).toBe(true);
  if (Option.isNone(failure))
    throw new Error('expected typed contract failure');
  const expected = expectedError(testCase.route as MatcherName | OperationName);
  expect(failure.value).toBeInstanceOf(expected);
  expect(recordValue(failure.value, 'typed structural failure')._tag).toBe(
    testCase.route.startsWith('match')
      ? 'InvalidPullRequestProviderMatchError'
      : 'InvalidPullRequestProviderOperationResultError'
  );
  expect(failure.value).not.toBe(candidate);
  expect(ownDataContainsIdentity(exit.cause, candidate)).toBe(false);
  expect(
    Reflect.getOwnPropertyDescriptor(
      recordValue(failure.value, 'typed structural failure'),
      'cause'
    )?.value
  ).not.toBe(candidate);
  expect(Cause.pretty(exit.cause)).not.toContain(structuralContractSecret);
  expect(String(failure.value)).not.toContain(structuralContractSecret);
  return failure.value;
}

describe('public PR result structural capture', () => {
  test('fails closed when a provider tries to reflect request auth-scope material through a public result', async () => {
    const sentinel = 'SECRET-PROVIDER-REQUEST-AUTH-SCOPE';
    for (const operation of operationCases) {
      const harness = registryHarness();
      harness.values[operation.name] = {
        ...(harness.values[operation.name] as Record<string, unknown>),
        authScope: {
          id: sentinel,
          providerId: providerId,
          host: 'example.test',
          account: 'ada',
        },
      };

      const exit = await Effect.runPromiseExit(operation.invoke(harness));
      expect(Exit.isFailure(exit), operation.name).toBe(true);
      if (Exit.isSuccess(exit)) {
        throw new Error(`expected ${operation.name} structural rejection`);
      }
      const failure = Cause.failureOption(exit.cause);
      expect(Option.isSome(failure), operation.name).toBe(true);
      if (Option.isNone(failure)) {
        throw new Error(`expected ${operation.name} typed failure`);
      }
      expect(failure.value, operation.name).toBeInstanceOf(
        InvalidPullRequestProviderOperationResultError
      );
      expect(inspect(exit, { depth: 12 }), operation.name).not.toContain(
        sentinel
      );
    }
  });

  for (const boundary of [
    'direct-resolver',
    'external-registry-host',
  ] as const satisfies readonly ContractBoundary[]) {
    for (const shape of publicShapeContractCases) {
      test(`${boundary} enforces required/optional structure for ${shape.name}`, async () => {
        const control = shape.makeRoot();
        const controlValue = await Effect.runPromise(
          invokeContractCandidate(boundary, shape, control)
        );
        expect(
          shape.focus(contractOutputRoot(shape.route, controlValue))
        ).toBeDefined();

        if (shape.requiredField !== undefined) {
          const missing = shape.makeRoot();
          const missingFocus = shape.focus(missing);
          expect(Object.hasOwn(missingFocus, shape.requiredField)).toBe(true);
          Reflect.deleteProperty(missingFocus, shape.requiredField);
          const firstMissing = await expectContractFailure(
            boundary,
            shape,
            missing
          );
          const secondMissing = await expectContractFailure(
            boundary,
            shape,
            missing
          );
          expect(firstMissing).not.toBe(secondMissing);

          const ownUndefined = shape.makeRoot();
          const undefinedFocus = shape.focus(ownUndefined);
          Object.defineProperty(undefinedFocus, shape.requiredField, {
            configurable: true,
            enumerable: true,
            writable: true,
            value: undefined,
          });
          const firstUndefined = await expectContractFailure(
            boundary,
            shape,
            ownUndefined
          );
          const secondUndefined = await expectContractFailure(
            boundary,
            shape,
            ownUndefined
          );
          expect(firstUndefined).not.toBe(secondUndefined);
        }

        if (shape.optionalField !== undefined) {
          const missing = shape.makeRoot();
          const missingFocus = shape.focus(missing);
          expect(Object.hasOwn(missingFocus, shape.optionalField)).toBe(true);
          Reflect.deleteProperty(missingFocus, shape.optionalField);
          const missingValue = await Effect.runPromise(
            invokeContractCandidate(boundary, shape, missing)
          );
          expect(
            Object.hasOwn(
              shape.focus(contractOutputRoot(shape.route, missingValue)),
              shape.optionalField
            )
          ).toBe(false);

          const ownUndefined = shape.makeRoot();
          const undefinedFocus = shape.focus(ownUndefined);
          Object.defineProperty(undefinedFocus, shape.optionalField, {
            configurable: true,
            enumerable: true,
            writable: true,
            value: undefined,
          });
          const undefinedValue = await Effect.runPromise(
            invokeContractCandidate(boundary, shape, ownUndefined)
          );
          expect(
            Object.hasOwn(
              shape.focus(contractOutputRoot(shape.route, undefinedValue)),
              shape.optionalField
            )
          ).toBe(false);
        }
      });
    }
  }

  test('keeps repository and match union arms exact at both production boundaries', async () => {
    const malformedCases = [
      {
        ...contractMatchRoot('matchRemote', {
          kind: 'github',
          owner: 'aide',
          repo: 'schema',
          providerId,
          displayName: 'must not become external',
        }),
      },
      {
        ...contractMatchRoot('matchRemote', {
          kind: 'azure-devops',
          project: 'schema',
          repo: 'capture',
          providerId,
          displayName: 'must not become external',
        }),
      },
      contractMatchRoot('matchRemote', {
        kind: 'unknown',
        providerId,
        displayName: 'must hit rejecting fallback',
      }),
      {
        ...contractMatchRoot('matchRemote'),
        pullRequest: { number: pullRequest.number },
      },
    ];
    const shape = publicShapeContractCases.find(
      (entry) => entry.name === 'AidePullRequestRemoteMatch'
    );
    if (shape === undefined) throw new Error('missing remote match shape case');
    for (const boundary of [
      'direct-resolver',
      'external-registry-host',
    ] as const) {
      for (const malformed of malformedCases) {
        const first = await expectContractFailure(boundary, shape, malformed);
        const second = await expectContractFailure(boundary, shape, malformed);
        expect(first).not.toBe(second);
      }
    }
  });

  test('redacts matcher failure identity while retaining operation failure identity and fixed host text', async () => {
    for (const target of ['matcher', 'operation'] as const) {
      const attacker = new Error();
      let messageReads = 0;
      Object.defineProperty(attacker, 'message', {
        configurable: true,
        get() {
          messageReads += 1;
          return `SECRET-${target}-FAILURE`;
        },
      });
      const failurePluginId = `external-pr-${target}-failure`;
      const capability: AidePullRequestProviderCapability = {
        providerId,
        priority: 100,
        features: {},
        authStatus: () => Effect.succeed({ state: 'configured' }),
        matchRemote: () => null,
        matchRepository: () =>
          target === 'matcher'
            ? Effect.fail(attacker)
            : Effect.succeed({ source: 'repository-ref', repository }),
        matchPullRequestUrl: () => null,
        operations: {
          listPullRequests: () =>
            target === 'operation'
              ? Effect.fail(attacker)
              : Effect.succeed({ repository, pullRequests: [] }),
        },
      };
      const registry = createKeyringCommandRegistry();
      registry.registerExternalPlugin(
        definePublicAidePlugin({
          id: failurePluginId,
          summary: 'PR genuine failure rendering fixture',
          commands: [],
          capabilities: { pullRequestProvider: capability },
        }),
        {
          manifest: {
            ...manifest(),
            id: failurePluginId,
          },
        }
      );
      const services = createAideHostServices(registry);
      const program: Effect.Effect<unknown, unknown> =
        target === 'matcher'
          ? services.resolvePullRequestProviderForRepositoryInput({
              providerId,
            })
          : services.listPullRequestsForRepository(repository);
      const exit = await Effect.runPromiseExit(program);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isSuccess(exit)) throw new Error('expected genuine failure');
      const failure = Cause.failureOption(exit.cause);
      expect(Option.isSome(failure)).toBe(true);
      if (Option.isNone(failure)) throw new Error('expected typed failure');
      const wrapper = failure.value;
      expect(wrapper).toBeInstanceOf(
        target === 'matcher'
          ? PullRequestProviderInvocationError
          : PullRequestProviderOperationError
      );
      const wrapperCause = (wrapper as { cause: unknown }).cause;
      if (target === 'matcher') {
        expect(wrapperCause).not.toBe(attacker);
        expect(wrapperCause).toBeInstanceOf(Error);
        expect((wrapperCause as Error).message).toBe(
          'Pull request provider matcher failed'
        );
      } else {
        expect(wrapperCause).toBe(attacker);
      }
      expect((wrapper as Error).message).toBe(
        target === 'matcher'
          ? `Pull request provider '${providerId}' from plugin '${failurePluginId}' failed while matching repository-ref provider=${providerId}`
          : `Pull request provider '${providerId}' from plugin '${failurePluginId}' failed during listPullRequests`
      );
      expect(messageReads).toBe(0);
    }
  });

  for (const failureShape of [
    'selected-scope',
    'hostile-wrapper',
    'hostile-proxy',
  ] as const) {
    test(`replaces ${failureShape} provider failures with a fresh fixed public cause when a host-selected scope is attached`, async () => {
      const selectedScopeId = `${providerId}:host:selected.example.test:account:selected-account`;
      const nestedIdentitySentinel = `SECRET-NESTED-SELECTED-IDENTITY-${failureShape}`;
      const failurePluginId = `external-pr-selected-failure-${failureShape}`;
      const providerFailures: unknown[] = [];
      const observedScopes: unknown[] = [];
      let trapReads = 0;
      const capability: AidePullRequestProviderCapability = {
        providerId,
        priority: 100,
        features: {},
        authStatus: () => Effect.succeed({ state: 'configured' }),
        matchRemote: () => null,
        matchRepository: () =>
          Effect.succeed({ source: 'repository-ref', repository }),
        matchPullRequestUrl: () => null,
        operations: {
          listPullRequests: (request) => {
            const selectedScope = request.authScope;
            observedScopes.push(selectedScope);
            let providerFailure: unknown = selectedScope;
            if (failureShape !== 'selected-scope') {
              const wrapper = Object.create(null) as Record<string, unknown>;
              Object.defineProperty(wrapper, 'nested', {
                enumerable: true,
                value: Object.freeze({
                  identity: selectedScope,
                  id: selectedScope?.id,
                  sentinel: nestedIdentitySentinel,
                }),
              });
              for (const field of ['message', 'cause', 'authScope', '_tag']) {
                Object.defineProperty(wrapper, field, {
                  get() {
                    trapReads += 1;
                    throw new Error(`SECRET-SELECTED-FAILURE-${field}`);
                  },
                });
              }
              providerFailure =
                failureShape === 'hostile-proxy'
                  ? new Proxy(wrapper, {
                      get() {
                        trapReads += 1;
                        throw new Error('SECRET-SELECTED-FAILURE-PROXY');
                      },
                      getOwnPropertyDescriptor() {
                        trapReads += 1;
                        throw new Error('SECRET-SELECTED-FAILURE-PROXY');
                      },
                      getPrototypeOf() {
                        trapReads += 1;
                        throw new Error('SECRET-SELECTED-FAILURE-PROXY');
                      },
                      ownKeys() {
                        trapReads += 1;
                        throw new Error('SECRET-SELECTED-FAILURE-PROXY');
                      },
                    })
                  : wrapper;
            }
            providerFailures.push(providerFailure);
            return Effect.fail(providerFailure);
          },
        },
      };
      const registry = createKeyringCommandRegistry();
      registry.registerExternalPlugin(
        definePublicAidePlugin({
          id: failurePluginId,
          summary: 'Selected-scope failure reflection probe',
          commands: [],
          capabilities: { pullRequestProvider: capability },
        }),
        { manifest: { ...manifest(), id: failurePluginId } }
      );
      const services = createAideInternalHostServices(
        registry,
        makeTestKeyring().layer,
        testGitHubAuthCatalogLayer
      ).withPullRequestAuthScopeSelector(() =>
        Effect.succeed({
          id: selectedScopeId,
          providerId,
          host: 'selected.example.test',
          account: 'selected-account',
        })
      );

      const publicFailures: PullRequestProviderOperationError[] = [];
      const publicCauses: unknown[] = [];
      const effectCauses: Cause.Cause<unknown>[] = [];
      for (let invocation = 0; invocation < 2; invocation += 1) {
        const exit = await Effect.runPromiseExit(
          services.listPullRequestsForRepository(repository)
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isSuccess(exit)) throw new Error('expected provider failure');
        const failure = Cause.failureOption(exit.cause);
        expect(Option.isSome(failure)).toBe(true);
        if (Option.isNone(failure)) throw new Error('expected typed failure');
        expect(failure.value).toBeInstanceOf(PullRequestProviderOperationError);
        const publicFailure =
          failure.value as PullRequestProviderOperationError;
        const publicCause = publicFailure.cause;
        expect(publicCause).not.toBe(providerFailures.at(-1));
        expect(publicCause).not.toBe(observedScopes.at(-1));
        expect(Object.getPrototypeOf(publicCause)).toBe(null);
        expect(Reflect.ownKeys(publicCause as object)).toEqual([]);
        expect(pullRequestProviderErrorMessage(publicFailure)).toBe(
          `Pull request provider '${providerId}' from plugin '${failurePluginId}' failed during listPullRequests`
        );
        publicFailures.push(publicFailure);
        publicCauses.push(publicCause);
        effectCauses.push(exit.cause);
      }

      expect(publicCauses[0]).not.toBe(publicCauses[1]);
      expect(observedScopes).toHaveLength(2);
      expect(observedScopes[0]).not.toBe(observedScopes[1]);
      expect(trapReads).toBe(0);
      const inspectable = inspect(
        { publicFailures, publicCauses, effectCauses },
        { depth: 12, getters: true }
      );
      for (const secret of [
        selectedScopeId,
        'selected.example.test',
        'selected-account',
        nestedIdentitySentinel,
      ]) {
        expect(inspectable).not.toContain(secret);
      }
      expect(trapReads).toBe(0);
    });
  }

  for (const causeShape of [
    'die-selected-scope',
    'parallel-fail-die',
    'sequential-fail-die',
    'parallel-fail-die-interrupt',
    'finalizer-die-selected-scope',
    'finalizer-die-hostile-wrapper',
    'finalizer-die-hostile-proxy',
  ] as const) {
    test(`sanitizes the complete selected-scope provider Cause for ${causeShape}`, async () => {
      const selectedScopeId = `${providerId}:host:selected-cause.example.test:account:selected-cause-account`;
      const nestedIdentitySentinel = `SECRET-SELECTED-CAUSE-${causeShape}`;
      const failurePluginId = `external-pr-complete-cause-${causeShape}`;
      const interruptor = FiberId.make(73, 17);
      const observedScopes: unknown[] = [];
      const rawDefects: unknown[] = [];
      let trapReads = 0;

      const hostileDefect = (
        selectedScope: unknown,
        proxy: boolean
      ): unknown => {
        const hostilePrototype = Object.freeze({
          inheritedScope: selectedScope,
          inheritedSentinel: nestedIdentitySentinel,
        });
        const wrapper = Object.create(hostilePrototype) as Record<
          PropertyKey,
          unknown
        >;
        Object.defineProperty(wrapper, 'nested', {
          enumerable: true,
          value: Object.freeze({
            identity: selectedScope,
            sentinel: nestedIdentitySentinel,
          }),
        });
        for (const field of [
          'message',
          'cause',
          'authScope',
          '_tag',
          'toJSON',
          Symbol.for('nodejs.util.inspect.custom'),
        ]) {
          Object.defineProperty(wrapper, field, {
            get() {
              trapReads += 1;
              throw new Error('SECRET-SELECTED-CAUSE-GETTER');
            },
          });
        }
        if (!proxy) return wrapper;
        return new Proxy(wrapper, {
          get() {
            trapReads += 1;
            throw new Error('SECRET-SELECTED-CAUSE-PROXY');
          },
          getOwnPropertyDescriptor() {
            trapReads += 1;
            throw new Error('SECRET-SELECTED-CAUSE-PROXY');
          },
          getPrototypeOf() {
            trapReads += 1;
            throw new Error('SECRET-SELECTED-CAUSE-PROXY');
          },
          ownKeys() {
            trapReads += 1;
            throw new Error('SECRET-SELECTED-CAUSE-PROXY');
          },
        });
      };

      const capability: AidePullRequestProviderCapability = {
        providerId,
        priority: 100,
        features: {},
        authStatus: () => Effect.succeed({ state: 'configured' }),
        matchRemote: () => null,
        matchRepository: () =>
          Effect.succeed({ source: 'repository-ref', repository }),
        matchPullRequestUrl: () => null,
        operations: {
          listPullRequests: (request) => {
            const selectedScope = request.authScope;
            observedScopes.push(selectedScope);
            switch (causeShape) {
              case 'die-selected-scope':
                rawDefects.push(selectedScope);
                return Effect.die(selectedScope);
              case 'parallel-fail-die':
                rawDefects.push(selectedScope);
                return Effect.failCause(
                  Cause.parallel(
                    Cause.fail(selectedScope),
                    Cause.die(selectedScope)
                  )
                );
              case 'sequential-fail-die':
                rawDefects.push(selectedScope);
                return Effect.failCause(
                  Cause.sequential(
                    Cause.fail(selectedScope),
                    Cause.die(selectedScope)
                  )
                );
              case 'parallel-fail-die-interrupt':
                rawDefects.push(selectedScope);
                return Effect.failCause(
                  Cause.parallel(
                    Cause.sequential(
                      Cause.fail(selectedScope),
                      Cause.die(selectedScope)
                    ),
                    Cause.interrupt(interruptor)
                  )
                );
              case 'finalizer-die-selected-scope':
                rawDefects.push(selectedScope);
                return Effect.fail(selectedScope).pipe(
                  Effect.ensuring(Effect.die(selectedScope))
                );
              case 'finalizer-die-hostile-wrapper': {
                const defect = hostileDefect(selectedScope, false);
                rawDefects.push(defect);
                return Effect.fail(selectedScope).pipe(
                  Effect.ensuring(Effect.die(defect))
                );
              }
              case 'finalizer-die-hostile-proxy': {
                const defect = hostileDefect(selectedScope, true);
                rawDefects.push(defect);
                return Effect.fail(selectedScope).pipe(
                  Effect.ensuring(Effect.die(defect))
                );
              }
            }
          },
        },
      };
      const registry = createKeyringCommandRegistry();
      registry.registerExternalPlugin(
        definePublicAidePlugin({
          id: failurePluginId,
          summary: 'Complete selected-scope Cause sanitization probe',
          commands: [],
          capabilities: { pullRequestProvider: capability },
        }),
        { manifest: { ...manifest(), id: failurePluginId } }
      );
      const services = createAideInternalHostServices(
        registry,
        makeTestKeyring().layer,
        testGitHubAuthCatalogLayer
      ).withPullRequestAuthScopeSelector(() =>
        Effect.succeed({
          id: selectedScopeId,
          providerId,
          host: 'selected-cause.example.test',
          account: 'selected-cause-account',
        })
      );

      const publicDefects: unknown[][] = [];
      for (let invocation = 0; invocation < 2; invocation += 1) {
        const exit = await Effect.runPromiseExit(
          services.listPullRequestsForRepository(repository)
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isSuccess(exit)) throw new Error('expected provider Cause');

        const expectedTopTag =
          causeShape === 'die-selected-scope'
            ? 'Die'
            : causeShape.startsWith('parallel-')
              ? 'Parallel'
              : 'Sequential';
        expect(exit.cause._tag).toBe(expectedTopTag);

        const failures = Array.from(Cause.failures(exit.cause));
        const defects = Array.from(Cause.defects(exit.cause));
        const expectedFailureCount =
          causeShape === 'die-selected-scope' ? 0 : 1;
        expect(failures).toHaveLength(expectedFailureCount);
        expect(defects).toHaveLength(1);
        expect(defects[0]).not.toBe(rawDefects.at(-1));
        expect(defects[0]).not.toBe(observedScopes.at(-1));
        expect(Object.getPrototypeOf(defects[0] as object)).toBe(null);
        expect(Reflect.ownKeys(defects[0] as object)).toEqual([]);
        publicDefects.push(defects);

        for (const failure of failures) {
          expect(failure).toBeInstanceOf(PullRequestProviderOperationError);
          const publicFailure = failure as PullRequestProviderOperationError;
          expect(Object.getPrototypeOf(publicFailure.cause)).toBe(null);
          expect(Reflect.ownKeys(publicFailure.cause as object)).toEqual([]);
          expect(pullRequestProviderErrorMessage(publicFailure)).toBe(
            `Pull request provider '${providerId}' from plugin '${failurePluginId}' failed during listPullRequests`
          );
        }

        const interruptors = Array.from(Cause.interruptors(exit.cause));
        if (causeShape === 'parallel-fail-die-interrupt') {
          expect(interruptors).toEqual([interruptor]);
        } else {
          expect(interruptors).toEqual([]);
        }

        const inspectionSurfaces = [
          JSON.stringify(failures),
          JSON.stringify(defects),
          JSON.stringify(exit.cause),
          inspect(failures, { depth: 20, getters: true, customInspect: true }),
          inspect(defects, { depth: 20, getters: true, customInspect: true }),
          inspect(exit.cause, {
            depth: 20,
            getters: true,
            customInspect: true,
          }),
          Cause.pretty(exit.cause),
        ];
        for (const secret of [
          selectedScopeId,
          'selected-cause.example.test',
          'selected-cause-account',
          nestedIdentitySentinel,
        ]) {
          for (const inspection of inspectionSurfaces) {
            expect(inspection).not.toContain(secret);
          }
        }
        expect(trapReads).toBe(0);
      }

      expect(publicDefects[0]![0]).not.toBe(publicDefects[1]![0]);
      expect(observedScopes).toHaveLength(2);
      expect(observedScopes[0]).not.toBe(observedScopes[1]);
      expect(trapReads).toBe(0);
    });
  }

  test('fails closed for malformed DNS lookup values crossing the public provider boundary', async () => {
    const lookupSecrets = [
      'CERT_DNS_PUBLIC_USER',
      'CERT_DNS_PUBLIC_PASSWORD',
    ] as const;
    const matcherSecret = 'TODO160-PUBLIC-MATCHER-FAILURE';
    const malformedRepo = `https://example..invalid/org/${lookupSecrets[0]}:${lookupSecrets[1]}@inner.invalid/repo.git`;
    const failurePluginId = 'external-pr-network-grammar-failure';
    const capability: AidePullRequestProviderCapability = {
      providerId,
      priority: 100,
      features: {},
      authStatus: () => Effect.succeed({ state: 'configured' }),
      matchRemote: () => null,
      matchRepository: () => Effect.fail(new Error(matcherSecret)),
      matchPullRequestUrl: () => null,
    };
    const registry = createKeyringCommandRegistry();
    registry.registerExternalPlugin(
      definePublicAidePlugin({
        id: failurePluginId,
        summary: 'PR network grammar failure fixture',
        commands: [],
        capabilities: { pullRequestProvider: capability },
      }),
      { manifest: { ...manifest(), id: failurePluginId } }
    );
    const exit = await Effect.runPromiseExit(
      createAideHostServices(
        registry
      ).resolvePullRequestProviderForRepositoryInput({
        providerId,
        repo: malformedRepo,
      })
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isSuccess(exit)) throw new Error('expected matcher failure');
    const failure = Cause.failureOption(exit.cause);
    expect(Option.isSome(failure)).toBe(true);
    if (Option.isNone(failure)) throw new Error('expected typed failure');
    expect(failure.value).toBeInstanceOf(PullRequestProviderInvocationError);
    const wrapper = failure.value as PullRequestProviderInvocationError;
    expect(wrapper.value).toBe('<redacted>');
    const surfaces = [
      wrapper.value,
      wrapper.message,
      String(wrapper),
      JSON.stringify(wrapper),
      inspect(wrapper, { depth: 12 }),
      inspect(wrapper.cause, { depth: 12 }),
      Cause.pretty(exit.cause),
      JSON.stringify(exit.cause),
      inspect(exit.cause, { depth: 12 }),
    ];
    for (const secret of [...lookupSecrets, matcherSecret]) {
      for (const surface of surfaces) expect(surface).not.toContain(secret);
    }
  });

  test('preserves mixed Cause topology and terminal identity while redacting matcher Fail payloads', async () => {
    for (const target of ['matcher', 'operation'] as const) {
      for (const topology of ['Parallel', 'Sequential'] as const) {
        for (const terminal of ['Die', 'Interrupt'] as const) {
          const failure = Object.freeze({ target, topology, terminal });
          const defect = Object.freeze({ defect: `${target}-${topology}` });
          const interruptor = FiberId.make(71, 13);
          const terminalCause =
            terminal === 'Die'
              ? Cause.die(defect)
              : Cause.interrupt(interruptor);
          const cause =
            topology === 'Parallel'
              ? Cause.parallel(Cause.fail(failure), terminalCause)
              : Cause.sequential(Cause.fail(failure), terminalCause);
          const failurePluginId =
            `external-pr-cause-${target}-${topology}-${terminal}`.toLowerCase();
          const capability: AidePullRequestProviderCapability = {
            providerId,
            priority: 100,
            features: {},
            authStatus: () => Effect.succeed({ state: 'configured' }),
            matchRemote: () => null,
            matchRepository: () =>
              target === 'matcher'
                ? Effect.failCause(cause)
                : Effect.succeed({ source: 'repository-ref', repository }),
            matchPullRequestUrl: () => null,
            operations: {
              listPullRequests: () =>
                target === 'operation'
                  ? Effect.failCause(cause)
                  : Effect.succeed({ repository, pullRequests: [] }),
            },
          };
          const registry = createKeyringCommandRegistry();
          registry.registerExternalPlugin(
            definePublicAidePlugin({
              id: failurePluginId,
              summary: 'PR mixed Cause fixture',
              commands: [],
              capabilities: { pullRequestProvider: capability },
            }),
            { manifest: { ...manifest(), id: failurePluginId } }
          );
          const services = createAideHostServices(registry);
          const program: Effect.Effect<unknown, unknown> =
            target === 'matcher'
              ? services.resolvePullRequestProviderForRepositoryInput({
                  providerId,
                })
              : services.listPullRequestsForRepository(repository);
          const exit = await Effect.runPromiseExit(program);

          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isSuccess(exit)) throw new Error('expected mixed Cause');
          expect(exit.cause._tag).toBe(topology);
          if (
            exit.cause._tag !== 'Parallel' &&
            exit.cause._tag !== 'Sequential'
          ) {
            throw new Error('expected composed Cause');
          }
          expect(exit.cause.left._tag).toBe('Fail');
          if (exit.cause.left._tag !== 'Fail') {
            throw new Error('expected Fail leaf');
          }
          const wrapper = exit.cause.left.error;
          expect(wrapper).toBeInstanceOf(
            target === 'matcher'
              ? PullRequestProviderInvocationError
              : PullRequestProviderOperationError
          );
          const wrapperCause = (wrapper as { cause: unknown }).cause;
          if (target === 'matcher') {
            expect(wrapperCause).not.toBe(failure);
            expect(wrapperCause).toBeInstanceOf(Error);
            expect((wrapperCause as Error).message).toBe(
              'Pull request provider matcher failed'
            );
          } else {
            expect(wrapperCause).toBe(failure);
          }
          expect((wrapper as Error).message).toBe(
            target === 'matcher'
              ? `Pull request provider '${providerId}' from plugin '${failurePluginId}' failed while matching repository-ref provider=${providerId}`
              : `Pull request provider '${providerId}' from plugin '${failurePluginId}' failed during listPullRequests`
          );
          expect(exit.cause.right._tag).toBe(terminal);
          if (exit.cause.right._tag === 'Die') {
            expect(exit.cause.right.defect).toBe(defect);
          } else if (exit.cause.right._tag === 'Interrupt') {
            expect(exit.cause.right.fiberId).toBe(interruptor);
          } else {
            throw new Error('expected terminal Cause leaf');
          }
        }
      }
    }
  });

  test('preserves every arbitrary metadata string key and value on matcher and operation paths', async () => {
    const harness = registryHarness();
    for (const target of ['matcher', 'operation'] as const) {
      const metadata = arbitraryMetadata();
      const source = sourceRepository(metadata);
      if (target === 'matcher') {
        harness.matcherValues.matchRemote = {
          source: 'git-remote',
          repository: source,
        };
      } else {
        harness.values.listPullRequests = {
          repository: source,
          pullRequests: [],
        };
      }
      const result = await Effect.runPromise(
        target === 'matcher'
          ? matcherCases[0]!.invoke(harness)
          : harness.services.listPullRequestsForRepository(source)
      );
      const captured =
        target === 'matcher'
          ? (result as { match: { repository: { metadata: object } } }).match
              .repository.metadata
          : (result as { repository: { metadata: object } }).repository
              .metadata;
      expect(Object.getPrototypeOf(captured)).toBeNull();
      expect(Reflect.ownKeys(captured)).toEqual([
        '__proto__',
        'constructor',
        '',
        'ordinary',
      ]);
      expect(
        Object.getOwnPropertyDescriptor(captured, '__proto__')?.value
      ).toBe('legitimate');
      expect(
        Object.getOwnPropertyDescriptor(captured, 'constructor')?.value
      ).toBe(42);
      expect(Object.getOwnPropertyDescriptor(captured, '')?.value).toBe(false);
      expect(Object.getOwnPropertyDescriptor(captured, 'ordinary')?.value).toBe(
        true
      );
      expect(Object.isFrozen(captured)).toBe(true);
      metadata.ordinary = false;
      expect(Object.getOwnPropertyDescriptor(captured, 'ordinary')?.value).toBe(
        true
      );
    }
  });

  test('keeps optional undefined metadata compatible on matcher and operation paths', async () => {
    const harness = registryHarness();
    const repositoryWithUndefinedMetadata = {
      kind: 'external' as const,
      providerId,
      displayName: 'Capture fixture',
      metadata: undefined,
    };
    harness.matcherValues.matchRemote = {
      source: 'git-remote',
      repository: repositoryWithUndefinedMetadata,
    };
    const matched = (await Effect.runPromise(
      matcherCases[0]!.invoke(harness)
    )) as {
      match: { repository: object };
    };
    expect(Object.hasOwn(matched.match.repository, 'metadata')).toBe(false);

    harness.values.listPullRequests = {
      repository: repositoryWithUndefinedMetadata,
      pullRequests: [],
    };
    const operated = (await Effect.runPromise(
      operationCases[0]!.invoke(harness)
    )) as { repository: object };
    expect(Object.hasOwn(operated.repository, 'metadata')).toBe(false);
  });

  test('rejects every malformed provider feature value on direct acquisition with fixed fresh failures', async () => {
    let reads = 0;
    let traps = 0;
    const accessorFeatures = Object.create(null);
    Object.defineProperty(accessorFeatures, 'draftPullRequests', {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error('SECRET-FEATURE-ACCESSOR');
      },
    });
    const proxyFeatureValue = new Proxy(
      {},
      {
        get() {
          traps += 1;
          throw new Error('SECRET-FEATURE-PROXY');
        },
        getPrototypeOf() {
          traps += 1;
          throw new Error('SECRET-FEATURE-PROXY');
        },
      }
    );
    const malformed = [
      { draftPullRequests: 'yes' },
      { reviewComments: null },
      { threadedComments: 1 },
      accessorFeatures,
      { enterpriseHosts: proxyFeatureValue },
    ];
    for (const features of malformed) {
      const capability = {
        providerId,
        priority: 100,
        features,
        authStatus: () => Effect.succeed({ state: 'configured' }),
        matchRemote: () => validMatcherResult('matchRemote'),
        matchPullRequestUrl: () => null,
      } as unknown as AidePullRequestProviderCapability;
      const providers = [{ pluginId, capability }];
      const first = await expectStructuralFailure(
        resolvePullRequestProviderForRemote(
          providers,
          'ssh://capture/repo.git'
        ),
        InvalidPullRequestProviderMatchError,
        'SECRET-FEATURE'
      );
      const second = await expectStructuralFailure(
        resolvePullRequestProviderForRemote(
          providers,
          'ssh://capture/repo.git'
        ),
        InvalidPullRequestProviderMatchError,
        'SECRET-FEATURE'
      );
      expect(first).not.toBe(second);
      expect((first as InvalidPullRequestProviderMatchError).reason).toBe(
        'match result failed structural capture'
      );
    }
    expect(reads).toBe(0);
    expect(traps).toBe(0);
  });

  test('does not read an accessor-backed feature container during direct acquisition', async () => {
    let reads = 0;
    const capability = {
      providerId,
      priority: 100,
      authStatus: () => Effect.succeed({ state: 'configured' }),
      matchRemote: () => validMatcherResult('matchRemote'),
      matchPullRequestUrl: () => null,
    } as Record<string, unknown>;
    Object.defineProperty(capability, 'features', {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error('SECRET-FEATURE-CONTAINER');
      },
    });
    const failure = await expectStructuralFailure(
      resolvePullRequestProviderForRemote(
        [{ pluginId, capability: capability as never }],
        'ssh://capture/repo.git'
      ),
      InvalidPullRequestProviderMatchError,
      'SECRET-FEATURE-CONTAINER'
    );
    expect((failure as InvalidPullRequestProviderMatchError).reason).toBe(
      'match result failed structural capture'
    );
    expect(reads).toBe(0);
  });

  test('keeps explicit undefined optional features compatible on direct acquisition', async () => {
    const capability = {
      providerId,
      priority: 100,
      features: {
        draftPullRequests: undefined,
        reviewComments: undefined,
        threadedComments: undefined,
        enterpriseHosts: undefined,
      },
      authStatus: () => Effect.succeed({ state: 'configured' }),
      matchRemote: () => validMatcherResult('matchRemote'),
      matchPullRequestUrl: () => null,
    } as unknown as AidePullRequestProviderCapability;
    const resolved = await Effect.runPromise(
      resolvePullRequestProviderForRemote(
        [{ pluginId, capability }],
        'ssh://capture/repo.git'
      )
    );
    expect(resolved.features).toEqual({});
    expect(Object.isFrozen(resolved.features)).toBe(true);
  });

  test('requires the public feature container on direct acquisition and rejects it atomically at external registration', async () => {
    for (const mode of ['missing', 'own-undefined'] as const) {
      const makeCapability = () => {
        const capability = capabilityHarness().capability as unknown as Record<
          string,
          unknown
        >;
        if (mode === 'missing') {
          Reflect.deleteProperty(capability, 'features');
        } else {
          Object.defineProperty(capability, 'features', {
            configurable: true,
            enumerable: true,
            writable: true,
            value: undefined,
          });
        }
        return capability;
      };

      const directFailures = [];
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const capability = makeCapability();
        directFailures.push(
          await expectStructuralFailure(
            resolvePullRequestProviderForRemote(
              [{ pluginId, capability: capability as never }],
              'ssh://capture/repo.git'
            ),
            InvalidPullRequestProviderMatchError
          )
        );
      }
      expect(directFailures).toHaveLength(2);
      expect(directFailures[0]).not.toBe(directFailures[1]);

      const registrationFailures: unknown[] = [];
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const registry = createKeyringCommandRegistry();
        const capability = makeCapability();
        try {
          registry.registerExternalPlugin(
            definePublicAidePlugin({
              id: `${pluginId}-${mode}-${attempt}`,
              summary: 'Missing PR feature container fixture',
              commands: [],
              capabilities: {
                pullRequestProvider: capability as never,
              },
            }),
            {
              manifest: {
                ...manifest(),
                id: `${pluginId}-${mode}-${attempt}`,
              },
            }
          );
          throw new Error('expected external feature-container rejection');
        } catch (error) {
          registrationFailures.push(error);
          expect(error).toBeInstanceOf(Error);
          expect((error as Error).message).toBe(
            'External plugin metadata capture failed'
          );
        }
        expect(registry.plugins()).toEqual([]);
      }
      expect(registrationFailures).toHaveLength(2);
      expect(registrationFailures[0]).not.toBe(registrationFailures[1]);
    }
  });

  test('enforces exact optional feature booleans through a real registry and host', async () => {
    const harness = registryHarness();
    const resolved = (await Effect.runPromise(
      matcherCases[0]!.invoke(harness)
    )) as { features: Record<string, unknown> };
    expect(resolved.features).toEqual({
      draftPullRequests: true,
      reviewComments: true,
      threadedComments: true,
      enterpriseHosts: true,
    });
    expect(Object.isFrozen(resolved.features)).toBe(true);

    for (const value of ['yes', null, 1]) {
      const failures: unknown[] = [];
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const registry = createKeyringCommandRegistry();
        const badPluginId = `bad-feature-${String(value)}-${attempt}`;
        const badCapability = {
          providerId: `${providerId}-${String(value)}-${attempt}`,
          priority: 100,
          features: { draftPullRequests: value },
          authStatus: () => Effect.succeed({ state: 'configured' }),
          matchRemote: () => null,
          matchPullRequestUrl: () => null,
        } as unknown as AidePullRequestProviderCapability;
        try {
          registry.registerExternalPlugin(
            definePublicAidePlugin({
              id: badPluginId,
              summary: 'Malformed feature fixture',
              commands: [],
              capabilities: { pullRequestProvider: badCapability },
            }),
            {
              manifest: {
                ...manifest(),
                id: badPluginId,
              },
            }
          );
          throw new Error('expected malformed feature rejection');
        } catch (error) {
          failures.push(error);
          expect(error).toBeInstanceOf(Error);
          expect((error as Error).message).toBe(
            'External plugin metadata capture failed'
          );
        }
        expect(registry.plugins()).toEqual([]);
      }
      expect(failures).toHaveLength(2);
      expect(failures[0]).not.toBe(failures[1]);
    }

    let reads = 0;
    let traps = 0;
    const accessorFeatures = Object.create(null);
    Object.defineProperty(accessorFeatures, 'draftPullRequests', {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error('SECRET-REGISTRY-FEATURE-ACCESSOR');
      },
    });
    const proxyFeatureValue = new Proxy(
      {},
      {
        get() {
          traps += 1;
          throw new Error('SECRET-REGISTRY-FEATURE-PROXY');
        },
        getPrototypeOf() {
          traps += 1;
          throw new Error('SECRET-REGISTRY-FEATURE-PROXY');
        },
      }
    );
    for (const [suffix, features] of [
      ['accessor', accessorFeatures],
      ['proxy', { draftPullRequests: proxyFeatureValue }],
    ] as const) {
      const failures: unknown[] = [];
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const registry = createKeyringCommandRegistry();
        const badPluginId = `bad-hostile-feature-${suffix}`;
        const badCapability = {
          providerId: `${providerId}-${suffix}`,
          priority: 100,
          features,
          authStatus: () => Effect.succeed({ state: 'configured' }),
          matchRemote: () => null,
          matchPullRequestUrl: () => null,
        } as unknown as AidePullRequestProviderCapability;
        try {
          registry.registerExternalPlugin(
            definePublicAidePlugin({
              id: badPluginId,
              summary: 'Hostile feature fixture',
              commands: [],
              capabilities: { pullRequestProvider: badCapability },
            }),
            {
              manifest: {
                ...manifest(),
                id: badPluginId,
              },
            }
          );
          throw new Error('expected hostile feature rejection');
        } catch (error) {
          failures.push(error);
          expect(error).toBeInstanceOf(Error);
          expect((error as Error).message).toBe(
            'External plugin metadata capture failed'
          );
          expect(String(error)).not.toContain('SECRET-REGISTRY-FEATURE');
        }
        expect(registry.plugins()).toEqual([]);
      }
      expect(failures[0]).not.toBe(failures[1]);
    }
    expect(reads).toBe(0);
    expect(traps).toBe(0);
  });

  test('routes every non-null matcher value through structural capture and keeps null as no-match', async () => {
    const malformed = [
      undefined,
      1,
      'match',
      true,
      Symbol('match'),
      () => null,
    ];
    for (const matcher of matcherCases) {
      for (const value of malformed) {
        const harness = registryHarness();
        setCaseValue(harness, matcher.name, value);
        const failure = await expectStructuralFailure(
          matcher.invoke(harness),
          InvalidPullRequestProviderMatchError
        );
        expect((failure as InvalidPullRequestProviderMatchError).reason).toBe(
          'match result failed structural capture'
        );
      }
      const harness = registryHarness();
      setCaseValue(harness, matcher.name, null);
      const exit = await Effect.runPromiseExit(matcher.invoke(harness));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isSuccess(exit)) throw new Error('expected no-match failure');
      const failure = Cause.failureOption(exit.cause);
      expect(Option.isSome(failure)).toBe(true);
      if (Option.isSome(failure)) {
        expect(failure.value).toBeInstanceOf(
          UnsupportedPullRequestProviderError
        );
      }
    }
  });

  test('reproduces comment 195 through a real external registry and keeps state atomic', async () => {
    const attacker = new Error('SECRET-PR-RESULT-GETTER');
    let traps = 0;
    const harness = registryHarness();
    harness.values.listPullRequests = new Proxy(
      {},
      {
        get() {
          traps += 1;
          throw attacker;
        },
      }
    );
    const pluginCount = harness.registry.plugins().length;
    const failure = await expectStructuralFailure(
      operationCases[0]!.invoke(harness),
      InvalidPullRequestProviderOperationResultError,
      attacker.message,
      attacker
    );
    expect(traps).toBe(0);
    expect(harness.registry.plugins().length).toBe(pluginCount);
    expect(
      (failure as InvalidPullRequestProviderOperationResultError).reason
    ).toBe('operation result failed structural capture');

    harness.values.listPullRequests = validOperationResult('listPullRequests');
    await Effect.runPromise(operationCases[0]!.invoke(harness));
    expect(harness.registry.plugins().length).toBe(pluginCount);
  });

  for (const testCase of allCases) {
    test(`${testCase.name} returns fresh recursively frozen detached snapshots`, async () => {
      const harness = registryHarness();
      const source = validCaseValue(testCase.name);
      setCaseValue(harness, testCase.name, source);
      const first = await Effect.runPromise(testCase.invoke(harness));
      const second = await Effect.runPromise(testCase.invoke(harness));
      expect(recursivelyFrozen(first)).toBe(true);
      expect(recursivelyFrozen(second)).toBe(true);
      expect(first).not.toBe(second);
      if (testCase.name.startsWith('match')) {
        expect((first as { match: unknown }).match).not.toBe(source);
      } else {
        expect(first).not.toBe(source);
      }
    });

    test(`${testCase.name} rejects top-level and nested accessors without reads`, async () => {
      const harness = registryHarness();
      let reads = 0;
      const top = Object.create(null) as Record<string, unknown>;
      Object.defineProperty(top, 'repository', {
        enumerable: true,
        get() {
          reads += 1;
          throw new Error('SECRET-TOP-ACCESSOR');
        },
      });
      setCaseValue(harness, testCase.name, top);
      await expectStructuralFailure(
        testCase.invoke(harness),
        expectedError(testCase.name),
        'SECRET-TOP-ACCESSOR'
      );

      const nested = sourceRepository() as Record<string, unknown>;
      Object.defineProperty(nested, 'displayName', {
        enumerable: true,
        get() {
          reads += 1;
          throw new Error('SECRET-NESTED-ACCESSOR');
        },
      });
      setCaseValue(harness, testCase.name, {
        ...validCaseValue(testCase.name),
        repository: nested,
      });
      await expectStructuralFailure(
        testCase.invoke(harness),
        expectedError(testCase.name),
        'SECRET-NESTED-ACCESSOR'
      );
      expect(reads).toBe(0);
    });

    test(`${testCase.name} rejects live/revoked top-level and nested Proxies without traps`, async () => {
      const harness = registryHarness();
      const attacker = new Error(`SECRET-${testCase.name}-PROXY`);
      let traps = 0;
      const handler: ProxyHandler<object> = {
        get() {
          traps += 1;
          throw attacker;
        },
        ownKeys() {
          traps += 1;
          throw attacker;
        },
        getPrototypeOf() {
          traps += 1;
          throw attacker;
        },
        getOwnPropertyDescriptor() {
          traps += 1;
          throw attacker;
        },
      };
      setCaseValue(harness, testCase.name, new Proxy({}, handler));
      await expectStructuralFailure(
        testCase.invoke(harness),
        expectedError(testCase.name),
        attacker.message,
        attacker
      );
      const revoked = Proxy.revocable({}, handler);
      revoked.revoke();
      setCaseValue(harness, testCase.name, revoked.proxy);
      await expectStructuralFailure(
        testCase.invoke(harness),
        expectedError(testCase.name)
      );
      setCaseValue(harness, testCase.name, {
        ...validCaseValue(testCase.name),
        repository: new Proxy(sourceRepository(), handler),
      });
      await expectStructuralFailure(
        testCase.invoke(harness),
        expectedError(testCase.name),
        attacker.message,
        attacker
      );
      expect(traps).toBe(0);
    });

    test(`${testCase.name} rejects inheritance, symbols, unknown keys, and callable scalars`, async () => {
      const harness = registryHarness();
      const source = validCaseValue(testCase.name);
      setCaseValue(harness, testCase.name, Object.create(source));
      await expectStructuralFailure(
        testCase.invoke(harness),
        expectedError(testCase.name)
      );

      const unknown = { ...source, attackerControlledUnknownKey: true };
      Object.defineProperty(unknown, Symbol('attacker'), { value: true });
      setCaseValue(harness, testCase.name, unknown);
      await expectStructuralFailure(
        testCase.invoke(harness),
        expectedError(testCase.name)
      );

      let calls = 0;
      const callback = () => {
        calls += 1;
        return 'external';
      };
      setCaseValue(harness, testCase.name, {
        ...source,
        repository: {
          kind: callback,
          providerId,
          displayName: 'Malformed repository',
        },
      });
      await expectStructuralFailure(
        testCase.invoke(harness),
        expectedError(testCase.name)
      );
      expect(calls).toBe(0);
    });
  }

  const arrayCases: readonly {
    readonly name: OperationName;
    readonly set: (result: Record<string, unknown>, value: unknown[]) => void;
  }[] = [
    {
      name: 'listPullRequests',
      set: (result, value) => void (result.pullRequests = value),
    },
    {
      name: 'getPullRequest',
      set: (result, value) =>
        void ((result.pullRequest as Record<string, unknown>).labels = value),
    },
    {
      name: 'createPullRequest',
      set: (result, value) => void (result.warnings = value),
    },
    {
      name: 'updatePullRequest',
      set: (result, value) => void (result.warnings = value),
    },
    {
      name: 'getPullRequestDiff',
      set: (result, value) => void (result.files = value),
    },
    {
      name: 'listPullRequestComments',
      set: (result, value) => void (result.threads = value),
    },
    {
      name: 'addPullRequestComment',
      set: (result, value) =>
        void (result.thread = { id: threadId, replies: value }),
    },
    {
      name: 'replyToPullRequestComment',
      set: (result, value) =>
        void ((result.thread as Record<string, unknown>).replies = value),
    },
    {
      name: 'findPullRequestForBranch',
      set: (result, value) =>
        void ((result.pullRequest as Record<string, unknown>).labels = value),
    },
  ];

  for (const arrayCase of arrayCases) {
    test(`${arrayCase.name} rejects sparse, custom-prototype, and oversized arrays`, async () => {
      const harness = registryHarness();
      const operation = operationCases.find(
        (entry) => entry.name === arrayCase.name
      )!;
      const sparse: unknown[] = [];
      sparse.length = 2;
      sparse[1] = 'entry';
      let result = validOperationResult(arrayCase.name);
      arrayCase.set(result, sparse);
      harness.values[arrayCase.name] = result;
      await expectStructuralFailure(
        operation.invoke(harness),
        InvalidPullRequestProviderOperationResultError
      );

      const custom = ['entry'];
      Object.setPrototypeOf(custom, Object.create(Array.prototype));
      result = validOperationResult(arrayCase.name);
      arrayCase.set(result, custom);
      harness.values[arrayCase.name] = result;
      await expectStructuralFailure(
        operation.invoke(harness),
        InvalidPullRequestProviderOperationResultError
      );

      result = validOperationResult(arrayCase.name);
      const oversized: unknown[] = [];
      oversized.length = 1_001;
      arrayCase.set(result, oversized);
      harness.values[arrayCase.name] = result;
      await expectStructuralFailure(
        operation.invoke(harness),
        InvalidPullRequestProviderOperationResultError
      );
    });
  }

  test('enforces exact array and record ceilings', async () => {
    const harness = registryHarness();
    const listCase = operationCases.find(
      (entry) => entry.name === 'listPullRequests'
    )!;
    harness.values.listPullRequests = {
      repository: sourceRepository(),
      pullRequests: Array.from({ length: 1_000 }, listItem),
    };
    const result = await Effect.runPromise(listCase.invoke(harness));
    expect(
      (result as { pullRequests: readonly unknown[] }).pullRequests
    ).toHaveLength(1_000);
    harness.values.listPullRequests = {
      repository: sourceRepository(),
      pullRequests: Array.from({ length: 1_001 }, listItem),
    };
    await expectStructuralFailure(
      listCase.invoke(harness),
      InvalidPullRequestProviderOperationResultError
    );

    const metadata = Object.fromEntries(
      Array.from({ length: 128 }, (_, index) => [`key${index}`, index])
    );
    const matcher = matcherCases[0]!;
    harness.matcherValues.matchRemote = {
      source: 'git-remote',
      repository: sourceRepository(metadata),
    };
    await Effect.runPromise(matcher.invoke(harness));
    metadata.key128 = 128;
    harness.matcherValues.matchRemote = {
      source: 'git-remote',
      repository: sourceRepository(metadata),
    };
    await expectStructuralFailure(
      matcher.invoke(harness),
      InvalidPullRequestProviderMatchError
    );
  });

  test('enforces exact depth, node, individual-string, and cumulative-string ceilings', async () => {
    const harness = registryHarness();
    const listCase = operationCases[0]!;
    harness.values.listPullRequests = {
      repository: sourceRepository(),
      repositoryLabel: 'x'.repeat(65_536),
      pullRequests: [],
    };
    await Effect.runPromise(listCase.invoke(harness));
    harness.values.listPullRequests = {
      repository: sourceRepository(),
      repositoryLabel: 'x'.repeat(65_537),
      pullRequests: [],
    };
    await expectStructuralFailure(
      listCase.invoke(harness),
      InvalidPullRequestProviderOperationResultError
    );

    const commentsCase = operationCases.find(
      (entry) => entry.name === 'listPullRequestComments'
    )!;
    const threads = Array.from({ length: 1_000 }, (_, index) => {
      const replies = [comment(), comment()];
      if (index < 427) replies.push(comment());
      if (index < 3) {
        (
          replies[0] as ReturnType<typeof comment> & {
            providerType?: string;
          }
        ).providerType = 'budget';
      }
      return { id: index + 1, replies };
    });
    const exactNodes = {
      repository: sourceRepository(),
      pullRequest,
      threads,
    };
    expect(capturedNodeCount(exactNodes)).toBe(20_000);
    expect(capturedDepth(exactNodes)).toBeLessThanOrEqual(8);
    harness.values.listPullRequestComments = exactNodes;
    await Effect.runPromise(commentsCase.invoke(harness));
    (
      threads[3]!.replies[0] as ReturnType<typeof comment> & {
        providerType?: string;
      }
    ).providerType = 'overflow';
    expect(capturedNodeCount(exactNodes)).toBe(20_001);
    await expectStructuralFailure(
      commentsCase.invoke(harness),
      InvalidPullRequestProviderOperationResultError
    );

    const createCase = operationCases.find(
      (entry) => entry.name === 'createPullRequest'
    )!;
    const warnings = Array.from({ length: 17 }, () => '');
    const exactStrings = {
      ...validOperationResult('createPullRequest'),
      warnings,
    };
    let remaining = 1_048_576 - capturedStringUnits(exactStrings);
    for (let index = 0; index < warnings.length && remaining > 0; index += 1) {
      const length = Math.min(65_536, remaining);
      warnings[index] = 'x'.repeat(length);
      remaining -= length;
    }
    expect(remaining).toBe(0);
    expect(capturedStringUnits(exactStrings)).toBe(1_048_576);
    harness.values.createPullRequest = exactStrings;
    await Effect.runPromise(createCase.invoke(harness));
    const lastFilled = warnings.findLastIndex((value) => value.length > 0);
    expect(warnings[lastFilled]!.length).toBeLessThan(65_536);
    warnings[lastFilled] += 'x';
    await expectStructuralFailure(
      createCase.invoke(harness),
      InvalidPullRequestProviderOperationResultError
    );
  });

  test('copies aliases deterministically, rejects cycles, and never invokes callbacks', async () => {
    const harness = registryHarness();
    const shared = comment();
    harness.values.replyToPullRequestComment = {
      repository: sourceRepository(),
      pullRequest,
      comment: shared,
      thread: { id: threadId, replies: [shared] },
    };
    const replyCase = operationCases.find(
      (entry) => entry.name === 'replyToPullRequestComment'
    )!;
    const result = (await Effect.runPromise(replyCase.invoke(harness))) as {
      comment: unknown;
      thread: { replies: readonly unknown[] };
    };
    expect(result.comment).not.toBe(result.thread.replies[0]);
    expect(recursivelyFrozen(result)).toBe(true);

    const metadata: Record<string, unknown> = {};
    metadata.self = metadata;
    harness.values.replyToPullRequestComment = {
      ...validOperationResult('replyToPullRequestComment'),
      repository: {
        kind: 'external',
        providerId,
        displayName: 'Cycle',
        metadata,
      },
    };
    await expectStructuralFailure(
      replyCase.invoke(harness),
      InvalidPullRequestProviderOperationResultError
    );

    let calls = 0;
    harness.values.replyToPullRequestComment = {
      ...validOperationResult('replyToPullRequestComment'),
      repositoryLabel: () => {
        calls += 1;
        return 'attacker';
      },
    };
    await expectStructuralFailure(
      replyCase.invoke(harness),
      InvalidPullRequestProviderOperationResultError
    );
    expect(calls).toBe(0);
  });

  test('returns fresh fixed errors for repeated structural faults', async () => {
    const harness = registryHarness();
    harness.values.listPullRequests = new Proxy({}, {});
    const first = await expectStructuralFailure(
      operationCases[0]!.invoke(harness),
      InvalidPullRequestProviderOperationResultError
    );
    const second = await expectStructuralFailure(
      operationCases[0]!.invoke(harness),
      InvalidPullRequestProviderOperationResultError
    );
    expect(first).not.toBe(second);
    expect(
      (first as InvalidPullRequestProviderOperationResultError).reason
    ).toBe('operation result failed structural capture');
    expect(
      (second as InvalidPullRequestProviderOperationResultError).reason
    ).toBe('operation result failed structural capture');
  });
});
