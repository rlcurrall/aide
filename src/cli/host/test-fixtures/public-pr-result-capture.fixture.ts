import { Cause, Effect, Exit, Option } from 'effect';

import {
  AIDE_PLUGIN_API_VERSION,
  defineAidePlugin as definePublicAidePlugin,
} from '@aide/plugin-api';
import { createKeyringCommandRegistry } from '@cli/host/command-registry.js';
import type { AidePullRequestProviderCapability } from '@cli/host/plugin-descriptor.js';
import {
  AmbiguousPullRequestProviderError,
  addPullRequestCommentForRepository,
  createPullRequestForRepository,
  findPullRequestForBranchForRepository,
  getPullRequestDiffForRepository,
  getPullRequestForRepository,
  getPullRequestForRemote,
  listPullRequestCommentsForRepository,
  listPullRequestsForRepository,
  replyToPullRequestCommentForRepository,
  resolvePullRequestProviderForRemote,
  updatePullRequestForRepository,
} from '@cli/host/pull-request-provider-resolver.js';
import { createAideHostServices } from '@cli/host/runtime-context.js';

type LegacyMode =
  | 'proxy-ownkeys'
  | 'proxy-prototype'
  | 'iterator-accessor'
  | 'custom-prototype-iterator'
  | 'matcher-failure-accessor'
  | 'matcher-failure-proxy'
  | 'operation-failure-accessor'
  | 'operation-failure-proxy';

type PrototypeBehavior = 'returning' | 'throwing' | 'slow';
type ProviderContinuationOperation = 'filter' | 'iterator' | 'sort' | 'map';
type ProviderContinuationCase =
  | 'preferred-filter'
  | 'iterator'
  | 'sort'
  | 'tie-filter'
  | 'map'
  | 'operation-filter-remote'
  | 'operation-filter-repository';
type ArrayPrototypeHook =
  | 'numeric-setter'
  | 'iterator-accessor'
  | 'method-accessor';
type OperationArrayCaseName =
  | 'list.pullRequests'
  | 'get.labels'
  | 'create.labels'
  | 'create.warnings'
  | 'update.labels'
  | 'update.warnings'
  | 'diff.labels'
  | 'diff.files'
  | 'comments.threads'
  | 'comments.replies'
  | 'add.replies'
  | 'reply.replies'
  | 'branch.labels';
type FeatureKey =
  | 'draftPullRequests'
  | 'reviewComments'
  | 'threadedComments'
  | 'enterpriseHosts';

type SchemaGetterMode = 'returning' | 'throwing' | 'slow';
type SchemaPath =
  | 'root-field'
  | 'nested-field'
  | 'variant'
  | 'required-optional'
  | 'control';
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
type SchemaCaseName = 'features' | MatcherName | OperationName;

const matcherNames = [
  'matchRemote',
  'matchRepository',
  'matchPullRequestUrl',
] as const satisfies readonly MatcherName[];
const operationNames = [
  'listPullRequests',
  'getPullRequest',
  'createPullRequest',
  'updatePullRequest',
  'getPullRequestDiff',
  'listPullRequestComments',
  'addPullRequestComment',
  'replyToPullRequestComment',
  'findPullRequestForBranch',
] as const satisfies readonly OperationName[];
const schemaCases = [
  'features',
  ...matcherNames,
  ...operationNames,
] as const satisfies readonly SchemaCaseName[];
const nestedSchemaCases = [
  ...matcherNames,
  ...operationNames,
] as const satisfies readonly SchemaCaseName[];
const operationArrayCaseNames = [
  'list.pullRequests',
  'get.labels',
  'create.labels',
  'create.warnings',
  'update.labels',
  'update.warnings',
  'diff.labels',
  'diff.files',
  'comments.threads',
  'comments.replies',
  'add.replies',
  'reply.replies',
  'branch.labels',
] as const satisfies readonly OperationArrayCaseName[];
const featureKeys = [
  'draftPullRequests',
  'reviewComments',
  'threadedComments',
  'enterpriseHosts',
] as const satisfies readonly FeatureKey[];
const arrayPrototypeProbeLength = 998;
const arrayPrototypeProbeIndex = arrayPrototypeProbeLength - 1;
const repositoryMetadataProbeKey = '__aide_pr_capture_metadata__';

const providerId = 'deadline-pr-capture';
const pullRequest = Object.freeze({ number: 7 });
const branch = 'feature/schema-capture';
const threadId = 12;

function hang(): never {
  for (;;) {
    // A hard-deadline parent proves this path is never entered.
  }
}

function sourceRepository(selectedProviderId = providerId) {
  return {
    kind: 'external' as const,
    providerId: selectedProviderId,
    displayName: 'Deadline capture fixture',
    metadata: { [repositoryMetadataProbeKey]: true },
  };
}

function listItem() {
  return {
    id: pullRequest.number,
    title: 'Schema capture pull request',
    status: 'active' as const,
    createdAt: '2026-07-13T00:00:00.000Z',
    author: { displayName: 'Ada Lovelace' },
  };
}

function viewItem() {
  return {
    ...listItem(),
    sourceBranch: branch,
    targetBranch: 'main',
    labels: ['schema'],
  };
}

function comment() {
  return {
    id: 91,
    kind: 'issue' as const,
    author: { displayName: 'Ada Lovelace' },
    body: 'Schema capture comment',
    createdAt: '2026-07-13T00:00:00.000Z',
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
        files: [{ path: 'src/schema.ts', status: 'modified' }],
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

function defineOwnData(
  target: Record<string, unknown>,
  key: string,
  value: unknown
): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    writable: true,
    value,
  });
}

function repositoryFromResult(value: Record<string, unknown>) {
  const descriptor = Reflect.getOwnPropertyDescriptor(value, 'repository');
  if (
    descriptor === undefined ||
    !Object.hasOwn(descriptor, 'value') ||
    typeof descriptor.value !== 'object' ||
    descriptor.value === null
  ) {
    throw new Error('schema fixture result has no repository');
  }
  return descriptor.value as Record<string, unknown>;
}

function prepareSchemaValue(
  name: MatcherName | OperationName,
  path: Exclude<SchemaPath, 'control'>,
  pollutionKey: string
): Record<string, unknown> {
  const value = name.startsWith('match')
    ? validMatcherResult(name as MatcherName)
    : validOperationResult(name as OperationName);
  if (path === 'root-field') {
    defineOwnData(value, pollutionKey, true);
  } else if (path === 'nested-field') {
    defineOwnData(repositoryFromResult(value), pollutionKey, true);
  } else if (path === 'variant') {
    defineOwnData(repositoryFromResult(value), 'kind', pollutionKey);
  }
  return value;
}

function schemaHarness(
  name: SchemaCaseName,
  path: SchemaPath,
  pollutionKey: string,
  attempt: number
) {
  const matcherValues = Object.fromEntries(
    matcherNames.map((matcherName) => [
      matcherName,
      path === 'control' || name !== matcherName
        ? validMatcherResult(matcherName)
        : prepareSchemaValue(matcherName, path, pollutionKey),
    ])
  ) as Record<MatcherName, unknown>;
  const operationValues = Object.fromEntries(
    operationNames.map((operationName) => [
      operationName,
      path === 'control' || name !== operationName
        ? validOperationResult(operationName)
        : prepareSchemaValue(operationName, path, pollutionKey),
    ])
  ) as Record<OperationName, unknown>;
  const capability: AidePullRequestProviderCapability = {
    providerId,
    priority: 100,
    features: {
      draftPullRequests: true,
      reviewComments: true,
      threadedComments: true,
      enterpriseHosts: true,
    },
    authStatus: () => Effect.succeed({ state: 'configured' }),
    matchRemote: () => matcherValues.matchRemote as never,
    matchRepository: () =>
      Effect.succeed(matcherValues.matchRepository as never),
    matchPullRequestUrl: () => matcherValues.matchPullRequestUrl as never,
    operations: {
      listPullRequests: () =>
        Effect.succeed(operationValues.listPullRequests as never),
      getPullRequest: () =>
        Effect.succeed(operationValues.getPullRequest as never),
      createPullRequest: () =>
        Effect.succeed(operationValues.createPullRequest as never),
      updatePullRequest: () =>
        Effect.succeed(operationValues.updatePullRequest as never),
      getPullRequestDiff: () =>
        Effect.succeed(operationValues.getPullRequestDiff as never),
      listPullRequestComments: () =>
        Effect.succeed(operationValues.listPullRequestComments as never),
      addPullRequestComment: () =>
        Effect.succeed(operationValues.addPullRequestComment as never),
      replyToPullRequestComment: () =>
        Effect.succeed(operationValues.replyToPullRequestComment as never),
      findPullRequestForBranch: () =>
        Effect.succeed(operationValues.findPullRequestForBranch as never),
    },
  };
  const pluginId = `schema-capture-${process.pid}-${attempt}`;
  const registry = createKeyringCommandRegistry();
  registry.registerExternalPlugin(
    definePublicAidePlugin({
      id: pluginId,
      summary: 'PR schema capture hard deadline fixture',
      commands: [],
      capabilities: { pullRequestProvider: capability },
    }),
    {
      manifest: {
        id: pluginId,
        version: '1.0.0',
        aidePluginApiVersion: AIDE_PLUGIN_API_VERSION,
        capabilities: ['pull-request-provider'],
      },
    }
  );
  return {
    services: createAideHostServices(registry),
    matcherValues,
    operationValues,
  };
}

