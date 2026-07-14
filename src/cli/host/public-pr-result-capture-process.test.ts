import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';
import { readFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

type Mode =
  | 'proxy-ownkeys'
  | 'proxy-prototype'
  | 'iterator-accessor'
  | 'custom-prototype-iterator'
  | 'matcher-failure-accessor'
  | 'matcher-failure-proxy'
  | 'operation-failure-accessor'
  | 'operation-failure-proxy'
  | 'array-prototype'
  | 'provider-selection-flat'
  | 'provider-selection-continuation'
  | 'feature-prototype';

type Lane = 'source' | 'native';
type SchemaGetterMode = 'returning' | 'throwing' | 'slow';
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
type SchemaPath =
  | 'root-field'
  | 'nested-field'
  | 'variant'
  | 'required-optional'
  | 'control';
type SchemaCaseName =
  | 'features'
  | 'matchRemote'
  | 'matchRepository'
  | 'matchPullRequestUrl'
  | 'listPullRequests'
  | 'getPullRequest'
  | 'createPullRequest'
  | 'updatePullRequest'
  | 'getPullRequestDiff'
  | 'listPullRequestComments'
  | 'addPullRequestComment'
  | 'replyToPullRequestComment'
  | 'findPullRequestForBranch';

interface SchemaSuccessControlResult {
  readonly kind: 'success-control';
  readonly name: SchemaCaseName;
  readonly success: boolean;
  readonly getterReads: number;
  readonly restored: boolean;
  readonly pollutionKey: string;
}

interface SchemaHostBoundaryFailureResult {
  readonly kind: 'host-boundary-failure';
  readonly name: SchemaCaseName;
  readonly failureCount: number;
  readonly failureTags: readonly unknown[];
  readonly expectedTag:
    | 'InvalidPullRequestProviderMatchError'
    | 'InvalidPullRequestProviderOperationResultError';
  readonly causeTags: readonly unknown[];
  readonly defects: number;
  readonly getterReads: number;
  readonly attackerRetained: boolean;
  readonly attackerCauseRetained: boolean;
  readonly candidateRetained: boolean;
  readonly attackerTextRetained: boolean;
  readonly fresh: boolean;
  readonly restored: boolean;
  readonly pollutionKey: string;
}

interface SchemaFixtureResult {
  readonly mode: 'schema';
  readonly getterMode: SchemaGetterMode;
  readonly path: SchemaPath;
  readonly results: readonly (
    | SchemaSuccessControlResult
    | SchemaHostBoundaryFailureResult
  )[];
}

interface ArrayPrototypeCaseResult {
  readonly name: OperationArrayCaseName;
  readonly validSuccessCount: number;
  readonly outputCount: number;
  readonly outputsAreDenseFrozenArrays: boolean;
  readonly hookCalls: number;
  readonly reachabilityCalls: number;
  readonly failureCount: number;
  readonly failureTags: readonly unknown[];
  readonly causeTags: readonly unknown[];
  readonly defects: number;
  readonly fresh: boolean;
  readonly attackerRetained: boolean;
  readonly attackerCauseRetained: boolean;
  readonly candidateRetained: boolean;
  readonly attackerTextRetained: boolean;
  readonly restored: boolean;
}

interface ArrayPrototypeFixtureResult {
  readonly mode: 'array-prototype';
  readonly hook: ArrayPrototypeHook;
  readonly behavior: PrototypeBehavior;
  readonly results: readonly ArrayPrototypeCaseResult[];
}

interface FeaturePrototypeCaseResult {
  readonly key: FeatureKey;
  readonly successCount: number;
  readonly successFeaturesAreFrozenNullPrototype: boolean;
  readonly getterReads: number;
  readonly directFailureCount: number;
  readonly directFailureTags: readonly unknown[];
  readonly directCauseTags: readonly unknown[];
  readonly directDefects: number;
  readonly directFresh: boolean;
  readonly registrationFailureCount: number;
  readonly registrationMessages: readonly unknown[];
  readonly registrationFresh: boolean;
  readonly registrationAtomic: boolean;
  readonly attackerRetained: boolean;
  readonly attackerCauseRetained: boolean;
  readonly candidateRetained: boolean;
  readonly attackerTextRetained: boolean;
  readonly restored: boolean;
}

interface FeaturePrototypeFixtureResult {
  readonly mode: 'feature-prototype';
  readonly behavior: PrototypeBehavior;
  readonly results: readonly FeaturePrototypeCaseResult[];
}

interface ProviderSelectionFlatAttemptResult {
  readonly attempt: number;
  readonly matcherCalls: number;
  readonly hookCalls: number;
  readonly reachabilityCalls: number;
  readonly success: boolean;
  readonly providerId: string | null;
  readonly priority: number | null;
  readonly failureTags: readonly unknown[];
  readonly defects: number;
  readonly attackerRetained: boolean;
  readonly attackerTextRetained: boolean;
  readonly restored: boolean;
}

interface ProviderSelectionFlatFixtureResult {
  readonly mode: 'provider-selection-flat';
  readonly behavior: PrototypeBehavior;
  readonly attempts: readonly ProviderSelectionFlatAttemptResult[];
}

interface ProviderContinuationAttemptResult {
  readonly attempt: number;
  readonly selectedCase: ProviderContinuationCase;
  readonly operation: ProviderContinuationOperation;
  readonly externalCalls: number;
  readonly hookCalls: number;
  readonly reachabilityCalls: number;
  readonly success: boolean;
  readonly providerId: string | null;
  readonly operationTitle: unknown;
  readonly failureTag: unknown;
  readonly causeTag: unknown;
  readonly defects: number;
  readonly typedAmbiguity: boolean;
  readonly ambiguityPriority: unknown;
  readonly ambiguityCandidates: readonly unknown[];
  readonly ambiguityMessage: unknown;
  readonly attackerRetained: boolean;
  readonly attackerTextRetained: boolean;
  readonly restored: boolean;
}

interface ProviderContinuationFixtureResult {
  readonly mode: 'provider-selection-continuation';
  readonly behavior: PrototypeBehavior;
  readonly selectedCase: ProviderContinuationCase;
  readonly attempts: readonly ProviderContinuationAttemptResult[];
}

const fixturePath = fileURLToPath(
  new URL(
    './test-fixtures/public-pr-result-capture.fixture.ts',
    import.meta.url
  )
);
const resolverPath = fileURLToPath(
  new URL('./pull-request-provider-resolver.ts', import.meta.url)
);
const commandErrorPath = fileURLToPath(
  new URL('../plugins/pull-requests/commands/error.ts', import.meta.url)
);
const nativeFixturePath = `/private/tmp/aide-public-pr-schema-capture-${process.pid}`;
const children = new Set<ReturnType<typeof Bun.spawn>>();
const parentOptionalDescriptor = Reflect.getOwnPropertyDescriptor(
  Object.prototype,
  'optional'
);
const parentArrayPrototypeDescriptors = new Map<
  PropertyKey,
  PropertyDescriptor | undefined
>(
  ['997', Symbol.iterator, 'flat', 'filter', 'sort', 'map', 'some', 'push'].map(
    (key) => [key, Reflect.getOwnPropertyDescriptor(Array.prototype, key)]
  )
);
const featureKeys = [
  'draftPullRequests',
  'reviewComments',
  'threadedComments',
  'enterpriseHosts',
] as const satisfies readonly FeatureKey[];
const parentFeatureDescriptors = new Map(
  featureKeys.map((key) => [
    key,
    Reflect.getOwnPropertyDescriptor(Object.prototype, key),
  ])
);

const schemaCaseNames = [
  'features',
  'matchRemote',
  'matchRepository',
  'matchPullRequestUrl',
  'listPullRequests',
  'getPullRequest',
  'createPullRequest',
  'updatePullRequest',
  'getPullRequestDiff',
  'listPullRequestComments',
  'addPullRequestComment',
  'replyToPullRequestComment',
  'findPullRequestForBranch',
] as const satisfies readonly SchemaCaseName[];
const nestedSchemaCaseNames = schemaCaseNames.filter(
  (name): name is Exclude<SchemaCaseName, 'features'> => name !== 'features'
);
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

function expectParentPrototypeRestored(): void {
  expect(
    descriptorsEqual(
      Reflect.getOwnPropertyDescriptor(Object.prototype, 'optional'),
      parentOptionalDescriptor
    )
  ).toBe(true);
  expect(
    Object.getOwnPropertyNames(Object.prototype).filter((key) =>
      key.startsWith('__aide_pr_schema_')
    )
  ).toEqual([]);
  for (const [key, descriptor] of parentArrayPrototypeDescriptors) {
    expect(
      descriptorsEqual(
        Reflect.getOwnPropertyDescriptor(Array.prototype, key),
        descriptor
      )
    ).toBe(true);
  }
  for (const [key, descriptor] of parentFeatureDescriptors) {
    expect(
      descriptorsEqual(
        Reflect.getOwnPropertyDescriptor(Object.prototype, key),
        descriptor
      )
    ).toBe(true);
  }
}

beforeAll(async () => {
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      'build',
      '--compile',
      '--target=bun-darwin-arm64',
      fixturePath,
      '--outfile',
      nativeFixturePath,
    ],
    cwd: import.meta.dir,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  children.add(child);
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout as ReadableStream<Uint8Array>).text(),
    new Response(child.stderr as ReadableStream<Uint8Array>).text(),
  ]);
  children.delete(child);
  expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
}, 30_000);

