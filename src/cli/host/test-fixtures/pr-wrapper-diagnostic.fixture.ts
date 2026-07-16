import {
  AmbiguousPullRequestProviderError,
  InvalidPullRequestProviderMatchError,
  InvalidPullRequestProviderOperationResultError,
  PullRequestProviderInvocationError,
  PullRequestProviderOperationError,
  PullRequestProviderOperationTimeoutError,
  PullRequestProviderTimeoutError,
  UnsupportedPullRequestProviderError,
  UnsupportedPullRequestProviderOperationError,
} from '@cli/host/pull-request-provider-resolver.js';
import { renderTopLevelError } from '@cli/index.js';
import { handlePullRequestCommandError } from '@cli/plugins/pull-requests/commands/error.js';

const generic = 'Error: Unknown error occurred';
const exitSignal = Object.freeze({});
let reads = 0;

function hang(): never {
  reads += 1;
  for (;;) {
    // The parent hard deadline proves no hostile hook is reached.
  }
}

function directResolverErrors(): unknown[] {
  return [
    new UnsupportedPullRequestProviderError({
      source: 'git-remote',
      value: 'SECRET-DIRECT-UNSUPPORTED',
    }),
    new AmbiguousPullRequestProviderError({
      source: 'git-remote',
      value: 'SECRET-DIRECT-AMBIGUOUS',
      priority: 100,
      candidates: [],
    }),
    new InvalidPullRequestProviderMatchError({
      source: 'git-remote',
      value: 'SECRET-DIRECT-INVALID-MATCH',
      pluginId: 'attacker-plugin',
      providerId: 'attacker-provider',
      reason: 'SECRET-DIRECT-REASON',
    }),
    new PullRequestProviderInvocationError({
      source: 'git-remote',
      value: 'SECRET-DIRECT-INVOCATION',
      pluginId: 'attacker-plugin',
      providerId: 'attacker-provider',
      cause: null,
    }),
    new PullRequestProviderTimeoutError({
      source: 'git-remote',
      value: 'SECRET-DIRECT-TIMEOUT',
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
      reason: 'SECRET-DIRECT-RESULT-REASON',
    }),
    new PullRequestProviderOperationError({
      pluginId: 'attacker-plugin',
      providerId: 'attacker-provider',
      operation: 'updatePullRequest',
      cause: null,
    }),
    new PullRequestProviderOperationTimeoutError({
      pluginId: 'attacker-plugin',
      providerId: 'attacker-provider',
      operation: 'getPullRequestDiff',
    }),
  ];
}

function operationError(): PullRequestProviderOperationError {
  return new PullRequestProviderOperationError({
    pluginId: 'attacker-plugin',
    providerId: 'attacker-provider',
    operation: 'updatePullRequest',
    cause: null,
  });
}

class ResolverLookalike {
  readonly _tag = 'PullRequestProviderOperationError';
  readonly message = 'SECRET-FORGED-CLASS';
}

class ResolverSubclass extends PullRequestProviderOperationError {
  override get message(): string {
    reads += 1;
    return 'SECRET-SUBCLASS';
  }
}

const prototypeChanged = operationError();
Object.setPrototypeOf(prototypeChanged, null);

const proxyTarget = operationError();
const hostileProxy = new Proxy(proxyTarget, {
  get: hang,
  getOwnPropertyDescriptor: hang,
  getPrototypeOf: hang,
  ownKeys: hang,
});

const returningGetter = operationError();
Object.defineProperty(returningGetter, 'message', {
  configurable: true,
  get() {
    reads += 1;
    return 'SECRET-RETURNING-GETTER';
  },
});
Object.defineProperty(returningGetter, 'name', {
  configurable: true,
  get() {
    reads += 1;
    return 'SECRET-RETURNING-NAME';
  },
});

const throwingGetter = operationError();
Object.defineProperty(throwingGetter, 'message', {
  configurable: true,
  get() {
    reads += 1;
    throw new Error('SECRET-THROWING-GETTER');
  },
});
Object.defineProperty(throwingGetter, 'name', {
  configurable: true,
  get() {
    reads += 1;
    throw new Error('SECRET-THROWING-NAME');
  },
});

const infiniteGetter = operationError();
Object.defineProperty(infiniteGetter, 'message', { get: hang });
Object.defineProperty(infiniteGetter, 'name', { get: hang });

const spread = { ...operationError() };
const clone = Object.assign(Object.create(null), spread);
const structured = structuredClone(spread);

const hostileCoercion = Object.freeze({
  _tag: 'PullRequestProviderOperationError',
  get message() {
    return hang();
  },
  toString: hang,
  [Symbol.toPrimitive]: hang,
});

const probes: unknown[] = [
  ...directResolverErrors(),
  new ResolverSubclass({
    pluginId: 'attacker-plugin',
    providerId: 'attacker-provider',
    operation: 'updatePullRequest',
    cause: null,
  }),
  prototypeChanged,
  hostileProxy,
  new Proxy(operationError(), { ownKeys: hang }),
  new Proxy(operationError(), { getOwnPropertyDescriptor: hang }),
  new Proxy(operationError(), { getPrototypeOf: hang }),
  spread,
  clone,
  structured,
  Object.freeze({
    _tag: 'PullRequestProviderOperationError',
    message: 'SECRET-LOOKALIKE',
  }),
  new ResolverLookalike(),
  returningGetter,
  throwingGetter,
  infiniteGetter,
  hostileCoercion,
  Object.assign(function forgedResolverError() {}, {
    _tag: 'PullRequestProviderOperationError',
  }),
];

const topLevel: string[] = [];
const handled: string[] = [];
const originalError = console.error;
const originalExit = process.exit;

try {
  for (const probe of probes) {
    topLevel.push(renderTopLevelError(probe));

    let line: string | undefined;
    console.error = (value?: unknown) => {
      if (typeof value !== 'string') throw new Error('non-string stderr');
      line = value;
    };
    process.exit = ((code?: number) => {
      if (code !== 1) throw new Error('unexpected exit code');
      throw exitSignal;
    }) as typeof process.exit;
    try {
      handlePullRequestCommandError(probe);
    } catch (error) {
      if (error !== exitSignal) throw error;
    } finally {
      console.error = originalError;
      process.exit = originalExit;
    }
    if (line === undefined) throw new Error('missing handler output');
    handled.push(line);
  }
} finally {
  console.error = originalError;
  process.exit = originalExit;
}

process.stdout.write(
  `${JSON.stringify({
    count: probes.length,
    topLevelGeneric: topLevel.every((value) => value === generic),
    handledGeneric: handled.every((value) => value === generic),
    reads,
    leaked: [...topLevel, ...handled].some((value) => value.includes('SECRET')),
  })}\n`
);