function invokeSchemaCase(
  name: SchemaCaseName,
  harness: ReturnType<typeof schemaHarness>
): Effect.Effect<unknown, unknown> {
  const repository = sourceRepository();
  switch (name) {
    case 'features':
    case 'matchRemote':
      return harness.services.resolvePullRequestProviderForRemote(
        'ssh://schema/repo.git'
      );
    case 'matchRepository':
      return harness.services.resolvePullRequestProviderForRepositoryInput({
        providerId,
        repo: 'schema',
      });
    case 'matchPullRequestUrl':
      return harness.services.resolvePullRequestProviderForUrl(
        'https://schema.test/repo/pull/7'
      );
    case 'listPullRequests':
      return harness.services.listPullRequestsForRepository(repository);
    case 'getPullRequest':
      return harness.services.getPullRequestForRepository(repository, {
        pullRequest,
      });
    case 'createPullRequest':
      return harness.services.createPullRequestForRepository(repository, {
        title: 'Schema capture',
        sourceBranch: branch,
        targetBranch: 'main',
      });
    case 'updatePullRequest':
      return harness.services.updatePullRequestForRepository(repository, {
        pullRequest,
        title: 'Updated schema capture',
      });
    case 'getPullRequestDiff':
      return harness.services.getPullRequestDiffForRepository(repository, {
        pullRequest,
      });
    case 'listPullRequestComments':
      return harness.services.listPullRequestCommentsForRepository(repository, {
        pullRequest,
      });
    case 'addPullRequestComment':
      return harness.services.addPullRequestCommentForRepository(repository, {
        pullRequest,
        body: 'Schema capture',
      });
    case 'replyToPullRequestComment':
      return harness.services.replyToPullRequestCommentForRepository(
        repository,
        { pullRequest, threadId, body: 'Schema capture' }
      );
    case 'findPullRequestForBranch':
      return harness.services.findPullRequestForBranchForRepository(
        repository,
        { branch }
      );
  }
}

function descriptorsEqual(
  left: PropertyDescriptor | undefined,
  right: PropertyDescriptor | undefined
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.configurable === right.configurable &&
    left.enumerable === right.enumerable &&
    left.writable === right.writable &&
    Object.is(left.value, right.value) &&
    Object.is(left.get, right.get) &&
    Object.is(left.set, right.set)
  );
}

function failureFromExit(exit: Exit.Exit<unknown, unknown>): unknown {
  if (Exit.isSuccess(exit)) return undefined;
  const failure = Cause.failureOption(exit.cause);
  return Option.isSome(failure) ? failure.value : undefined;
}

function failureTag(failure: unknown): unknown {
  if (typeof failure !== 'object' || failure === null) return undefined;
  const descriptor = Reflect.getOwnPropertyDescriptor(failure, '_tag');
  return descriptor !== undefined && Object.hasOwn(descriptor, 'value')
    ? descriptor.value
    : undefined;
}

function ownCause(failure: unknown): unknown {
  if (typeof failure !== 'object' || failure === null) return undefined;
  const descriptor = Reflect.getOwnPropertyDescriptor(failure, 'cause');
  return descriptor !== undefined && Object.hasOwn(descriptor, 'value')
    ? descriptor.value
    : undefined;
}

function retainsOwnDataIdentity(
  value: unknown,
  target: unknown,
  seen = new Set<object>()
): boolean {
  if (value === target) return true;
  if (typeof value !== 'object' || value === null || seen.has(value)) {
    return false;
  }
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (
      descriptor !== undefined &&
      Object.hasOwn(descriptor, 'value') &&
      retainsOwnDataIdentity(descriptor.value, target, seen)
    ) {
      return true;
    }
  }
  return false;
}

function directFeatureAcquisition(
  features: unknown,
  sequence: number
): Effect.Effect<unknown, unknown> {
  const directPluginId = `schema-feature-direct-${process.pid}-${sequence}`;
  const capability = {
    providerId,
    priority: 100,
    features,
    authStatus: () => Effect.succeed({ state: 'configured' }),
    matchRemote: () => validMatcherResult('matchRemote'),
    matchPullRequestUrl: () => null,
  } as unknown as AidePullRequestProviderCapability;
  return resolvePullRequestProviderForRemote(
    [{ pluginId: directPluginId, capability }],
    'ssh://schema/repo.git'
  );
}

async function runSchemaCase(
  getterMode: SchemaGetterMode,
  path: SchemaPath,
  name: SchemaCaseName,
  sequence: number
) {
  const pollutionKey =
    path === 'required-optional'
      ? 'optional'
      : `__aide_pr_schema_${process.pid}_${sequence}_${path}__`;
  const attempts = [
    schemaHarness(name, path, pollutionKey, sequence * 2),
    schemaHarness(name, path, pollutionKey, sequence * 2 + 1),
  ];
  if (path === 'control') {
    const exit = await Effect.runPromiseExit(
      invokeSchemaCase(name as SchemaCaseName, attempts[0]!)
    );
    return {
      kind: 'success-control' as const,
      name,
      success: Exit.isSuccess(exit),
      getterReads: 0,
      restored: true,
      pollutionKey,
    };
  }

  const previous = Reflect.getOwnPropertyDescriptor(
    Object.prototype,
    pollutionKey
  );
  if (previous?.configurable === false) {
    throw new Error(
      `schema pollution key '${pollutionKey}' is not configurable`
    );
  }
  let getterReads = 0;
  const secret = `SECRET-PR-SCHEMA-${process.pid}-${sequence}`;
  const attacker = new Error(secret);
  let restored = false;
  const exits: Exit.Exit<unknown, unknown>[] = [];
  const candidates: unknown[] = [];
  try {
    Object.defineProperty(Object.prototype, pollutionKey, {
      configurable: true,
      enumerable: false,
      get() {
        getterReads += 1;
        if (getterMode === 'throwing') throw attacker;
        if (getterMode === 'slow') return hang();
        return undefined;
      },
    });
    if (name === 'features' && path === 'root-field') {
      const features = { draftPullRequests: true } as Record<string, unknown>;
      defineOwnData(features, pollutionKey, true);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        candidates.push(features);
        exits.push(
          await Effect.runPromiseExit(
            directFeatureAcquisition(features, sequence * 2 + attempt)
          )
        );
      }
    } else {
      for (const attempt of attempts) {
        candidates.push(
          name.startsWith('match')
            ? attempt.matcherValues[name as MatcherName]
            : attempt.operationValues[name as OperationName]
        );
        exits.push(
          await Effect.runPromiseExit(
            invokeSchemaCase(name as SchemaCaseName, attempt)
          )
        );
      }
    }
  } finally {
    if (previous === undefined) {
      Reflect.deleteProperty(Object.prototype, pollutionKey);
    } else {
      Object.defineProperty(Object.prototype, pollutionKey, previous);
    }
    restored = descriptorsEqual(
      Reflect.getOwnPropertyDescriptor(Object.prototype, pollutionKey),
      previous
    );
  }

  const failures = exits.map(failureFromExit);
  const expectedTag =
    name === 'features' || name.startsWith('match')
      ? 'InvalidPullRequestProviderMatchError'
      : 'InvalidPullRequestProviderOperationResultError';
  const expectsSuccess = path === 'required-optional';
  if (expectsSuccess) {
    return {
      kind: 'success-control' as const,
      name,
      success: exits.length === 2 && exits.every(Exit.isSuccess),
      getterReads,
      restored,
      pollutionKey,
    };
  }

  const failureExits = exits.filter(Exit.isFailure);
  return {
    kind: 'host-boundary-failure' as const,
    name,
    failureCount: failures.filter((failure) => failure !== undefined).length,
    failureTags: failures.map(failureTag),
    expectedTag,
    causeTags: failureExits.map((exit) => exit.cause._tag),
    defects: exits.reduce(
      (count, exit) =>
        count +
        (Exit.isFailure(exit)
          ? Array.from(Cause.defects(exit.cause)).length
          : 0),
      0
    ),
    getterReads,
    attackerRetained:
      failures.some((failure) => failure === attacker) ||
      failureExits.some((exit) => retainsOwnDataIdentity(exit.cause, attacker)),
    attackerCauseRetained: failures.some(
      (failure) => ownCause(failure) === attacker
    ),
    candidateRetained: failureExits.some((exit, index) =>
      retainsOwnDataIdentity(exit.cause, candidates[index])
    ),
    attackerTextRetained:
      failures.some(
        (failure) =>
          failure !== undefined &&
          failure !== attacker &&
          String(failure).includes(secret)
      ) ||
      failureExits.some((exit) => Cause.pretty(exit.cause).includes(secret)),
    fresh: failures.length === 2 && failures[0] !== failures[1],
    restored,
    pollutionKey,
  };
}