afterAll(async () => {
  try {
    await unlink(nativeFixturePath);
  } catch (error) {
    if (
      typeof error !== 'object' ||
      error === null ||
      !('code' in error) ||
      error.code !== 'ENOENT'
    ) {
      throw error;
    }
  }
});

afterEach(async () => {
  for (const child of children) child.kill('SIGKILL');
  await Promise.allSettled([...children].map((child) => child.exited));
  children.clear();
});

async function runFixture(
  mode: Mode | 'schema',
  args: readonly string[] = [],
  lane: Lane = 'source'
) {
  const environment = { ...Bun.env };
  delete environment.FORCE_COLOR;
  delete environment.NO_COLOR;
  const child = Bun.spawn({
    cmd:
      lane === 'source'
        ? [process.execPath, 'run', fixturePath, mode, ...args]
        : [nativeFixturePath, mode, ...args],
    cwd: import.meta.dir,
    env: environment,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  children.add(child);
  const outcome = await Promise.race([
    Promise.all([
      child.exited,
      new Response(child.stdout as ReadableStream<Uint8Array>).text(),
      new Response(child.stderr as ReadableStream<Uint8Array>).text(),
    ]).then(([exitCode, stdout, stderr]) => ({
      status: 'exited' as const,
      exitCode,
      stdout,
      stderr,
    })),
    Bun.sleep(2_000).then(() => ({ status: 'deadline' as const })),
  ]);
  if (outcome.status === 'deadline') {
    child.kill('SIGKILL');
    await child.exited;
    children.delete(child);
    throw new Error(
      `Fixture '${lane}:${mode}:${args.join(':')}' exceeded its hard deadline`
    );
  }
  children.delete(child);
  return {
    ...outcome,
    value: JSON.parse(outcome.stdout.trim()) as Record<string, unknown>,
  };
}

async function runSchemaFixture(
  lane: Lane,
  getterMode: SchemaGetterMode,
  path: SchemaPath,
  selectedCase: SchemaCaseName | 'all'
): Promise<SchemaFixtureResult> {
  try {
    const result = await runFixture(
      'schema',
      [getterMode, path, selectedCase],
      lane
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    return result.value as unknown as SchemaFixtureResult;
  } finally {
    expectParentPrototypeRestored();
  }
}

function expectSchemaResults(
  result: SchemaFixtureResult,
  expectedNames: readonly SchemaCaseName[]
): void {
  expect(result.results.map(({ name }) => name)).toEqual([...expectedNames]);
  for (const item of result.results) {
    expect(item.getterReads, `${result.path}:${item.name}`).toBe(0);
    expect(item.restored, `${result.path}:${item.name}`).toBe(true);
    if (result.path === 'control' || result.path === 'required-optional') {
      expect(item.kind, `${result.path}:${item.name}`).toBe('success-control');
      if (item.kind !== 'success-control') {
        throw new Error('expected a success-only schema control');
      }
      expect(item.success, `${result.path}:${item.name}`).toBe(true);
      continue;
    }

    expect(item.kind, `${result.path}:${item.name}`).toBe(
      'host-boundary-failure'
    );
    if (item.kind !== 'host-boundary-failure') {
      throw new Error('expected an actual host-boundary failure');
    }
    expect(item.failureCount, `${result.path}:${item.name}`).toBe(2);
    expect(item.failureTags, `${result.path}:${item.name}`).toEqual([
      item.expectedTag,
      item.expectedTag,
    ]);
    expect(item.causeTags, `${result.path}:${item.name}`).toEqual([
      'Fail',
      'Fail',
    ]);
    expect(item.defects, `${result.path}:${item.name}`).toBe(0);
    expect(item.attackerRetained, `${result.path}:${item.name}`).toBe(false);
    expect(item.attackerCauseRetained, `${result.path}:${item.name}`).toBe(
      false
    );
    expect(item.candidateRetained, `${result.path}:${item.name}`).toBe(false);
    expect(item.attackerTextRetained, `${result.path}:${item.name}`).toBe(
      false
    );
    expect(item.fresh, `${result.path}:${item.name}`).toBe(true);
  }
}

async function runArrayPrototypeFixture(
  lane: Lane,
  hook: ArrayPrototypeHook,
  behavior: PrototypeBehavior,
  selectedCase: OperationArrayCaseName | 'all'
): Promise<ArrayPrototypeFixtureResult> {
  try {
    const result = await runFixture(
      'array-prototype',
      [hook, behavior, selectedCase],
      lane
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    return result.value as unknown as ArrayPrototypeFixtureResult;
  } finally {
    expectParentPrototypeRestored();
  }
}

function expectArrayPrototypeResults(
  result: ArrayPrototypeFixtureResult,
  expectedNames: readonly OperationArrayCaseName[]
): void {
  expect(result.results.map(({ name }) => name)).toEqual([...expectedNames]);
  for (const item of result.results) {
    const label = `${result.hook}:${result.behavior}:${item.name}`;
    expect(item.validSuccessCount, label).toBe(2);
    expect(item.outputCount, label).toBe(2);
    expect(item.outputsAreDenseFrozenArrays, label).toBe(true);
    expect(item.hookCalls, label).toBe(0);
    expect(item.reachabilityCalls, label).toBe(
      result.hook === 'iterator-accessor' ? 2 : 0
    );
    expect(item.failureCount, label).toBe(2);
    expect(item.failureTags, label).toEqual([
      'InvalidPullRequestProviderOperationResultError',
      'InvalidPullRequestProviderOperationResultError',
    ]);
    expect(item.causeTags, label).toEqual(['Fail', 'Fail']);
    expect(item.defects, label).toBe(0);
    expect(item.fresh, label).toBe(true);
    expect(item.attackerRetained, label).toBe(false);
    expect(item.attackerCauseRetained, label).toBe(false);
    expect(item.candidateRetained, label).toBe(false);
    expect(item.attackerTextRetained, label).toBe(false);
    expect(item.restored, label).toBe(true);
  }
}

async function runProviderSelectionFlatFixture(
  lane: Lane,
  behavior: PrototypeBehavior
): Promise<ProviderSelectionFlatFixtureResult> {
  try {
    const result = await runFixture(
      'provider-selection-flat',
      [behavior],
      lane
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    return result.value as unknown as ProviderSelectionFlatFixtureResult;
  } finally {
    expectParentPrototypeRestored();
  }
}

function expectProviderSelectionFlatResults(
  result: ProviderSelectionFlatFixtureResult
): void {
  expect(result.attempts.map(({ attempt }) => attempt)).toEqual([0, 1]);
  for (const item of result.attempts) {
    const label = `${result.behavior}:${item.attempt}`;
    expect(item.matcherCalls, label).toBe(1);
    expect(item.hookCalls, label).toBe(0);
    expect(item.reachabilityCalls, label).toBe(1);
    expect(item.success, label).toBe(true);
    expect(item.providerId, label).toBe('deadline-pr-capture');
    expect(item.priority, label).toBe(100);
    expect(item.failureTags, label).toEqual([]);
    expect(item.defects, label).toBe(0);
    expect(item.attackerRetained, label).toBe(false);
    expect(item.attackerTextRetained, label).toBe(false);
    expect(item.restored, label).toBe(true);
  }
}

async function runProviderContinuationFixture(
  lane: Lane,
  behavior: PrototypeBehavior,
  selectedCase: ProviderContinuationCase
): Promise<ProviderContinuationFixtureResult> {
  try {
    const result = await runFixture(
      'provider-selection-continuation',
      [behavior, selectedCase],
      lane
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    return result.value as unknown as ProviderContinuationFixtureResult;
  } finally {
    expectParentPrototypeRestored();
  }
}

function expectProviderContinuationResults(
  result: ProviderContinuationFixtureResult
): void {
  expect(result.attempts.map(({ attempt }) => attempt)).toEqual([0, 1]);
  const ambiguityCase =
    result.selectedCase === 'tie-filter' || result.selectedCase === 'map';
  const operationCase =
    result.selectedCase === 'operation-filter-remote' ||
    result.selectedCase === 'operation-filter-repository';
  const expectedProviderId =
    result.selectedCase === 'preferred-filter'
      ? 'continuation-first'
      : result.selectedCase === 'iterator' || result.selectedCase === 'sort'
        ? 'continuation-second'
        : null;
  const expectedOperation =
    result.selectedCase === 'iterator' ||
    result.selectedCase === 'sort' ||
    result.selectedCase === 'map'
      ? result.selectedCase
      : 'filter';
  for (const item of result.attempts) {
    const label = `${result.selectedCase}:${result.behavior}:${item.attempt}`;
    expect(item.selectedCase, label).toBe(result.selectedCase);
    expect(item.operation, label).toBe(expectedOperation);
    expect(item.externalCalls, label).toBe(2);
    expect(item.hookCalls, label).toBe(0);
    expect(item.reachabilityCalls, label).toBe(1);
    expect(item.success, label).toBe(!ambiguityCase);
    expect(item.providerId, label).toBe(expectedProviderId);
    expect(item.operationTitle, label).toBe(
      operationCase ? 'selected-operation-provider' : null
    );
    expect(item.failureTag, label).toBe(
      ambiguityCase ? 'AmbiguousPullRequestProviderError' : undefined
    );
    expect(item.causeTag, label).toBe(ambiguityCase ? 'Fail' : null);
    expect(item.defects, label).toBe(0);
    expect(item.typedAmbiguity, label).toBe(ambiguityCase);
    expect(item.ambiguityPriority, label).toBe(ambiguityCase ? 100 : null);
    expect(item.ambiguityCandidates, label).toEqual(
      ambiguityCase
        ? [
            'provider-continuation-plugin-first/continuation-first@100',
            'provider-continuation-plugin-second/continuation-second@100',
          ]
        : []
    );
    expect(item.ambiguityMessage, label).toBe(
      ambiguityCase
        ? 'Multiple pull request providers matched git-remote: ssh://provider-continuation/repository.git (provider-continuation-plugin-first/continuation-first, provider-continuation-plugin-second/continuation-second)'
        : null
    );
    expect(item.attackerRetained, label).toBe(false);
    expect(item.attackerTextRetained, label).toBe(false);
    expect(item.restored, label).toBe(true);
  }
}

async function runFeaturePrototypeFixture(
  lane: Lane,
  behavior: PrototypeBehavior,
  selectedKey: FeatureKey | 'all'
): Promise<FeaturePrototypeFixtureResult> {
  try {
    const result = await runFixture(
      'feature-prototype',
      [behavior, selectedKey],
      lane
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    return result.value as unknown as FeaturePrototypeFixtureResult;
  } finally {
    expectParentPrototypeRestored();
  }
}

function expectFeaturePrototypeResults(
  result: FeaturePrototypeFixtureResult,
  expectedKeys: readonly FeatureKey[]
): void {
  expect(result.results.map(({ key }) => key)).toEqual([...expectedKeys]);
  for (const item of result.results) {
    const label = `${result.behavior}:${item.key}`;
    expect(item.successCount, label).toBe(2);
    expect(item.successFeaturesAreFrozenNullPrototype, label).toBe(true);
    expect(item.getterReads, label).toBe(0);
    expect(item.directFailureCount, label).toBe(2);
    expect(item.directFailureTags, label).toEqual([
      'InvalidPullRequestProviderMatchError',
      'InvalidPullRequestProviderMatchError',
    ]);
    expect(item.directCauseTags, label).toEqual(['Fail', 'Fail']);
    expect(item.directDefects, label).toBe(0);
    expect(item.directFresh, label).toBe(true);
    expect(item.registrationFailureCount, label).toBe(2);
    expect(item.registrationMessages, label).toEqual([
      'External plugin metadata capture failed',
      'External plugin metadata capture failed',
    ]);
    expect(item.registrationFresh, label).toBe(true);
    expect(item.registrationAtomic, label).toBe(true);
    expect(item.attackerRetained, label).toBe(false);
    expect(item.attackerCauseRetained, label).toBe(false);
    expect(item.candidateRetained, label).toBe(false);
    expect(item.attackerTextRetained, label).toBe(false);
    expect(item.restored, label).toBe(true);
  }
}

describe('public PR result structural capture subprocess probes', () => {
  for (const mode of [
    'proxy-ownkeys',
    'proxy-prototype',
    'iterator-accessor',
    'custom-prototype-iterator',
  ] satisfies readonly Mode[]) {
    test(`contains ${mode} under a real hard deadline`, async () => {
      const result = await runFixture(mode);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.value).toEqual({
        mode,
        typed: true,
        defects: 0,
        trapCalls: 0,
        iteratorCalls: 0,
      });
    }, 4_000);
  }

  for (const mode of [
    'matcher-failure-accessor',
    'matcher-failure-proxy',
    'operation-failure-accessor',
    'operation-failure-proxy',
  ] satisfies readonly Mode[]) {
    test(`renders ${mode} without inspecting the genuine failure`, async () => {
      const result = await runFixture(mode);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.value).toEqual({
        mode,
        typed: true,
        defects: 0,
        causeContract: true,
        fixedMessage: true,
        messageReads: 0,
        trapCalls: 0,
        iteratorCalls: 0,
      });
    }, 4_000);
  }
});

describe('PR result array prototype isolation subprocess probes', () => {
  for (const lane of ['source', 'native'] as const satisfies readonly Lane[]) {
    for (const hook of [
      'numeric-setter',
      'iterator-accessor',
      'method-accessor',
    ] as const satisfies readonly ArrayPrototypeHook[]) {
      for (const behavior of [
        'returning',
        'throwing',
      ] as const satisfies readonly PrototypeBehavior[]) {
        test(`${lane} ignores ${behavior} inherited ${hook} hooks at every operation array site`, async () => {
          const result = await runArrayPrototypeFixture(
            lane,
            hook,
            behavior,
            'all'
          );
          expectArrayPrototypeResults(result, operationArrayCaseNames);
        }, 10_000);
      }

      test(`${lane} isolates every non-returning inherited ${hook} operation-array tuple`, async () => {
        const outcomes = await Promise.allSettled(
          operationArrayCaseNames.map(async (arrayCase) => {
            const result = await runArrayPrototypeFixture(
              lane,
              hook,
              'slow',
              arrayCase
            );
            expectArrayPrototypeResults(result, [arrayCase]);
          })
        );
        const rejected = outcomes.filter(
          (outcome): outcome is PromiseRejectedResult =>
            outcome.status === 'rejected'
        );
        expect(
          rejected.map(({ reason }) =>
            reason instanceof Error ? reason.message : String(reason)
          )
        ).toEqual([]);
      }, 15_000);
    }
  }
});

describe('PR provider-selection Array.prototype.flat isolation subprocess probes', () => {
  for (const lane of ['source', 'native'] as const satisfies readonly Lane[]) {
    for (const behavior of [
      'returning',
      'throwing',
      'slow',
    ] as const satisfies readonly PrototypeBehavior[]) {
      test(`${lane} ignores a ${behavior} flat accessor installed by an external matcher`, async () => {
        const result = await runProviderSelectionFlatFixture(lane, behavior);
        expectProviderSelectionFlatResults(result);
      }, 10_000);
    }
  }
});

describe('PR provider-selection continuation isolation subprocess probes', () => {
  for (const lane of ['source', 'native'] as const satisfies readonly Lane[]) {
    for (const selectedCase of [
      'preferred-filter',
      'iterator',
      'sort',
      'tie-filter',
      'map',
    ] as const satisfies readonly ProviderContinuationCase[]) {
      for (const behavior of [
        'returning',
        'throwing',
        'slow',
      ] as const satisfies readonly PrototypeBehavior[]) {
        test(`${lane} ignores a ${behavior} ${selectedCase} accessor installed by an external matcher`, async () => {
          const result = await runProviderContinuationFixture(
            lane,
            behavior,
            selectedCase
          );
          expectProviderContinuationResults(result);
        }, 10_000);
      }
    }
  }
});

describe('PR operation-selection continuation isolation subprocess probes', () => {
  for (const lane of ['source', 'native'] as const satisfies readonly Lane[]) {
    for (const selectedCase of [
      'operation-filter-remote',
      'operation-filter-repository',
    ] as const satisfies readonly ProviderContinuationCase[]) {
      for (const behavior of [
        'returning',
        'throwing',
        'slow',
      ] as const satisfies readonly PrototypeBehavior[]) {
        test(`${lane} ignores a ${behavior} filter at the deeper ${selectedCase} lookup`, async () => {
          const result = await runProviderContinuationFixture(
            lane,
            behavior,
            selectedCase
          );
          expectProviderContinuationResults(result);
        }, 10_000);
      }
    }
  }
});

describe('PR feature Object.prototype isolation subprocess probes', () => {
  for (const lane of ['source', 'native'] as const satisfies readonly Lane[]) {
    for (const behavior of [
      'returning',
      'throwing',
    ] as const satisfies readonly PrototypeBehavior[]) {
      test(`${lane} ignores ${behavior} inherited accessors for every optional feature`, async () => {
        const result = await runFeaturePrototypeFixture(lane, behavior, 'all');
        expectFeaturePrototypeResults(result, featureKeys);
      }, 10_000);
    }

    test(`${lane} isolates every non-returning inherited optional-feature accessor tuple`, async () => {
      const outcomes = await Promise.allSettled(
        featureKeys.map(async (featureKey) => {
          const result = await runFeaturePrototypeFixture(
            lane,
            'slow',
            featureKey
          );
          expectFeaturePrototypeResults(result, [featureKey]);
        })
      );
      const rejected = outcomes.filter(
        (outcome): outcome is PromiseRejectedResult =>
          outcome.status === 'rejected'
      );
      expect(
        rejected.map(({ reason }) =>
          reason instanceof Error ? reason.message : String(reason)
        )
      ).toEqual([]);
    }, 15_000);
  }
});

describe('PR schema own-data lookup subprocess probes', () => {
  test('source invariant only: the prospective schema depth ceiling is 8 and accounting rejects only greater depths', async () => {
    const source = await readFile(resolverPath, 'utf8');
    const accountStart = source.indexOf('function accountPullRequestCapture(');
    const accountEnd = source.indexOf('\n}\n', accountStart) + 2;
    expect(accountStart).toBeGreaterThan(-1);
    expect(accountEnd).toBeGreaterThan(accountStart);
    expect(source).toContain('const MAX_PR_RESULT_DEPTH = 8;');
    expect(source.slice(accountStart, accountEnd)).toContain(
      'if (depth > MAX_PR_RESULT_DEPTH) failPullRequestCapture();'
    );
    expect(source).not.toContain('pullRequestPublicResultDepthAcceptedForTest');
  });

  test('source invariant: the public command adapter has no raw Cause reader/storage seam', async () => {
    const source = await readFile(commandErrorPath, 'utf8');
    expect(source).not.toContain('pullRequestCommandEffectCause');
    expect(source).not.toContain('pullRequestCommandEffectCauses');
    expect(source).toContain(
      "onFailure: (cause) => ({ kind: 'failure' as const, cause })"
    );
    expect(source).toContain(
      'throw new PullRequestCommandEffectError(outcome.cause);'
    );
  });

  test('source invariant: required nodes are own false, optional nodes are own true, and top-level lookup is descriptor-only and fail-closed', async () => {
    const source = await readFile(resolverPath, 'utf8');
    const requiredStart = source.indexOf('function requiredCaptureField(');
    const requiredEnd = source.indexOf('\n}\n', requiredStart) + 2;
    const optionalStart = source.indexOf('function optionalCaptureField(');
    const optionalEnd = source.indexOf('\n}\n', optionalStart) + 2;
    const captureStart = source.indexOf(
      'function capturePullRequestPublicStructure('
    );
    const captureEnd = source.indexOf(
      '\n}\n\nfunction guardPullRequestOperationValidation',
      captureStart
    );
    expect(requiredStart).toBeGreaterThan(-1);
    expect(optionalStart).toBeGreaterThan(-1);
    expect(captureStart).toBeGreaterThan(-1);
    expect(captureEnd).toBeGreaterThan(captureStart);
    expect(source.slice(requiredStart, requiredEnd)).toContain(
      'immutablePullRequestCaptureRecord({ schema, optional: false })'
    );
    expect(source.slice(optionalStart, optionalEnd)).toContain(
      'immutablePullRequestCaptureRecord({ schema, optional: true })'
    );
    const captureBody = source.slice(captureStart, captureEnd);
    expect(captureBody).toContain(
      'const schema = ownPullRequestDataValue(\n      pullRequestCaptureSchemas,\n      schemaName\n    );'
    );
    expect(captureBody).toContain(
      'if (schema === missingPullRequestOwnData) failPullRequestCapture();'
    );
    expect(captureBody).not.toMatch(/pullRequestCaptureSchemas\s*\[/u);
    expect(source).not.toContain(
      'pullRequestPublicResultCaptureAcceptedForTest'
    );
  });

  for (const lane of ['source', 'native'] as const satisfies readonly Lane[]) {
    test(`${lane} admits controls for all eleven schemas and all matcher paths`, async () => {
      const result = await runSchemaFixture(
        lane,
        'returning',
        'control',
        'all'
      );
      expectSchemaResults(result, schemaCaseNames);
    }, 10_000);

    for (const getterMode of [
      'returning',
      'throwing',
    ] as const satisfies readonly SchemaGetterMode[]) {
      for (const path of [
        'root-field',
        'nested-field',
        'variant',
        'required-optional',
      ] as const satisfies readonly SchemaPath[]) {
        test(`${lane} ${getterMode} inherited getter is never read for ${path}`, async () => {
          const result = await runSchemaFixture(lane, getterMode, path, 'all');
          expectSchemaResults(
            result,
            path === 'root-field' ? schemaCaseNames : nestedSchemaCaseNames
          );
        }, 10_000);
      }
    }

    for (const [path, cases] of [
      ['root-field', schemaCaseNames],
      ['nested-field', nestedSchemaCaseNames],
      ['variant', nestedSchemaCaseNames],
      ['required-optional', nestedSchemaCaseNames],
    ] as const satisfies readonly (readonly [
      SchemaPath,
      readonly SchemaCaseName[],
    ])[]) {
      test(`${lane} isolates every slow inherited getter tuple for ${path}`, async () => {
        const outcomes = await Promise.allSettled(
          cases.map(async (schemaCase) => {
            const result = await runSchemaFixture(
              lane,
              'slow',
              path,
              schemaCase
            );
            expectSchemaResults(result, [schemaCase]);
          })
        );
        const rejected = outcomes.filter(
          (outcome): outcome is PromiseRejectedResult =>
            outcome.status === 'rejected'
        );
        expect(
          rejected.map(({ reason }) =>
            reason instanceof Error ? reason.message : String(reason)
          )
        ).toEqual([]);
      }, 15_000);
    }
  }
});