async function runSchemaMode(
  getterMode: SchemaGetterMode,
  path: SchemaPath,
  selectedCase: SchemaCaseName | 'all'
) {
  const cases: readonly SchemaCaseName[] =
    selectedCase !== 'all'
      ? [selectedCase]
      : path === 'nested-field' ||
          path === 'variant' ||
          path === 'required-optional'
        ? nestedSchemaCases
        : schemaCases;
  const results = [];
  for (const [index, name] of cases.entries()) {
    results.push(await runSchemaCase(getterMode, path, name, index));
  }
  console.log(
    JSON.stringify({
      mode: 'schema',
      getterMode,
      path,
      results,
    })
  );
}

function ownDataValue(value: object, key: PropertyKey): unknown {
  const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && Object.hasOwn(descriptor, 'value')
    ? descriptor.value
    : undefined;
}

function containsOwnMarker(
  value: unknown,
  marker: string,
  seen = new Set<object>(),
  depth = 0
): boolean {
  if (value === marker) return true;
  if (
    (typeof value !== 'object' && typeof value !== 'function') ||
    value === null ||
    seen.has(value) ||
    depth > 8
  ) {
    return false;
  }
  seen.add(value);
  const keys = Reflect.ownKeys(value);
  for (let index = 0; index < keys.length; index += 1) {
    const key = ownDataValue(keys, String(index));
    if (
      key !== undefined &&
      containsOwnMarker(
        ownDataValue(value, key as PropertyKey),
        marker,
        seen,
        depth + 1
      )
    ) {
      return true;
    }
  }
  return false;
}

function installArrayPrototypeHook(
  hook: ArrayPrototypeHook,
  behavior: PrototypeBehavior,
  marker: string,
  attacker: Error
) {
  const keys: readonly PropertyKey[] =
    hook === 'numeric-setter'
      ? [String(arrayPrototypeProbeIndex)]
      : hook === 'iterator-accessor'
        ? [Symbol.iterator]
        : ['some', 'push'];
  const previous = new Map<PropertyKey, PropertyDescriptor | undefined>();
  let hookCalls = 0;
  let reachabilityCalls = 0;
  let armed = true;
  const attack = () => {
    if (!armed) {
      reachabilityCalls += 1;
      return;
    }
    hookCalls += 1;
    if (behavior === 'throwing') throw attacker;
    if (behavior === 'slow') return hang();
  };

  const isTargetOwnKeysArray = (value: unknown): boolean => {
    if (!Array.isArray(value)) return false;
    const length = ownDataValue(value, 'length');
    const isOperationArrayKeys =
      length === arrayPrototypeProbeLength + 1 &&
      ownDataValue(value, '0') === '0' &&
      ownDataValue(value, String(arrayPrototypeProbeIndex)) ===
        String(arrayPrototypeProbeIndex) &&
      ownDataValue(value, String(arrayPrototypeProbeLength)) === 'length';
    const isRepositoryMetadataKeys =
      length === 1 && ownDataValue(value, '0') === repositoryMetadataProbeKey;
    return isOperationArrayKeys || isRepositoryMetadataKeys;
  };

  for (let index = 0; index < keys.length; index += 1) {
    const key = ownDataValue(keys, String(index)) as PropertyKey;
    const descriptor = Reflect.getOwnPropertyDescriptor(Array.prototype, key);
    previous.set(key, descriptor);
    if (hook === 'numeric-setter') {
      Object.defineProperty(Array.prototype, key, {
        configurable: true,
        set(value) {
          if (
            ownDataValue(this, 'length') === arrayPrototypeProbeIndex &&
            containsOwnMarker(value, marker)
          ) {
            attack();
          }
          Object.defineProperty(this, key, {
            configurable: true,
            enumerable: true,
            writable: true,
            value,
          });
        },
      });
      continue;
    }
    if (
      descriptor === undefined ||
      !Object.hasOwn(descriptor, 'value') ||
      typeof descriptor.value !== 'function'
    ) {
      throw new Error(`array prototype hook '${String(key)}' is unavailable`);
    }
    const original = descriptor.value as (...args: unknown[]) => unknown;
    if (hook === 'iterator-accessor') {
      Object.defineProperty(Array.prototype, key, {
        configurable: true,
        get() {
          if (isTargetOwnKeysArray(this)) attack();
          return original;
        },
      });
      continue;
    }
    Object.defineProperty(Array.prototype, key, {
      configurable: true,
      get() {
        return (...args: unknown[]) => {
          const receiverLength = ownDataValue(this, 'length');
          const isTarget =
            (key === 'some' &&
              receiverLength === arrayPrototypeProbeLength &&
              containsOwnMarker(this, marker)) ||
            (key === 'push' &&
              receiverLength === arrayPrototypeProbeIndex &&
              containsOwnMarker(args, marker));
          if (isTarget) {
            attack();
          }
          return Reflect.apply(original, this, args);
        };
      },
    });
  }

  return {
    calls: () => hookCalls,
    reachabilityCalls: () => reachabilityCalls,
    proveReachable: (source: object) => {
      armed = false;
      if (hook !== 'iterator-accessor') return;
      Reflect.get(Reflect.ownKeys(source), Symbol.iterator);
      Reflect.get(
        Reflect.ownKeys({ [repositoryMetadataProbeKey]: true }),
        Symbol.iterator
      );
    },
    restore: () => {
      for (let index = 0; index < keys.length; index += 1) {
        const key = ownDataValue(keys, String(index)) as PropertyKey;
        const descriptor = previous.get(key);
        if (descriptor === undefined) {
          Reflect.deleteProperty(Array.prototype, key);
        } else {
          Object.defineProperty(Array.prototype, key, descriptor);
        }
      }
      for (let index = 0; index < keys.length; index += 1) {
        const key = ownDataValue(keys, String(index)) as PropertyKey;
        if (
          !descriptorsEqual(
            Reflect.getOwnPropertyDescriptor(Array.prototype, key),
            previous.get(key)
          )
        ) {
          return false;
        }
      }
      return true;
    },
  };
}

function markedListItem(marker: string) {
  return { ...listItem(), title: marker };
}

function markedViewItem(marker: string) {
  return { ...viewItem(), labels: [marker] };
}

function markedComment(marker: string) {
  return { ...comment(), body: marker };
}

function operationForArrayCase(name: OperationArrayCaseName): OperationName {
  if (name.startsWith('list.')) return 'listPullRequests';
  if (name.startsWith('get.')) return 'getPullRequest';
  if (name.startsWith('create.')) return 'createPullRequest';
  if (name.startsWith('update.')) return 'updatePullRequest';
  if (name.startsWith('diff.')) return 'getPullRequestDiff';
  if (name.startsWith('comments.')) return 'listPullRequestComments';
  if (name.startsWith('add.')) return 'addPullRequestComment';
  if (name.startsWith('reply.')) return 'replyToPullRequestComment';
  return 'findPullRequestForBranch';
}

function setOperationArray(
  name: OperationArrayCaseName,
  result: Record<string, unknown>,
  value: unknown[]
): void {
  switch (name) {
    case 'list.pullRequests':
      defineOwnData(result, 'pullRequests', value);
      return;
    case 'get.labels':
    case 'create.labels':
    case 'update.labels':
    case 'diff.labels':
    case 'branch.labels':
      defineOwnData(
        result.pullRequest as Record<string, unknown>,
        'labels',
        value
      );
      return;
    case 'create.warnings':
    case 'update.warnings':
      defineOwnData(result, 'warnings', value);
      return;
    case 'diff.files':
      defineOwnData(result, 'files', value);
      return;
    case 'comments.threads':
      defineOwnData(result, 'threads', value);
      return;
    case 'comments.replies': {
      const threads = result.threads as Record<string, unknown>[];
      defineOwnData(threads[0]!, 'replies', value);
      return;
    }
    case 'add.replies':
      defineOwnData(result, 'thread', { id: threadId, replies: value });
      return;
    case 'reply.replies':
      defineOwnData(result.thread as Record<string, unknown>, 'replies', value);
  }
}

function operationArrayEntry(
  name: OperationArrayCaseName,
  marker: string
): unknown {
  switch (name) {
    case 'list.pullRequests':
      return markedListItem(marker);
    case 'get.labels':
    case 'create.labels':
    case 'update.labels':
    case 'diff.labels':
    case 'create.warnings':
    case 'update.warnings':
    case 'branch.labels':
      return marker;
    case 'diff.files':
      return { path: marker, status: 'modified' };
    case 'comments.threads':
      return { id: marker, replies: [markedComment(marker)] };
    case 'comments.replies':
    case 'add.replies':
    case 'reply.replies':
      return markedComment(marker);
  }
}

function operationArrayCandidate(
  name: OperationArrayCaseName,
  marker: string,
  malformed: boolean
) {
  const operation = operationForArrayCase(name);
  const result = validOperationResult(operation);
  if (name.endsWith('.labels')) {
    defineOwnData(result, 'pullRequest', markedViewItem(marker));
  }
  if (name === 'comments.replies') {
    defineOwnData(result, 'threads', [
      { id: threadId, replies: [markedComment(marker)] },
    ]);
  }
  if (name === 'add.replies') {
    defineOwnData(result, 'thread', {
      id: threadId,
      replies: [markedComment(marker)],
    });
  }
  const array: unknown[] = malformed
    ? []
    : Array.from({ length: arrayPrototypeProbeLength }, (_, index) =>
        operationArrayEntry(
          name,
          index === arrayPrototypeProbeIndex ? marker : '__AIDE_ARRAY_CONTROL__'
        )
      );
  if (malformed) array.length = 1;
  setOperationArray(name, result, array);
  return { operation, result, array };
}

function operationCapability(
  values: Record<OperationName, unknown>
): AidePullRequestProviderCapability {
  return {
    providerId,
    priority: 100,
    features: {},
    authStatus: () => Effect.succeed({ state: 'configured' }),
    matchRemote: () => null,
    matchRepository: () =>
      Effect.succeed({
        source: 'repository-ref',
        repository: sourceRepository(),
      }),
    matchPullRequestUrl: () => null,
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
}

function operationPrototypeHarness(
  name: OperationArrayCaseName,
  marker: string,
  malformed: boolean,
  sequence: number
) {
  const candidate = operationArrayCandidate(name, marker, malformed);
  const values = Object.fromEntries(
    operationNames.map((operation) => [
      operation,
      operation === candidate.operation
        ? candidate.result
        : validOperationResult(operation),
    ])
  ) as Record<OperationName, unknown>;
  const capability = operationCapability(values);
  const pluginId = `prototype-array-${process.pid}-${sequence}`;
  const providers = [{ pluginId, capability }];
  const registry = createKeyringCommandRegistry();
  registry.registerExternalPlugin(
    definePublicAidePlugin({
      id: pluginId,
      summary: 'PR array prototype fixture',
      commands: [],
      capabilities: { pullRequestProvider: capability },
    }),
    {
      manifest: {
        id: pluginId,
        version: '1.0.0',
        aidePluginApiVersion: AIDE_PLUGIN_API_VERSION,
        capabilities: ['pull-request-provider'],
      },
    }
  );
  return {
    candidate,
    providers,
    services: createAideHostServices(registry),
  };
}

function invokeDirectOperation(
  name: OperationName,
  providers: readonly {
    readonly pluginId: string;
    readonly capability: AidePullRequestProviderCapability;
  }[]
): Effect.Effect<unknown, unknown> {
  const repository = sourceRepository();
  switch (name) {
    case 'listPullRequests':
      return listPullRequestsForRepository(providers, repository);
    case 'getPullRequest':
      return getPullRequestForRepository(providers, repository, {
        pullRequest,
      });
    case 'createPullRequest':
      return createPullRequestForRepository(providers, repository, {
        title: 'Prototype array',
        sourceBranch: branch,
        targetBranch: 'main',
      });
    case 'updatePullRequest':
      return updatePullRequestForRepository(providers, repository, {
        pullRequest,
        title: 'Prototype array update',
      });
    case 'getPullRequestDiff':
      return getPullRequestDiffForRepository(providers, repository, {
        pullRequest,
      });
    case 'listPullRequestComments':
      return listPullRequestCommentsForRepository(providers, repository, {
        pullRequest,
      });
    case 'addPullRequestComment':
      return addPullRequestCommentForRepository(providers, repository, {
        pullRequest,
        body: 'Prototype array',
      });
    case 'replyToPullRequestComment':
      return replyToPullRequestCommentForRepository(providers, repository, {
        pullRequest,
        threadId,
        body: 'Prototype array',
      });
    case 'findPullRequestForBranch':
      return findPullRequestForBranchForRepository(providers, repository, {
        branch,
      });
  }
}

function invokeHostOperation(
  name: OperationName,
  services: ReturnType<typeof createAideHostServices>
): Effect.Effect<unknown, unknown> {
  const repository = sourceRepository();
  switch (name) {
    case 'listPullRequests':
      return services.listPullRequestsForRepository(repository);
    case 'getPullRequest':
      return services.getPullRequestForRepository(repository, { pullRequest });
    case 'createPullRequest':
      return services.createPullRequestForRepository(repository, {
        title: 'Prototype array',
        sourceBranch: branch,
        targetBranch: 'main',
      });
    case 'updatePullRequest':
      return services.updatePullRequestForRepository(repository, {
        pullRequest,
        title: 'Prototype array update',
      });
    case 'getPullRequestDiff':
      return services.getPullRequestDiffForRepository(repository, {
        pullRequest,
      });
    case 'listPullRequestComments':
      return services.listPullRequestCommentsForRepository(repository, {
        pullRequest,
      });
    case 'addPullRequestComment':
      return services.addPullRequestCommentForRepository(repository, {
        pullRequest,
        body: 'Prototype array',
      });
    case 'replyToPullRequestComment':
      return services.replyToPullRequestCommentForRepository(repository, {
        pullRequest,
        threadId,
        body: 'Prototype array',
      });
    case 'findPullRequestForBranch':
      return services.findPullRequestForBranchForRepository(repository, {
        branch,
      });
  }
}

function outputArray(name: OperationArrayCaseName, output: unknown): unknown {
  const result = output as Record<string, unknown>;
  switch (name) {
    case 'list.pullRequests':
      return result.pullRequests;
    case 'get.labels':
    case 'create.labels':
    case 'update.labels':
    case 'diff.labels':
    case 'branch.labels':
      return (result.pullRequest as Record<string, unknown>).labels;
    case 'create.warnings':
    case 'update.warnings':
      return result.warnings;
    case 'diff.files':
      return result.files;
    case 'comments.threads':
      return result.threads;
    case 'comments.replies':
      return (
        (result.threads as Record<string, unknown>[])[0] as Record<
          string,
          unknown
        >
      ).replies;
    case 'add.replies':
    case 'reply.replies':
      return (result.thread as Record<string, unknown>).replies;
  }
}

function isDenseFrozenArrayWithMarker(value: unknown, marker: string): boolean {
  if (
    !Array.isArray(value) ||
    Reflect.getPrototypeOf(value) !== Array.prototype ||
    !Object.isFrozen(value)
  ) {
    return false;
  }
  const length = ownDataValue(value, 'length');
  if (typeof length !== 'number' || length < 1) return false;
  for (let index = 0; index < length; index += 1) {
    if (Reflect.getOwnPropertyDescriptor(value, String(index)) === undefined) {
      return false;
    }
  }
  return containsOwnMarker(value, marker);
}

async function runArrayPrototypeCase(
  hook: ArrayPrototypeHook,
  behavior: PrototypeBehavior,
  name: OperationArrayCaseName,
  sequence: number
) {
  const marker = `__AIDE_ARRAY_${process.pid}_${sequence}_${name}__`;
  const secret = `SECRET-ARRAY-${process.pid}-${sequence}-${name}`;
  const attacker = new Error(secret);
  const validDirect = operationPrototypeHarness(
    name,
    marker,
    false,
    sequence * 4
  );
  const validHost = operationPrototypeHarness(
    name,
    marker,
    false,
    sequence * 4 + 1
  );
  const malformedDirect = operationPrototypeHarness(
    name,
    marker,
    true,
    sequence * 4 + 2
  );
  const malformedHost = operationPrototypeHarness(
    name,
    marker,
    true,
    sequence * 4 + 3
  );
  const installed = installArrayPrototypeHook(hook, behavior, marker, attacker);
  const validExits: Exit.Exit<unknown, unknown>[] = [];
  const malformedExits: Exit.Exit<unknown, unknown>[] = [];
  let restored = false;
  try {
    Object.defineProperty(validExits, '0', {
      configurable: true,
      enumerable: true,
      writable: true,
      value: await Effect.runPromiseExit(
        invokeDirectOperation(
          validDirect.candidate.operation,
          validDirect.providers
        )
      ),
    });
    Object.defineProperty(validExits, '1', {
      configurable: true,
      enumerable: true,
      writable: true,
      value: await Effect.runPromiseExit(
        invokeHostOperation(validHost.candidate.operation, validHost.services)
      ),
    });
    Object.defineProperty(malformedExits, '0', {
      configurable: true,
      enumerable: true,
      writable: true,
      value: await Effect.runPromiseExit(
        invokeDirectOperation(
          malformedDirect.candidate.operation,
          malformedDirect.providers
        )
      ),
    });
    Object.defineProperty(malformedExits, '1', {
      configurable: true,
      enumerable: true,
      writable: true,
      value: await Effect.runPromiseExit(
        invokeHostOperation(
          malformedHost.candidate.operation,
          malformedHost.services
        )
      ),
    });
    installed.proveReachable(validDirect.candidate.array);
  } finally {
    restored = installed.restore();
  }

  const failures = malformedExits.map(failureFromExit);
  const failureExits = malformedExits.filter(Exit.isFailure);
  const allFailureExits = [...validExits, ...malformedExits].filter(
    Exit.isFailure
  );
  const outputs = validExits
    .filter(Exit.isSuccess)
    .map((exit) => outputArray(name, exit.value));
  const candidates = [
    malformedDirect.candidate.result,
    malformedDirect.candidate.array,
    malformedHost.candidate.result,
    malformedHost.candidate.array,
  ];
  return {
    name,
    validSuccessCount: validExits.filter(Exit.isSuccess).length,
    outputCount: outputs.length,
    outputsAreDenseFrozenArrays: outputs.every((output) =>
      isDenseFrozenArrayWithMarker(output, marker)
    ),
    hookCalls: installed.calls(),
    reachabilityCalls: installed.reachabilityCalls(),
    failureCount: failures.filter((failure) => failure !== undefined).length,
    failureTags: failures.map(failureTag),
    causeTags: failureExits.map((exit) => exit.cause._tag),
    defects: malformedExits.reduce(
      (count, exit) =>
        count +
        (Exit.isFailure(exit)
          ? Array.from(Cause.defects(exit.cause)).length
          : 0),
      0
    ),
    fresh: failures.length === 2 && failures[0] !== failures[1],
    attackerRetained: allFailureExits.some((exit) =>
      retainsOwnDataIdentity(exit.cause, attacker)
    ),
    attackerCauseRetained: failures.some(
      (failure) => ownCause(failure) === attacker
    ),
    candidateRetained: failureExits.some((exit) =>
      candidates.some((candidate) =>
        retainsOwnDataIdentity(exit.cause, candidate)
      )
    ),
    attackerTextRetained:
      failures.some(
        (failure) => failure !== undefined && String(failure).includes(secret)
      ) ||
      failureExits.some((exit) => Cause.pretty(exit.cause).includes(secret)),
    restored,
  };
}

async function runArrayPrototypeMode(
  hook: ArrayPrototypeHook,
  behavior: PrototypeBehavior,
  selectedCase: OperationArrayCaseName | 'all'
) {
  const cases: readonly OperationArrayCaseName[] =
    selectedCase === 'all' ? operationArrayCaseNames : [selectedCase];
  const results = [];
  for (let index = 0; index < cases.length; index += 1) {
    const name = ownDataValue(cases, String(index)) as OperationArrayCaseName;
    results.push(await runArrayPrototypeCase(hook, behavior, name, index));
  }
  console.log(
    JSON.stringify({ mode: 'array-prototype', hook, behavior, results })
  );
}

function installProviderSelectionFlatAccessor(
  behavior: PrototypeBehavior,
  attacker: Error
) {
  const previous = Reflect.getOwnPropertyDescriptor(Array.prototype, 'flat');
  if (
    previous === undefined ||
    !Object.hasOwn(previous, 'value') ||
    typeof previous.value !== 'function'
  ) {
    throw new Error('Array.prototype.flat is unavailable');
  }

  const original = previous.value as (...args: unknown[]) => unknown;
  let armed = true;
  let hookCalls = 0;
  let reachabilityCalls = 0;
  Object.defineProperty(Array.prototype, 'flat', {
    configurable: true,
    enumerable: previous.enumerable,
    get() {
      if (armed) {
        hookCalls += 1;
        if (behavior === 'throwing') throw attacker;
        if (behavior === 'slow') return hang();
      } else {
        reachabilityCalls += 1;
      }
      return original;
    },
  });

  return {
    calls: () => hookCalls,
    reachabilityCalls: () => reachabilityCalls,
    proveReachable: () => {
      armed = false;
      const source = [['flat-control']];
      const method = Reflect.get(source, 'flat') as (
        this: unknown[][]
      ) => unknown[];
      const result = Reflect.apply(method, source, []);
      if (ownDataValue(result, '0') !== 'flat-control') {
        throw new Error('flat reachability control returned an invalid result');
      }
    },
    restore: () => {
      Object.defineProperty(Array.prototype, 'flat', previous);
      return descriptorsEqual(
        Reflect.getOwnPropertyDescriptor(Array.prototype, 'flat'),
        previous
      );
    },
  };
}

async function runProviderSelectionFlatAttempt(
  behavior: PrototypeBehavior,
  attempt: number
) {
  const secret = `SECRET-PROVIDER-FLAT-${process.pid}-${attempt}`;
  const attacker = new Error(secret);
  let matcherCalls = 0;
  let installed:
    | ReturnType<typeof installProviderSelectionFlatAccessor>
    | undefined;
  const capability: AidePullRequestProviderCapability = {
    providerId,
    priority: 100,
    features: {},
    authStatus: () => Effect.succeed({ state: 'configured' }),
    matchRemote: () => {
      matcherCalls += 1;
      installed = installProviderSelectionFlatAccessor(behavior, attacker);
      return {
        source: 'git-remote',
        repository: sourceRepository(),
      };
    },
    matchPullRequestUrl: () => null,
  };
  const providers = [{ pluginId: 'provider-flat-plugin', capability }];
  let exit: Exit.Exit<unknown, unknown> | undefined;
  let restored = false;
  try {
    exit = await Effect.runPromiseExit(
      resolvePullRequestProviderForRemote(
        providers,
        'ssh://provider-flat/repository.git'
      )
    );
    if (installed === undefined) {
      throw new Error('external matcher did not install the flat accessor');
    }
    installed.proveReachable();
  } finally {
    restored = installed?.restore() ?? false;
  }

  if (exit === undefined || installed === undefined) {
    throw new Error('provider selection did not complete');
  }
  const failure = failureFromExit(exit);
  const defects = Exit.isFailure(exit)
    ? Array.from(Cause.defects(exit.cause))
    : [];
  return {
    attempt,
    matcherCalls,
    hookCalls: installed.calls(),
    reachabilityCalls: installed.reachabilityCalls(),
    success: Exit.isSuccess(exit),
    providerId:
      Exit.isSuccess(exit) &&
      typeof exit.value === 'object' &&
      exit.value !== null &&
      ownDataValue(exit.value, 'providerId') === providerId
        ? providerId
        : null,
    priority:
      Exit.isSuccess(exit) &&
      typeof exit.value === 'object' &&
      exit.value !== null &&
      ownDataValue(exit.value, 'priority') === 100
        ? 100
        : null,
    failureTags: failure === undefined ? [] : [failureTag(failure)],
    defects: defects.length,
    attackerRetained: defects.some((defect) => defect === attacker),
    attackerTextRetained:
      Exit.isFailure(exit) && Cause.pretty(exit.cause).includes(secret),
    restored,
  };
}

async function runProviderSelectionFlatMode(behavior: PrototypeBehavior) {
  const attempts: Awaited<
    ReturnType<typeof runProviderSelectionFlatAttempt>
  >[] = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    Object.defineProperty(attempts, String(attempt), {
      configurable: true,
      enumerable: true,
      writable: true,
      value: await runProviderSelectionFlatAttempt(behavior, attempt),
    });
  }
  console.log(
    JSON.stringify({ mode: 'provider-selection-flat', behavior, attempts })
  );
}

function providerContinuationOperation(
  selectedCase: ProviderContinuationCase
): ProviderContinuationOperation {
  switch (selectedCase) {
    case 'preferred-filter':
    case 'tie-filter':
    case 'operation-filter-remote':
    case 'operation-filter-repository':
      return 'filter';
    case 'iterator':
    case 'sort':
    case 'map':
      return selectedCase;
  }
}

function isProviderContinuationArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) return false;
  const first = ownDataValue(value, '0');
  if (typeof first !== 'object' || first === null) return false;
  const pluginId = ownDataValue(first, 'pluginId');
  return (
    typeof pluginId === 'string' &&
    pluginId.startsWith('provider-continuation-')
  );
}

function installProviderContinuationAccessor(
  operation: ProviderContinuationOperation,
  behavior: PrototypeBehavior,
  attacker: Error
) {
  const key = operation === 'iterator' ? Symbol.iterator : operation;
  const previous = Reflect.getOwnPropertyDescriptor(Array.prototype, key);
  if (
    previous === undefined ||
    !Object.hasOwn(previous, 'value') ||
    typeof previous.value !== 'function'
  ) {
    throw new Error(`Array.prototype ${operation} operation is unavailable`);
  }

  const original = previous.value as (...args: unknown[]) => unknown;
  let armed = true;
  let hookCalls = 0;
  let reachabilityCalls = 0;
  Object.defineProperty(Array.prototype, key, {
    configurable: true,
    enumerable: previous.enumerable,
    get(this: unknown) {
      if (!isProviderContinuationArray(this)) return original;
      if (armed) {
        hookCalls += 1;
        if (behavior === 'throwing') throw attacker;
        if (behavior === 'slow') return hang();
      } else {
        reachabilityCalls += 1;
      }
      return original;
    },
  });

  return {
    calls: () => hookCalls,
    reachabilityCalls: () => reachabilityCalls,
    proveReachable: () => {
      armed = false;
      if (operation === 'iterator') {
        const control = {
          pluginId: 'provider-continuation-control',
          providerId: 'iterator-control',
          priority: 1,
        };
        const source = [control];
        const iteratorFactory = Reflect.get(source, Symbol.iterator) as (
          this: unknown[]
        ) => Iterator<unknown>;
        const iterator = Reflect.apply(iteratorFactory, source, []);
        const result = iterator.next();
        if (result.done || result.value !== control) {
          throw new Error(
            'iterator reachability control returned invalid data'
          );
        }
        return;
      }

      if (operation === 'filter') {
        const control = {
          pluginId: 'provider-continuation-control',
          providerId: 'filter-control',
          priority: 1,
        };
        const source = [control];
        const method = Reflect.get(source, 'filter') as (
          this: unknown[],
          predicate: (value: unknown) => boolean
        ) => unknown[];
        const result = Reflect.apply(method, source, [() => true]);
        if (ownDataValue(result, '0') !== control) {
          throw new Error('filter reachability control returned invalid data');
        }
        return;
      }

      if (operation === 'sort') {
        const second = {
          pluginId: 'provider-continuation-control',
          providerId: 'sort-second',
          priority: 2,
        };
        const first = {
          pluginId: 'provider-continuation-control',
          providerId: 'sort-first',
          priority: 1,
        };
        const source = [second, first];
        const method = Reflect.get(source, 'sort') as (
          this: typeof source,
          compare: (
            left: (typeof source)[number],
            right: (typeof source)[number]
          ) => number
        ) => typeof source;
        const result = Reflect.apply(method, source, [
          (left: (typeof source)[number], right: (typeof source)[number]) =>
            left.priority - right.priority,
        ]);
        if (ownDataValue(result, '0') !== first) {
          throw new Error('sort reachability control returned invalid data');
        }
        return;
      }

      const control = {
        pluginId: 'provider-continuation-control',
        providerId: 'map-control',
        priority: 1,
      };
      const source = [control];
      const method = Reflect.get(source, 'map') as (
        this: unknown[],
        mapper: (value: unknown) => unknown
      ) => unknown[];
      const result = Reflect.apply(method, source, [(value: unknown) => value]);
      if (ownDataValue(result, '0') !== control) {
        throw new Error('map reachability control returned invalid data');
      }
    },
    restore: () => {
      Object.defineProperty(Array.prototype, key, previous);
      return descriptorsEqual(
        Reflect.getOwnPropertyDescriptor(Array.prototype, key),
        previous
      );
    },
  };
}

function providerContinuationCapability(args: {
  readonly providerId: string;
  readonly priority: number;
  readonly onMatch?: () => void;
  readonly operationTitle?: string;
}): AidePullRequestProviderCapability {
  const operations =
    args.operationTitle === undefined
      ? undefined
      : {
          getPullRequest: () =>
            Effect.succeed({
              ...validOperationResult('getPullRequest'),
              repository: sourceRepository(args.providerId),
              pullRequest: { ...viewItem(), title: args.operationTitle },
            } as never),
        };
  return {
    providerId: args.providerId,
    priority: args.priority,
    features: {},
    authStatus: () => Effect.succeed({ state: 'configured' }),
    matchRemote: () => {
      args.onMatch?.();
      return {
        source: 'git-remote',
        repository: sourceRepository(args.providerId),
      };
    },
    matchPullRequestUrl: () => null,
    ...(operations === undefined ? {} : { operations }),
  };
}

function ambiguityCandidateOrder(
  failure: AmbiguousPullRequestProviderError
): string[] {
  const candidates = failure.candidates;
  const length = ownDataValue(candidates, 'length');
  if (typeof length !== 'number') return [];
  const order: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const candidate = ownDataValue(candidates, String(index));
    if (typeof candidate !== 'object' || candidate === null) continue;
    const pluginId = ownDataValue(candidate, 'pluginId');
    const selectedProviderId = ownDataValue(candidate, 'providerId');
    const priority = ownDataValue(candidate, 'priority');
    Object.defineProperty(order, String(index), {
      configurable: true,
      enumerable: true,
      writable: true,
      value: `${String(pluginId)}/${String(selectedProviderId)}@${String(priority)}`,
    });
  }
  return order;
}

async function runProviderContinuationAttempt(
  selectedCase: ProviderContinuationCase,
  behavior: PrototypeBehavior,
  attempt: number
) {
  const operation = providerContinuationOperation(selectedCase);
  const secret = `SECRET-PROVIDER-CONTINUATION-${selectedCase}-${process.pid}-${attempt}`;
  const attacker = new Error(secret);
  let externalCalls = 0;
  let installed:
    | ReturnType<typeof installProviderContinuationAccessor>
    | undefined;
  const install = () => {
    if (installed === undefined) {
      installed = installProviderContinuationAccessor(
        operation,
        behavior,
        attacker
      );
    }
  };

  const firstPluginId = 'provider-continuation-plugin-first';
  const secondPluginId = 'provider-continuation-plugin-second';
  const firstProviderId =
    selectedCase === 'operation-filter-repository'
      ? providerId
      : 'continuation-first';
  const secondProviderId =
    selectedCase === 'operation-filter-repository'
      ? providerId
      : 'continuation-second';
  const tied = selectedCase === 'tie-filter' || selectedCase === 'map';
  const operationCase =
    selectedCase === 'operation-filter-remote' ||
    selectedCase === 'operation-filter-repository';
  const firstCapability = providerContinuationCapability({
    providerId: firstProviderId,
    priority: tied ? 100 : 10,
    operationTitle: operationCase ? 'selected-operation-provider' : undefined,
    onMatch:
      selectedCase === 'operation-filter-repository'
        ? undefined
        : () => {
            externalCalls += 1;
          },
  });
  let secondCapability = providerContinuationCapability({
    providerId: secondProviderId,
    priority: 100,
    onMatch:
      selectedCase === 'operation-filter-repository'
        ? undefined
        : () => {
            externalCalls += 1;
            install();
          },
  });
  if (selectedCase === 'operation-filter-repository') {
    const repositoryCapability = {
      providerId: secondCapability.providerId,
      features: secondCapability.features,
      authStatus: secondCapability.authStatus,
      matchRemote: secondCapability.matchRemote,
      matchPullRequestUrl: secondCapability.matchPullRequestUrl,
    } as unknown as AidePullRequestProviderCapability;
    Object.defineProperty(repositoryCapability, 'priority', {
      configurable: true,
      enumerable: true,
      get() {
        externalCalls += 1;
        install();
        return 100;
      },
    });
    secondCapability = repositoryCapability;
  }

  const providers = [
    { pluginId: firstPluginId, capability: firstCapability },
    { pluginId: secondPluginId, capability: secondCapability },
  ];
  let exit: Exit.Exit<unknown, unknown> | undefined;
  let restored = false;
  try {
    if (selectedCase === 'operation-filter-remote') {
      exit = await Effect.runPromiseExit(
        getPullRequestForRemote(
          providers,
          'ssh://provider-continuation/repository.git',
          { pullRequest }
        )
      );
    } else if (selectedCase === 'operation-filter-repository') {
      exit = await Effect.runPromiseExit(
        getPullRequestForRepository(
          providers,
          Object.freeze(sourceRepository()),
          { pullRequest }
        )
      );
    } else {
      exit = await Effect.runPromiseExit(
        resolvePullRequestProviderForRemote(
          providers,
          'ssh://provider-continuation/repository.git',
          selectedCase === 'preferred-filter'
            ? {
                preferred: (candidate) =>
                  candidate.providerId === firstProviderId,
              }
            : {}
        )
      );
    }
    if (installed === undefined) {
      throw new Error(
        'external provider did not install the continuation accessor'
      );
    }
    installed.proveReachable();
  } finally {
    restored = installed?.restore() ?? false;
  }

  if (exit === undefined || installed === undefined) {
    throw new Error('provider continuation did not complete');
  }
  const failure = failureFromExit(exit);
  const defects = Exit.isFailure(exit)
    ? Array.from(Cause.defects(exit.cause))
    : [];
  const ambiguity =
    failure instanceof AmbiguousPullRequestProviderError ? failure : undefined;
  const expectedProviderId =
    selectedCase === 'preferred-filter'
      ? firstProviderId
      : selectedCase === 'iterator' || selectedCase === 'sort'
        ? secondProviderId
        : null;
  return {
    attempt,
    selectedCase,
    operation,
    externalCalls,
    hookCalls: installed.calls(),
    reachabilityCalls: installed.reachabilityCalls(),
    success: Exit.isSuccess(exit),
    providerId:
      Exit.isSuccess(exit) &&
      expectedProviderId !== null &&
      typeof exit.value === 'object' &&
      exit.value !== null &&
      ownDataValue(exit.value, 'providerId') === expectedProviderId
        ? expectedProviderId
        : null,
    operationTitle:
      Exit.isSuccess(exit) &&
      operationCase &&
      typeof exit.value === 'object' &&
      exit.value !== null
        ? (() => {
            const selectedPullRequest = ownDataValue(
              exit.value as object,
              'pullRequest'
            );
            return typeof selectedPullRequest === 'object' &&
              selectedPullRequest !== null
              ? ownDataValue(selectedPullRequest, 'title')
              : null;
          })()
        : null,
    failureTag: failureTag(failure),
    causeTag: Exit.isFailure(exit) ? ownDataValue(exit.cause, '_tag') : null,
    defects: defects.length,
    typedAmbiguity: ambiguity !== undefined,
    ambiguityPriority:
      ambiguity === undefined ? null : ownDataValue(ambiguity, 'priority'),
    ambiguityCandidates:
      ambiguity === undefined ? [] : ambiguityCandidateOrder(ambiguity),
    ambiguityMessage: ambiguity?.message ?? null,
    attackerRetained:
      failure === attacker || defects.some((defect) => defect === attacker),
    attackerTextRetained:
      Exit.isFailure(exit) && Cause.pretty(exit.cause).includes(secret),
    restored,
  };
}

async function runProviderContinuationMode(
  behavior: PrototypeBehavior,
  selectedCase: ProviderContinuationCase
) {
  const attempts: Awaited<ReturnType<typeof runProviderContinuationAttempt>>[] =
    [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    Object.defineProperty(attempts, String(attempt), {
      configurable: true,
      enumerable: true,
      writable: true,
      value: await runProviderContinuationAttempt(
        selectedCase,
        behavior,
        attempt
      ),
    });
  }
  console.log(
    JSON.stringify({
      mode: 'provider-selection-continuation',
      behavior,
      selectedCase,
      attempts,
    })
  );
}

function featureCapability(
  features: unknown
): AidePullRequestProviderCapability {
  return {
    providerId,
    priority: 100,
    features: features as never,
    authStatus: () => Effect.succeed({ state: 'configured' }),
    matchRemote: () => ({
      source: 'git-remote',
      repository: sourceRepository(),
    }),
    matchPullRequestUrl: () => null,
  };
}

function installFeaturePrototypeAccessor(
  key: FeatureKey,
  behavior: PrototypeBehavior,
  attacker: Error
) {
  const previous = Reflect.getOwnPropertyDescriptor(Object.prototype, key);
  let getterReads = 0;
  Object.defineProperty(Object.prototype, key, {
    configurable: true,
    get() {
      getterReads += 1;
      if (behavior === 'throwing') throw attacker;
      if (behavior === 'slow') return hang();
      return true;
    },
  });
  return {
    reads: () => getterReads,
    restore: () => {
      if (previous === undefined) {
        Reflect.deleteProperty(Object.prototype, key);
      } else {
        Object.defineProperty(Object.prototype, key, previous);
      }
      return descriptorsEqual(
        Reflect.getOwnPropertyDescriptor(Object.prototype, key),
        previous
      );
    },
  };
}

function featureDirectEffect(features: unknown, sequence: number) {
  const capability = featureCapability(features);
  return {
    candidate: features,
    effect: resolvePullRequestProviderForRemote(
      [{ pluginId: `feature-direct-${process.pid}-${sequence}`, capability }],
      'ssh://feature-prototype/repo.git'
    ),
  };
}

function registerFeaturePlugin(features: unknown, sequence: number) {
  const pluginId = `feature-registry-${process.pid}-${sequence}`;
  const registry = createKeyringCommandRegistry();
  registry.registerExternalPlugin(
    definePublicAidePlugin({
      id: pluginId,
      summary: 'PR feature prototype fixture',
      commands: [],
      capabilities: { pullRequestProvider: featureCapability(features) },
    }),
    {
      manifest: {
        id: pluginId,
        version: '1.0.0',
        aidePluginApiVersion: AIDE_PLUGIN_API_VERSION,
        capabilities: ['pull-request-provider'],
      },
    }
  );
  return registry;
}

async function runFeaturePrototypeCase(
  behavior: PrototypeBehavior,
  key: FeatureKey,
  sequence: number
) {
  const otherKey =
    key === 'draftPullRequests' ? 'reviewComments' : 'draftPullRequests';
  const inheritedFeatures = { [otherKey]: true };
  const secret = `SECRET-FEATURE-${process.pid}-${sequence}-${key}`;
  const attacker = new Error(secret);
  const ownAccessorFeatures = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(ownAccessorFeatures, key, {
    configurable: true,
    enumerable: true,
    get() {
      throw attacker;
    },
  });
  const installed = installFeaturePrototypeAccessor(key, behavior, attacker);
  const directSuccessExits: Exit.Exit<unknown, unknown>[] = [];
  const hostSuccessExits: Exit.Exit<unknown, unknown>[] = [];
  const directFailureExits: Exit.Exit<unknown, unknown>[] = [];
  const registrationFailures: unknown[] = [];
  const rejectedRegistries: ReturnType<typeof createKeyringCommandRegistry>[] =
    [];
  let restored = false;
  try {
    const direct = featureDirectEffect(inheritedFeatures, sequence * 10);
    directSuccessExits.push(await Effect.runPromiseExit(direct.effect));
    const acceptedRegistry = registerFeaturePlugin(
      inheritedFeatures,
      sequence * 10 + 1
    );
    hostSuccessExits.push(
      await Effect.runPromiseExit(
        createAideHostServices(
          acceptedRegistry
        ).resolvePullRequestProviderForRemote(
          'ssh://feature-prototype/repo.git'
        )
      )
    );

    for (let attempt = 0; attempt < 2; attempt += 1) {
      directFailureExits.push(
        await Effect.runPromiseExit(
          featureDirectEffect(ownAccessorFeatures, sequence * 10 + 2 + attempt)
            .effect
        )
      );
      const registry = createKeyringCommandRegistry();
      rejectedRegistries.push(registry);
      const pluginId = `feature-rejected-${process.pid}-${sequence}-${attempt}`;
      try {
        registry.registerExternalPlugin(
          definePublicAidePlugin({
            id: pluginId,
            summary: 'Rejected PR feature prototype fixture',
            commands: [],
            capabilities: {
              pullRequestProvider: featureCapability(ownAccessorFeatures),
            },
          }),
          {
            manifest: {
              id: pluginId,
              version: '1.0.0',
              aidePluginApiVersion: AIDE_PLUGIN_API_VERSION,
              capabilities: ['pull-request-provider'],
            },
          }
        );
      } catch (error) {
        registrationFailures.push(error);
      }
    }
  } finally {
    restored = installed.restore();
  }

  const directFailures = directFailureExits.map(failureFromExit);
  const directFailureCauses = directFailureExits.filter(Exit.isFailure);
  const successOutputs = [...directSuccessExits, ...hostSuccessExits]
    .filter(Exit.isSuccess)
    .map((exit) => (exit.value as Record<string, unknown>).features);
  return {
    key,
    successCount:
      directSuccessExits.filter(Exit.isSuccess).length +
      hostSuccessExits.filter(Exit.isSuccess).length,
    successFeaturesAreFrozenNullPrototype: successOutputs.every(
      (features) =>
        typeof features === 'object' &&
        features !== null &&
        Reflect.getPrototypeOf(features) === null &&
        Object.isFrozen(features) &&
        !Object.hasOwn(features, key) &&
        ownDataValue(features, otherKey) === true
    ),
    getterReads: installed.reads(),
    directFailureCount: directFailures.filter(
      (failure) => failure !== undefined
    ).length,
    directFailureTags: directFailures.map(failureTag),
    directCauseTags: directFailureCauses.map((exit) => exit.cause._tag),
    directDefects: directFailureCauses.reduce(
      (count, exit) => count + Array.from(Cause.defects(exit.cause)).length,
      0
    ),
    directFresh:
      directFailures.length === 2 && directFailures[0] !== directFailures[1],
    registrationFailureCount: registrationFailures.length,
    registrationMessages: registrationFailures.map((failure) =>
      failure instanceof Error ? failure.message : undefined
    ),
    registrationFresh:
      registrationFailures.length === 2 &&
      registrationFailures[0] !== registrationFailures[1],
    registrationAtomic: rejectedRegistries.every(
      (registry) => registry.plugins().length === 0
    ),
    attackerRetained:
      directFailureCauses.some((exit) =>
        retainsOwnDataIdentity(exit.cause, attacker)
      ) || registrationFailures.some((failure) => failure === attacker),
    attackerCauseRetained: directFailures.some(
      (failure) => ownCause(failure) === attacker
    ),
    candidateRetained: directFailureCauses.some((exit) =>
      retainsOwnDataIdentity(exit.cause, ownAccessorFeatures)
    ),
    attackerTextRetained:
      directFailures.some(
        (failure) => failure !== undefined && String(failure).includes(secret)
      ) ||
      directFailureCauses.some((exit) =>
        Cause.pretty(exit.cause).includes(secret)
      ) ||
      registrationFailures.some((failure) => String(failure).includes(secret)),
    restored,
  };
}

async function runFeaturePrototypeMode(
  behavior: PrototypeBehavior,
  selectedKey: FeatureKey | 'all'
) {
  const keys: readonly FeatureKey[] =
    selectedKey === 'all' ? featureKeys : [selectedKey];
  const results = [];
  for (let index = 0; index < keys.length; index += 1) {
    const key = ownDataValue(keys, String(index)) as FeatureKey;
    results.push(await runFeaturePrototypeCase(behavior, key, index));
  }
  console.log(JSON.stringify({ mode: 'feature-prototype', behavior, results }));
}

async function runLegacyMode(mode: LegacyMode) {
  const pluginId = `deadline-pr-capture-${mode}`;
  const repository = Object.freeze(sourceRepository());
  let trapCalls = 0;
  let iteratorCalls = 0;
  let messageReads = 0;

  function hostileResult(): unknown {
    switch (mode) {
      case 'proxy-ownkeys':
        return new Proxy({}, { ownKeys: () => ((trapCalls += 1), hang()) });
      case 'proxy-prototype':
        return new Proxy(
          {},
          { getPrototypeOf: () => ((trapCalls += 1), hang()) }
        );
      case 'iterator-accessor': {
        const pullRequests: unknown[] = [];
        Object.defineProperty(pullRequests, Symbol.iterator, {
          get: () => ((iteratorCalls += 1), hang()),
        });
        return { repository, pullRequests };
      }
      case 'custom-prototype-iterator': {
        const prototype = Object.create(Array.prototype);
        Object.defineProperty(prototype, Symbol.iterator, {
          get: () => ((iteratorCalls += 1), hang()),
        });
        const pullRequests: unknown[] = [];
        Object.setPrototypeOf(pullRequests, prototype);
        return { repository, pullRequests };
      }
      case 'matcher-failure-accessor':
      case 'matcher-failure-proxy':
      case 'operation-failure-accessor':
      case 'operation-failure-proxy':
        return { repository, pullRequests: [] };
    }
  }

  function hostileFailure(): unknown {
    if (mode.endsWith('accessor')) {
      const failure = new Error();
      Object.defineProperty(failure, 'message', {
        configurable: true,
        get: () => {
          messageReads += 1;
          return 'SECRET-PR-FAILURE-ACCESSOR';
        },
      });
      return failure;
    }
    return new Proxy(new Error(), {
      get: () => ((trapCalls += 1), hang()),
      getPrototypeOf: () => ((trapCalls += 1), hang()),
    });
  }

  const failureValue = mode.includes('failure') ? hostileFailure() : undefined;
  const isMatcherFailure = mode.startsWith('matcher-failure');
  const isOperationFailure = mode.startsWith('operation-failure');
  const capability: AidePullRequestProviderCapability = {
    providerId,
    priority: 100,
    features: {},
    authStatus: () => Effect.succeed({ state: 'configured' }),
    matchRemote: () => null,
    matchRepository: () =>
      isMatcherFailure
        ? Effect.fail(failureValue)
        : Effect.succeed({ source: 'repository-ref', repository }),
    matchPullRequestUrl: () => null,
    operations: {
      listPullRequests: () =>
        isOperationFailure
          ? Effect.fail(failureValue)
          : Effect.succeed(hostileResult() as never),
    },
  };
  const registry = createKeyringCommandRegistry();
  registry.registerExternalPlugin(
    definePublicAidePlugin({
      id: pluginId,
      summary: 'PR capture hard deadline fixture',
      commands: [],
      capabilities: { pullRequestProvider: capability },
    }),
    {
      manifest: {
        id: pluginId,
        version: '1.0.0',
        aidePluginApiVersion: AIDE_PLUGIN_API_VERSION,
        capabilities: ['pull-request-provider'],
      },
    }
  );

  const services = createAideHostServices(registry);
  const program: Effect.Effect<unknown, unknown> = isMatcherFailure
    ? services.resolvePullRequestProviderForRepositoryInput({ providerId })
    : services.listPullRequestsForRepository(repository);
  const exit = await Effect.runPromiseExit(program);
  const failure = Exit.isFailure(exit)
    ? Cause.failureOption(exit.cause)
    : Option.none();
  const failureObject = Option.isSome(failure) ? failure.value : undefined;
  const expectedMessage = isMatcherFailure
    ? `Pull request provider '${providerId}' from plugin '${pluginId}' failed while matching repository-ref provider=${providerId}`
    : `Pull request provider '${providerId}' from plugin '${pluginId}' failed during listPullRequests`;
  const genuineFailureMode = isMatcherFailure || isOperationFailure;
  console.log(
    JSON.stringify({
      mode,
      typed:
        Option.isSome(failure) &&
        typeof failure.value === 'object' &&
        failure.value !== null &&
        '_tag' in failure.value &&
        (genuineFailureMode
          ? failure.value._tag ===
            (isMatcherFailure
              ? 'PullRequestProviderInvocationError'
              : 'PullRequestProviderOperationError')
          : failure.value._tag ===
            'InvalidPullRequestProviderOperationResultError'),
      defects: Exit.isFailure(exit)
        ? Array.from(Cause.defects(exit.cause)).length
        : -1,
      ...(genuineFailureMode
        ? {
            causeContract:
              typeof failureObject === 'object' &&
              failureObject !== null &&
              'cause' in failureObject &&
              (isMatcherFailure
                ? failureObject.cause !== failureValue &&
                  failureObject.cause instanceof Error &&
                  failureObject.cause.message ===
                    'Pull request provider matcher failed'
                : failureObject.cause === failureValue),
            fixedMessage:
              typeof failureObject === 'object' &&
              failureObject !== null &&
              'message' in failureObject &&
              failureObject.message === expectedMessage,
            messageReads,
          }
        : {}),
      trapCalls,
      iteratorCalls,
    })
  );
}

const [mode, getterMode, path, selectedCase] = process.argv.slice(2);
if (mode === 'schema') {
  await runSchemaMode(
    getterMode as SchemaGetterMode,
    path as SchemaPath,
    selectedCase as SchemaCaseName | 'all'
  );
} else if (mode === 'array-prototype') {
  await runArrayPrototypeMode(
    getterMode as ArrayPrototypeHook,
    path as PrototypeBehavior,
    selectedCase as OperationArrayCaseName | 'all'
  );
} else if (mode === 'provider-selection-flat') {
  await runProviderSelectionFlatMode(getterMode as PrototypeBehavior);
} else if (mode === 'provider-selection-continuation') {
  await runProviderContinuationMode(
    getterMode as PrototypeBehavior,
    path as ProviderContinuationCase
  );
} else if (mode === 'feature-prototype') {
  await runFeaturePrototypeMode(
    getterMode as PrototypeBehavior,
    path as FeatureKey | 'all'
  );
} else {
  await runLegacyMode(mode as LegacyMode);
}
