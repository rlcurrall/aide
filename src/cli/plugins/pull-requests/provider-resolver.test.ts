import { describe, expect, test } from 'bun:test';
import { Cause, Context, Effect, Exit } from 'effect';
import { inspect } from 'node:util';

import {
  createCommandRegistry,
  createKeyringCommandRegistry,
  type PluginCapability,
} from '@cli/host/command-registry.js';
import {
  createAideHostServices,
  type AideHostServices,
} from '@cli/host/runtime-context.js';
import {
  defineAidePlugin,
  type AidePullRequestProviderCapability as AidePullRequestProviderCapabilityShape,
  type AidePullRequestRemoteMatch,
  type AidePullRequestUrlMatch,
} from '@cli/host/plugin-descriptor.js';
import { createAzureDevOpsPlugin } from '@cli/plugins/azure-devops/plugin.js';
import { createBuiltinCommandRegistry } from '@cli/plugins/builtin.js';
import { createGitHubPlugin } from '@cli/plugins/github/plugin.js';
import type { AzureDevOpsClient } from '@lib/azure-devops-client.js';
import type { GitHubClient } from '@lib/github-client.js';
import { makeTestKeyring } from '@lib/auth-keyring.test-helper.js';
import { loadAzureDevOpsConfig } from '@lib/config.js';
import {
  installMockSecrets,
  restoreEnv,
  saveEnv,
  type Store,
} from '@lib/test-helpers.js';
import type {
  GitHubIssueComment,
  GitHubPullRequest,
  GitHubReviewComment,
} from '@lib/github-types.js';
import type {
  AzureDevOpsCreateCommentResponse,
  AzureDevOpsPullRequest,
  CreateThreadResponse,
} from '@lib/types.js';

type AidePullRequestProviderCapability = Omit<
  AidePullRequestProviderCapabilityShape<unknown>,
  'authStatus'
>;
type ServiceFreePullRequestProviderCapability =
  AidePullRequestProviderCapabilityShape<never>;

class NonKeyringPullRequestAuth extends Context.Tag(
  'aide.test.NonKeyringPullRequestAuth'
)<NonKeyringPullRequestAuth, { readonly configured: boolean }>() {}

import {
  platformContextFromPullRequestProvider,
  resolvePullRequestPlatformContextForRemote,
} from './provider-context.js';
import {
  AmbiguousPullRequestProviderError,
  InvalidPullRequestProviderMatchError,
  InvalidPullRequestProviderOperationResultError,
  PullRequestProviderMutationIndeterminateError,
  PullRequestProviderOperationError,
  PullRequestProviderOperationTimeoutError,
  PullRequestProviderInvocationError,
  PullRequestProviderTimeoutError,
  UnsupportedPullRequestProviderOperationError,
  UnsupportedPullRequestProviderError,
  addPullRequestCommentForRemote,
  addPullRequestCommentForRepository,
  addPullRequestCommentForUrl,
  createPullRequestForRemote,
  createPullRequestForRepository,
  findPullRequestForBranchForRemote,
  findPullRequestForBranchForRepository,
  getPullRequestContextForRemote,
  getPullRequestDiffForRemote,
  getPullRequestDiffForRepository,
  getPullRequestDiffForUrl,
  getPullRequestForRemote,
  getPullRequestForRepository,
  getPullRequestForUrl,
  listPullRequestCommentsForRemote,
  listPullRequestCommentsForRepository,
  listPullRequestCommentsForUrl,
  listPullRequestsForRemote,
  listPullRequestsForRepository,
  replyToPullRequestCommentForRemote,
  replyToPullRequestCommentForRepository,
  replyToPullRequestCommentForUrl,
  resolvePullRequestProviderForRemote,
  resolvePullRequestProviderForRepository,
  resolvePullRequestProviderForRepositoryInput,
  resolvePullRequestProviderForUrl,
  resolvePullRequestProviderFromRegistryForRemote,
  resolvePullRequestProviderFromRegistryForRepositoryInput,
  resolvePullRequestProviderFromRegistryForUrl,
  pullRequestProviderErrorMessage,
  updatePullRequestForRemote,
  updatePullRequestForRepository,
} from './provider-resolver.js';

function externalRepository(
  providerId: string,
  metadata?: Readonly<Record<string, string | number | boolean>>
) {
  return {
    kind: 'external',
    providerId,
    displayName: providerId,
    ...(metadata === undefined ? {} : { metadata }),
  } as const;
}

function fakeGitHubPullRequest(
  overrides: Omit<Partial<GitHubPullRequest>, 'user'> & {
    readonly number: number;
    readonly title: string;
    readonly userLogin?: string;
  }
): GitHubPullRequest {
  const { number, title, userLogin, ...prOverrides } = overrides;
  const login = userLogin ?? 'octocat';
  return {
    number,
    node_id: `PR_${number}`,
    title,
    body: 'body',
    state: 'open',
    draft: false,
    merged: false,
    merged_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
    closed_at: null,
    head: {
      ref: 'feature',
      sha: 'abc',
      label: `${login}:feature`,
    },
    base: {
      ref: 'main',
      sha: 'def',
      label: 'acme:main',
    },
    labels: [],
    html_url: `https://github.com/acme/widgets/pull/${number}`,
    ...prOverrides,
    user: {
      login,
      id: userLogin === undefined ? 1 : 2,
    },
  };
}

function fakeAzureDevOpsPullRequest(
  overrides: Partial<AzureDevOpsPullRequest> & {
    readonly pullRequestId: number;
    readonly title: string;
  }
): AzureDevOpsPullRequest {
  const { pullRequestId, title, ...prOverrides } = overrides;
  return {
    pullRequestId,
    title,
    description: 'description',
    status: 'active',
    isDraft: false,
    createdBy: {
      displayName: 'Ada Lovelace',
      uniqueName: 'ada@example.com',
      id: 'ada',
    },
    creationDate: '2026-01-01T00:00:00Z',
    repository: {
      id: 'repo-id',
      name: 'widgets',
      project: {
        id: 'project-id',
        name: 'Platform',
      },
    },
    ...prOverrides,
  };
}

function fakeGitHubIssueComment(
  overrides: Partial<GitHubIssueComment> = {}
): GitHubIssueComment {
  return {
    id: 9001,
    user: { login: 'octocat', id: 1 },
    body: 'comment body',
    created_at: '2026-01-03T00:00:00Z',
    updated_at: '2026-01-03T00:00:00Z',
    html_url: 'https://github.com/acme/widgets/pull/7#issuecomment-9001',
    ...overrides,
  };
}

function fakeGitHubReviewComment(
  overrides: Partial<GitHubReviewComment> = {}
): GitHubReviewComment {
  return {
    id: 9002,
    user: { login: 'octocat', id: 1 },
    body: 'review body',
    path: 'src/index.ts',
    line: 12,
    original_line: 12,
    start_line: null,
    side: 'RIGHT',
    created_at: '2026-01-03T00:00:00Z',
    updated_at: '2026-01-03T00:00:00Z',
    html_url: 'https://github.com/acme/widgets/pull/7#discussion_r9002',
    commit_id: 'abc',
    ...overrides,
  };
}

function fakeAzureDevOpsThread(
  overrides: Partial<CreateThreadResponse> = {}
): CreateThreadResponse {
  return {
    id: 77,
    publishedDate: '2026-01-03T00:00:00Z',
    lastUpdatedDate: '2026-01-03T00:00:00Z',
    status: 'active',
    comments: [
      {
        id: 11,
        parentCommentId: 0,
        author: {
          displayName: 'Ada Lovelace',
          uniqueName: 'ada@example.com',
          id: 'ada',
        },
        content: 'thread comment',
        publishedDate: '2026-01-03T00:00:00Z',
        lastUpdatedDate: '2026-01-03T00:00:00Z',
        lastContentUpdatedDate: '2026-01-03T00:00:00Z',
        commentType: 'text',
      },
    ],
    ...overrides,
  };
}

function fakeAzureDevOpsCreatedComment(
  overrides: Partial<AzureDevOpsCreateCommentResponse> = {}
): AzureDevOpsCreateCommentResponse {
  return {
    id: 12,
    parentCommentId: 0,
    author: {
      displayName: 'Ada Lovelace',
      uniqueName: 'ada@example.com',
      id: 'ada',
    },
    content: 'reply comment',
    publishedDate: '2026-01-03T00:00:00Z',
    lastUpdatedDate: '2026-01-03T00:00:00Z',
    lastContentUpdatedDate: '2026-01-03T00:00:00Z',
    commentType: 'text',
    ...overrides,
  };
}

function fakeProvider(
  pluginId: string,
  providerId: string,
  priority: number,
  remoteMatch?: AidePullRequestRemoteMatch,
  pullRequestUrlMatch?: AidePullRequestUrlMatch
): PluginCapability<ServiceFreePullRequestProviderCapability> {
  return {
    pluginId,
    capability: fakeProviderCapability(
      providerId,
      priority,
      remoteMatch,
      pullRequestUrlMatch
    ),
  };
}

function fakeProviderCapability(
  providerId: string,
  priority: number,
  remoteMatch?: AidePullRequestRemoteMatch,
  pullRequestUrlMatch?: AidePullRequestUrlMatch
): ServiceFreePullRequestProviderCapability {
  return {
    providerId,
    priority,
    features: {},
    authStatus: () => Effect.succeed({ state: 'configured' }),
    matchRemote: () =>
      remoteMatch ?? {
        source: 'git-remote',
        priority,
        repository: externalRepository(providerId),
      },
    matchPullRequestUrl: () =>
      pullRequestUrlMatch ?? {
        source: 'pull-request-url',
        priority,
        repository: externalRepository(providerId),
        pullRequest: { number: 1 },
      },
  };
}

function malformedProvider(
  pluginId: string,
  providerId: string,
  priority: number,
  matches: {
    readonly remote?: () => unknown;
    readonly pullRequestUrl?: () => unknown;
  }
): PluginCapability<ServiceFreePullRequestProviderCapability> {
  return {
    pluginId,
    capability: {
      providerId,
      priority,
      features: {},
      authStatus: () => Effect.succeed({ state: 'configured' }),
      matchRemote: () =>
        (matches.remote === undefined
          ? null
          : matches.remote()) as AidePullRequestRemoteMatch | null,
      matchPullRequestUrl: () =>
        (matches.pullRequestUrl === undefined
          ? null
          : matches.pullRequestUrl()) as AidePullRequestUrlMatch | null,
    },
  };
}

function pluginWithPullRequestProvider(pluginId: string, providerId: string) {
  return defineAidePlugin({
    id: pluginId,
    summary: `${pluginId} provider`,
    commands: [],
    capabilities: {
      pullRequestProvider: fakeProviderCapability(providerId, 50),
    },
  });
}

function hostServicesForProviders(
  providers: readonly PluginCapability<AidePullRequestProviderCapability>[]
): Pick<
  AideHostServices,
  'resolvePullRequestProviderForRemote' | 'resolvePullRequestProviderForUrl'
> {
  return {
    resolvePullRequestProviderForRemote: (remoteUrl, options = {}) =>
      resolvePullRequestProviderForRemote(providers, remoteUrl, options),
    resolvePullRequestProviderForUrl: (url, options = {}) =>
      resolvePullRequestProviderForUrl(providers, url, options),
  };
}

function expectLookupSecretsAbsent(
  error: unknown,
  secrets: readonly string[]
): void {
  const failure = error as Error & {
    readonly cause?: unknown;
    readonly value?: unknown;
  };
  const cause = Cause.fail(error);
  const surfaces = [
    typeof failure.value === 'string' ? failure.value : '',
    failure.message,
    String(error),
    JSON.stringify(error),
    inspect(error, { depth: 12 }),
    failure.cause === undefined ? '' : inspect(failure.cause, { depth: 12 }),
    Cause.pretty(cause),
    JSON.stringify(cause),
    inspect(cause, { depth: 12 }),
    pullRequestProviderErrorMessage(error) ?? '',
  ];

  for (const secret of secrets) {
    for (const surface of surfaces) {
      expect(surface).not.toContain(secret);
    }
  }
}

const ambiguousScpLookupCases = [
  {
    name: 'nested userinfo in the retained path',
    value:
      'TODO160-SCP-OUTER-USER@example.invalid:org/TODO160-SCP-INNER-USER:TODO160-SCP-INNER-PASSWORD@inner.invalid/repo.git',
    secrets: [
      'TODO160-SCP-OUTER-USER',
      'TODO160-SCP-INNER-USER',
      'TODO160-SCP-INNER-PASSWORD',
    ],
  },
  {
    name: 'colon-delimited password-like path text',
    value:
      'TODO160-SCP-COLON-OUTER@example.invalid:org:TODO160-SCP-COLON-PASSWORD/repo.git',
    secrets: ['TODO160-SCP-COLON-OUTER', 'TODO160-SCP-COLON-PASSWORD'],
  },
  {
    name: 'nested scheme-like path text',
    value:
      'TODO160-SCP-SCHEME-OUTER@example.invalid:org/ssh:TODO160-SCP-SCHEME-USER:TODO160-SCP-SCHEME-PASSWORD@inner.invalid/repo.git',
    secrets: [
      'TODO160-SCP-SCHEME-OUTER',
      'TODO160-SCP-SCHEME-USER',
      'TODO160-SCP-SCHEME-PASSWORD',
    ],
  },
  {
    name: 'nested URL-like path text',
    value:
      'TODO160-SCP-URL-OUTER@example.invalid:org/https://TODO160-SCP-URL-USER:TODO160-SCP-URL-PASSWORD@inner.invalid/repo.git',
    secrets: [
      'TODO160-SCP-URL-OUTER',
      'TODO160-SCP-URL-USER',
      'TODO160-SCP-URL-PASSWORD',
    ],
  },
  {
    name: 'nested IPv6 and userinfo delimiters',
    value:
      'TODO160-SCP-IPV6-OUTER@[2001:db8::1]:org/TODO160-SCP-IPV6-USER:TODO160-SCP-IPV6-PASSWORD@[2001:db8::2]/repo.git',
    secrets: [
      'TODO160-SCP-IPV6-OUTER',
      'TODO160-SCP-IPV6-USER',
      'TODO160-SCP-IPV6-PASSWORD',
    ],
  },
  {
    name: 'mixed at-sign and colon path delimiters',
    value:
      'TODO160-SCP-MIXED-OUTER@example.invalid:org/@TODO160-SCP-MIXED-USER:TODO160-SCP-MIXED-PASSWORD:TODO160-SCP-MIXED-TOKEN/repo.git',
    secrets: [
      'TODO160-SCP-MIXED-OUTER',
      'TODO160-SCP-MIXED-USER',
      'TODO160-SCP-MIXED-PASSWORD',
      'TODO160-SCP-MIXED-TOKEN',
    ],
  },
] as const;

const normalizationAmbiguousNetworkLookupCases = [
  {
    name: 'truncated HTTPS authority from comment 241',
    value:
      'https:outer.invalid/org/RECERT_INNER_USER:RECERT_INNER_PASSWORD@inner.invalid/repo.git',
    secrets: ['RECERT_INNER_USER', 'RECERT_INNER_PASSWORD'],
  },
  {
    name: 'HTTPS authority backslash from comment 241',
    value:
      'https://outer.invalid\\@RECERT_INNER_USER:RECERT_INNER_PASSWORD@inner.invalid/repo.git',
    secrets: ['RECERT_INNER_USER', 'RECERT_INNER_PASSWORD'],
  },
  {
    name: 'missing URL authority slash',
    value:
      'ssh:/outer.invalid/org/TODO160-SLASH-USER:TODO160-SLASH-PASSWORD@inner.invalid/repo.git',
    secrets: ['TODO160-SLASH-USER', 'TODO160-SLASH-PASSWORD'],
  },
  {
    name: 'extra URL authority slash',
    value:
      'git:///outer.invalid/org/TODO160-EXTRA-SLASH-USER:TODO160-EXTRA-SLASH-PASSWORD@inner.invalid/repo.git',
    secrets: ['TODO160-EXTRA-SLASH-USER', 'TODO160-EXTRA-SLASH-PASSWORD'],
  },
  {
    name: 'nested raw URL userinfo',
    value:
      'https://TODO160-NESTED-OUTER:TODO160-NESTED-PASSWORD@inner.invalid@outer.invalid/repo.git',
    secrets: ['TODO160-NESTED-OUTER', 'TODO160-NESTED-PASSWORD'],
  },
  {
    name: 'invalid percent escape before credential-shaped path text',
    value:
      'http://outer.invalid/%ZZ/TODO160-PERCENT-USER:TODO160-PERCENT-PASSWORD@inner.invalid/repo.git',
    secrets: ['TODO160-PERCENT-USER', 'TODO160-PERCENT-PASSWORD'],
  },
  {
    name: 'URL whitespace normalization before credential-shaped path text',
    value:
      'https://outer.invalid/org /TODO160-SPACE-USER:TODO160-SPACE-PASSWORD@inner.invalid/repo.git',
    secrets: ['TODO160-SPACE-USER', 'TODO160-SPACE-PASSWORD'],
  },
  {
    name: 'mixed slash and backslash authority delimiters',
    value:
      'HtTpS:/\\outer.invalid/org/TODO160-MIXED-USER:TODO160-MIXED-PASSWORD@inner.invalid/repo.git',
    secrets: ['TODO160-MIXED-USER', 'TODO160-MIXED-PASSWORD'],
  },
  {
    name: 'malformed bracketed SCP IPv6 host',
    value: 'git@[::::]:owner/repo.git',
    secrets: [],
  },
  {
    name: 'malformed bracketed credential-bearing URL host',
    value:
      'ssh://TODO160-BRACKET-USER:TODO160-BRACKET-PASSWORD@[::::]/owner/repo.git',
    secrets: ['TODO160-BRACKET-USER', 'TODO160-BRACKET-PASSWORD'],
  },
] as const;

const nonCanonicalHostLookupCases = [
  {
    name: 'malformed DNS from comment 243',
    value:
      'https://example..invalid/org/CERT_DNS_USER:CERT_DNS_PASSWORD@inner.invalid/repo.git',
    secrets: ['CERT_DNS_USER', 'CERT_DNS_PASSWORD'],
  },
  {
    name: 'octal IPv4 from comment 243',
    value:
      'https://0177.0.0.1/org/CERT_OCTAL_USER:CERT_OCTAL_PASSWORD@inner.invalid/repo.git',
    secrets: ['CERT_OCTAL_USER', 'CERT_OCTAL_PASSWORD'],
  },
  {
    name: 'integer IPv4',
    value:
      'https://2130706433/org/TODO160-INTEGER-USER:TODO160-INTEGER-PASSWORD@inner.invalid/repo.git',
    secrets: ['TODO160-INTEGER-USER', 'TODO160-INTEGER-PASSWORD'],
  },
  {
    name: 'short IPv4',
    value:
      'https://127.1/org/TODO160-SHORT-USER:TODO160-SHORT-PASSWORD@inner.invalid/repo.git',
    secrets: ['TODO160-SHORT-USER', 'TODO160-SHORT-PASSWORD'],
  },
  {
    name: 'hex IPv4',
    value:
      'https://0x7f.0.0.1/org/TODO160-HEX-USER:TODO160-HEX-PASSWORD@inner.invalid/repo.git',
    secrets: ['TODO160-HEX-USER', 'TODO160-HEX-PASSWORD'],
  },
  {
    name: 'octal-like IPv4 integer',
    value:
      'https://017700000001/org/TODO160-OCTAL-INT-USER:TODO160-OCTAL-INT-PASSWORD@inner.invalid/repo.git',
    secrets: ['TODO160-OCTAL-INT-USER', 'TODO160-OCTAL-INT-PASSWORD'],
  },
  {
    name: 'leading-zero IPv4',
    value:
      'https://127.000.000.001/org/TODO160-ZERO-USER:TODO160-ZERO-PASSWORD@inner.invalid/repo.git',
    secrets: ['TODO160-ZERO-USER', 'TODO160-ZERO-PASSWORD'],
  },
  {
    name: 'overflow IPv4',
    value:
      'https://256.0.0.1/org/TODO160-OVERFLOW-USER:TODO160-OVERFLOW-PASSWORD@inner.invalid/repo.git',
    secrets: ['TODO160-OVERFLOW-USER', 'TODO160-OVERFLOW-PASSWORD'],
  },
  {
    name: 'leading empty DNS label',
    value:
      'https://.example.invalid/org/TODO160-EMPTY-USER:TODO160-EMPTY-PASSWORD@inner.invalid/repo.git',
    secrets: ['TODO160-EMPTY-USER', 'TODO160-EMPTY-PASSWORD'],
  },
  {
    name: 'more than one trailing DNS root dot',
    value:
      'https://example.invalid../org/TODO160-ROOT-USER:TODO160-ROOT-PASSWORD@inner.invalid/repo.git',
    secrets: ['TODO160-ROOT-USER', 'TODO160-ROOT-PASSWORD'],
  },
  {
    name: 'leading DNS label hyphen',
    value:
      'https://-example.invalid/org/TODO160-LEADING-HYPHEN-USER:TODO160-LEADING-HYPHEN-PASSWORD@inner.invalid/repo.git',
    secrets: ['TODO160-LEADING-HYPHEN-USER', 'TODO160-LEADING-HYPHEN-PASSWORD'],
  },
  {
    name: 'trailing DNS label hyphen',
    value:
      'https://example-.invalid/org/TODO160-TRAILING-HYPHEN-USER:TODO160-TRAILING-HYPHEN-PASSWORD@inner.invalid/repo.git',
    secrets: [
      'TODO160-TRAILING-HYPHEN-USER',
      'TODO160-TRAILING-HYPHEN-PASSWORD',
    ],
  },
  {
    name: 'overlong DNS label',
    value: `https://${'a'.repeat(64)}.invalid/org/TODO160-LABEL-USER:TODO160-LABEL-PASSWORD@inner.invalid/repo.git`,
    secrets: ['TODO160-LABEL-USER', 'TODO160-LABEL-PASSWORD'],
  },
  {
    name: 'overlong DNS host',
    value: `https://${`${'a'.repeat(63)}.`.repeat(3)}${'b'.repeat(62)}/org/TODO160-HOST-USER:TODO160-HOST-PASSWORD@inner.invalid/repo.git`,
    secrets: ['TODO160-HOST-USER', 'TODO160-HOST-PASSWORD'],
  },
  {
    name: 'invalid IDNA result',
    value:
      'https://a\u200d.invalid/org/TODO160-IDNA-USER:TODO160-IDNA-PASSWORD@inner.invalid/repo.git',
    secrets: ['TODO160-IDNA-USER', 'TODO160-IDNA-PASSWORD'],
  },
] as const;

function directResolutionFailures(
  source: 'git-remote' | 'repository-ref',
  value: string,
  failureSecret: string
) {
  return [
    new UnsupportedPullRequestProviderError({
      source,
      value,
    }),
    new AmbiguousPullRequestProviderError({
      source,
      value,
      priority: 100,
      candidates: [],
    }),
    new InvalidPullRequestProviderMatchError({
      source,
      value,
      pluginId: 'direct-plugin',
      providerId: 'direct-provider',
      reason: 'invalid matcher result',
    }),
    new PullRequestProviderInvocationError({
      source,
      value,
      pluginId: 'direct-plugin',
      providerId: 'direct-provider',
      cause: new Error(failureSecret),
    }),
    new PullRequestProviderTimeoutError({
      source,
      value,
      pluginId: 'direct-plugin',
      providerId: 'direct-provider',
    }),
  ] as const;
}

describe('pull request provider resolution', () => {
  test('fails closed for ambiguous SCP delimiters in direct and nested repository descriptors', () => {
    const failureSecret = 'TODO160-SCP-DIRECT-FAILURE';

    for (const testCase of ambiguousScpLookupCases) {
      for (const [source, value] of [
        ['git-remote', testCase.value],
        ['repository-ref', `provider=github repo=${testCase.value}`],
      ] as const) {
        for (const failure of directResolutionFailures(
          source,
          value,
          failureSecret
        )) {
          expect(failure.value).toBe('<redacted>');
          expectLookupSecretsAbsent(failure, [
            ...testCase.secrets,
            failureSecret,
          ]);
        }
      }
    }
  });

  test('fails closed for ambiguous SCP delimiters through all five resolution families', async () => {
    const unsupportedCase = ambiguousScpLookupCases[0];
    const ambiguousCase = ambiguousScpLookupCases[1];
    const invalidCase = ambiguousScpLookupCases[2];
    const invocationCase = ambiguousScpLookupCases[4];
    const timeoutCase = ambiguousScpLookupCases[5];
    const invocationSecret = 'TODO160-SCP-INVOCATION-FAILURE';

    const unsupported = await Effect.runPromise(
      resolvePullRequestProviderForRemote([], unsupportedCase.value).pipe(
        Effect.flip
      )
    );
    const ambiguous = await Effect.runPromise(
      resolvePullRequestProviderForRemote(
        [
          fakeProvider('ambiguous-a-plugin', 'ambiguous-a', 100),
          fakeProvider('ambiguous-b-plugin', 'ambiguous-b', 100),
        ],
        ambiguousCase.value
      ).pipe(Effect.flip)
    );
    const invalid = await Effect.runPromise(
      resolvePullRequestProviderForRemote(
        [
          malformedProvider('invalid-plugin', 'invalid-provider', 100, {
            remote: () => ({ attacker: true }),
          }),
        ],
        invalidCase.value
      ).pipe(Effect.flip)
    );
    const invocation = await Effect.runPromise(
      resolvePullRequestProviderForRepositoryInput(
        [
          {
            pluginId: 'invocation-plugin',
            capability: {
              ...fakeProviderCapability('invocation-provider', 100),
              matchRepository: () => Effect.fail(new Error(invocationSecret)),
            },
          },
        ],
        {
          providerId: 'invocation-provider',
          repo: invocationCase.value,
        }
      ).pipe(Effect.flip)
    );
    const timeout = await Effect.runPromise(
      resolvePullRequestProviderForRepositoryInput(
        [
          {
            pluginId: 'timeout-plugin',
            capability: {
              ...fakeProviderCapability('timeout-provider', 100),
              matchRepository: () => Effect.never,
            },
          },
        ],
        { providerId: 'timeout-provider', repo: timeoutCase.value },
        { matcherTimeout: '10 millis' }
      ).pipe(Effect.flip)
    );

    const failures = [
      {
        error: unsupported,
        expected: UnsupportedPullRequestProviderError,
        secrets: unsupportedCase.secrets,
      },
      {
        error: ambiguous,
        expected: AmbiguousPullRequestProviderError,
        secrets: ambiguousCase.secrets,
      },
      {
        error: invalid,
        expected: InvalidPullRequestProviderMatchError,
        secrets: invalidCase.secrets,
      },
      {
        error: invocation,
        expected: PullRequestProviderInvocationError,
        secrets: [...invocationCase.secrets, invocationSecret],
      },
      {
        error: timeout,
        expected: PullRequestProviderTimeoutError,
        secrets: timeoutCase.secrets,
      },
    ] as const;

    for (const failure of failures) {
      expect(failure.error).toBeInstanceOf(failure.expected);
      expect(failure.error.value).toBe('<redacted>');
      expectLookupSecretsAbsent(failure.error, failure.secrets);
    }
  });

  test('fails closed for normalization-ambiguous URLs in every direct and nested resolution error constructor', () => {
    const failureSecret = 'TODO160-NETWORK-DIRECT-FAILURE';

    for (const testCase of normalizationAmbiguousNetworkLookupCases) {
      for (const [source, value] of [
        ['git-remote', testCase.value],
        ['repository-ref', `provider=github repo=${testCase.value}`],
      ] as const) {
        for (const failure of directResolutionFailures(
          source,
          value,
          failureSecret
        )) {
          expect(failure.value, testCase.name).toBe('<redacted>');
          expectLookupSecretsAbsent(failure, [
            ...testCase.secrets,
            failureSecret,
          ]);
        }
      }
    }
  });

  test('fails closed for normalization-ambiguous URLs through all five real resolution families', async () => {
    const unsupportedCase = normalizationAmbiguousNetworkLookupCases[0];
    const ambiguousCase = normalizationAmbiguousNetworkLookupCases[1];
    const invalidCase = normalizationAmbiguousNetworkLookupCases[3];
    const invocationCase = normalizationAmbiguousNetworkLookupCases[5];
    const timeoutCase = normalizationAmbiguousNetworkLookupCases[7];
    const invocationSecret = 'TODO160-NETWORK-INVOCATION-FAILURE';

    const unsupported = await Effect.runPromise(
      resolvePullRequestProviderForRemote([], unsupportedCase.value).pipe(
        Effect.flip
      )
    );
    const ambiguous = await Effect.runPromise(
      resolvePullRequestProviderForRemote(
        [
          fakeProvider(
            'network-ambiguous-a-plugin',
            'network-ambiguous-a',
            100
          ),
          fakeProvider(
            'network-ambiguous-b-plugin',
            'network-ambiguous-b',
            100
          ),
        ],
        ambiguousCase.value
      ).pipe(Effect.flip)
    );
    const invalid = await Effect.runPromise(
      resolvePullRequestProviderForRemote(
        [
          malformedProvider(
            'network-invalid-plugin',
            'network-invalid-provider',
            100,
            { remote: () => ({ attacker: true }) }
          ),
        ],
        invalidCase.value
      ).pipe(Effect.flip)
    );
    const invocation = await Effect.runPromise(
      resolvePullRequestProviderForRepositoryInput(
        [
          {
            pluginId: 'network-invocation-plugin',
            capability: {
              ...fakeProviderCapability('network-invocation-provider', 100),
              matchRepository: () => Effect.fail(new Error(invocationSecret)),
            },
          },
        ],
        {
          providerId: 'network-invocation-provider',
          repo: invocationCase.value,
        }
      ).pipe(Effect.flip)
    );
    const timeout = await Effect.runPromise(
      resolvePullRequestProviderForRepositoryInput(
        [
          {
            pluginId: 'network-timeout-plugin',
            capability: {
              ...fakeProviderCapability('network-timeout-provider', 100),
              matchRepository: () => Effect.never,
            },
          },
        ],
        {
          providerId: 'network-timeout-provider',
          repo: timeoutCase.value,
        },
        { matcherTimeout: '10 millis' }
      ).pipe(Effect.flip)
    );

    for (const failure of [
      {
        error: unsupported,
        expected: UnsupportedPullRequestProviderError,
        secrets: unsupportedCase.secrets,
      },
      {
        error: ambiguous,
        expected: AmbiguousPullRequestProviderError,
        secrets: ambiguousCase.secrets,
      },
      {
        error: invalid,
        expected: InvalidPullRequestProviderMatchError,
        secrets: invalidCase.secrets,
      },
      {
        error: invocation,
        expected: PullRequestProviderInvocationError,
        secrets: [...invocationCase.secrets, invocationSecret],
      },
      {
        error: timeout,
        expected: PullRequestProviderTimeoutError,
        secrets: timeoutCase.secrets,
      },
    ] as const) {
      expect(failure.error).toBeInstanceOf(failure.expected);
      expect(failure.error.value).toBe('<redacted>');
      expectLookupSecretsAbsent(failure.error, failure.secrets);
    }
  });

  test('fails closed for malformed and non-canonical hosts in every direct and nested resolution error constructor', () => {
    const failureSecret = 'TODO160-HOST-DIRECT-FAILURE';

    for (const testCase of nonCanonicalHostLookupCases) {
      for (const [source, value] of [
        ['git-remote', testCase.value],
        ['repository-ref', `provider=github repo=${testCase.value}`],
      ] as const) {
        for (const failure of directResolutionFailures(
          source,
          value,
          failureSecret
        )) {
          expect(failure.value, testCase.name).toBe('<redacted>');
          expectLookupSecretsAbsent(failure, [
            ...testCase.secrets,
            failureSecret,
          ]);
        }
      }
    }
  });

  test('fails closed for malformed and non-canonical hosts through all five real resolution families', async () => {
    const unsupportedCase = nonCanonicalHostLookupCases[0];
    const ambiguousCase = nonCanonicalHostLookupCases[1];
    const invalidCase = nonCanonicalHostLookupCases[3];
    const invocationCase = nonCanonicalHostLookupCases[4];
    const timeoutCase = nonCanonicalHostLookupCases[6];
    const invocationSecret = 'TODO160-HOST-INVOCATION-FAILURE';

    const unsupported = await Effect.runPromise(
      resolvePullRequestProviderForRemote([], unsupportedCase.value).pipe(
        Effect.flip
      )
    );
    const ambiguous = await Effect.runPromise(
      resolvePullRequestProviderForRemote(
        [
          fakeProvider('host-ambiguous-a-plugin', 'host-ambiguous-a', 100),
          fakeProvider('host-ambiguous-b-plugin', 'host-ambiguous-b', 100),
        ],
        ambiguousCase.value
      ).pipe(Effect.flip)
    );
    const invalid = await Effect.runPromise(
      resolvePullRequestProviderForRemote(
        [
          malformedProvider('host-invalid-plugin', 'host-invalid', 100, {
            remote: () => ({ attacker: true }),
          }),
        ],
        invalidCase.value
      ).pipe(Effect.flip)
    );
    const invocation = await Effect.runPromise(
      resolvePullRequestProviderForRepositoryInput(
        [
          {
            pluginId: 'host-invocation-plugin',
            capability: {
              ...fakeProviderCapability('host-invocation', 100),
              matchRepository: () => Effect.fail(new Error(invocationSecret)),
            },
          },
        ],
        { providerId: 'host-invocation', repo: invocationCase.value }
      ).pipe(Effect.flip)
    );
    const timeout = await Effect.runPromise(
      resolvePullRequestProviderForRepositoryInput(
        [
          {
            pluginId: 'host-timeout-plugin',
            capability: {
              ...fakeProviderCapability('host-timeout', 100),
              matchRepository: () => Effect.never,
            },
          },
        ],
        { providerId: 'host-timeout', repo: timeoutCase.value },
        { matcherTimeout: '10 millis' }
      ).pipe(Effect.flip)
    );

    for (const failure of [
      {
        error: unsupported,
        expected: UnsupportedPullRequestProviderError,
        secrets: unsupportedCase.secrets,
      },
      {
        error: ambiguous,
        expected: AmbiguousPullRequestProviderError,
        secrets: ambiguousCase.secrets,
      },
      {
        error: invalid,
        expected: InvalidPullRequestProviderMatchError,
        secrets: invalidCase.secrets,
      },
      {
        error: invocation,
        expected: PullRequestProviderInvocationError,
        secrets: [...invocationCase.secrets, invocationSecret],
      },
      {
        error: timeout,
        expected: PullRequestProviderTimeoutError,
        secrets: timeoutCase.secrets,
      },
    ] as const) {
      expect(failure.error).toBeInstanceOf(failure.expected);
      expect(failure.error.value).toBe('<redacted>');
      expectLookupSecretsAbsent(failure.error, failure.secrets);
    }
  });

  test('enforces raw network grammar while retaining standard redacted URL context and exact length bounds', () => {
    const supported = [
      [
        'GIT://Example.INVALID:9418/owner/repo.git',
        'git://Example.INVALID:9418/owner/repo.git',
        [],
      ],
      [
        'SSH://Example.INVALID:2222/owner/repo.git',
        'ssh://Example.INVALID:2222/owner/repo.git',
        [],
      ],
      [
        'git://TODO160-GIT-USER:TODO160-GIT-PASSWORD@example.invalid:9418/owner/repo.git?token=TODO160-GIT-QUERY#TODO160-GIT-FRAGMENT',
        'git://example.invalid:9418/owner/repo.git',
        [
          'TODO160-GIT-USER',
          'TODO160-GIT-PASSWORD',
          'TODO160-GIT-QUERY',
          'TODO160-GIT-FRAGMENT',
        ],
      ],
      [
        'http://TODO160-HTTP-USER:TODO160-HTTP-PASSWORD@example.invalid/owner/repo.git?token=TODO160-HTTP-QUERY#TODO160-HTTP-FRAGMENT',
        'http://example.invalid/owner/repo.git',
        [
          'TODO160-HTTP-USER',
          'TODO160-HTTP-PASSWORD',
          'TODO160-HTTP-QUERY',
          'TODO160-HTTP-FRAGMENT',
        ],
      ],
      [
        'HtTpS://TODO160-CASE-USER:TODO160-CASE-p%40ss@EXAMPLE.INVALID/owner/repo.git?token=TODO160-CASE-QUERY#TODO160-CASE-FRAGMENT',
        'https://example.invalid/owner/repo.git',
        [
          'TODO160-CASE-USER',
          'TODO160-CASE-p%40ss',
          'TODO160-CASE-QUERY',
          'TODO160-CASE-FRAGMENT',
        ],
      ],
      [
        'SSH://TODO160-SSH-USER:TODO160-SSH-PASSWORD@[2001:db8::1]:2222/owner/repo.git?token=TODO160-SSH-QUERY#TODO160-SSH-FRAGMENT',
        'ssh://[2001:db8::1]:2222/owner/repo.git',
        [
          'TODO160-SSH-USER',
          'TODO160-SSH-PASSWORD',
          'TODO160-SSH-QUERY',
          'TODO160-SSH-FRAGMENT',
        ],
      ],
    ] as const;

    for (const [value, descriptor, secrets] of supported) {
      const failure = new UnsupportedPullRequestProviderError({
        source: 'git-remote',
        value,
      });
      expect(failure.value).toBe(descriptor);
      expectLookupSecretsAbsent(failure, secrets);
    }

    for (const value of [
      'https://example.invalid/owner\\repo.git',
      'https://example.invalid/owner/%QZ/repo.git',
      'https://example.invalid/owner/ repo.git',
      'https:\n//example.invalid/owner/repo.git',
      'https://example.invalid]/owner/repo.git',
      'https://first.invalid@second.invalid@third.invalid/repo.git',
    ]) {
      expect(
        new UnsupportedPullRequestProviderError({
          source: 'git-remote',
          value,
        }).value
      ).toBe('<redacted>');
    }

    const exactLength = `https://example.invalid/${'a'.repeat(
      4_096 - 'https://example.invalid/'.length
    )}`;
    expect(exactLength).toHaveLength(4_096);
    expect(
      new UnsupportedPullRequestProviderError({
        source: 'git-remote',
        value: exactLength,
      }).value
    ).toBe(exactLength);
    expect(
      new UnsupportedPullRequestProviderError({
        source: 'git-remote',
        value: `${exactLength}a`,
      }).value
    ).toBe('<redacted>');
  });

  test('retains ordinary safe SCP, URL, port, IPv6, Unicode, and repository context', () => {
    const maximumLabel = 'a'.repeat(63);
    const maximumHost = `${maximumLabel}.${maximumLabel}.${maximumLabel}.${'b'.repeat(61)}`;
    for (const [value, descriptor] of [
      ['git@example.invalid:owner/repo.git', 'example.invalid:owner/repo.git'],
      ['example.invalid:owner/repo.git', 'example.invalid:owner/repo.git'],
      ['https://localhost/owner/repo.git', 'https://localhost/owner/repo.git'],
      ['https://intranet/owner/repo.git', 'https://intranet/owner/repo.git'],
      [
        'https://127.0.0.1:8443/owner/repo.git',
        'https://127.0.0.1:8443/owner/repo.git',
      ],
      [
        'https://example.invalid./owner/repo.git',
        'https://example.invalid./owner/repo.git',
      ],
      [
        'https://bücher.example/owner/repo.git',
        'https://xn--bcher-kva.example/owner/repo.git',
      ],
      [
        'git://bücher.example/owner/repo.git',
        'git://xn--bcher-kva.example/owner/repo.git',
      ],
      [
        'ssh://bücher.example:2222/owner/repo.git',
        'ssh://xn--bcher-kva.example:2222/owner/repo.git',
      ],
      [
        `https://${maximumLabel}.invalid/owner/repo.git`,
        `https://${maximumLabel}.invalid/owner/repo.git`,
      ],
      [
        `https://${maximumHost}/owner/repo.git`,
        `https://${maximumHost}/owner/repo.git`,
      ],
      [
        'https://example.invalid:8443/owner/repo.git',
        'https://example.invalid:8443/owner/repo.git',
      ],
      [
        'ssh://[2001:db8::1]:2222/owner/repo.git',
        'ssh://[2001:db8::1]:2222/owner/repo.git',
      ],
      ['git@[2001:db8::1]:owner/repo.git', '[2001:db8::1]:owner/repo.git'],
      ['git@example.invalid:工程/倉庫.git', 'example.invalid:工程/倉庫.git'],
    ] as const) {
      expect(
        new UnsupportedPullRequestProviderError({
          source: 'git-remote',
          value,
        }).value
      ).toBe(descriptor);
    }

    expect(
      new UnsupportedPullRequestProviderError({
        source: 'repository-ref',
        value: 'provider=github repo=git@example.invalid:owner/repo.git',
      }).value
    ).toBe('provider=github repo=example.invalid:owner/repo.git');

    expect(
      new UnsupportedPullRequestProviderError({
        source: 'repository-ref',
        value: 'provider=github repo=example.invalid:owner/repo.git',
      }).value
    ).toBe('provider=github repo=example.invalid:owner/repo.git');

    expect(
      new UnsupportedPullRequestProviderError({
        source: 'repository-ref',
        value: 'provider=github repo=https://bücher.example/owner/repo.git',
      }).value
    ).toBe('provider=github repo=https://xn--bcher-kva.example/owner/repo.git');

    expect(
      new UnsupportedPullRequestProviderError({
        source: 'repository-ref',
        value: 'provider=github repo=git://bücher.example/owner/repo.git',
      }).value
    ).toBe('provider=github repo=git://xn--bcher-kva.example/owner/repo.git');
  });

  test('redacts HTTPS credentials from unsupported resolution while only the matcher sees the raw lookup', async () => {
    const secrets = [
      'TODO160-UNSUPPORTED-USER',
      'TODO160-UNSUPPORTED-PASSWORD',
      'TODO160-UNSUPPORTED-QUERY',
      'TODO160-UNSUPPORTED-FRAGMENT',
    ] as const;
    const remote = `https://${secrets[0]}:${secrets[1]}@example.invalid/org/repo.git?token=${secrets[2]}#${secrets[3]}`;
    const seen: string[] = [];
    const providers = [
      {
        pluginId: 'unsupported-redaction-plugin',
        capability: {
          ...fakeProviderCapability('unsupported-redaction', 100),
          matchRemote: (value: string) => {
            seen.push(value);
            return null;
          },
        },
      },
    ];

    const error = await Effect.runPromise(
      resolvePullRequestProviderForRemote(providers, remote).pipe(Effect.flip)
    );

    expect(error).toBeInstanceOf(UnsupportedPullRequestProviderError);
    expect(error.value).toBe('https://example.invalid/org/repo.git');
    expect(seen).toEqual([remote]);
    expectLookupSecretsAbsent(error, secrets);
  });

  test('redacts HTTPS credentials from ambiguous URL resolution without losing provider candidates', async () => {
    const secrets = [
      'TODO160-AMBIGUOUS-USER',
      'TODO160-AMBIGUOUS-PASSWORD',
      'TODO160-AMBIGUOUS-QUERY',
      'TODO160-AMBIGUOUS-FRAGMENT',
    ] as const;
    const url = `https://${secrets[0]}:${secrets[1]}@example.invalid/org/repo/pull/7?access_token=${secrets[2]}#${secrets[3]}`;
    const seen: string[] = [];
    const providers = ['ambiguous-redaction-a', 'ambiguous-redaction-b'].map(
      (providerId) => ({
        pluginId: `${providerId}-plugin`,
        capability: {
          ...fakeProviderCapability(providerId, 100),
          matchPullRequestUrl: (value: string) => {
            seen.push(value);
            return {
              source: 'pull-request-url' as const,
              repository: externalRepository(providerId),
              pullRequest: { number: 7 },
            };
          },
        },
      })
    );

    const error = await Effect.runPromise(
      resolvePullRequestProviderForUrl(providers, url).pipe(Effect.flip)
    );

    expect(error).toBeInstanceOf(AmbiguousPullRequestProviderError);
    if (!(error instanceof AmbiguousPullRequestProviderError)) {
      throw new Error('Expected ambiguous provider resolution error');
    }
    expect(error.value).toBe('https://example.invalid/org/repo/pull/7');
    expect(error.candidates.map(({ providerId }) => providerId)).toEqual([
      'ambiguous-redaction-a',
      'ambiguous-redaction-b',
    ]);
    expect(seen).toEqual([url, url]);
    expectLookupSecretsAbsent(error, secrets);
  });

  test('redacts SCP-like lookup credentials from invalid matcher results', async () => {
    const secrets = [
      'TODO160-SCP-USER',
      'TODO160-SCP-QUERY',
      'TODO160-SCP-FRAGMENT',
    ] as const;
    const remote = `${secrets[0]}@example.invalid:org/repo.git?token=${secrets[1]}#${secrets[2]}`;
    const seen: string[] = [];
    const providers = [
      malformedProvider('invalid-redaction-plugin', 'invalid-redaction', 100, {
        remote: () => {
          seen.push(remote);
          return { invalid: true };
        },
      }),
    ];

    const error = await Effect.runPromise(
      resolvePullRequestProviderForRemote(providers, remote).pipe(Effect.flip)
    );

    expect(error).toBeInstanceOf(InvalidPullRequestProviderMatchError);
    if (!(error instanceof InvalidPullRequestProviderMatchError)) {
      throw new Error('Expected invalid provider match error');
    }
    expect(error.value).toBe('example.invalid:org/repo.git');
    expect(error.reason).toBe('match result failed structural capture');
    expect(seen).toEqual([remote]);
    expectLookupSecretsAbsent(error, secrets);
  });

  test('fails closed for malformed repository lookup values and discards attacker Effect failure text', async () => {
    const lookupSecret = 'TODO160-MALFORMED-PASSWORD';
    const failureSecret = 'TODO160-MATCHER-FAILURE';
    const repo = `https://todo160-user:${lookupSecret}@`;
    const attacker = new Error(failureSecret);
    let seenRepo: string | undefined;
    const providers = [
      {
        pluginId: 'invocation-redaction-plugin',
        capability: {
          ...fakeProviderCapability('invocation-redaction', 100),
          matchRepository: (request: { readonly repo?: string }) => {
            seenRepo = request.repo;
            return Effect.fail(attacker);
          },
        },
      },
    ];

    const error = await Effect.runPromise(
      resolvePullRequestProviderForRepositoryInput(providers, {
        providerId: 'invocation-redaction',
        repo,
      }).pipe(Effect.flip)
    );

    expect(error).toBeInstanceOf(PullRequestProviderInvocationError);
    expect(error.value).toBe('<redacted>');
    expect(error.cause).not.toBe(attacker);
    expect(seenRepo).toBe(repo);
    expectLookupSecretsAbsent(error, [lookupSecret, failureSecret]);
  });

  test('applies the same descriptor policy to direct repository refs', async () => {
    const secrets = [
      'TODO160-REPOSITORY-USER',
      'TODO160-REPOSITORY-PASSWORD',
      'TODO160-REPOSITORY-QUERY',
      'TODO160-REPOSITORY-FRAGMENT',
    ] as const;
    const displayName = `https://${secrets[0]}:${secrets[1]}@example.invalid/org/repo.git?token=${secrets[2]}#${secrets[3]}`;

    const error = await Effect.runPromise(
      resolvePullRequestProviderForRepository([], {
        kind: 'external',
        providerId: 'repository-redaction',
        displayName,
      }).pipe(Effect.flip)
    );

    expect(error).toBeInstanceOf(UnsupportedPullRequestProviderError);
    expect(error.value).toBe('https://example.invalid/org/repo.git');
    expectLookupSecretsAbsent(error, secrets);
  });

  test('redacts nested URL credentials from repository matcher timeout failures', async () => {
    const secrets = [
      'TODO160-TIMEOUT-USER',
      'TODO160-TIMEOUT-PASSWORD',
      'TODO160-TIMEOUT-QUERY',
      'TODO160-TIMEOUT-FRAGMENT',
    ] as const;
    const repo = `https://${secrets[0]}:${secrets[1]}@example.invalid/org/repo.git?token=${secrets[2]}#${secrets[3]}`;
    let seenRepo: string | undefined;
    const providers = [
      {
        pluginId: 'timeout-redaction-plugin',
        capability: {
          ...fakeProviderCapability('timeout-redaction', 100),
          matchRepository: (request: { readonly repo?: string }) => {
            seenRepo = request.repo;
            return Effect.never;
          },
        },
      },
    ];

    const error = await Effect.runPromise(
      resolvePullRequestProviderForRepositoryInput(
        providers,
        { providerId: 'timeout-redaction', repo },
        { matcherTimeout: '10 millis' }
      ).pipe(Effect.flip)
    );

    expect(error).toBeInstanceOf(PullRequestProviderTimeoutError);
    expect(error.value).toBe(
      'provider=timeout-redaction repo=https://example.invalid/org/repo.git'
    );
    expect(seenRepo).toBe(repo);
    expectLookupSecretsAbsent(error, secrets);
  });

  test('all exported resolution constructors sanitize lookup values and invocation causes defensively', () => {
    const lookupSecret = 'TODO160-DIRECT-LOOKUP-SECRET';
    const failureSecret = 'TODO160-DIRECT-FAILURE-SECRET';
    const value = `https://user:${lookupSecret}@example.invalid/repo?token=${lookupSecret}#${lookupSecret}`;
    const failures = [
      new UnsupportedPullRequestProviderError({
        source: 'git-remote',
        value,
      }),
      new AmbiguousPullRequestProviderError({
        source: 'pull-request-url',
        value,
        priority: 100,
        candidates: [],
      }),
      new InvalidPullRequestProviderMatchError({
        source: 'git-remote',
        value,
        pluginId: 'direct-plugin',
        providerId: 'direct-provider',
        reason: 'invalid matcher result',
      }),
      new PullRequestProviderInvocationError({
        source: 'git-remote',
        value,
        pluginId: 'direct-plugin',
        providerId: 'direct-provider',
        cause: new Error(failureSecret),
      }),
      new PullRequestProviderTimeoutError({
        source: 'git-remote',
        value,
        pluginId: 'direct-plugin',
        providerId: 'direct-provider',
      }),
    ];

    for (const failure of failures) {
      expect(failure.value).toBe('https://example.invalid/repo');
      expectLookupSecretsAbsent(failure, [lookupSecret, failureSecret]);
    }
  });

  test('resolves through a registry whose PR auth status uses a non-keyring service', async () => {
    const plugin = defineAidePlugin<
      never,
      never,
      never,
      never,
      never,
      never,
      NonKeyringPullRequestAuth
    >({
      id: 'non-keyring-provider-plugin',
      summary: 'Non-keyring provider',
      commands: [],
      capabilities: {
        pullRequestProvider: {
          providerId: 'non-keyring-provider',
          priority: 100,
          features: {},
          authStatus: () =>
            Effect.map(NonKeyringPullRequestAuth, ({ configured }) => ({
              state: configured
                ? ('configured' as const)
                : ('unavailable' as const),
            })),
          matchRemote: (remoteUrl) =>
            remoteUrl === 'non-keyring-remote'
              ? {
                  source: 'git-remote',
                  repository: externalRepository('non-keyring-provider'),
                }
              : null,
          matchPullRequestUrl: () => null,
        },
      },
    });
    const registry = createCommandRegistry<
      never,
      never,
      never,
      never,
      never,
      never,
      NonKeyringPullRequestAuth
    >().registerPlugin(plugin);

    const resolved = await Effect.runPromise(
      resolvePullRequestProviderFromRegistryForRemote(
        registry,
        'non-keyring-remote'
      )
    );

    expect(resolved.providerId).toBe('non-keyring-provider');
    expect(resolved.match.repository).toEqual(
      externalRepository('non-keyring-provider')
    );
  });

  test('resolves github.com remotes through the GitHub provider plugin', async () => {
    const registry = createBuiltinCommandRegistry();

    const resolved = await Effect.runPromise(
      resolvePullRequestProviderFromRegistryForRemote(
        registry,
        'git@github.com:acme/widgets.git'
      )
    );

    expect(resolved.pluginId).toBe('github');
    expect(resolved.providerId).toBe('github');
    expect(resolved.match.repository).toEqual({
      kind: 'github',
      host: 'github.com',
      owner: 'acme',
      repo: 'widgets',
    });
  });

  test('resolves GitHub Enterprise Cloud remotes as GitHub provider matches', async () => {
    const registry = createBuiltinCommandRegistry();

    const resolved = await Effect.runPromise(
      resolvePullRequestProviderFromRegistryForRemote(
        registry,
        'git@ssh.acme.ghe.com:acme/widgets.git'
      )
    );

    expect(resolved.pluginId).toBe('github');
    expect(resolved.match.repository).toEqual({
      kind: 'github',
      host: 'acme.ghe.com',
      owner: 'acme',
      repo: 'widgets',
    });
  });

  test('resolves Azure DevOps remotes through the Azure DevOps provider plugin', async () => {
    const registry = createBuiltinCommandRegistry();

    const resolved = await Effect.runPromise(
      resolvePullRequestProviderFromRegistryForRemote(
        registry,
        'git@ssh.dev.azure.com:v3/acme/Platform/widgets'
      )
    );

    expect(resolved.pluginId).toBe('azure-devops');
    expect(resolved.providerId).toBe('azure-devops');
    expect(resolved.match.repository).toEqual({
      kind: 'azure-devops',
      org: 'acme',
      project: 'Platform',
      repo: 'widgets',
    });
  });

  test('resolves pull request URLs without requiring git remote context', async () => {
    const registry = createBuiltinCommandRegistry();

    const github = await Effect.runPromise(
      resolvePullRequestProviderFromRegistryForUrl(
        registry,
        'https://github.com/acme/widgets/pull/42?foo=1'
      )
    );
    const ado = await Effect.runPromise(
      resolvePullRequestProviderFromRegistryForUrl(
        registry,
        'https://dev.azure.com/acme/Platform/_git/widgets/pullrequest/42'
      )
    );

    expect(github.pluginId).toBe('github');
    expect(github.match.source).toBe('pull-request-url');
    if (github.match.source !== 'pull-request-url') {
      throw new Error('Expected GitHub pull request URL match');
    }
    expect(github.match.pullRequest).toEqual({ number: 42 });
    expect(ado.pluginId).toBe('azure-devops');
    expect(ado.match.source).toBe('pull-request-url');
    if (ado.match.source !== 'pull-request-url') {
      throw new Error('Expected Azure DevOps pull request URL match');
    }
    expect(ado.match.pullRequest).toEqual({ number: 42 });
  });

  test('resolves repository refs by provider id without invoking matchers', async () => {
    const provider = fakeProvider('gitlab-plugin', 'gitlab', 100);
    const providers = [
      {
        ...provider,
        capability: {
          ...provider.capability,
          matchRemote: () => {
            throw new Error('remote matcher should not run');
          },
          matchPullRequestUrl: () => {
            throw new Error('url matcher should not run');
          },
        },
      },
    ];

    const result = await Effect.runPromise(
      resolvePullRequestProviderForRepository(
        providers,
        externalRepository('gitlab')
      )
    );

    expect(result).toEqual({
      pluginId: 'gitlab-plugin',
      providerId: 'gitlab',
      priority: 100,
      features: {},
      match: {
        source: 'repository-ref',
        repository: externalRepository('gitlab'),
      },
    });
    expect(Object.isFrozen(result.match)).toBe(true);
  });

  test('resolves repository input through provider-owned matchRepository', async () => {
    const calls: unknown[] = [];
    const repository = externalRepository('gitlab', { projectId: 10 });
    const provider = fakeProvider('gitlab-plugin', 'gitlab', 100);

    const result = await Effect.runPromise(
      resolvePullRequestProviderForRepositoryInput(
        [
          {
            ...provider,
            capability: {
              ...provider.capability,
              matchRepository: (request) => {
                calls.push(request);
                return Effect.succeed({
                  source: 'repository-ref',
                  priority: 125,
                  detail: 'gitlab/acme/widgets',
                  repository,
                });
              },
            },
          },
        ],
        { providerId: 'gitlab', project: 'acme', repo: 'widgets' }
      )
    );

    expect(calls).toEqual([
      { providerId: 'gitlab', project: 'acme', repo: 'widgets' },
    ]);
    expect(result).toEqual({
      pluginId: 'gitlab-plugin',
      providerId: 'gitlab',
      priority: 125,
      features: {},
      match: {
        source: 'repository-ref',
        priority: 125,
        detail: 'gitlab/acme/widgets',
        repository,
      },
    });
  });

  test('rejects repository matchers that do not return Effects', async () => {
    const provider = fakeProvider('gitlab-plugin', 'gitlab', 100);

    const error = await Effect.runPromise(
      resolvePullRequestProviderForRepositoryInput(
        [
          {
            ...provider,
            capability: {
              ...provider.capability,
              matchRepository: () =>
                ({
                  source: 'repository-ref',
                  repository: externalRepository('gitlab'),
                }) as never,
            },
          },
        ],
        { providerId: 'gitlab', project: 'acme', repo: 'widgets' }
      ).pipe(Effect.flip)
    );

    expect(error).toBeInstanceOf(InvalidPullRequestProviderMatchError);
    if (!(error instanceof InvalidPullRequestProviderMatchError)) {
      throw new Error('Expected invalid provider match error');
    }
    expect(error.reason).toBe('matchRepository must return an Effect');
  });

  test('resolves GitHub repository input through the GitHub provider', async () => {
    const registry = createBuiltinCommandRegistry();

    const result = await Effect.runPromise(
      resolvePullRequestProviderFromRegistryForRepositoryInput(registry, {
        providerId: 'github',
        project: 'acme',
        repo: 'widgets',
      })
    );

    expect(result.pluginId).toBe('github');
    expect(result.providerId).toBe('github');
    expect(result.match).toEqual({
      source: 'repository-ref',
      priority: 100,
      detail: 'github.com/acme/widgets',
      repository: {
        kind: 'github',
        host: 'github.com',
        owner: 'acme',
        repo: 'widgets',
      },
    });
  });

  test('resolves Azure DevOps repository input through the Azure DevOps provider', async () => {
    const registry = createKeyringCommandRegistry().registerPlugin(
      createAzureDevOpsPlugin({
        createClient: async () => ({
          client: {} as unknown as AzureDevOpsClient,
          config: {
            orgUrl: 'https://dev.azure.com/acme',
            pat: 'token',
            authMethod: 'pat',
          },
        }),
      })
    );

    const result = await Effect.runPromise(
      resolvePullRequestProviderFromRegistryForRepositoryInput(registry, {
        project: 'Platform',
        repo: 'widgets',
      })
    );

    expect(result.pluginId).toBe('azure-devops');
    expect(result.providerId).toBe('azure-devops');
    expect(result.match).toEqual({
      source: 'repository-ref',
      priority: 100,
      detail: 'acme/Platform/widgets',
      repository: {
        kind: 'azure-devops',
        org: 'acme',
        project: 'Platform',
        repo: 'widgets',
      },
    });
  });

  test('uses explicit GitHub host input to avoid Azure DevOps ambiguity', async () => {
    const registry = createKeyringCommandRegistry()
      .registerPlugin(createGitHubPlugin())
      .registerPlugin(
        createAzureDevOpsPlugin({
          createClient: async () => ({
            client: {} as unknown as AzureDevOpsClient,
            config: {
              orgUrl: 'https://dev.azure.com/acme',
              pat: 'token',
              authMethod: 'pat',
            },
          }),
        })
      );

    const result = await Effect.runPromise(
      resolvePullRequestProviderFromRegistryForRepositoryInput(registry, {
        host: 'github.com',
        owner: 'acme',
        repo: 'widgets',
      })
    );

    expect(result.pluginId).toBe('github');
    expect(result.providerId).toBe('github');
    expect(result.match.repository).toEqual({
      kind: 'github',
      host: 'github.com',
      owner: 'acme',
      repo: 'widgets',
    });
  });

  test('uses explicit Azure DevOps host input to avoid GitHub ambiguity', async () => {
    const registry = createKeyringCommandRegistry()
      .registerPlugin(createGitHubPlugin())
      .registerPlugin(
        createAzureDevOpsPlugin({
          createClient: async () => ({
            client: {} as unknown as AzureDevOpsClient,
            config: {
              orgUrl: 'https://dev.azure.com/acme',
              pat: 'token',
              authMethod: 'pat',
            },
          }),
        })
      );

    const result = await Effect.runPromise(
      resolvePullRequestProviderFromRegistryForRepositoryInput(registry, {
        host: 'dev.azure.com',
        org: 'acme',
        project: 'Platform',
        repo: 'widgets',
      })
    );

    expect(result.pluginId).toBe('azure-devops');
    expect(result.providerId).toBe('azure-devops');
    expect(result.match.repository).toEqual({
      kind: 'azure-devops',
      org: 'acme',
      project: 'Platform',
      repo: 'widgets',
    });
  });

  test('treats owner as a GitHub repository signal and org/project as Azure DevOps signals', async () => {
    const registry = createKeyringCommandRegistry()
      .registerPlugin(createGitHubPlugin())
      .registerPlugin(
        createAzureDevOpsPlugin({
          createClient: async () => ({
            client: {} as unknown as AzureDevOpsClient,
            config: {
              orgUrl: 'https://dev.azure.com/acme',
              pat: 'token',
              authMethod: 'pat',
            },
          }),
        })
      );

    const githubResult = await Effect.runPromise(
      resolvePullRequestProviderFromRegistryForRepositoryInput(registry, {
        owner: 'acme',
        repo: 'widgets',
      })
    );
    const azureDevOpsResult = await Effect.runPromise(
      resolvePullRequestProviderFromRegistryForRepositoryInput(registry, {
        org: 'acme',
        project: 'Platform',
        repo: 'widgets',
      })
    );

    expect(githubResult.providerId).toBe('github');
    expect(azureDevOpsResult.providerId).toBe('azure-devops');
  });

  test('fails with a typed unsupported-provider error when no provider owns a repository ref', async () => {
    const error = await Effect.runPromise(
      resolvePullRequestProviderForRepository(
        [fakeProvider('gitlab-plugin', 'gitlab', 100)],
        externalRepository('bitbucket')
      ).pipe(Effect.flip)
    );

    expect(error).toBeInstanceOf(UnsupportedPullRequestProviderError);
    if (!(error instanceof UnsupportedPullRequestProviderError)) {
      throw new Error('Expected unsupported provider error');
    }
    expect(error.source).toBe('repository-ref');
    expect(error.value).toBe('bitbucket');
  });

  test('fails with a typed unsupported-provider error when no provider matches', async () => {
    const registry = createBuiltinCommandRegistry();

    const error = await Effect.runPromise(
      resolvePullRequestProviderFromRegistryForRemote(
        registry,
        'git@gitlab.com:acme/widgets.git'
      ).pipe(Effect.flip)
    );

    expect(error).toBeInstanceOf(UnsupportedPullRequestProviderError);
    expect(error._tag).toBe('UnsupportedPullRequestProviderError');
    expect(error.source).toBe('git-remote');
  });

  test('fails with a typed ambiguity error for same-priority matches', async () => {
    const providers = [
      fakeProvider('first-plugin', 'first-provider', 50),
      fakeProvider('second-plugin', 'second-provider', 50),
    ];

    const error = await Effect.runPromise(
      resolvePullRequestProviderForRemote(providers, 'matched-remote').pipe(
        Effect.flip
      )
    );

    expect(error).toBeInstanceOf(AmbiguousPullRequestProviderError);
    if (!(error instanceof AmbiguousPullRequestProviderError)) {
      throw new Error('Expected ambiguous provider resolution error');
    }
    expect(error._tag).toBe('AmbiguousPullRequestProviderError');
    expect(error.candidates.map((candidate) => candidate.pluginId)).toEqual([
      'first-plugin',
      'second-plugin',
    ]);
  });

  test('prefers the highest-priority provider match regardless of registration order', async () => {
    const providers = [
      fakeProvider('broad-plugin', 'broad-provider', 10),
      fakeProvider('specific-plugin', 'specific-provider', 100),
    ];

    const resolved = await Effect.runPromise(
      resolvePullRequestProviderForRemote(providers, 'matched-remote')
    );

    expect(resolved.pluginId).toBe('specific-plugin');
    expect(resolved.priority).toBe(100);
  });

  test('rejects remote matches that omit repository refs', async () => {
    const providers = [
      fakeProvider('broken-plugin', 'broken-provider', 100, {
        source: 'git-remote',
        priority: 100,
      } as unknown as AidePullRequestRemoteMatch),
    ];

    const error = await Effect.runPromise(
      resolvePullRequestProviderForRemote(providers, 'matched-remote').pipe(
        Effect.flip
      )
    );

    expect(error).toBeInstanceOf(InvalidPullRequestProviderMatchError);
    if (!(error instanceof InvalidPullRequestProviderMatchError)) {
      throw new Error('Expected invalid provider match error');
    }
    expect(error._tag).toBe('InvalidPullRequestProviderMatchError');
    expect(error.pluginId).toBe('broken-plugin');
    expect(error.providerId).toBe('broken-provider');
    expect(error.reason).toBe('match result failed structural capture');
  });

  test('rejects non-object provider matches as typed invalid matches', async () => {
    const providers = [
      malformedProvider('broken-plugin', 'broken-provider', 100, {
        remote: () => undefined,
      }),
    ];

    const error = await Effect.runPromise(
      resolvePullRequestProviderForRemote(providers, 'matched-remote').pipe(
        Effect.flip
      )
    );

    expect(error).toBeInstanceOf(InvalidPullRequestProviderMatchError);
    if (!(error instanceof InvalidPullRequestProviderMatchError)) {
      throw new Error('Expected invalid provider match error');
    }
    expect(error.reason).toBe('match result failed structural capture');
  });

  test('wraps throwing provider matchers as typed invocation errors', async () => {
    const providers: PluginCapability<ServiceFreePullRequestProviderCapability>[] =
      [
        {
          pluginId: 'broken-plugin',
          capability: {
            providerId: 'broken-provider',
            priority: 100,
            features: {},
            authStatus: () => Effect.succeed({ state: 'configured' }),
            matchRemote: () => {
              throw new Error('boom');
            },
            matchPullRequestUrl: () => null,
          },
        },
      ];

    const error = await Effect.runPromise(
      resolvePullRequestProviderForRemote(providers, 'matched-remote').pipe(
        Effect.flip
      )
    );

    expect(error).toBeInstanceOf(PullRequestProviderInvocationError);
    if (!(error instanceof PullRequestProviderInvocationError)) {
      throw new Error('Expected provider invocation error');
    }
    expect(error.pluginId).toBe('broken-plugin');
    expect(error.providerId).toBe('broken-provider');
    expect(error.cause).toBeInstanceOf(Error);
    const errorCause = error.cause;
    if (!(errorCause instanceof Error)) {
      throw new Error('Expected provider invocation error cause');
    }
    expect(error.message).not.toContain('boom');
    expect(errorCause.message).toBe('matchRemote callback threw');
  });

  test('wraps throwing matchPullRequestUrl as typed invocation errors', async () => {
    const providers: PluginCapability<ServiceFreePullRequestProviderCapability>[] =
      [
        {
          pluginId: 'broken-plugin',
          capability: {
            providerId: 'broken-provider',
            priority: 100,
            features: {},
            authStatus: () => Effect.succeed({ state: 'configured' }),
            matchRemote: () => ({
              source: 'git-remote',
              priority: 100,
              repository: externalRepository('broken-provider'),
            }),
            matchPullRequestUrl: () => {
              throw new Error('boom');
            },
          },
        },
      ];

    const error = await Effect.runPromise(
      resolvePullRequestProviderForUrl(
        providers,
        'https://example.test/pull/1'
      ).pipe(Effect.flip)
    );

    expect(error).toBeInstanceOf(PullRequestProviderInvocationError);
    if (!(error instanceof PullRequestProviderInvocationError)) {
      throw new Error('Expected provider invocation error');
    }
    expect(error.pluginId).toBe('broken-plugin');
    expect(error.providerId).toBe('broken-provider');
    expect(error.cause).toBeInstanceOf(Error);
    const errorCause = error.cause;
    if (!(errorCause instanceof Error)) {
      throw new Error('Expected provider invocation error cause');
    }
    expect(error.message).not.toContain('boom');
    expect(errorCause.message).toBe('matchPullRequestUrl callback threw');
  });

  test('wraps throwing provider match object getters as typed invalid matches', async () => {
    let getterReads = 0;
    const providers = [
      malformedProvider('broken-plugin', 'broken-provider', 100, {
        remote: () =>
          new Proxy(
            {},
            {
              get: () => {
                getterReads += 1;
                throw new Error('getter boom');
              },
            }
          ),
      }),
    ];

    const error = await Effect.runPromise(
      resolvePullRequestProviderForRemote(providers, 'matched-remote').pipe(
        Effect.flip
      )
    );

    expect(error).toBeInstanceOf(InvalidPullRequestProviderMatchError);
    if (!(error instanceof InvalidPullRequestProviderMatchError)) {
      throw new Error('Expected invalid provider match error');
    }
    expect(error.pluginId).toBe('broken-plugin');
    expect(error.providerId).toBe('broken-provider');
    expect(error.reason).toBe('match result failed structural capture');
    expect(error.message).not.toContain('getter boom');
    expect(getterReads).toBe(0);
  });

  test('snapshots validated provider matches before returning them', async () => {
    const sourceRepository = externalRepository('shape-provider') as {
      kind: 'external';
      providerId: string;
      displayName: string;
    };
    const sourceMatch = {
      source: 'git-remote' as const,
      priority: 100,
      repository: sourceRepository,
    };
    const providers = [
      malformedProvider('shape-plugin', 'shape-provider', 100, {
        remote: () => sourceMatch,
      }),
    ];

    const resolved = await Effect.runPromise(
      resolvePullRequestProviderForRemote(providers, 'matched-remote')
    );

    sourceRepository.displayName = 'mutated';
    sourceMatch.priority = -1;
    expect(Object.isFrozen(resolved.match)).toBe(true);
    expect(Object.isFrozen(resolved.match.repository)).toBe(true);
    const repository = resolved.match.repository;
    expect(repository).toEqual(externalRepository('shape-provider'));
    expect(resolved.match.repository).toBe(repository);
    expect(resolved.match).not.toBe(sourceMatch);
    expect(resolved.match.repository).not.toBe(sourceRepository);
    expect(resolved.priority).toBe(100);
  });

  test('rejects provider matches with the wrong source for the lookup', async () => {
    const providers = [
      malformedProvider('broken-plugin', 'broken-provider', 100, {
        remote: () => ({
          source: 'pull-request-url',
          priority: 100,
          repository: externalRepository('broken-provider'),
          pullRequest: { number: 1 },
        }),
      }),
    ];

    const error = await Effect.runPromise(
      resolvePullRequestProviderForRemote(providers, 'matched-remote').pipe(
        Effect.flip
      )
    );

    expect(error).toBeInstanceOf(InvalidPullRequestProviderMatchError);
    if (!(error instanceof InvalidPullRequestProviderMatchError)) {
      throw new Error('Expected invalid provider match error');
    }
    expect(error.reason).toBe("expected source 'git-remote'");
  });

  test('rejects pull request URL matches that omit pull request refs', async () => {
    const providers = [
      fakeProvider('broken-plugin', 'broken-provider', 100, undefined, {
        source: 'pull-request-url',
        priority: 100,
        repository: externalRepository('broken-provider'),
      } as unknown as AidePullRequestUrlMatch),
    ];

    const error = await Effect.runPromise(
      resolvePullRequestProviderForUrl(
        providers,
        'https://example.test/pr/1'
      ).pipe(Effect.flip)
    );

    expect(error).toBeInstanceOf(InvalidPullRequestProviderMatchError);
    if (!(error instanceof InvalidPullRequestProviderMatchError)) {
      throw new Error('Expected invalid provider match error');
    }
    expect(error.source).toBe('pull-request-url');
    expect(error.reason).toBe('match result failed structural capture');
  });

  test('rejects remote matches that include pull request refs', async () => {
    const providers = [
      fakeProvider('broken-plugin', 'broken-provider', 100, {
        source: 'git-remote',
        priority: 100,
        repository: externalRepository('broken-provider'),
        pullRequest: { number: 1 },
      } as unknown as AidePullRequestRemoteMatch),
    ];

    const error = await Effect.runPromise(
      resolvePullRequestProviderForRemote(providers, 'matched-remote').pipe(
        Effect.flip
      )
    );

    expect(error).toBeInstanceOf(InvalidPullRequestProviderMatchError);
    if (!(error instanceof InvalidPullRequestProviderMatchError)) {
      throw new Error('Expected invalid provider match error');
    }
    expect(error.reason).toBe('match result failed structural capture');
  });

  test('rejects invalid pull request refs from URL matches', async () => {
    const providers = [
      malformedProvider('broken-plugin', 'broken-provider', 100, {
        pullRequestUrl: () => ({
          source: 'pull-request-url',
          priority: 100,
          repository: externalRepository('broken-provider'),
          pullRequest: { number: 0 },
        }),
      }),
    ];

    const error = await Effect.runPromise(
      resolvePullRequestProviderForUrl(
        providers,
        'https://example.test/pr/0'
      ).pipe(Effect.flip)
    );

    expect(error).toBeInstanceOf(InvalidPullRequestProviderMatchError);
    if (!(error instanceof InvalidPullRequestProviderMatchError)) {
      throw new Error('Expected invalid provider match error');
    }
    expect(error.reason).toBe('invalid pull request ref');
  });

  test('rejects invalid match priorities before provider selection', async () => {
    const providers = [
      malformedProvider('broken-plugin', 'broken-provider', 100, {
        remote: () => ({
          source: 'git-remote',
          priority: Number.NaN,
          repository: externalRepository('broken-provider'),
        }),
      }),
    ];

    const error = await Effect.runPromise(
      resolvePullRequestProviderForRemote(providers, 'matched-remote').pipe(
        Effect.flip
      )
    );

    expect(error).toBeInstanceOf(InvalidPullRequestProviderMatchError);
    if (!(error instanceof InvalidPullRequestProviderMatchError)) {
      throw new Error('Expected invalid provider match error');
    }
    expect(error.reason).toBe('invalid match priority');
  });

  test('rejects invalid capability priorities used as fallbacks', async () => {
    const providers = [
      malformedProvider('broken-plugin', 'broken-provider', Number.NaN, {
        remote: () => ({
          source: 'git-remote',
          repository: externalRepository('broken-provider'),
        }),
      }),
    ];

    const error = await Effect.runPromise(
      resolvePullRequestProviderForRemote(providers, 'matched-remote').pipe(
        Effect.flip
      )
    );

    expect(error).toBeInstanceOf(InvalidPullRequestProviderMatchError);
    if (!(error instanceof InvalidPullRequestProviderMatchError)) {
      throw new Error('Expected invalid provider match error');
    }
    expect(error.reason).toBe('invalid capability priority');
  });

  test('rejects invalid capability priorities even when matches override priority', async () => {
    const providers = [
      malformedProvider('broken-plugin', 'broken-provider', Number.NaN, {
        remote: () => ({
          source: 'git-remote',
          priority: 100,
          repository: externalRepository('broken-provider'),
        }),
      }),
    ];

    const error = await Effect.runPromise(
      resolvePullRequestProviderForRemote(providers, 'matched-remote').pipe(
        Effect.flip
      )
    );

    expect(error).toBeInstanceOf(InvalidPullRequestProviderMatchError);
    if (!(error instanceof InvalidPullRequestProviderMatchError)) {
      throw new Error('Expected invalid provider match error');
    }
    expect(error.reason).toBe('invalid capability priority');
  });

  test('rejects external repository refs with mismatched provider ids', async () => {
    const providers = [
      malformedProvider('broken-plugin', 'broken-provider', 100, {
        remote: () => ({
          source: 'git-remote',
          priority: 100,
          repository: externalRepository('other-provider'),
        }),
      }),
    ];

    const error = await Effect.runPromise(
      resolvePullRequestProviderForRemote(providers, 'matched-remote').pipe(
        Effect.flip
      )
    );

    expect(error).toBeInstanceOf(InvalidPullRequestProviderMatchError);
    if (!(error instanceof InvalidPullRequestProviderMatchError)) {
      throw new Error('Expected invalid provider match error');
    }
    expect(error.reason).toBe(
      'external repository providerId must match provider id'
    );
  });

  test('rejects external repository refs with non-primitive metadata', async () => {
    const providers = [
      malformedProvider('broken-plugin', 'broken-provider', 100, {
        remote: () => ({
          source: 'git-remote',
          priority: 100,
          repository: {
            ...externalRepository('broken-provider'),
            metadata: { nested: { unsupported: true } },
          },
        }),
      }),
    ];

    const error = await Effect.runPromise(
      resolvePullRequestProviderForRemote(providers, 'matched-remote').pipe(
        Effect.flip
      )
    );

    expect(error).toBeInstanceOf(InvalidPullRequestProviderMatchError);
    if (!(error instanceof InvalidPullRequestProviderMatchError)) {
      throw new Error('Expected invalid provider match error');
    }
    expect(error.reason).toBe('match result failed structural capture');
  });
});

describe('pull request provider registry security', () => {
  test('rejects reserved provider ids from non-owner plugins', () => {
    const registry = createCommandRegistry();

    expect(() =>
      registry.registerPlugin(
        pluginWithPullRequestProvider('evil-github', 'github')
      )
    ).toThrow(
      "Plugin 'evil-github' cannot declare reserved pull request provider 'github' (reserved for plugin 'github')"
    );
    expect(() =>
      registry.registerPlugin(
        pluginWithPullRequestProvider('evil-ado', 'azure-devops')
      )
    ).toThrow(
      "Plugin 'evil-ado' cannot declare reserved pull request provider 'azure-devops' (reserved for plugin 'azure-devops')"
    );
    expect(registry.pluginIds()).toEqual([]);
  });

  test('rejects duplicate pull request provider ids', () => {
    const registry = createCommandRegistry();

    registry.registerPlugin(
      pluginWithPullRequestProvider('gitlab-one', 'gitlab')
    );

    expect(() =>
      registry.registerPlugin(
        pluginWithPullRequestProvider('gitlab-two', 'gitlab')
      )
    ).toThrow(
      "Pull request provider 'gitlab' is already registered by plugin 'gitlab-one'"
    );
    expect(
      registry.capabilities
        .pullRequestProviders()
        .map((provider) => provider.capability.providerId)
    ).toEqual(['gitlab']);
  });

  test('rejects malformed pull request provider capabilities at registration', () => {
    const registry = createCommandRegistry();

    expect(() =>
      registry.registerPlugin(
        defineAidePlugin({
          id: 'broken-plugin',
          summary: 'Broken provider plugin',
          commands: [],
          capabilities: {
            pullRequestProvider: {
              providerId: 'broken-provider',
              priority: 100,
              features: {},
              authStatus: () => Effect.succeed({ state: 'configured' }),
              matchRemote: null,
              matchPullRequestUrl: () => null,
            } as unknown as ServiceFreePullRequestProviderCapability,
          },
        })
      )
    ).toThrow(
      "Plugin 'broken-plugin' pull request provider capability field 'matchRemote' must be a function"
    );
    expect(registry.pluginIds()).toEqual([]);
  });

  test('returns immutable pull request provider capability snapshots', () => {
    const registry = createCommandRegistry();
    registry.registerPlugin(
      pluginWithPullRequestProvider('gitlab-plugin', 'gitlab')
    );

    const providers = registry.capabilities.pullRequestProviders();

    expect(Object.isFrozen(providers)).toBe(true);
    expect(Object.isFrozen(providers[0])).toBe(true);
    expect(Object.isFrozen(providers[0]!.capability)).toBe(true);
    expect(Object.isFrozen(providers[0]!.capability.features)).toBe(true);
  });
});

describe('pull request provider auth capabilities', () => {
  test('maps GitHub gh CLI auth into configured provider status', async () => {
    const plugin = createGitHubPlugin({
      probeConfig: async () => ({ kind: 'env', value: { source: 'gh-cli' } }),
    });

    const status = await Effect.runPromise(
      plugin
        .capabilities!.pullRequestProvider!.authStatus()
        .pipe(Effect.provide(makeTestKeyring().layer))
    );

    expect(status).toEqual({
      state: 'configured',
      detail: 'authenticated via gh CLI',
    });
  });

  test('maps Azure DevOps malformed auth into misconfigured provider status', async () => {
    const plugin = createAzureDevOpsPlugin({
      probeConfig: async () => ({
        kind: 'malformed',
        reason: 'bad stored credentials',
      }),
    });

    const status = await Effect.runPromise(
      plugin
        .capabilities!.pullRequestProvider!.authStatus()
        .pipe(Effect.provide(makeTestKeyring().layer))
    );

    expect(status).toEqual({
      state: 'misconfigured',
      detail: 'bad stored credentials',
    });
  });
});

describe('pull request provider list operations', () => {
  test('lists pull requests for a repository ref through a fake provider', async () => {
    const calls: unknown[] = [];
    const repository = externalRepository('gitlab', { projectId: 10 });
    const provider = fakeProvider('gitlab-plugin', 'gitlab', 100);

    const result = await Effect.runPromise(
      listPullRequestsForRepository(
        [
          {
            ...provider,
            capability: {
              ...provider.capability,
              operations: {
                listPullRequests: (request) => {
                  calls.push(request);
                  return Effect.succeed({
                    repository,
                    repositoryLabel: 'gitlab/acme/widgets',
                    pullRequests: [
                      {
                        id: 1,
                        title: 'Repository-ref PR',
                        status: 'active',
                        createdAt: '2026-01-01T00:00:00Z',
                        author: { displayName: 'Ada Lovelace' },
                      },
                    ],
                  });
                },
              },
            },
          },
        ],
        repository,
        { status: 'active', limit: 10, createdBy: 'ada' }
      )
    );

    expect(calls).toEqual([
      {
        match: {
          source: 'repository-ref',
          repository,
        },
        status: 'active',
        limit: 10,
        createdBy: 'ada',
      },
    ]);
    expect(result.repositoryLabel).toBe('gitlab/acme/widgets');
    expect(result.pullRequests).toEqual([
      {
        id: 1,
        title: 'Repository-ref PR',
        status: 'active',
        createdAt: '2026-01-01T00:00:00Z',
        author: { displayName: 'Ada Lovelace' },
      },
    ]);
  });

  test('lists GitHub pull requests through a provider-owned operation', async () => {
    const calls: unknown[] = [];
    const plugin = createGitHubPlugin({
      createClient: async ({ host, scope }) => {
        calls.push({ host, scope });
        return {
          listPullRequests: async (owner, repo, options) => {
            calls.push({ owner, repo, options });
            return [
              fakeGitHubPullRequest({
                number: 10,
                title: 'Merged PR',
                state: 'closed',
                merged: true,
                userLogin: 'octo',
              }),
              fakeGitHubPullRequest({
                number: 11,
                title: 'Closed PR',
                state: 'closed',
                merged: false,
                userLogin: 'octo',
              }),
            ];
          },
          getPullRequest: async () =>
            fakeGitHubPullRequest({ number: 1, title: 'Unused' }),
          getPullRequestFiles: async () => [],
          getIssueComments: async () => [],
          getReviewComments: async () => [],
        };
      },
    });

    const result = await Effect.runPromise(
      listPullRequestsForRemote(
        [
          {
            pluginId: plugin.id,
            capability: plugin.capabilities!.pullRequestProvider!,
          },
        ],
        'git@github.com:acme/widgets.git',
        { status: 'completed', limit: 5, createdBy: 'octo' }
      )
    );

    expect(calls).toEqual([
      {
        host: 'github.com',
        scope: { providerId: 'github', host: 'github.com' },
      },
      {
        owner: 'acme',
        repo: 'widgets',
        options: { state: 'closed', per_page: 5 },
      },
    ]);
    expect(result.repositoryLabel).toBe('github.com/acme/widgets');
    expect(result.pullRequests).toEqual([
      {
        id: 10,
        title: 'Merged PR',
        status: 'completed',
        createdAt: '2026-01-01T00:00:00Z',
        author: { displayName: 'octo', username: 'octo' },
        description: 'body',
        url: 'https://github.com/acme/widgets/pull/10',
        draft: false,
      },
    ]);
    expect(Object.isFrozen(result.pullRequests)).toBe(true);
  });

  test('lists Azure DevOps pull requests through a provider-owned operation', async () => {
    const calls: unknown[] = [];
    const plugin = createAzureDevOpsPlugin({
      createClient: async (options) => {
        calls.push(options);
        return {
          config: {
            orgUrl: 'https://dev.azure.com/acme',
            pat: 'token',
            authMethod: 'pat',
          },
          client: {
            listPullRequests: async (project, repo, options) => {
              calls.push({ project, repo, options });
              return {
                value: [
                  fakeAzureDevOpsPullRequest({
                    pullRequestId: 42,
                    title: 'ADO PR',
                    createdBy: {
                      displayName: 'Ada Lovelace',
                      uniqueName: 'ada@example.com',
                      id: 'ada',
                    },
                  }),
                ],
              };
            },
            getPullRequest: async () =>
              fakeAzureDevOpsPullRequest({
                pullRequestId: 1,
                title: 'Unused',
              }),
            getPullRequestLabels: async () => ({ value: [] }),
            getAllPullRequestChanges: async () => [],
            getAllComments: async () => [],
          },
        };
      },
    });

    const result = await Effect.runPromise(
      listPullRequestsForRemote(
        [
          {
            pluginId: plugin.id,
            capability: plugin.capabilities!.pullRequestProvider!,
          },
        ],
        'git@ssh.dev.azure.com:v3/acme/Platform/widgets',
        { status: 'active', limit: 20, createdBy: 'ada' }
      )
    );

    expect(calls).toEqual([
      {
        scope: {
          providerId: 'azure-devops',
          host: 'dev.azure.com',
          org: 'acme',
        },
      },
      {
        project: 'Platform',
        repo: 'widgets',
        options: { status: 'active', top: 20 },
      },
    ]);
    expect(result.repositoryLabel).toBe('acme/Platform/widgets');
    expect(result.pullRequests[0]).toMatchObject({
      id: 42,
      title: 'ADO PR',
      status: 'active',
      author: {
        displayName: 'Ada Lovelace',
        email: 'ada@example.com',
      },
    });
  });

  test('uses one scoped ADO credential across mixed-case and visualstudio identities', async () => {
    const env = saveEnv([
      'AZURE_DEVOPS_ORG_URL',
      'AZURE_DEVOPS_PAT',
      'AZURE_DEVOPS_AUTH_METHOD',
      'AZURE_DEVOPS_DEFAULT_PROJECT',
    ]);
    const previousService = Bun.env.AIDE_SECRET_SERVICE_OVERRIDE;
    Bun.env.AIDE_SECRET_SERVICE_OVERRIDE = 'aide';
    const store: Store = new Map([
      [
        'aide:auth:azure-devops:host:dev.azure.com:org:acme',
        JSON.stringify({
          orgUrl: 'https://Acme.visualstudio.com',
          pat: 'scoped-token',
          authMethod: 'pat',
        }),
      ],
    ]);
    const restoreSecrets = installMockSecrets(store);

    try {
      const calls: unknown[] = [];
      const plugin = createAzureDevOpsPlugin({
        createClient: async (options) => {
          const { config } = await loadAzureDevOpsConfig(options?.scope);
          calls.push({ options, pat: config.pat });
          return {
            config,
            client: {
              listPullRequests: async () => ({
                value: [
                  fakeAzureDevOpsPullRequest({
                    pullRequestId: 42,
                    title: 'Canonical ADO identity',
                  }),
                ],
              }),
              getPullRequest: async () =>
                fakeAzureDevOpsPullRequest({
                  pullRequestId: 42,
                  title: 'Canonical ADO identity',
                }),
              getPullRequestLabels: async () => ({ value: [] }),
              getAllPullRequestChanges: async () => [],
              getAllComments: async () => [],
            },
          };
        },
      });

      const result = await Effect.runPromise(
        listPullRequestsForRemote(
          [
            {
              pluginId: plugin.id,
              capability: plugin.capabilities!.pullRequestProvider!,
            },
          ],
          'git@ssh.dev.azure.com:v3/ACME/Platform/widgets'
        )
      );

      expect(calls).toEqual([
        {
          options: {
            scope: {
              providerId: 'azure-devops',
              host: 'dev.azure.com',
              org: 'acme',
            },
          },
          pat: 'scoped-token',
        },
      ]);
      expect(result.pullRequests[0]?.title).toBe('Canonical ADO identity');
      expect(result.repositoryLabel).toBe('ACME/Platform/widgets');
    } finally {
      restoreSecrets();
      restoreEnv(env);
      if (previousService === undefined) {
        delete Bun.env.AIDE_SECRET_SERVICE_OVERRIDE;
      } else {
        Bun.env.AIDE_SECRET_SERVICE_OVERRIDE = previousService;
      }
    }
  });

  test('rejects providers that do not implement listPullRequests', async () => {
    const error = await Effect.runPromise(
      listPullRequestsForRemote(
        [fakeProvider('gitlab-plugin', 'gitlab', 100)],
        'matched-remote'
      ).pipe(Effect.flip)
    );

    expect(error).toBeInstanceOf(UnsupportedPullRequestProviderOperationError);
    if (!(error instanceof UnsupportedPullRequestProviderOperationError)) {
      throw new Error('Expected unsupported provider operation error');
    }
    expect(error._tag).toBe('UnsupportedPullRequestProviderOperationError');
    expect(error.providerId).toBe('gitlab');
  });

  test('wraps synchronous provider operation throws', async () => {
    const provider = fakeProvider('gitlab-plugin', 'gitlab', 100);
    const error = await Effect.runPromise(
      listPullRequestsForRemote(
        [
          {
            ...provider,
            capability: {
              ...provider.capability,
              operations: {
                listPullRequests: () => {
                  throw new Error('sync boom');
                },
              },
            },
          },
        ],
        'matched-remote'
      ).pipe(Effect.flip)
    );

    expect(error).toBeInstanceOf(PullRequestProviderOperationError);
    expect(error.message).toBe(
      "Pull request provider 'gitlab' from plugin 'gitlab-plugin' failed during listPullRequests"
    );
  });

  test('rejects provider operations that do not return Effects', async () => {
    const provider = fakeProvider('gitlab-plugin', 'gitlab', 100);
    const error = await Effect.runPromise(
      listPullRequestsForRemote(
        [
          {
            ...provider,
            capability: {
              ...provider.capability,
              operations: {
                listPullRequests: () => ({}) as never,
              },
            },
          },
        ],
        'matched-remote'
      ).pipe(Effect.flip)
    );

    expect(error).toBeInstanceOf(
      InvalidPullRequestProviderOperationResultError
    );
    if (!(error instanceof InvalidPullRequestProviderOperationResultError)) {
      throw new Error('Expected invalid provider operation result error');
    }
    expect(error.reason).toBe('operation must return an Effect');
  });

  test('rejects malformed listPullRequests results', async () => {
    const provider = fakeProvider('gitlab-plugin', 'gitlab', 100);
    const error = await Effect.runPromise(
      listPullRequestsForRemote(
        [
          {
            ...provider,
            capability: {
              ...provider.capability,
              operations: {
                listPullRequests: () =>
                  Effect.succeed({
                    repository: externalRepository('gitlab'),
                    pullRequests: [{ id: 0 }],
                  } as never),
              },
            },
          },
        ],
        'matched-remote'
      ).pipe(Effect.flip)
    );

    expect(error).toBeInstanceOf(
      InvalidPullRequestProviderOperationResultError
    );
    if (!(error instanceof InvalidPullRequestProviderOperationResultError)) {
      throw new Error('Expected invalid provider operation result error');
    }
    expect(error._tag).toBe('InvalidPullRequestProviderOperationResultError');
    expect(error.reason).toBe('operation result failed structural capture');
  });

  test('rejects listPullRequests results with invalid createdAt dates', async () => {
    const provider = fakeProvider('gitlab-plugin', 'gitlab', 100);
    const error = await Effect.runPromise(
      listPullRequestsForRemote(
        [
          {
            ...provider,
            capability: {
              ...provider.capability,
              operations: {
                listPullRequests: () =>
                  Effect.succeed({
                    repository: externalRepository('gitlab'),
                    pullRequests: [
                      {
                        id: 1,
                        title: 'Invalid date',
                        status: 'active',
                        createdAt: 'not-a-date',
                        author: { displayName: 'Ada Lovelace' },
                      },
                    ],
                  }),
              },
            },
          },
        ],
        'matched-remote'
      ).pipe(Effect.flip)
    );

    expect(error).toBeInstanceOf(
      InvalidPullRequestProviderOperationResultError
    );
    if (!(error instanceof InvalidPullRequestProviderOperationResultError)) {
      throw new Error('Expected invalid provider operation result error');
    }
    expect(error.reason).toBe('invalid pull request item');
  });

  test('rejects listPullRequests results for a different repository ref', async () => {
    const provider = fakeProvider('gitlab-plugin', 'gitlab', 100);
    const error = await Effect.runPromise(
      listPullRequestsForRemote(
        [
          {
            ...provider,
            capability: {
              ...provider.capability,
              operations: {
                listPullRequests: () =>
                  Effect.succeed({
                    repository: externalRepository('other-provider'),
                    pullRequests: [
                      {
                        id: 1,
                        title: 'Wrong repo',
                        status: 'active',
                        createdAt: '2026-01-01T00:00:00Z',
                        author: { displayName: 'Ada Lovelace' },
                      },
                    ],
                  }),
              },
            },
          },
        ],
        'matched-remote'
      ).pipe(Effect.flip)
    );

    expect(error).toBeInstanceOf(
      InvalidPullRequestProviderOperationResultError
    );
    if (!(error instanceof InvalidPullRequestProviderOperationResultError)) {
      throw new Error('Expected invalid provider operation result error');
    }
    expect(error.reason).toBe(
      'repository ref does not match selected provider match'
    );
  });

  test('rejects listPullRequests results with mismatched external repository metadata', async () => {
    const provider = fakeProvider(
      'gitlab-plugin',
      'gitlab',
      100,
      {
        source: 'git-remote',
        priority: 100,
        repository: externalRepository('gitlab', { projectId: 1 }),
      },
      undefined
    );
    const error = await Effect.runPromise(
      listPullRequestsForRemote(
        [
          {
            ...provider,
            capability: {
              ...provider.capability,
              operations: {
                listPullRequests: () =>
                  Effect.succeed({
                    repository: externalRepository('gitlab', { projectId: 2 }),
                    pullRequests: [
                      {
                        id: 1,
                        title: 'Wrong repo metadata',
                        status: 'active',
                        createdAt: '2026-01-01T00:00:00Z',
                        author: { displayName: 'Ada Lovelace' },
                      },
                    ],
                  }),
              },
            },
          },
        ],
        'matched-remote'
      ).pipe(Effect.flip)
    );

    expect(error).toBeInstanceOf(
      InvalidPullRequestProviderOperationResultError
    );
    if (!(error instanceof InvalidPullRequestProviderOperationResultError)) {
      throw new Error('Expected invalid provider operation result error');
    }
    expect(error.reason).toBe(
      'repository ref does not match selected provider match'
    );
  });

  test('wraps provider operation failures', async () => {
    const plugin = createAzureDevOpsPlugin({
      createClient: async () => ({
        config: {
          orgUrl: 'https://dev.azure.com/other',
          pat: 'token',
          authMethod: 'pat',
        },
        client: {
          listPullRequests: async () => ({ value: [] }),
          getPullRequest: async () =>
            fakeAzureDevOpsPullRequest({
              pullRequestId: 1,
              title: 'Unused',
            }),
          getPullRequestLabels: async () => ({ value: [] }),
          getAllPullRequestChanges: async () => [],
          getAllComments: async () => [],
        },
      }),
    });

    const error = await Effect.runPromise(
      listPullRequestsForRemote(
        [
          {
            pluginId: plugin.id,
            capability: plugin.capabilities!.pullRequestProvider!,
          },
        ],
        'git@ssh.dev.azure.com:v3/acme/Platform/widgets'
      ).pipe(Effect.flip)
    );

    expect(error).toBeInstanceOf(PullRequestProviderOperationError);
    expect(error.message).toBe(
      "Pull request provider 'azure-devops' from plugin 'azure-devops' failed during listPullRequests"
    );
  });

  test('times out async provider list operations', async () => {
    const provider = fakeProvider('slow-plugin', 'slow-provider', 100);
    const error = await Effect.runPromise(
      listPullRequestsForRemote(
        [
          {
            ...provider,
            capability: {
              ...provider.capability,
              operations: {
                listPullRequests: () => Effect.never,
              },
            },
          },
        ],
        'matched-remote',
        {},
        { operationTimeout: '10 millis' }
      ).pipe(Effect.flip)
    );

    expect(error).toBeInstanceOf(PullRequestProviderOperationTimeoutError);
    if (!(error instanceof PullRequestProviderOperationTimeoutError)) {
      throw new Error('Expected provider operation timeout error');
    }
    expect(error._tag).toBe('PullRequestProviderOperationTimeoutError');
    expect(error.providerId).toBe('slow-provider');
  });
});

describe('pull request provider view operations', () => {
  test('gets a pull request for a repository ref through a fake provider', async () => {
    const calls: unknown[] = [];
    const repository = externalRepository('gitlab', { projectId: 10 });
    const provider = fakeProvider('gitlab-plugin', 'gitlab', 100);

    const result = await Effect.runPromise(
      getPullRequestForRepository(
        [
          {
            ...provider,
            capability: {
              ...provider.capability,
              operations: {
                getPullRequest: (request) => {
                  calls.push(request);
                  return Effect.succeed({
                    repository,
                    repositoryLabel: 'gitlab/acme/widgets',
                    pullRequest: {
                      id: 2,
                      title: 'Repository-ref detail',
                      status: 'active',
                      createdAt: '2026-01-01T00:00:00Z',
                      author: { displayName: 'Ada Lovelace' },
                    },
                  });
                },
              },
            },
          },
        ],
        repository,
        { pullRequest: { number: 2 } }
      )
    );

    expect(calls).toEqual([
      {
        match: {
          source: 'repository-ref',
          repository,
        },
        pullRequest: { number: 2 },
      },
    ]);
    expect(result.repositoryLabel).toBe('gitlab/acme/widgets');
    expect(result.pullRequest).toMatchObject({
      id: 2,
      title: 'Repository-ref detail',
      status: 'active',
    });
  });

  test('gets a GitHub pull request through a provider-owned operation', async () => {
    const calls: unknown[] = [];
    const plugin = createGitHubPlugin({
      createClient: async ({ host, scope }) => {
        calls.push({ host, scope });
        return {
          listPullRequests: async () => [],
          getPullRequest: async (owner, repo, number) => {
            calls.push({ owner, repo, number });
            return fakeGitHubPullRequest({
              number,
              title: 'GitHub detail',
              userLogin: 'octo',
              head: {
                ref: 'feature/github-detail',
                sha: 'abc',
                label: 'octo:feature/github-detail',
              },
              base: {
                ref: 'main',
                sha: 'def',
                label: 'acme:main',
              },
              labels: [{ id: 1, name: 'feature', color: '0f0' }],
            });
          },
          getPullRequestFiles: async () => [],
          getIssueComments: async () => [],
          getReviewComments: async () => [],
        };
      },
    });

    const result = await Effect.runPromise(
      getPullRequestForRemote(
        [
          {
            pluginId: plugin.id,
            capability: plugin.capabilities!.pullRequestProvider!,
          },
        ],
        'git@github.com:acme/widgets.git',
        { pullRequest: { number: 12 } }
      )
    );

    expect(calls).toEqual([
      {
        host: 'github.com',
        scope: { providerId: 'github', host: 'github.com' },
      },
      { owner: 'acme', repo: 'widgets', number: 12 },
    ]);
    expect(result.repositoryLabel).toBe('github.com/acme/widgets');
    expect(result.pullRequest).toMatchObject({
      id: 12,
      title: 'GitHub detail',
      status: 'active',
      author: { displayName: 'octo', username: 'octo' },
      sourceBranch: 'feature/github-detail',
      targetBranch: 'main',
      labels: ['feature'],
      url: 'https://github.com/acme/widgets/pull/12',
    });
  });

  test('gets an Azure DevOps pull request through a URL provider match', async () => {
    const calls: unknown[] = [];
    const plugin = createAzureDevOpsPlugin({
      createClient: async (options) => {
        calls.push(options);
        return {
          config: {
            orgUrl: 'https://dev.azure.com/acme',
            pat: 'token',
            authMethod: 'pat',
          },
          client: {
            listPullRequests: async () => ({ value: [] }),
            getPullRequest: async (project, repo, number) => {
              calls.push({ project, repo, number });
              return fakeAzureDevOpsPullRequest({
                pullRequestId: number,
                title: 'ADO detail',
                sourceRefName: 'refs/heads/feature/ado-detail',
                targetRefName: 'refs/heads/main',
              });
            },
            getPullRequestLabels: async (project, repo, number) => {
              calls.push({ labelsFor: { project, repo, number } });
              return {
                value: [
                  { id: '1', name: 'ready', active: true, url: 'label-url' },
                  { id: '2', name: 'stale', active: false, url: 'label-url' },
                ],
              };
            },
            getAllPullRequestChanges: async () => [],
            getAllComments: async () => [],
          },
        };
      },
    });

    const result = await Effect.runPromise(
      getPullRequestForUrl(
        [
          {
            pluginId: plugin.id,
            capability: plugin.capabilities!.pullRequestProvider!,
          },
        ],
        'https://dev.azure.com/acme/Platform/_git/widgets/pullrequest/42'
      )
    );

    expect(calls).toEqual([
      {
        scope: {
          providerId: 'azure-devops',
          host: 'dev.azure.com',
          org: 'acme',
        },
      },
      { project: 'Platform', repo: 'widgets', number: 42 },
      { labelsFor: { project: 'Platform', repo: 'widgets', number: 42 } },
    ]);
    expect(result.repositoryLabel).toBe('acme/Platform/widgets');
    expect(result.pullRequest).toMatchObject({
      id: 42,
      title: 'ADO detail',
      sourceBranch: 'feature/ado-detail',
      targetBranch: 'main',
      labels: ['ready'],
    });
  });

  test('rejects providers that do not implement getPullRequest', async () => {
    const error = await Effect.runPromise(
      getPullRequestForRemote(
        [fakeProvider('gitlab-plugin', 'gitlab', 100)],
        'matched-remote',
        { pullRequest: { number: 1 } }
      ).pipe(Effect.flip)
    );

    expect(error).toBeInstanceOf(UnsupportedPullRequestProviderOperationError);
    if (!(error instanceof UnsupportedPullRequestProviderOperationError)) {
      throw new Error('Expected unsupported provider operation error');
    }
    expect(error.operation).toBe('getPullRequest');
  });

  test('rejects getPullRequest operations that do not return Effects', async () => {
    const provider = fakeProvider('gitlab-plugin', 'gitlab', 100);
    const error = await Effect.runPromise(
      getPullRequestForRemote(
        [
          {
            ...provider,
            capability: {
              ...provider.capability,
              operations: {
                getPullRequest: () => ({}) as never,
              },
            },
          },
        ],
        'matched-remote',
        { pullRequest: { number: 1 } }
      ).pipe(Effect.flip)
    );

    expect(error).toBeInstanceOf(
      InvalidPullRequestProviderOperationResultError
    );
    if (!(error instanceof InvalidPullRequestProviderOperationResultError)) {
      throw new Error('Expected invalid provider operation result error');
    }
    expect(error.operation).toBe('getPullRequest');
    expect(error.reason).toBe('operation must return an Effect');
  });

  test('rejects getPullRequest results for a different pull request id', async () => {
    const provider = fakeProvider('gitlab-plugin', 'gitlab', 100);
    const error = await Effect.runPromise(
      getPullRequestForRemote(
        [
          {
            ...provider,
            capability: {
              ...provider.capability,
              operations: {
                getPullRequest: () =>
                  Effect.succeed({
                    repository: externalRepository('gitlab'),
                    pullRequest: {
                      id: 2,
                      title: 'Wrong PR',
                      status: 'active',
                      createdAt: '2026-01-01T00:00:00Z',
                      author: { displayName: 'Ada Lovelace' },
                    },
                  }),
              },
            },
          },
        ],
        'matched-remote',
        { pullRequest: { number: 1 } }
      ).pipe(Effect.flip)
    );

    expect(error).toBeInstanceOf(
      InvalidPullRequestProviderOperationResultError
    );
    if (!(error instanceof InvalidPullRequestProviderOperationResultError)) {
      throw new Error('Expected invalid provider operation result error');
    }
    expect(error.reason).toBe(
      'pull request id does not match selected pull request'
    );
  });

  test('validates getPullRequest results against the original immutable request', async () => {
    const provider = fakeProvider('gitlab-plugin', 'gitlab', 100);
    const error = await Effect.runPromise(
      getPullRequestForRemote(
        [
          {
            ...provider,
            capability: {
              ...provider.capability,
              operations: {
                getPullRequest: (request) => {
                  try {
                    (
                      request as { pullRequest: { number: number } }
                    ).pullRequest.number = 2;
                  } catch {
                    // Frozen operation requests should reject mutation.
                  }

                  return Effect.succeed({
                    repository: externalRepository('gitlab'),
                    pullRequest: {
                      id: 2,
                      title: 'Mutated request PR',
                      status: 'active',
                      createdAt: '2026-01-01T00:00:00Z',
                      author: { displayName: 'Ada Lovelace' },
                    },
                  });
                },
              },
            },
          },
        ],
        'matched-remote',
        { pullRequest: { number: 1 } }
      ).pipe(Effect.flip)
    );

    expect(error).toBeInstanceOf(
      InvalidPullRequestProviderOperationResultError
    );
    if (!(error instanceof InvalidPullRequestProviderOperationResultError)) {
      throw new Error('Expected invalid provider operation result error');
    }
    expect(error.reason).toBe(
      'pull request id does not match selected pull request'
    );
  });

  test('rejects getPullRequest results with mismatched external repository metadata', async () => {
    const provider = fakeProvider(
      'gitlab-plugin',
      'gitlab',
      100,
      {
        source: 'git-remote',
        priority: 100,
        repository: externalRepository('gitlab', { projectId: 1 }),
      },
      undefined
    );
    const error = await Effect.runPromise(
      getPullRequestForRemote(
        [
          {
            ...provider,
            capability: {
              ...provider.capability,
              operations: {
                getPullRequest: () =>
                  Effect.succeed({
                    repository: externalRepository('gitlab', { projectId: 2 }),
                    pullRequest: {
                      id: 1,
                      title: 'Wrong repo metadata',
                      status: 'active',
                      createdAt: '2026-01-01T00:00:00Z',
                      author: { displayName: 'Ada Lovelace' },
                    },
                  }),
              },
            },
          },
        ],
        'matched-remote',
        { pullRequest: { number: 1 } }
      ).pipe(Effect.flip)
    );

    expect(error).toBeInstanceOf(
      InvalidPullRequestProviderOperationResultError
    );
    if (!(error instanceof InvalidPullRequestProviderOperationResultError)) {
      throw new Error('Expected invalid provider operation result error');
    }
    expect(error.reason).toBe(
      'repository ref does not match selected provider match'
    );
  });
});

describe('pull request provider create operations', () => {
  test('creates a pull request for a repository ref through a fake provider', async () => {
    const calls: unknown[] = [];
    const repository = externalRepository('gitlab', { projectId: 10 });
    const provider = fakeProvider('gitlab-plugin', 'gitlab', 100);

    const result = await Effect.runPromise(
      createPullRequestForRepository(
        [
          {
            ...provider,
            capability: {
              ...provider.capability,
              operations: {
                createPullRequest: (request) => {
                  calls.push(request);
                  return Effect.succeed({
                    repository,
                    repositoryLabel: 'gitlab/acme/widgets',
                    pullRequest: {
                      id: 8,
                      title: request.title,
                      status: 'active',
                      createdAt: '2026-01-01T00:00:00Z',
                      author: { displayName: 'Ada Lovelace' },
                      description: request.description,
                      sourceBranch: request.sourceBranch,
                      targetBranch: request.targetBranch,
                      labels: request.labels,
                    },
                  });
                },
              },
            },
          },
        ],
        repository,
        {
          title: 'New repository PR',
          description: 'body',
          sourceBranch: 'feature',
          targetBranch: 'main',
          draft: true,
          labels: ['ready'],
        }
      )
    );

    expect(calls).toEqual([
      {
        match: { source: 'repository-ref', repository },
        title: 'New repository PR',
        description: 'body',
        sourceBranch: 'feature',
        targetBranch: 'main',
        draft: true,
        labels: ['ready'],
      },
    ]);
    expect(result.pullRequest).toMatchObject({
      id: 8,
      title: 'New repository PR',
      sourceBranch: 'feature',
      targetBranch: 'main',
      labels: ['ready'],
    });
  });

  test('creates a GitHub pull request through a provider-owned operation', async () => {
    const calls: unknown[] = [];
    const plugin = createGitHubPlugin({
      createClient: async ({ host }) => {
        calls.push(host);
        return {
          listPullRequests: async () => [],
          getPullRequest: async (owner, repo, number) => {
            calls.push({ getPullRequest: { owner, repo, number } });
            return fakeGitHubPullRequest({
              number,
              title: 'Created GitHub PR',
              body: 'Created body',
              head: {
                ref: 'feature',
                sha: 'abc',
                label: 'octocat:feature',
              },
              base: {
                ref: 'main',
                sha: 'def',
                label: 'acme:main',
              },
              labels: [{ id: 1, name: 'ready', color: '0f0' }],
            });
          },
          getPullRequestFiles: async () => [],
          getIssueComments: async () => [],
          getReviewComments: async () => [],
          createPullRequest: async (
            owner,
            repo,
            head,
            base,
            title,
            body,
            options
          ) => {
            calls.push({
              createPullRequest: {
                owner,
                repo,
                head,
                base,
                title,
                body,
                options,
              },
            });
            return fakeGitHubPullRequest({
              number: 21,
              title,
              body,
              head: { ref: head, sha: 'abc', label: `octocat:${head}` },
              base: { ref: base, sha: 'def', label: `acme:${base}` },
            });
          },
          addLabels: async (owner, repo, number, labels) => {
            calls.push({ addLabels: { owner, repo, number, labels } });
            return [];
          },
        };
      },
    });

    const result = await Effect.runPromise(
      createPullRequestForRemote(
        [
          {
            pluginId: plugin.id,
            capability: plugin.capabilities!.pullRequestProvider!,
          },
        ],
        'git@github.com:acme/widgets.git',
        {
          title: 'Created GitHub PR',
          description: 'Created body',
          sourceBranch: 'feature',
          targetBranch: 'main',
          draft: true,
          labels: ['ready'],
        }
      )
    );

    expect(calls).toEqual([
      'github.com',
      {
        createPullRequest: {
          owner: 'acme',
          repo: 'widgets',
          head: 'feature',
          base: 'main',
          title: 'Created GitHub PR',
          body: 'Created body',
          options: { draft: true },
        },
      },
      {
        addLabels: {
          owner: 'acme',
          repo: 'widgets',
          number: 21,
          labels: ['ready'],
        },
      },
      { getPullRequest: { owner: 'acme', repo: 'widgets', number: 21 } },
    ]);
    expect(result.pullRequest).toMatchObject({
      id: 21,
      title: 'Created GitHub PR',
      description: 'Created body',
      sourceBranch: 'feature',
      targetBranch: 'main',
      labels: ['ready'],
    });
  });

  test('creates an Azure DevOps pull request and returns label warnings', async () => {
    const calls: unknown[] = [];
    const plugin = createAzureDevOpsPlugin({
      createClient: async () => ({
        config: {
          orgUrl: 'https://dev.azure.com/acme',
          pat: 'token',
          authMethod: 'pat',
        },
        client: {
          listPullRequests: async () => ({ value: [] }),
          getPullRequest: async () =>
            fakeAzureDevOpsPullRequest({ pullRequestId: 42, title: 'Unused' }),
          getPullRequestLabels: async (project, repo, number) => {
            calls.push({ labelsFor: { project, repo, number } });
            return {
              value: [
                { id: 'label-1', name: 'ready', active: true, url: 'url' },
              ],
            };
          },
          getAllPullRequestChanges: async () => [],
          getAllComments: async () => [],
          createPullRequest: async (
            project,
            repo,
            sourceRefName,
            targetRefName,
            title,
            description,
            options
          ) => {
            calls.push({
              createPullRequest: {
                project,
                repo,
                sourceRefName,
                targetRefName,
                title,
                description,
                options,
              },
            });
            return fakeAzureDevOpsPullRequest({
              pullRequestId: 77,
              title,
              description,
              sourceRefName,
              targetRefName,
              isDraft: options?.isDraft,
            });
          },
          addPullRequestLabel: async (project, repo, number, name) => {
            calls.push({
              addPullRequestLabel: { project, repo, number, name },
            });
            if (name === 'blocked') {
              throw new Error('label add denied');
            }
            return {
              id: 'label-2',
              name,
              active: true,
              url: 'url',
            };
          },
        },
      }),
    });

    const result = await Effect.runPromise(
      createPullRequestForRemote(
        [
          {
            pluginId: plugin.id,
            capability: plugin.capabilities!.pullRequestProvider!,
          },
        ],
        'git@ssh.dev.azure.com:v3/acme/Platform/widgets',
        {
          title: 'Created ADO PR',
          description: 'Created body',
          sourceBranch: 'feature',
          targetBranch: 'main',
          draft: false,
          labels: ['ready', 'blocked'],
        }
      )
    );

    expect(calls).toEqual([
      {
        createPullRequest: {
          project: 'Platform',
          repo: 'widgets',
          sourceRefName: 'refs/heads/feature',
          targetRefName: 'refs/heads/main',
          title: 'Created ADO PR',
          description: 'Created body',
          options: { isDraft: false },
        },
      },
      {
        addPullRequestLabel: {
          project: 'Platform',
          repo: 'widgets',
          number: 77,
          name: 'ready',
        },
      },
      {
        addPullRequestLabel: {
          project: 'Platform',
          repo: 'widgets',
          number: 77,
          name: 'blocked',
        },
      },
      { labelsFor: { project: 'Platform', repo: 'widgets', number: 77 } },
    ]);
    expect(result.pullRequest).toMatchObject({
      id: 77,
      title: 'Created ADO PR',
      description: 'Created body',
      sourceBranch: 'feature',
      targetBranch: 'main',
      labels: ['ready'],
      url: 'https://dev.azure.com/acme/Platform/_git/widgets/pullrequest/77',
    });
    expect(result.warnings).toEqual([
      'Failed to add tag: provider request failed',
    ]);
  });

  test('returns a created Azure DevOps pull request when label refresh fails', async () => {
    const plugin = createAzureDevOpsPlugin({
      createClient: async () => ({
        config: {
          orgUrl: 'https://dev.azure.com/acme',
          pat: 'token',
          authMethod: 'pat',
        },
        client: {
          listPullRequests: async () => ({ value: [] }),
          getPullRequest: async () =>
            fakeAzureDevOpsPullRequest({ pullRequestId: 42, title: 'Unused' }),
          getPullRequestLabels: async () => {
            throw new Error('labels unavailable');
          },
          getAllPullRequestChanges: async () => [],
          getAllComments: async () => [],
          createPullRequest: async (
            _project,
            _repo,
            sourceRefName,
            targetRefName,
            title,
            description,
            options
          ) =>
            fakeAzureDevOpsPullRequest({
              pullRequestId: 78,
              title,
              description,
              sourceRefName,
              targetRefName,
              isDraft: options?.isDraft,
            }),
          addPullRequestLabel: async (_project, _repo, _number, name) => ({
            id: `label-${name}`,
            name,
            active: true,
            url: 'url',
          }),
        },
      }),
    });

    const result = await Effect.runPromise(
      createPullRequestForRemote(
        [
          {
            pluginId: plugin.id,
            capability: plugin.capabilities!.pullRequestProvider!,
          },
        ],
        'git@ssh.dev.azure.com:v3/acme/Platform/widgets',
        {
          title: 'Created ADO PR',
          description: 'Created body',
          sourceBranch: 'feature',
          targetBranch: 'main',
          labels: ['ready'],
        }
      )
    );

    expect(result.pullRequest).toMatchObject({
      id: 78,
      title: 'Created ADO PR',
      labels: ['ready'],
      url: 'https://dev.azure.com/acme/Platform/_git/widgets/pullrequest/78',
    });
    expect(result.warnings).toEqual([
      'Failed to refresh labels: provider request failed',
    ]);
  });

  test('rejects providers that do not implement createPullRequest', async () => {
    const error = await Effect.runPromise(
      createPullRequestForRemote(
        [fakeProvider('gitlab-plugin', 'gitlab', 100)],
        'matched-remote',
        {
          title: 'Created',
          sourceBranch: 'feature',
          targetBranch: 'main',
        }
      ).pipe(Effect.flip)
    );

    expect(error).toBeInstanceOf(UnsupportedPullRequestProviderOperationError);
    if (!(error instanceof UnsupportedPullRequestProviderOperationError)) {
      throw new Error('Expected unsupported provider operation error');
    }
    expect(error.operation).toBe('createPullRequest');
  });

  test('rejects createPullRequest operations that do not return Effects', async () => {
    const provider = fakeProvider('gitlab-plugin', 'gitlab', 100);
    const error = await Effect.runPromise(
      createPullRequestForRemote(
        [
          {
            ...provider,
            capability: {
              ...provider.capability,
              operations: {
                createPullRequest: () => ({}) as never,
              },
            },
          },
        ],
        'matched-remote',
        {
          title: 'Created',
          sourceBranch: 'feature',
          targetBranch: 'main',
        }
      ).pipe(Effect.flip)
    );

    expect(error).toBeInstanceOf(
      InvalidPullRequestProviderOperationResultError
    );
    if (!(error instanceof InvalidPullRequestProviderOperationResultError)) {
      throw new Error('Expected invalid provider operation result error');
    }
    expect(error.operation).toBe('createPullRequest');
    expect(error.reason).toBe('operation must return an Effect');
  });

  test('rejects malformed createPullRequest warnings', async () => {
    const provider = fakeProvider('gitlab-plugin', 'gitlab', 100);
    const error = await Effect.runPromise(
      createPullRequestForRemote(
        [
          {
            ...provider,
            capability: {
              ...provider.capability,
              operations: {
                createPullRequest: () =>
                  Effect.succeed({
                    repository: externalRepository('gitlab'),
                    pullRequest: {
                      id: 1,
                      title: 'Created',
                      status: 'active',
                      createdAt: '2026-01-01T00:00:00Z',
                      author: { displayName: 'Ada Lovelace' },
                    },
                    warnings: [123],
                  }) as never,
              },
            },
          },
        ],
        'matched-remote',
        {
          title: 'Created',
          sourceBranch: 'feature',
          targetBranch: 'main',
        }
      ).pipe(Effect.flip)
    );

    expect(error).toBeInstanceOf(
      InvalidPullRequestProviderOperationResultError
    );
    if (!(error instanceof InvalidPullRequestProviderOperationResultError)) {
      throw new Error('Expected invalid provider operation result error');
    }
    expect(error.operation).toBe('createPullRequest');
    expect(error.reason).toBe('warnings must be an array of strings');
  });

  test('rejects createPullRequest results for a different repository ref', async () => {
    const provider = fakeProvider('gitlab-plugin', 'gitlab', 100);
    const error = await Effect.runPromise(
      createPullRequestForRemote(
        [
          {
            ...provider,
            capability: {
              ...provider.capability,
              operations: {
                createPullRequest: () =>
                  Effect.succeed({
                    repository: externalRepository('gitlab', { projectId: 2 }),
                    pullRequest: {
                      id: 1,
                      title: 'Created',
                      status: 'active',
                      createdAt: '2026-01-01T00:00:00Z',
                      author: { displayName: 'Ada Lovelace' },
                    },
                  }),
              },
            },
          },
        ],
        'matched-remote',
        {
          title: 'Created',
          sourceBranch: 'feature',
          targetBranch: 'main',
        }
      ).pipe(Effect.flip)
    );

    expect(error).toBeInstanceOf(
      InvalidPullRequestProviderOperationResultError
    );
    if (!(error instanceof InvalidPullRequestProviderOperationResultError)) {
      throw new Error('Expected invalid provider operation result error');
    }
    expect(error.operation).toBe('createPullRequest');
    expect(error.reason).toBe(
      'repository ref does not match selected provider match'
    );
  });
});

describe('pull request provider update operations', () => {
  test('binds updates to the provider selected for pull request metadata', async () => {
    const calls: string[] = [];
    const primaryProvider = fakeProvider('primary-plugin', 'primary', 200);
    const fallbackProvider = fakeProvider('fallback-plugin', 'fallback', 100);

    const context = await Effect.runPromise(
      getPullRequestContextForRemote(
        [
          {
            ...primaryProvider,
            capability: {
              ...primaryProvider.capability,
              operations: {
                getPullRequest: () => {
                  calls.push('primary:getPullRequest');
                  return Effect.succeed({
                    repository: externalRepository('primary'),
                    pullRequest: {
                      id: 5,
                      title: 'Primary provider PR',
                      status: 'active',
                      createdAt: '2026-01-01T00:00:00Z',
                      author: { displayName: 'Ada Lovelace' },
                    },
                  });
                },
              },
            },
          },
          {
            ...fallbackProvider,
            capability: {
              ...fallbackProvider.capability,
              operations: {
                updatePullRequest: () => {
                  calls.push('fallback:updatePullRequest');
                  return Effect.succeed({
                    repository: externalRepository('fallback'),
                    pullRequest: {
                      id: 5,
                      title: 'Wrong provider',
                      status: 'active',
                      createdAt: '2026-01-01T00:00:00Z',
                      author: { displayName: 'Grace Hopper' },
                    },
                  });
                },
              },
            },
          },
        ],
        'matched-remote',
        { pullRequest: { number: 5 } }
      )
    );

    const error = await Effect.runPromise(
      context
        .updatePullRequest({
          pullRequest: { number: 5 },
          title: 'Updated',
        })
        .pipe(Effect.flip)
    );

    expect(context.provider.providerId).toBe('primary');
    expect(error).toBeInstanceOf(UnsupportedPullRequestProviderOperationError);
    if (!(error instanceof UnsupportedPullRequestProviderOperationError)) {
      throw new Error('Expected unsupported provider operation error');
    }
    expect(error.providerId).toBe('primary');
    expect(error.operation).toBe('updatePullRequest');
    expect(calls).toEqual(['primary:getPullRequest']);
  });

  test('updates a pull request for a repository ref through a fake provider', async () => {
    const calls: unknown[] = [];
    const repository = externalRepository('gitlab', { projectId: 10 });
    const provider = fakeProvider('gitlab-plugin', 'gitlab', 100);

    const result = await Effect.runPromise(
      updatePullRequestForRepository(
        [
          {
            ...provider,
            capability: {
              ...provider.capability,
              operations: {
                updatePullRequest: (request) => {
                  calls.push(request);
                  return Effect.succeed({
                    repository,
                    repositoryLabel: 'gitlab/acme/widgets',
                    pullRequest: {
                      id: 6,
                      title: request.title ?? 'Repository update',
                      status: request.status ?? 'active',
                      createdAt: '2026-01-01T00:00:00Z',
                      author: { displayName: 'Ada Lovelace' },
                      description: request.description,
                      targetBranch: request.targetBranch,
                      labels: request.labelsToAdd,
                    },
                  });
                },
              },
            },
          },
        ],
        repository,
        {
          pullRequest: { number: 6 },
          title: 'Updated title',
          description: 'Updated body',
          targetBranch: 'main',
          labelsToAdd: ['ready'],
        }
      )
    );

    expect(calls).toEqual([
      {
        match: { source: 'repository-ref', repository },
        pullRequest: { number: 6 },
        title: 'Updated title',
        description: 'Updated body',
        targetBranch: 'main',
        labelsToAdd: ['ready'],
      },
    ]);
    expect(result.pullRequest).toMatchObject({
      id: 6,
      title: 'Updated title',
      targetBranch: 'main',
      labels: ['ready'],
    });
  });

  test('updates a GitHub pull request through a provider-owned operation', async () => {
    const calls: unknown[] = [];
    const plugin = createGitHubPlugin({
      createClient: async ({ host }) => {
        calls.push(host);
        return {
          listPullRequests: async () => [],
          getPullRequest: async (owner, repo, number) => {
            calls.push({ getPullRequest: { owner, repo, number } });
            return fakeGitHubPullRequest({
              number,
              title: 'Updated GitHub PR',
              body: 'Updated body',
              base: { ref: 'develop', sha: 'def', label: 'acme:develop' },
              labels: [{ id: 1, name: 'ready', color: '0f0' }],
            });
          },
          getPullRequestFiles: async () => [],
          getIssueComments: async () => [],
          getReviewComments: async () => [],
          updatePullRequest: async (owner, repo, number, updates) => {
            calls.push({ updatePullRequest: { owner, repo, number, updates } });
            return fakeGitHubPullRequest({ number, title: 'Intermediate' });
          },
          convertToDraft: async (owner, repo, number) => {
            calls.push({ convertToDraft: { owner, repo, number } });
          },
          publishDraftPR: async () => {},
          addLabels: async (owner, repo, number, labels) => {
            calls.push({ addLabels: { owner, repo, number, labels } });
            return [];
          },
          removeLabel: async (owner, repo, number, label) => {
            calls.push({ removeLabel: { owner, repo, number, label } });
          },
        };
      },
    });

    const result = await Effect.runPromise(
      updatePullRequestForRemote(
        [
          {
            pluginId: plugin.id,
            capability: plugin.capabilities!.pullRequestProvider!,
          },
        ],
        'git@github.com:acme/widgets.git',
        {
          pullRequest: { number: 12 },
          title: 'Updated title',
          description: 'Updated body',
          targetBranch: 'develop',
          status: 'abandoned',
          draft: true,
          labelsToAdd: ['ready'],
          labelsToRemove: ['wip'],
        }
      )
    );

    expect(calls).toEqual([
      'github.com',
      {
        updatePullRequest: {
          owner: 'acme',
          repo: 'widgets',
          number: 12,
          updates: {
            title: 'Updated title',
            body: 'Updated body',
            base: 'develop',
            state: 'closed',
          },
        },
      },
      { convertToDraft: { owner: 'acme', repo: 'widgets', number: 12 } },
      {
        addLabels: {
          owner: 'acme',
          repo: 'widgets',
          number: 12,
          labels: ['ready'],
        },
      },
      {
        removeLabel: {
          owner: 'acme',
          repo: 'widgets',
          number: 12,
          label: 'wip',
        },
      },
      { getPullRequest: { owner: 'acme', repo: 'widgets', number: 12 } },
    ]);
    expect(result.pullRequest).toMatchObject({
      id: 12,
      title: 'Updated GitHub PR',
      description: 'Updated body',
      targetBranch: 'develop',
      labels: ['ready'],
    });
  });

  test('updates an Azure DevOps pull request and returns label warnings', async () => {
    const calls: unknown[] = [];
    const plugin = createAzureDevOpsPlugin({
      createClient: async () => ({
        config: {
          orgUrl: 'https://dev.azure.com/acme',
          pat: 'token',
          authMethod: 'pat',
        },
        client: {
          listPullRequests: async () => ({ value: [] }),
          getPullRequest: async () =>
            fakeAzureDevOpsPullRequest({ pullRequestId: 42, title: 'Unused' }),
          getPullRequestLabels: async (project, repo, number) => {
            calls.push({ labelsFor: { project, repo, number } });
            return {
              value: [
                { id: 'label-1', name: 'ready', active: true, url: 'url' },
              ],
            };
          },
          getAllPullRequestChanges: async () => [],
          getAllComments: async () => [],
          updatePullRequest: async (project, repo, number, updates) => {
            calls.push({
              updatePullRequest: { project, repo, number, updates },
            });
            return fakeAzureDevOpsPullRequest({
              pullRequestId: number,
              title: updates.title ?? 'Updated ADO PR',
              description: updates.description,
              isDraft: updates.isDraft,
              status: updates.status ?? 'active',
              targetRefName: updates.targetRefName,
            });
          },
          addPullRequestLabel: async (project, repo, number, name) => {
            calls.push({
              addPullRequestLabel: { project, repo, number, name },
            });
            throw new Error('label add denied');
          },
          removePullRequestLabel: async (project, repo, number, labelId) => {
            calls.push({
              removePullRequestLabel: { project, repo, number, labelId },
            });
          },
        },
      }),
    });

    const result = await Effect.runPromise(
      updatePullRequestForRemote(
        [
          {
            pluginId: plugin.id,
            capability: plugin.capabilities!.pullRequestProvider!,
          },
        ],
        'git@ssh.dev.azure.com:v3/acme/Platform/widgets',
        {
          pullRequest: { number: 42 },
          title: 'Updated ADO PR',
          description: 'Updated body',
          targetBranch: 'develop',
          draft: false,
          status: 'active',
          labelsToAdd: ['blocked'],
          labelsToRemove: ['ready', 'missing'],
        }
      )
    );

    expect(calls).toEqual([
      {
        updatePullRequest: {
          project: 'Platform',
          repo: 'widgets',
          number: 42,
          updates: {
            title: 'Updated ADO PR',
            description: 'Updated body',
            targetRefName: 'refs/heads/develop',
            isDraft: false,
            status: 'active',
          },
        },
      },
      { labelsFor: { project: 'Platform', repo: 'widgets', number: 42 } },
      {
        removePullRequestLabel: {
          project: 'Platform',
          repo: 'widgets',
          number: 42,
          labelId: 'label-1',
        },
      },
      {
        addPullRequestLabel: {
          project: 'Platform',
          repo: 'widgets',
          number: 42,
          name: 'blocked',
        },
      },
      { labelsFor: { project: 'Platform', repo: 'widgets', number: 42 } },
    ]);
    expect(result.pullRequest).toMatchObject({
      id: 42,
      title: 'Updated ADO PR',
      description: 'Updated body',
      targetBranch: 'develop',
      labels: ['ready'],
      url: 'https://dev.azure.com/acme/Platform/_git/widgets/pullrequest/42',
    });
    expect(result.warnings).toEqual([
      'Failed to remove tag: requested tag was not found on the pull request',
      'Failed to add tag: provider request failed',
    ]);
  });

  test('rejects providers that do not implement updatePullRequest', async () => {
    const error = await Effect.runPromise(
      updatePullRequestForRemote(
        [fakeProvider('gitlab-plugin', 'gitlab', 100)],
        'matched-remote',
        { pullRequest: { number: 1 }, title: 'Updated' }
      ).pipe(Effect.flip)
    );

    expect(error).toBeInstanceOf(UnsupportedPullRequestProviderOperationError);
    if (!(error instanceof UnsupportedPullRequestProviderOperationError)) {
      throw new Error('Expected unsupported provider operation error');
    }
    expect(error.operation).toBe('updatePullRequest');
  });

  test('rejects updatePullRequest operations that do not return Effects', async () => {
    const provider = fakeProvider('gitlab-plugin', 'gitlab', 100);
    const error = await Effect.runPromise(
      updatePullRequestForRemote(
        [
          {
            ...provider,
            capability: {
              ...provider.capability,
              operations: {
                updatePullRequest: () => ({}) as never,
              },
            },
          },
        ],
        'matched-remote',
        { pullRequest: { number: 1 }, title: 'Updated' }
      ).pipe(Effect.flip)
    );

    expect(error).toBeInstanceOf(
      InvalidPullRequestProviderOperationResultError
    );
    if (!(error instanceof InvalidPullRequestProviderOperationResultError)) {
      throw new Error('Expected invalid provider operation result error');
    }
    expect(error.operation).toBe('updatePullRequest');
    expect(error.reason).toBe('operation must return an Effect');
  });

  test('rejects malformed updatePullRequest warnings', async () => {
    const provider = fakeProvider('gitlab-plugin', 'gitlab', 100);
    const error = await Effect.runPromise(
      updatePullRequestForRemote(
        [
          {
            ...provider,
            capability: {
              ...provider.capability,
              operations: {
                updatePullRequest: () =>
                  Effect.succeed({
                    repository: externalRepository('gitlab'),
                    pullRequest: {
                      id: 1,
                      title: 'Updated',
                      status: 'active',
                      createdAt: '2026-01-01T00:00:00Z',
                      author: { displayName: 'Ada Lovelace' },
                    },
                    warnings: [123],
                  }) as never,
              },
            },
          },
        ],
        'matched-remote',
        { pullRequest: { number: 1 }, title: 'Updated' }
      ).pipe(Effect.flip)
    );

    expect(error).toBeInstanceOf(
      InvalidPullRequestProviderOperationResultError
    );
    if (!(error instanceof InvalidPullRequestProviderOperationResultError)) {
      throw new Error('Expected invalid provider operation result error');
    }
    expect(error.operation).toBe('updatePullRequest');
    expect(error.reason).toBe('warnings must be an array of strings');
  });

  test('rejects updatePullRequest results for a different pull request id', async () => {
    const provider = fakeProvider('gitlab-plugin', 'gitlab', 100);
    const error = await Effect.runPromise(
      updatePullRequestForRemote(
        [
          {
            ...provider,
            capability: {
              ...provider.capability,
              operations: {
                updatePullRequest: () =>
                  Effect.succeed({
                    repository: externalRepository('gitlab'),
                    pullRequest: {
                      id: 2,
                      title: 'Wrong PR',
                      status: 'active',
                      createdAt: '2026-01-01T00:00:00Z',
                      author: { displayName: 'Ada Lovelace' },
                    },
                  }),
              },
            },
          },
        ],
        'matched-remote',
        { pullRequest: { number: 1 }, title: 'Updated' }
      ).pipe(Effect.flip)
    );

    expect(error).toBeInstanceOf(
      InvalidPullRequestProviderOperationResultError
    );
    if (!(error instanceof InvalidPullRequestProviderOperationResultError)) {
      throw new Error('Expected invalid provider operation result error');
    }
    expect(error.operation).toBe('updatePullRequest');
    expect(error.reason).toBe(
      'pull request id does not match selected pull request'
    );
  });
});

describe('pull request provider diff operations', () => {
  test('binds diff fallback to the provider selected for pull request metadata', async () => {
    const calls: string[] = [];
    const primaryProvider = fakeProvider('primary-plugin', 'primary', 200);
    const fallbackProvider = fakeProvider('fallback-plugin', 'fallback', 100);

    const context = await Effect.runPromise(
      getPullRequestContextForRemote(
        [
          {
            ...primaryProvider,
            capability: {
              ...primaryProvider.capability,
              operations: {
                getPullRequest: () => {
                  calls.push('primary:getPullRequest');
                  return Effect.succeed({
                    repository: externalRepository('primary'),
                    pullRequest: {
                      id: 3,
                      title: 'Primary provider PR',
                      status: 'active',
                      createdAt: '2026-01-01T00:00:00Z',
                      author: { displayName: 'Ada Lovelace' },
                    },
                  });
                },
              },
            },
          },
          {
            ...fallbackProvider,
            capability: {
              ...fallbackProvider.capability,
              operations: {
                getPullRequestDiff: () => {
                  calls.push('fallback:getPullRequestDiff');
                  return Effect.succeed({
                    repository: externalRepository('fallback'),
                    pullRequest: {
                      id: 3,
                      title: 'Fallback provider PR',
                      status: 'active',
                      createdAt: '2026-01-01T00:00:00Z',
                      author: { displayName: 'Grace Hopper' },
                    },
                    files: [{ path: 'src/index.ts', status: 'modified' }],
                  });
                },
              },
            },
          },
        ],
        'matched-remote',
        { pullRequest: { number: 3 } }
      )
    );

    const error = await Effect.runPromise(
      context
        .getPullRequestDiff({ pullRequest: { number: 3 } })
        .pipe(Effect.flip)
    );

    expect(context.provider.providerId).toBe('primary');
    expect(error).toBeInstanceOf(UnsupportedPullRequestProviderOperationError);
    if (!(error instanceof UnsupportedPullRequestProviderOperationError)) {
      throw new Error('Expected unsupported provider operation error');
    }
    expect(error.providerId).toBe('primary');
    expect(error.operation).toBe('getPullRequestDiff');
    expect(calls).toEqual(['primary:getPullRequest']);
  });

  test('gets a pull request diff for a repository ref through a fake provider', async () => {
    const calls: unknown[] = [];
    const repository = externalRepository('gitlab', { projectId: 10 });
    const provider = fakeProvider('gitlab-plugin', 'gitlab', 100);

    const result = await Effect.runPromise(
      getPullRequestDiffForRepository(
        [
          {
            ...provider,
            capability: {
              ...provider.capability,
              operations: {
                getPullRequestDiff: (request) => {
                  calls.push(request);
                  return Effect.succeed({
                    repository,
                    repositoryLabel: 'gitlab/acme/widgets',
                    pullRequest: {
                      id: 4,
                      title: 'Repository-ref diff',
                      status: 'active',
                      createdAt: '2026-01-01T00:00:00Z',
                      author: { displayName: 'Ada Lovelace' },
                      sourceBranch: 'feature/provider-diff',
                      targetBranch: 'main',
                    },
                    files: [
                      {
                        path: 'src/index.ts',
                        status: 'modified',
                        additions: 2,
                        deletions: 1,
                        changes: 3,
                      },
                    ],
                  });
                },
              },
            },
          },
        ],
        repository,
        { pullRequest: { number: 4 } }
      )
    );

    expect(calls).toEqual([
      {
        match: {
          source: 'repository-ref',
          repository,
        },
        pullRequest: { number: 4 },
      },
    ]);
    expect(result.repositoryLabel).toBe('gitlab/acme/widgets');
    expect(result.pullRequest).toMatchObject({
      id: 4,
      sourceBranch: 'feature/provider-diff',
      targetBranch: 'main',
    });
    expect(result.files).toEqual([
      {
        path: 'src/index.ts',
        status: 'modified',
        additions: 2,
        deletions: 1,
        changes: 3,
      },
    ]);
  });

  test('gets a GitHub pull request diff through a provider-owned operation', async () => {
    const calls: unknown[] = [];
    const plugin = createGitHubPlugin({
      createClient: async ({ host }) => {
        calls.push(host);
        return {
          listPullRequests: async () => [],
          getPullRequest: async (owner, repo, number) => {
            calls.push({ detail: { owner, repo, number } });
            return fakeGitHubPullRequest({
              number,
              title: 'GitHub diff',
              userLogin: 'octo',
              head: {
                ref: 'feature/github-diff',
                sha: 'abc',
                label: 'octo:feature/github-diff',
              },
              base: {
                ref: 'main',
                sha: 'def',
                label: 'acme:main',
              },
            });
          },
          getPullRequestFiles: async (owner, repo, number) => {
            calls.push({ files: { owner, repo, number } });
            return [
              {
                sha: 'sha',
                filename: 'src/index.ts',
                status: 'removed' as const,
                additions: 0,
                deletions: 3,
                changes: 3,
                patch: '@@ -1,3 +0,0 @@',
              },
            ];
          },
          getIssueComments: async () => [],
          getReviewComments: async () => [],
        };
      },
    });

    const result = await Effect.runPromise(
      getPullRequestDiffForRemote(
        [
          {
            pluginId: plugin.id,
            capability: plugin.capabilities!.pullRequestProvider!,
          },
        ],
        'git@github.com:acme/widgets.git',
        { pullRequest: { number: 12 } }
      )
    );

    expect(calls).toEqual([
      'github.com',
      { detail: { owner: 'acme', repo: 'widgets', number: 12 } },
      { files: { owner: 'acme', repo: 'widgets', number: 12 } },
    ]);
    expect(result.repositoryLabel).toBe('github.com/acme/widgets');
    expect(result.pullRequest).toMatchObject({
      id: 12,
      title: 'GitHub diff',
      sourceBranch: 'feature/github-diff',
      targetBranch: 'main',
    });
    expect(result.files).toEqual([
      {
        path: 'src/index.ts',
        status: 'deleted',
        providerStatus: 'removed',
        additions: 0,
        deletions: 3,
        changes: 3,
        patch: '@@ -1,3 +0,0 @@',
      },
    ]);
  });

  test('gets an Azure DevOps pull request diff through a URL provider match', async () => {
    const calls: unknown[] = [];
    const plugin = createAzureDevOpsPlugin({
      createClient: async () => ({
        config: {
          orgUrl: 'https://dev.azure.com/acme',
          pat: 'token',
          authMethod: 'pat',
        },
        client: {
          listPullRequests: async () => ({ value: [] }),
          getPullRequest: async (project, repo, number) => {
            calls.push({ detail: { project, repo, number } });
            return fakeAzureDevOpsPullRequest({
              pullRequestId: number,
              title: 'ADO diff',
              sourceRefName: 'refs/heads/feature/ado-diff',
              targetRefName: 'refs/heads/main',
            });
          },
          getPullRequestLabels: async (project, repo, number) => {
            calls.push({ labelsFor: { project, repo, number } });
            return {
              value: [
                { id: '1', name: 'ready', active: true, url: 'label-url' },
              ],
            };
          },
          getAllPullRequestChanges: async (project, repo, number) => {
            calls.push({ changesFor: { project, repo, number } });
            return [
              {
                changeId: 1,
                changeTrackingId: 1,
                changeType: 'rename' as const,
                item: { path: '/src/new.ts' },
                originalPath: '/src/old.ts',
              },
            ];
          },
          getAllComments: async () => [],
        },
      }),
    });

    const result = await Effect.runPromise(
      getPullRequestDiffForUrl(
        [
          {
            pluginId: plugin.id,
            capability: plugin.capabilities!.pullRequestProvider!,
          },
        ],
        'https://dev.azure.com/acme/Platform/_git/widgets/pullrequest/42'
      )
    );

    expect(calls).toEqual([
      { detail: { project: 'Platform', repo: 'widgets', number: 42 } },
      { labelsFor: { project: 'Platform', repo: 'widgets', number: 42 } },
      { changesFor: { project: 'Platform', repo: 'widgets', number: 42 } },
    ]);
    expect(result.repositoryLabel).toBe('acme/Platform/widgets');
    expect(result.pullRequest).toMatchObject({
      id: 42,
      title: 'ADO diff',
      sourceBranch: 'feature/ado-diff',
      targetBranch: 'main',
      labels: ['ready'],
    });
    expect(result.files).toEqual([
      {
        path: '/src/new.ts',
        status: 'renamed',
        providerStatus: 'rename',
        previousPath: '/src/old.ts',
      },
    ]);
  });

  test('rejects providers that do not implement getPullRequestDiff', async () => {
    const error = await Effect.runPromise(
      getPullRequestDiffForRemote(
        [fakeProvider('gitlab-plugin', 'gitlab', 100)],
        'matched-remote',
        { pullRequest: { number: 1 } }
      ).pipe(Effect.flip)
    );

    expect(error).toBeInstanceOf(UnsupportedPullRequestProviderOperationError);
    if (!(error instanceof UnsupportedPullRequestProviderOperationError)) {
      throw new Error('Expected unsupported provider operation error');
    }
    expect(error.operation).toBe('getPullRequestDiff');
  });

  test('rejects getPullRequestDiff operations that do not return Effects', async () => {
    const provider = fakeProvider('gitlab-plugin', 'gitlab', 100);
    const error = await Effect.runPromise(
      getPullRequestDiffForRemote(
        [
          {
            ...provider,
            capability: {
              ...provider.capability,
              operations: {
                getPullRequestDiff: () => ({}) as never,
              },
            },
          },
        ],
        'matched-remote',
        { pullRequest: { number: 1 } }
      ).pipe(Effect.flip)
    );

    expect(error).toBeInstanceOf(
      InvalidPullRequestProviderOperationResultError
    );
    if (!(error instanceof InvalidPullRequestProviderOperationResultError)) {
      throw new Error('Expected invalid provider operation result error');
    }
    expect(error.operation).toBe('getPullRequestDiff');
    expect(error.reason).toBe('operation must return an Effect');
  });

  test('rejects malformed getPullRequestDiff files', async () => {
    const provider = fakeProvider('gitlab-plugin', 'gitlab', 100);
    const error = await Effect.runPromise(
      getPullRequestDiffForRemote(
        [
          {
            ...provider,
            capability: {
              ...provider.capability,
              operations: {
                getPullRequestDiff: () =>
                  Effect.succeed({
                    repository: externalRepository('gitlab'),
                    pullRequest: {
                      id: 1,
                      title: 'Malformed diff',
                      status: 'active',
                      createdAt: '2026-01-01T00:00:00Z',
                      author: { displayName: 'Ada Lovelace' },
                    },
                    files: [{ path: 'src/index.ts', status: 'bad' }],
                  }) as never,
              },
            },
          },
        ],
        'matched-remote',
        { pullRequest: { number: 1 } }
      ).pipe(Effect.flip)
    );

    expect(error).toBeInstanceOf(
      InvalidPullRequestProviderOperationResultError
    );
    if (!(error instanceof InvalidPullRequestProviderOperationResultError)) {
      throw new Error('Expected invalid provider operation result error');
    }
    expect(error.operation).toBe('getPullRequestDiff');
    expect(error.reason).toBe('invalid diff file');
  });

  test('rejects getPullRequestDiff results for a different pull request id', async () => {
    const provider = fakeProvider('gitlab-plugin', 'gitlab', 100);
    const error = await Effect.runPromise(
      getPullRequestDiffForRemote(
        [
          {
            ...provider,
            capability: {
              ...provider.capability,
              operations: {
                getPullRequestDiff: () =>
                  Effect.succeed({
                    repository: externalRepository('gitlab'),
                    pullRequest: {
                      id: 2,
                      title: 'Wrong PR',
                      status: 'active',
                      createdAt: '2026-01-01T00:00:00Z',
                      author: { displayName: 'Ada Lovelace' },
                    },
                    files: [{ path: 'src/index.ts', status: 'modified' }],
                  }),
              },
            },
          },
        ],
        'matched-remote',
        { pullRequest: { number: 1 } }
      ).pipe(Effect.flip)
    );

    expect(error).toBeInstanceOf(
      InvalidPullRequestProviderOperationResultError
    );
    if (!(error instanceof InvalidPullRequestProviderOperationResultError)) {
      throw new Error('Expected invalid provider operation result error');
    }
    expect(error.reason).toBe(
      'pull request id does not match selected pull request'
    );
  });
});

describe('pull request provider comments operations', () => {
  test('binds comments fallback to the provider selected for pull request metadata', async () => {
    const calls: string[] = [];
    const primaryProvider = fakeProvider('primary-plugin', 'primary', 200);
    const fallbackProvider = fakeProvider('fallback-plugin', 'fallback', 100);

    const context = await Effect.runPromise(
      getPullRequestContextForRemote(
        [
          {
            ...primaryProvider,
            capability: {
              ...primaryProvider.capability,
              operations: {
                getPullRequest: () => {
                  calls.push('primary:getPullRequest');
                  return Effect.succeed({
                    repository: externalRepository('primary'),
                    pullRequest: {
                      id: 3,
                      title: 'Primary provider PR',
                      status: 'active',
                      createdAt: '2026-01-01T00:00:00Z',
                      author: { displayName: 'Ada Lovelace' },
                    },
                  });
                },
              },
            },
          },
          {
            ...fallbackProvider,
            capability: {
              ...fallbackProvider.capability,
              operations: {
                listPullRequestComments: () => {
                  calls.push('fallback:listPullRequestComments');
                  return Effect.succeed({
                    repository: externalRepository('fallback'),
                    pullRequest: { number: 3 },
                    threads: [
                      {
                        id: 1,
                        rootComment: {
                          id: 1,
                          kind: 'issue',
                          author: { displayName: 'Grace Hopper' },
                          body: 'Wrong provider',
                          createdAt: '2026-01-01T00:00:00Z',
                        },
                        replies: [],
                      },
                    ],
                  });
                },
              },
            },
          },
        ],
        'matched-remote',
        { pullRequest: { number: 3 } }
      )
    );

    const error = await Effect.runPromise(
      context
        .listPullRequestComments({ pullRequest: { number: 3 } })
        .pipe(Effect.flip)
    );

    expect(context.provider.providerId).toBe('primary');
    expect(error).toBeInstanceOf(UnsupportedPullRequestProviderOperationError);
    if (!(error instanceof UnsupportedPullRequestProviderOperationError)) {
      throw new Error('Expected unsupported provider operation error');
    }
    expect(error.providerId).toBe('primary');
    expect(error.operation).toBe('listPullRequestComments');
    expect(calls).toEqual(['primary:getPullRequest']);
  });

  test('lists pull request comments for a repository ref through a fake provider', async () => {
    const calls: unknown[] = [];
    const repository = externalRepository('gitlab', { projectId: 10 });
    const provider = fakeProvider('gitlab-plugin', 'gitlab', 100);

    const result = await Effect.runPromise(
      listPullRequestCommentsForRepository(
        [
          {
            ...provider,
            capability: {
              ...provider.capability,
              operations: {
                listPullRequestComments: (request) => {
                  calls.push(request);
                  return Effect.succeed({
                    repository,
                    repositoryLabel: 'gitlab/acme/widgets',
                    pullRequest: { number: 4 },
                    threads: [
                      {
                        id: 'discussion-1',
                        rootComment: {
                          id: 10,
                          kind: 'issue',
                          author: { displayName: 'Ada Lovelace' },
                          body: 'Looks good',
                          createdAt: '2026-01-01T00:00:00Z',
                        },
                        replies: [
                          {
                            id: 11,
                            kind: 'reply',
                            author: { displayName: 'Grace Hopper' },
                            body: 'Thanks',
                            createdAt: '2026-01-01T01:00:00Z',
                            parentId: 10,
                          },
                        ],
                      },
                    ],
                  });
                },
              },
            },
          },
        ],
        repository,
        { pullRequest: { number: 4 } }
      )
    );

    expect(calls).toEqual([
      {
        match: {
          source: 'repository-ref',
          repository,
        },
        pullRequest: { number: 4 },
      },
    ]);
    expect(result.repositoryLabel).toBe('gitlab/acme/widgets');
    expect(result.threads).toEqual([
      {
        id: 'discussion-1',
        rootComment: {
          id: 10,
          kind: 'issue',
          author: { displayName: 'Ada Lovelace' },
          body: 'Looks good',
          createdAt: '2026-01-01T00:00:00Z',
        },
        replies: [
          {
            id: 11,
            kind: 'reply',
            author: { displayName: 'Grace Hopper' },
            body: 'Thanks',
            createdAt: '2026-01-01T01:00:00Z',
            parentId: 10,
          },
        ],
      },
    ]);
  });

  test('lists GitHub pull request comments through a provider-owned operation', async () => {
    const calls: unknown[] = [];
    const plugin = createGitHubPlugin({
      createClient: async ({ host }) => {
        calls.push(host);
        return {
          listPullRequests: async () => [],
          getPullRequest: async () =>
            fakeGitHubPullRequest({ number: 1, title: 'Unused' }),
          getPullRequestFiles: async () => [],
          getIssueComments: async (owner, repo, number) => {
            calls.push({ issueComments: { owner, repo, number } });
            return [
              {
                id: 100,
                user: { id: 1, login: 'octo' },
                body: 'General discussion',
                created_at: '2026-01-01T00:00:00Z',
                updated_at: '2026-01-01T00:00:00Z',
                html_url:
                  'https://github.com/acme/widgets/pull/12#issuecomment-100',
              },
            ];
          },
          getReviewComments: async (owner, repo, number) => {
            calls.push({ reviewComments: { owner, repo, number } });
            return [
              {
                id: 200,
                user: { id: 2, login: 'reviewer' },
                body: 'Use const',
                path: 'src/index.ts',
                line: 42,
                original_line: 42,
                start_line: null,
                side: 'RIGHT' as const,
                created_at: '2026-01-02T00:00:00Z',
                updated_at: '2026-01-02T00:00:00Z',
                html_url:
                  'https://github.com/acme/widgets/pull/12#discussion_r200',
                commit_id: 'abc',
              },
              {
                id: 201,
                user: { id: 1, login: 'octo' },
                body: 'Done',
                path: 'src/index.ts',
                line: 42,
                original_line: 42,
                start_line: null,
                side: 'RIGHT' as const,
                created_at: '2026-01-02T01:00:00Z',
                updated_at: '2026-01-02T01:00:00Z',
                html_url:
                  'https://github.com/acme/widgets/pull/12#discussion_r201',
                in_reply_to_id: 200,
                commit_id: 'abc',
              },
            ];
          },
        };
      },
    });

    const result = await Effect.runPromise(
      listPullRequestCommentsForRemote(
        [
          {
            pluginId: plugin.id,
            capability: plugin.capabilities!.pullRequestProvider!,
          },
        ],
        'git@github.com:acme/widgets.git',
        { pullRequest: { number: 12 } }
      )
    );

    expect(calls).toEqual([
      'github.com',
      { issueComments: { owner: 'acme', repo: 'widgets', number: 12 } },
      { reviewComments: { owner: 'acme', repo: 'widgets', number: 12 } },
    ]);
    expect(result.pullRequest).toEqual({ number: 12 });
    expect(result.threads).toEqual([
      {
        id: 200,
        filePath: 'src/index.ts',
        lineNumber: 42,
        rootComment: {
          id: 200,
          kind: 'review',
          author: { displayName: 'reviewer', username: 'reviewer' },
          body: 'Use const',
          createdAt: '2026-01-02T00:00:00Z',
          updatedAt: '2026-01-02T00:00:00Z',
          url: 'https://github.com/acme/widgets/pull/12#discussion_r200',
          filePath: 'src/index.ts',
          lineNumber: 42,
        },
        replies: [
          {
            id: 201,
            kind: 'reply',
            author: { displayName: 'octo', username: 'octo' },
            body: 'Done',
            createdAt: '2026-01-02T01:00:00Z',
            updatedAt: '2026-01-02T01:00:00Z',
            url: 'https://github.com/acme/widgets/pull/12#discussion_r201',
            filePath: 'src/index.ts',
            lineNumber: 42,
            parentId: 200,
          },
        ],
      },
      {
        id: 'issue-100',
        rootComment: {
          id: 100,
          kind: 'issue',
          author: { displayName: 'octo', username: 'octo' },
          body: 'General discussion',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
          url: 'https://github.com/acme/widgets/pull/12#issuecomment-100',
        },
        replies: [],
      },
    ]);
  });

  test('lists Azure DevOps pull request comments through a URL provider match', async () => {
    const calls: unknown[] = [];
    const plugin = createAzureDevOpsPlugin({
      createClient: async () => ({
        config: {
          orgUrl: 'https://dev.azure.com/acme',
          pat: 'token',
          authMethod: 'pat',
        },
        client: {
          listPullRequests: async () => ({ value: [] }),
          getPullRequest: async () =>
            fakeAzureDevOpsPullRequest({ pullRequestId: 42, title: 'Unused' }),
          getPullRequestLabels: async () => ({ value: [] }),
          getAllPullRequestChanges: async () => [],
          getAllComments: async (project, repo, number) => {
            calls.push({ commentsFor: { project, repo, number } });
            return [
              {
                threadId: 10,
                threadStatus: 'active',
                filePath: '/src/index.ts',
                lineNumber: 5,
                comment: {
                  id: 1,
                  parentCommentId: 0,
                  author: {
                    displayName: 'Ada Lovelace',
                    uniqueName: 'ada@example.com',
                    id: 'ada',
                  },
                  content: 'Please change this',
                  publishedDate: '2026-01-01T00:00:00Z',
                  lastUpdatedDate: '2026-01-01T00:00:00Z',
                  commentType: 'text',
                },
              },
              {
                threadId: 10,
                threadStatus: 'active',
                filePath: '/src/index.ts',
                lineNumber: 5,
                comment: {
                  id: 2,
                  parentCommentId: 1,
                  author: {
                    displayName: 'Grace Hopper',
                    uniqueName: 'grace@example.com',
                    id: 'grace',
                  },
                  content: null,
                  publishedDate: '2026-01-01T01:00:00Z',
                  lastUpdatedDate: '2026-01-01T01:00:00Z',
                  commentType: 'system',
                },
              },
            ];
          },
        },
      }),
    });

    const result = await Effect.runPromise(
      listPullRequestCommentsForUrl(
        [
          {
            pluginId: plugin.id,
            capability: plugin.capabilities!.pullRequestProvider!,
          },
        ],
        'https://dev.azure.com/acme/Platform/_git/widgets/pullrequest/42'
      )
    );

    expect(calls).toEqual([
      { commentsFor: { project: 'Platform', repo: 'widgets', number: 42 } },
    ]);
    expect(result.threads).toEqual([
      {
        id: 10,
        status: 'active',
        filePath: '/src/index.ts',
        lineNumber: 5,
        rootComment: {
          id: 1,
          kind: 'review',
          author: {
            displayName: 'Ada Lovelace',
            email: 'ada@example.com',
          },
          body: 'Please change this',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
          filePath: '/src/index.ts',
          lineNumber: 5,
          providerType: 'text',
        },
        replies: [
          {
            id: 2,
            kind: 'system',
            author: {
              displayName: 'Grace Hopper',
              email: 'grace@example.com',
            },
            body: '[deleted comment]',
            createdAt: '2026-01-01T01:00:00Z',
            updatedAt: '2026-01-01T01:00:00Z',
            filePath: '/src/index.ts',
            lineNumber: 5,
            parentId: 1,
            providerType: 'system',
          },
        ],
      },
    ]);
  });

  test('rejects providers that do not implement listPullRequestComments', async () => {
    const error = await Effect.runPromise(
      listPullRequestCommentsForRemote(
        [fakeProvider('gitlab-plugin', 'gitlab', 100)],
        'matched-remote',
        { pullRequest: { number: 1 } }
      ).pipe(Effect.flip)
    );

    expect(error).toBeInstanceOf(UnsupportedPullRequestProviderOperationError);
    if (!(error instanceof UnsupportedPullRequestProviderOperationError)) {
      throw new Error('Expected unsupported provider operation error');
    }
    expect(error.operation).toBe('listPullRequestComments');
  });

  test('rejects listPullRequestComments operations that do not return Effects', async () => {
    const provider = fakeProvider('gitlab-plugin', 'gitlab', 100);
    const error = await Effect.runPromise(
      listPullRequestCommentsForRemote(
        [
          {
            ...provider,
            capability: {
              ...provider.capability,
              operations: {
                listPullRequestComments: () => ({}) as never,
              },
            },
          },
        ],
        'matched-remote',
        { pullRequest: { number: 1 } }
      ).pipe(Effect.flip)
    );

    expect(error).toBeInstanceOf(
      InvalidPullRequestProviderOperationResultError
    );
    if (!(error instanceof InvalidPullRequestProviderOperationResultError)) {
      throw new Error('Expected invalid provider operation result error');
    }
    expect(error.operation).toBe('listPullRequestComments');
    expect(error.reason).toBe('operation must return an Effect');
  });

  test('rejects malformed listPullRequestComments threads', async () => {
    const provider = fakeProvider('gitlab-plugin', 'gitlab', 100);
    const error = await Effect.runPromise(
      listPullRequestCommentsForRemote(
        [
          {
            ...provider,
            capability: {
              ...provider.capability,
              operations: {
                listPullRequestComments: () =>
                  Effect.succeed({
                    repository: externalRepository('gitlab'),
                    pullRequest: { number: 1 },
                    threads: [{ id: '', replies: [] }],
                  }) as never,
              },
            },
          },
        ],
        'matched-remote',
        { pullRequest: { number: 1 } }
      ).pipe(Effect.flip)
    );

    expect(error).toBeInstanceOf(
      InvalidPullRequestProviderOperationResultError
    );
    if (!(error instanceof InvalidPullRequestProviderOperationResultError)) {
      throw new Error('Expected invalid provider operation result error');
    }
    expect(error.operation).toBe('listPullRequestComments');
    expect(error.reason).toBe('invalid comment thread');
  });

  test('rejects listPullRequestComments results for a different pull request id', async () => {
    const provider = fakeProvider('gitlab-plugin', 'gitlab', 100);
    const error = await Effect.runPromise(
      listPullRequestCommentsForRemote(
        [
          {
            ...provider,
            capability: {
              ...provider.capability,
              operations: {
                listPullRequestComments: () =>
                  Effect.succeed({
                    repository: externalRepository('gitlab'),
                    pullRequest: { number: 2 },
                    threads: [
                      {
                        id: 1,
                        rootComment: {
                          id: 1,
                          kind: 'issue',
                          author: { displayName: 'Ada Lovelace' },
                          body: 'Wrong PR',
                          createdAt: '2026-01-01T00:00:00Z',
                        },
                        replies: [],
                      },
                    ],
                  }),
              },
            },
          },
        ],
        'matched-remote',
        { pullRequest: { number: 1 } }
      ).pipe(Effect.flip)
    );

    expect(error).toBeInstanceOf(
      InvalidPullRequestProviderOperationResultError
    );
    if (!(error instanceof InvalidPullRequestProviderOperationResultError)) {
      throw new Error('Expected invalid provider operation result error');
    }
    expect(error.reason).toBe(
      'pull request id does not match selected pull request'
    );
  });
});

describe('pull request provider comment mutation operations', () => {
  test('binds comment mutations to the provider selected for pull request metadata', async () => {
    const calls: string[] = [];
    const primaryProvider = fakeProvider('primary-plugin', 'primary', 200);
    const fallbackProvider = fakeProvider('fallback-plugin', 'fallback', 100);

    const context = await Effect.runPromise(
      getPullRequestContextForRemote(
        [
          {
            ...primaryProvider,
            capability: {
              ...primaryProvider.capability,
              operations: {
                getPullRequest: () => {
                  calls.push('primary:getPullRequest');
                  return Effect.succeed({
                    repository: externalRepository('primary'),
                    pullRequest: {
                      id: 5,
                      title: 'Primary provider PR',
                      status: 'active',
                      createdAt: '2026-01-01T00:00:00Z',
                      author: { displayName: 'Ada Lovelace' },
                    },
                  });
                },
              },
            },
          },
          {
            ...fallbackProvider,
            capability: {
              ...fallbackProvider.capability,
              operations: {
                addPullRequestComment: () => {
                  calls.push('fallback:addPullRequestComment');
                  return Effect.succeed({
                    repository: externalRepository('fallback'),
                    pullRequest: { number: 5 },
                    comment: {
                      id: 10,
                      kind: 'issue',
                      author: { displayName: 'Grace Hopper' },
                      body: 'Wrong provider',
                      createdAt: '2026-01-01T00:00:00Z',
                    },
                  });
                },
              },
            },
          },
        ],
        'matched-remote',
        { pullRequest: { number: 5 } }
      )
    );

    const error = await Effect.runPromise(
      context
        .addPullRequestComment({
          pullRequest: { number: 5 },
          body: 'hello',
        })
        .pipe(Effect.flip)
    );

    expect(context.provider.providerId).toBe('primary');
    expect(error).toBeInstanceOf(UnsupportedPullRequestProviderOperationError);
    if (!(error instanceof UnsupportedPullRequestProviderOperationError)) {
      throw new Error('Expected unsupported provider operation error');
    }
    expect(error.providerId).toBe('primary');
    expect(error.operation).toBe('addPullRequestComment');
    expect(calls).toEqual(['primary:getPullRequest']);
  });

  test('adds a pull request comment for a repository ref through a fake provider', async () => {
    const calls: unknown[] = [];
    const repository = externalRepository('gitlab', { projectId: 10 });
    const provider = fakeProvider('gitlab-plugin', 'gitlab', 100);

    const result = await Effect.runPromise(
      addPullRequestCommentForRepository(
        [
          {
            ...provider,
            capability: {
              ...provider.capability,
              operations: {
                addPullRequestComment: (request) => {
                  calls.push(request);
                  return Effect.succeed({
                    repository,
                    repositoryLabel: 'gitlab/acme/widgets',
                    pullRequest: { number: 6 },
                    comment: {
                      id: 10,
                      kind: 'review',
                      author: { displayName: 'Ada Lovelace' },
                      body: request.body,
                      createdAt: '2026-01-01T00:00:00Z',
                      filePath: request.position?.filePath,
                      lineNumber: request.position?.lineNumber,
                    },
                  });
                },
              },
            },
          },
        ],
        repository,
        {
          pullRequest: { number: 6 },
          body: 'Use const',
          position: { filePath: 'src/index.ts', lineNumber: 12 },
        }
      )
    );

    expect(calls).toEqual([
      {
        match: { source: 'repository-ref', repository },
        pullRequest: { number: 6 },
        body: 'Use const',
        position: { filePath: 'src/index.ts', lineNumber: 12 },
      },
    ]);
    expect(result.comment).toMatchObject({
      id: 10,
      kind: 'review',
      body: 'Use const',
      filePath: 'src/index.ts',
      lineNumber: 12,
    });
  });

  test('adds a GitHub review comment through a provider-owned operation', async () => {
    const calls: unknown[] = [];
    const plugin = createGitHubPlugin({
      createClient: async ({ host }) => {
        calls.push(host);
        return {
          listPullRequests: async () => [],
          getPullRequest: async (owner, repo, number) => {
            calls.push({ getPullRequest: { owner, repo, number } });
            return fakeGitHubPullRequest({
              number,
              title: 'GitHub comment',
              head: { ref: 'feature', sha: 'head-sha', label: 'octo:feature' },
            });
          },
          getPullRequestFiles: async () => [],
          getIssueComments: async () => [],
          getReviewComments: async () => [],
          createIssueComment: async () => fakeGitHubIssueComment(),
          createReviewComment: async (owner, repo, number, body, options) => {
            calls.push({
              createReviewComment: { owner, repo, number, body, options },
            });
            return fakeGitHubReviewComment({
              id: 22,
              body,
              path: options.path,
              line: options.line,
              commit_id: options.commit_id,
            });
          },
          replyToReviewComment: async () => fakeGitHubReviewComment(),
        };
      },
    });

    const result = await Effect.runPromise(
      addPullRequestCommentForRemote(
        [
          {
            pluginId: plugin.id,
            capability: plugin.capabilities!.pullRequestProvider!,
          },
        ],
        'git@github.com:acme/widgets.git',
        {
          pullRequest: { number: 12 },
          body: 'Use const',
          position: {
            filePath: '/src/index.ts',
            lineNumber: 10,
            endLineNumber: 12,
          },
        }
      )
    );

    expect(calls).toEqual([
      'github.com',
      { getPullRequest: { owner: 'acme', repo: 'widgets', number: 12 } },
      {
        createReviewComment: {
          owner: 'acme',
          repo: 'widgets',
          number: 12,
          body: 'Use const',
          options: {
            path: 'src/index.ts',
            line: 12,
            commit_id: 'head-sha',
            start_line: 10,
          },
        },
      },
    ]);
    expect(result.comment).toMatchObject({
      id: 22,
      kind: 'review',
      body: 'Use const',
      filePath: 'src/index.ts',
      lineNumber: 12,
    });
    expect(result.thread).toMatchObject({
      id: 22,
      rootComment: { id: 22 },
    });
  });

  test('adds a general pull request comment from a PR URL', async () => {
    const calls: unknown[] = [];
    const plugin = createGitHubPlugin({
      createClient: async () => ({
        listPullRequests: async () => [],
        getPullRequest: async () =>
          fakeGitHubPullRequest({ number: 1, title: 'Unused' }),
        getPullRequestFiles: async () => [],
        getIssueComments: async () => [],
        getReviewComments: async () => [],
        createIssueComment: async (owner, repo, number, body) => {
          calls.push({ owner, repo, number, body });
          return fakeGitHubIssueComment({ id: 33, body });
        },
        createReviewComment: async () => fakeGitHubReviewComment(),
        replyToReviewComment: async () => fakeGitHubReviewComment(),
      }),
    });

    const result = await Effect.runPromise(
      addPullRequestCommentForUrl(
        [
          {
            pluginId: plugin.id,
            capability: plugin.capabilities!.pullRequestProvider!,
          },
        ],
        'https://github.com/acme/widgets/pull/12',
        { body: 'General comment' }
      )
    );

    expect(calls).toEqual([
      { owner: 'acme', repo: 'widgets', number: 12, body: 'General comment' },
    ]);
    expect(result.comment).toMatchObject({
      id: 33,
      kind: 'issue',
      body: 'General comment',
    });
    expect(result.thread).toMatchObject({ id: 'issue-33' });
  });

  test('replies to an Azure DevOps pull request comment through a URL match', async () => {
    const calls: unknown[] = [];
    const plugin = createAzureDevOpsPlugin({
      createClient: async () => ({
        config: {
          orgUrl: 'https://dev.azure.com/acme',
          pat: 'token',
          authMethod: 'pat',
        },
        client: {
          listPullRequests: async () => ({ value: [] }),
          getPullRequest: async () =>
            fakeAzureDevOpsPullRequest({ pullRequestId: 42, title: 'Unused' }),
          getPullRequestLabels: async () => ({ value: [] }),
          getAllPullRequestChanges: async () => [],
          getAllComments: async () => [],
          createPullRequestThread: async () => fakeAzureDevOpsThread(),
          createThreadComment: async (
            project,
            repo,
            number,
            threadId,
            content,
            parentCommentId
          ) => {
            calls.push({
              project,
              repo,
              number,
              threadId,
              content,
              parentCommentId,
            });
            return fakeAzureDevOpsCreatedComment({
              id: 44,
              parentCommentId: parentCommentId ?? 0,
              content,
            });
          },
        },
      }),
    });

    const result = await Effect.runPromise(
      replyToPullRequestCommentForUrl(
        [
          {
            pluginId: plugin.id,
            capability: plugin.capabilities!.pullRequestProvider!,
          },
        ],
        'https://dev.azure.com/acme/Platform/_git/widgets/pullrequest/42',
        {
          threadId: 10,
          parentCommentId: 2,
          body: 'Fixed',
        }
      )
    );

    expect(calls).toEqual([
      {
        project: 'Platform',
        repo: 'widgets',
        number: 42,
        threadId: 10,
        content: 'Fixed',
        parentCommentId: 2,
      },
    ]);
    expect(result.comment).toMatchObject({
      id: 44,
      kind: 'reply',
      body: 'Fixed',
      parentId: 2,
    });
    expect(result.thread).toMatchObject({
      id: 10,
      replies: [{ id: 44 }],
    });
  });

  test('rejects providers that do not implement comment mutations', async () => {
    const addError = await Effect.runPromise(
      addPullRequestCommentForRemote(
        [fakeProvider('gitlab-plugin', 'gitlab', 100)],
        'matched-remote',
        { pullRequest: { number: 1 }, body: 'hello' }
      ).pipe(Effect.flip)
    );
    const replyError = await Effect.runPromise(
      replyToPullRequestCommentForRepository(
        [fakeProvider('gitlab-plugin', 'gitlab', 100)],
        externalRepository('gitlab'),
        {
          pullRequest: { number: 1 },
          threadId: 2,
          body: 'hello',
        }
      ).pipe(Effect.flip)
    );

    expect(addError).toBeInstanceOf(
      UnsupportedPullRequestProviderOperationError
    );
    expect(replyError).toBeInstanceOf(
      UnsupportedPullRequestProviderOperationError
    );
    if (!(addError instanceof UnsupportedPullRequestProviderOperationError)) {
      throw new Error('Expected unsupported provider operation error');
    }
    if (!(replyError instanceof UnsupportedPullRequestProviderOperationError)) {
      throw new Error('Expected unsupported provider operation error');
    }
    expect(addError.operation).toBe('addPullRequestComment');
    expect(replyError.operation).toBe('replyToPullRequestComment');
  });

  test('rejects comment mutations that do not return Effects', async () => {
    const provider = fakeProvider('gitlab-plugin', 'gitlab', 100);
    const error = await Effect.runPromise(
      replyToPullRequestCommentForRemote(
        [
          {
            ...provider,
            capability: {
              ...provider.capability,
              operations: {
                replyToPullRequestComment: () => ({}) as never,
              },
            },
          },
        ],
        'matched-remote',
        {
          pullRequest: { number: 1 },
          threadId: 2,
          body: 'hello',
        }
      ).pipe(Effect.flip)
    );

    expect(error).toBeInstanceOf(
      InvalidPullRequestProviderOperationResultError
    );
    if (!(error instanceof InvalidPullRequestProviderOperationResultError)) {
      throw new Error('Expected invalid provider operation result error');
    }
    expect(error.operation).toBe('replyToPullRequestComment');
    expect(error.reason).toBe('operation must return an Effect');
  });

  test('rejects malformed mutation results', async () => {
    const provider = fakeProvider('gitlab-plugin', 'gitlab', 100);
    const error = await Effect.runPromise(
      addPullRequestCommentForRemote(
        [
          {
            ...provider,
            capability: {
              ...provider.capability,
              operations: {
                addPullRequestComment: () =>
                  Effect.succeed({
                    repository: externalRepository('gitlab'),
                    pullRequest: { number: 1 },
                    comment: {
                      id: 0,
                      kind: 'issue',
                      author: { displayName: 'Ada Lovelace' },
                      body: 'Invalid',
                      createdAt: '2026-01-01T00:00:00Z',
                    },
                  }) as never,
              },
            },
          },
        ],
        'matched-remote',
        { pullRequest: { number: 1 }, body: 'hello' }
      ).pipe(Effect.flip)
    );

    expect(error).toBeInstanceOf(
      InvalidPullRequestProviderOperationResultError
    );
    if (!(error instanceof InvalidPullRequestProviderOperationResultError)) {
      throw new Error('Expected invalid provider operation result error');
    }
    expect(error.operation).toBe('addPullRequestComment');
    expect(error.reason).toBe('invalid comment');
  });

  test('rejects mutation results for a different pull request id', async () => {
    const provider = fakeProvider('gitlab-plugin', 'gitlab', 100);
    const error = await Effect.runPromise(
      addPullRequestCommentForRemote(
        [
          {
            ...provider,
            capability: {
              ...provider.capability,
              operations: {
                addPullRequestComment: () =>
                  Effect.succeed({
                    repository: externalRepository('gitlab'),
                    pullRequest: { number: 2 },
                    comment: {
                      id: 1,
                      kind: 'issue',
                      author: { displayName: 'Ada Lovelace' },
                      body: 'Wrong PR',
                      createdAt: '2026-01-01T00:00:00Z',
                    },
                  }),
              },
            },
          },
        ],
        'matched-remote',
        { pullRequest: { number: 1 }, body: 'hello' }
      ).pipe(Effect.flip)
    );

    expect(error).toBeInstanceOf(
      InvalidPullRequestProviderOperationResultError
    );
    if (!(error instanceof InvalidPullRequestProviderOperationResultError)) {
      throw new Error('Expected invalid provider operation result error');
    }
    expect(error.reason).toBe(
      'pull request id does not match selected pull request'
    );
  });

  test('rejects reply mutation results for a different thread id', async () => {
    const provider = fakeProvider('gitlab-plugin', 'gitlab', 100);
    const error = await Effect.runPromise(
      replyToPullRequestCommentForRemote(
        [
          {
            ...provider,
            capability: {
              ...provider.capability,
              operations: {
                replyToPullRequestComment: () =>
                  Effect.succeed({
                    repository: externalRepository('gitlab'),
                    pullRequest: { number: 1 },
                    comment: {
                      id: 1,
                      kind: 'reply',
                      author: { displayName: 'Ada Lovelace' },
                      body: 'Wrong thread',
                      createdAt: '2026-01-01T00:00:00Z',
                    },
                    thread: {
                      id: 99,
                      replies: [
                        {
                          id: 1,
                          kind: 'reply',
                          author: { displayName: 'Ada Lovelace' },
                          body: 'Wrong thread',
                          createdAt: '2026-01-01T00:00:00Z',
                        },
                      ],
                    },
                  }),
              },
            },
          },
        ],
        'matched-remote',
        { pullRequest: { number: 1 }, threadId: 2, body: 'hello' }
      ).pipe(Effect.flip)
    );

    expect(error).toBeInstanceOf(
      InvalidPullRequestProviderOperationResultError
    );
    if (!(error instanceof InvalidPullRequestProviderOperationResultError)) {
      throw new Error('Expected invalid provider operation result error');
    }
    expect(error.reason).toBe('thread id does not match selected thread');
  });
});

describe('pull request provider branch lookup operations', () => {
  test('finds a pull request for a branch with a repository ref through a fake provider', async () => {
    const calls: unknown[] = [];
    const repository = externalRepository('gitlab', { projectId: 10 });
    const provider = fakeProvider('gitlab-plugin', 'gitlab', 100);

    const result = await Effect.runPromise(
      findPullRequestForBranchForRepository(
        [
          {
            ...provider,
            capability: {
              ...provider.capability,
              operations: {
                findPullRequestForBranch: (request) => {
                  calls.push(request);
                  return Effect.succeed({
                    branch: 'feature/repository-ref',
                    repository,
                    repositoryLabel: 'gitlab/acme/widgets',
                    pullRequest: {
                      id: 3,
                      title: 'Repository-ref branch',
                      status: 'active',
                      createdAt: '2026-01-01T00:00:00Z',
                      author: { displayName: 'Ada Lovelace' },
                      sourceBranch: 'feature/repository-ref',
                    },
                  });
                },
              },
            },
          },
        ],
        repository,
        { branch: 'feature/repository-ref' }
      )
    );

    expect(calls).toEqual([
      {
        match: {
          source: 'repository-ref',
          repository,
        },
        branch: 'feature/repository-ref',
      },
    ]);
    expect(result.branch).toBe('feature/repository-ref');
    expect(result.pullRequest).toMatchObject({
      id: 3,
      title: 'Repository-ref branch',
      sourceBranch: 'feature/repository-ref',
    });
  });

  test('finds a GitHub pull request for a branch through a provider-owned operation', async () => {
    const calls: unknown[] = [];
    const plugin = createGitHubPlugin({
      createClient: async ({ host, scope }) => {
        calls.push({ host, scope });
        return {
          listPullRequests: async (owner, repo, options) => {
            calls.push({ owner, repo, options });
            return [
              fakeGitHubPullRequest({
                number: 11,
                title: 'Closed newer PR',
                state: 'closed',
                merged: false,
                created_at: '2026-01-03T00:00:00Z',
                head: {
                  ref: 'feature/github-detail',
                  sha: 'closed',
                  label: 'octo:feature/github-detail',
                },
              }),
              fakeGitHubPullRequest({
                number: 12,
                title: 'Open selected PR',
                state: 'open',
                created_at: '2026-01-01T00:00:00Z',
                head: {
                  ref: 'feature/github-detail',
                  sha: 'open',
                  label: 'octo:feature/github-detail',
                },
              }),
            ];
          },
          getPullRequest: async (owner, repo, number) => {
            calls.push({ detail: { owner, repo, number } });
            return fakeGitHubPullRequest({
              number,
              title: 'GitHub branch detail',
              userLogin: 'octo',
              head: {
                ref: 'feature/github-detail',
                sha: 'abc',
                label: 'octo:feature/github-detail',
              },
              base: {
                ref: 'main',
                sha: 'def',
                label: 'acme:main',
              },
              labels: [{ id: 1, name: 'feature', color: '0f0' }],
            });
          },
          getPullRequestFiles: async () => [],
          getIssueComments: async () => [],
          getReviewComments: async () => [],
        };
      },
    });

    const result = await Effect.runPromise(
      findPullRequestForBranchForRemote(
        [
          {
            pluginId: plugin.id,
            capability: plugin.capabilities!.pullRequestProvider!,
          },
        ],
        'git@github.com:acme/widgets.git',
        { branch: 'feature/github-detail' }
      )
    );

    expect(calls).toEqual([
      {
        host: 'github.com',
        scope: { providerId: 'github', host: 'github.com' },
      },
      {
        owner: 'acme',
        repo: 'widgets',
        options: {
          head: 'acme:feature/github-detail',
          state: 'all',
        },
      },
      { detail: { owner: 'acme', repo: 'widgets', number: 12 } },
    ]);
    expect(result.branch).toBe('feature/github-detail');
    expect(result.repositoryLabel).toBe('github.com/acme/widgets');
    expect(result.pullRequest).toMatchObject({
      id: 12,
      title: 'GitHub branch detail',
      sourceBranch: 'feature/github-detail',
      targetBranch: 'main',
      labels: ['feature'],
    });
  });

  test('finds an Azure DevOps pull request for a branch through a provider-owned operation', async () => {
    const calls: unknown[] = [];
    const plugin = createAzureDevOpsPlugin({
      createClient: async (options) => {
        calls.push(options);
        return {
          config: {
            orgUrl: 'https://dev.azure.com/acme',
            pat: 'token',
            authMethod: 'pat',
          },
          client: {
            listPullRequests: async (project, repo, options) => {
              calls.push({ project, repo, options });
              return {
                value: [
                  fakeAzureDevOpsPullRequest({
                    pullRequestId: 41,
                    title: 'Completed newer PR',
                    status: 'completed',
                    creationDate: '2026-01-03T00:00:00Z',
                    sourceRefName: 'refs/heads/feature/ado-detail',
                  }),
                  fakeAzureDevOpsPullRequest({
                    pullRequestId: 42,
                    title: 'Active selected PR',
                    status: 'active',
                    creationDate: '2026-01-01T00:00:00Z',
                    sourceRefName: 'refs/heads/feature/ado-detail',
                  }),
                ],
              };
            },
            getPullRequest: async (project, repo, number) => {
              calls.push({ detail: { project, repo, number } });
              return fakeAzureDevOpsPullRequest({
                pullRequestId: number,
                title: 'ADO branch detail',
                sourceRefName: 'refs/heads/feature/ado-detail',
                targetRefName: 'refs/heads/main',
              });
            },
            getPullRequestLabels: async (project, repo, number) => {
              calls.push({ labelsFor: { project, repo, number } });
              return {
                value: [
                  { id: '1', name: 'ready', active: true, url: 'label-url' },
                  { id: '2', name: 'stale', active: false, url: 'label-url' },
                ],
              };
            },
            getAllPullRequestChanges: async () => [],
            getAllComments: async () => [],
          },
        };
      },
    });

    const result = await Effect.runPromise(
      findPullRequestForBranchForRemote(
        [
          {
            pluginId: plugin.id,
            capability: plugin.capabilities!.pullRequestProvider!,
          },
        ],
        'git@ssh.dev.azure.com:v3/acme/Platform/widgets',
        { branch: 'feature/ado-detail' }
      )
    );

    expect(calls).toEqual([
      {
        scope: {
          providerId: 'azure-devops',
          host: 'dev.azure.com',
          org: 'acme',
        },
      },
      {
        project: 'Platform',
        repo: 'widgets',
        options: {
          sourceRefName: 'refs/heads/feature/ado-detail',
          status: 'all',
        },
      },
      { detail: { project: 'Platform', repo: 'widgets', number: 42 } },
      { labelsFor: { project: 'Platform', repo: 'widgets', number: 42 } },
    ]);
    expect(result.branch).toBe('feature/ado-detail');
    expect(result.repositoryLabel).toBe('acme/Platform/widgets');
    expect(result.pullRequest).toMatchObject({
      id: 42,
      title: 'ADO branch detail',
      sourceBranch: 'feature/ado-detail',
      targetBranch: 'main',
      labels: ['ready'],
    });
  });

  test('rejects providers that do not implement findPullRequestForBranch', async () => {
    const error = await Effect.runPromise(
      findPullRequestForBranchForRemote(
        [fakeProvider('gitlab-plugin', 'gitlab', 100)],
        'matched-remote',
        { branch: 'feature/provider-branch' }
      ).pipe(Effect.flip)
    );

    expect(error).toBeInstanceOf(UnsupportedPullRequestProviderOperationError);
    if (!(error instanceof UnsupportedPullRequestProviderOperationError)) {
      throw new Error('Expected unsupported provider operation error');
    }
    expect(error.operation).toBe('findPullRequestForBranch');
  });

  test('rejects findPullRequestForBranch operations that do not return Effects', async () => {
    const provider = fakeProvider('gitlab-plugin', 'gitlab', 100);
    const error = await Effect.runPromise(
      findPullRequestForBranchForRemote(
        [
          {
            ...provider,
            capability: {
              ...provider.capability,
              operations: {
                findPullRequestForBranch: () => ({}) as never,
              },
            },
          },
        ],
        'matched-remote',
        { branch: 'feature/provider-branch' }
      ).pipe(Effect.flip)
    );

    expect(error).toBeInstanceOf(
      InvalidPullRequestProviderOperationResultError
    );
    if (!(error instanceof InvalidPullRequestProviderOperationResultError)) {
      throw new Error('Expected invalid provider operation result error');
    }
    expect(error.operation).toBe('findPullRequestForBranch');
    expect(error.reason).toBe('operation must return an Effect');
  });

  test('rejects findPullRequestForBranch results for a different branch', async () => {
    const provider = fakeProvider('gitlab-plugin', 'gitlab', 100);
    const error = await Effect.runPromise(
      findPullRequestForBranchForRemote(
        [
          {
            ...provider,
            capability: {
              ...provider.capability,
              operations: {
                findPullRequestForBranch: () =>
                  Effect.succeed({
                    branch: 'feature/other',
                    repository: externalRepository('gitlab'),
                    pullRequest: {
                      id: 1,
                      title: 'Wrong branch',
                      status: 'active',
                      createdAt: '2026-01-01T00:00:00Z',
                      author: { displayName: 'Ada Lovelace' },
                    },
                  }),
              },
            },
          },
        ],
        'matched-remote',
        { branch: 'feature/provider-branch' }
      ).pipe(Effect.flip)
    );

    expect(error).toBeInstanceOf(
      InvalidPullRequestProviderOperationResultError
    );
    if (!(error instanceof InvalidPullRequestProviderOperationResultError)) {
      throw new Error('Expected invalid provider operation result error');
    }
    expect(error.reason).toBe('branch does not match requested branch');
  });

  test('rejects findPullRequestForBranch results whose PR source branch differs', async () => {
    const provider = fakeProvider('gitlab-plugin', 'gitlab', 100);
    const error = await Effect.runPromise(
      findPullRequestForBranchForRemote(
        [
          {
            ...provider,
            capability: {
              ...provider.capability,
              operations: {
                findPullRequestForBranch: () =>
                  Effect.succeed({
                    branch: 'feature/provider-branch',
                    repository: externalRepository('gitlab'),
                    pullRequest: {
                      id: 1,
                      title: 'Wrong source branch',
                      status: 'active',
                      createdAt: '2026-01-01T00:00:00Z',
                      author: { displayName: 'Ada Lovelace' },
                      sourceBranch: 'feature/other',
                    },
                  }),
              },
            },
          },
        ],
        'matched-remote',
        { branch: 'feature/provider-branch' }
      ).pipe(Effect.flip)
    );

    expect(error).toBeInstanceOf(
      InvalidPullRequestProviderOperationResultError
    );
    if (!(error instanceof InvalidPullRequestProviderOperationResultError)) {
      throw new Error('Expected invalid provider operation result error');
    }
    expect(error.reason).toBe(
      'pull request source branch does not match requested branch'
    );
  });

  test('rejects findPullRequestForBranch results that omit PR source branch', async () => {
    const provider = fakeProvider('gitlab-plugin', 'gitlab', 100);
    const error = await Effect.runPromise(
      findPullRequestForBranchForRemote(
        [
          {
            ...provider,
            capability: {
              ...provider.capability,
              operations: {
                findPullRequestForBranch: () =>
                  Effect.succeed({
                    branch: 'feature/provider-branch',
                    repository: externalRepository('gitlab'),
                    pullRequest: {
                      id: 1,
                      title: 'Missing source branch',
                      status: 'active',
                      createdAt: '2026-01-01T00:00:00Z',
                      author: { displayName: 'Ada Lovelace' },
                    },
                  }),
              },
            },
          },
        ],
        'matched-remote',
        { branch: 'feature/provider-branch' }
      ).pipe(Effect.flip)
    );

    expect(error).toBeInstanceOf(
      InvalidPullRequestProviderOperationResultError
    );
    if (!(error instanceof InvalidPullRequestProviderOperationResultError)) {
      throw new Error('Expected invalid provider operation result error');
    }
    expect(error.reason).toBe(
      'pull request source branch does not match requested branch'
    );
  });

  test('validates findPullRequestForBranch results against the original immutable request', async () => {
    const provider = fakeProvider('gitlab-plugin', 'gitlab', 100);
    const error = await Effect.runPromise(
      findPullRequestForBranchForRemote(
        [
          {
            ...provider,
            capability: {
              ...provider.capability,
              operations: {
                findPullRequestForBranch: (request) => {
                  try {
                    (request as { branch: string }).branch = 'feature/other';
                  } catch {
                    // Frozen operation requests should reject mutation.
                  }

                  return Effect.succeed({
                    branch: 'feature/other',
                    repository: externalRepository('gitlab'),
                    pullRequest: {
                      id: 1,
                      title: 'Mutated branch',
                      status: 'active',
                      createdAt: '2026-01-01T00:00:00Z',
                      author: { displayName: 'Ada Lovelace' },
                      sourceBranch: 'feature/other',
                    },
                  });
                },
              },
            },
          },
        ],
        'matched-remote',
        { branch: 'feature/provider-branch' }
      ).pipe(Effect.flip)
    );

    expect(error).toBeInstanceOf(
      InvalidPullRequestProviderOperationResultError
    );
    if (!(error instanceof InvalidPullRequestProviderOperationResultError)) {
      throw new Error('Expected invalid provider operation result error');
    }
    expect(error.reason).toBe('branch does not match requested branch');
  });

  test('prefers a branch-capable provider over a higher-priority match without the operation', async () => {
    const branchCapableProvider = fakeProvider(
      'branch-plugin',
      'branch-provider',
      50
    );

    const result = await Effect.runPromise(
      findPullRequestForBranchForRemote(
        [
          fakeProvider('shadow-plugin', 'shadow-provider', 1000),
          {
            ...branchCapableProvider,
            capability: {
              ...branchCapableProvider.capability,
              operations: {
                findPullRequestForBranch: (request) =>
                  Effect.succeed({
                    branch: request.branch,
                    repository: externalRepository('branch-provider'),
                    pullRequest: {
                      id: 1,
                      title: 'Branch-capable provider',
                      status: 'active',
                      createdAt: '2026-01-01T00:00:00Z',
                      author: { displayName: 'Ada Lovelace' },
                      sourceBranch: request.branch,
                    },
                  }),
              },
            },
          },
        ],
        'matched-remote',
        { branch: 'feature/provider-branch' }
      )
    );

    expect(result.repository).toEqual(externalRepository('branch-provider'));
    expect(result.pullRequest.title).toBe('Branch-capable provider');
  });
});

describe('pull request provider platform context bridge', () => {
  test('creates a GitHub platform context from the resolved provider match', async () => {
    const registry = createBuiltinCommandRegistry();
    const calls: unknown[] = [];

    const ctx = await resolvePullRequestPlatformContextForRemote(
      createAideHostServices(registry),
      'git@ssh.acme.ghe.com:acme/widgets.git',
      {
        createGitHubClient: async ({ host, scope }) => {
          calls.push({ host, scope });
          return { kind: 'github-client' } as unknown as GitHubClient;
        },
        createAzureDevOpsClient: async () => {
          throw new Error('Azure DevOps client should not be created');
        },
      }
    );

    expect(ctx).toMatchObject({
      platform: 'github',
      host: 'acme.ghe.com',
      owner: 'acme',
      repo: 'widgets',
      autoDiscovered: true,
    });
    expect(calls).toEqual([
      {
        host: 'acme.ghe.com',
        scope: { providerId: 'github', host: 'acme.ghe.com' },
      },
    ]);
  });

  test('creates an Azure DevOps platform context from the resolved provider match', async () => {
    const registry = createBuiltinCommandRegistry();
    const calls: unknown[] = [];

    const ctx = await resolvePullRequestPlatformContextForRemote(
      createAideHostServices(registry),
      'git@ssh.dev.azure.com:v3/acme/Platform/widgets',
      {
        createGitHubClient: async () => {
          throw new Error('GitHub client should not be created');
        },
        createAzureDevOpsClient: async (options) => {
          calls.push(options);
          return {
            kind: 'azure-devops-client',
          } as unknown as AzureDevOpsClient;
        },
      }
    );

    expect(ctx).toMatchObject({
      platform: 'azure-devops',
      org: 'acme',
      project: 'Platform',
      repo: 'widgets',
      autoDiscovered: true,
    });
    expect(calls).toEqual([
      {
        scope: {
          providerId: 'azure-devops',
          host: 'dev.azure.com',
          org: 'acme',
        },
      },
    ]);
  });

  test('uses trusted GitHub provider when a high-priority external provider matches the same remote', async () => {
    const registry = createBuiltinCommandRegistry();
    const calls: string[] = [];
    const shadowingProvider = fakeProvider('gitlab-plugin', 'gitlab', 1000, {
      source: 'git-remote',
      priority: 1000,
      repository: {
        kind: 'github',
        host: 'evil.example',
        owner: 'acme',
        repo: 'widgets',
      },
    });

    const ctx = await resolvePullRequestPlatformContextForRemote(
      hostServicesForProviders([
        shadowingProvider,
        ...registry.capabilities.pullRequestProviders(),
      ]),
      'git@github.com:acme/widgets.git',
      {
        createGitHubClient: async ({ host }) => {
          calls.push(`github:${host}`);
          return { kind: 'github-client' } as unknown as GitHubClient;
        },
        createAzureDevOpsClient: async () => {
          calls.push('ado');
          return {
            kind: 'azure-devops-client',
          } as unknown as AzureDevOpsClient;
        },
      }
    );

    expect(ctx).toMatchObject({
      platform: 'github',
      host: 'github.com',
      owner: 'acme',
      repo: 'widgets',
      autoDiscovered: true,
    });
    expect(calls).toEqual(['github:github.com']);
  });

  test('rejects direct external providers that forge GitHub core refs', async () => {
    const calls: string[] = [];

    await expect(
      platformContextFromPullRequestProvider(
        {
          pluginId: 'evil-plugin',
          providerId: 'evil-provider',
          features: {},
          priority: 1000,
          match: {
            source: 'git-remote',
            priority: 1000,
            repository: {
              kind: 'github',
              host: 'evil.example',
              owner: 'acme',
              repo: 'widgets',
            },
          },
        },
        {
          createGitHubClient: async ({ host }) => {
            calls.push(`github:${host}`);
            return { kind: 'github-client' } as unknown as GitHubClient;
          },
          createAzureDevOpsClient: async () => {
            calls.push('ado');
            return {
              kind: 'azure-devops-client',
            } as unknown as AzureDevOpsClient;
          },
        }
      )
    ).rejects.toThrow(
      "Pull request provider 'evil-provider' from plugin 'evil-plugin' cannot provide 'github' repository refs to the legacy platform bridge"
    );
    expect(calls).toEqual([]);
  });

  test('uses trusted Azure DevOps provider when a high-priority external provider matches the same remote', async () => {
    const registry = createBuiltinCommandRegistry();
    const calls: string[] = [];
    const shadowingProvider = fakeProvider('gitlab-plugin', 'gitlab', 1000, {
      source: 'git-remote',
      priority: 1000,
      repository: {
        kind: 'external',
        providerId: 'gitlab',
        displayName: 'GitLab',
      },
    });

    const ctx = await resolvePullRequestPlatformContextForRemote(
      hostServicesForProviders([
        shadowingProvider,
        ...registry.capabilities.pullRequestProviders(),
      ]),
      'git@ssh.dev.azure.com:v3/acme/Platform/widgets',
      {
        createGitHubClient: async ({ host }) => {
          calls.push(`github:${host}`);
          return { kind: 'github-client' } as unknown as GitHubClient;
        },
        createAzureDevOpsClient: async () => {
          calls.push('ado');
          return {
            kind: 'azure-devops-client',
          } as unknown as AzureDevOpsClient;
        },
      }
    );

    expect(ctx).toMatchObject({
      platform: 'azure-devops',
      org: 'acme',
      project: 'Platform',
      repo: 'widgets',
      autoDiscovered: true,
    });
    expect(calls).toEqual(['ado']);
  });

  test('rejects high-priority external providers that forge Azure DevOps core refs', async () => {
    const calls: string[] = [];
    const maliciousProvider = fakeProvider(
      'evil-plugin',
      'evil-provider',
      1000,
      {
        source: 'git-remote',
        priority: 1000,
        repository: {
          kind: 'azure-devops',
          org: 'evil',
          project: 'Platform',
          repo: 'widgets',
        },
      }
    );

    await expect(
      resolvePullRequestPlatformContextForRemote(
        hostServicesForProviders([maliciousProvider]),
        'git@ssh.dev.azure.com:v3/acme/Platform/widgets',
        {
          createGitHubClient: async ({ host }) => {
            calls.push(`github:${host}`);
            return { kind: 'github-client' } as unknown as GitHubClient;
          },
          createAzureDevOpsClient: async () => {
            calls.push('ado');
            return {
              kind: 'azure-devops-client',
            } as unknown as AzureDevOpsClient;
          },
        }
      )
    ).rejects.toThrow(
      "Pull request provider 'evil-provider' from plugin 'evil-plugin' cannot provide 'azure-devops' repository refs to the legacy platform bridge"
    );
    expect(calls).toEqual([]);
  });

  test('validates GitHub hosts before creating a core GitHub client', async () => {
    const calls: string[] = [];

    await expect(
      platformContextFromPullRequestProvider(
        {
          pluginId: 'github',
          providerId: 'github',
          features: {},
          priority: 100,
          match: {
            source: 'git-remote',
            priority: 100,
            repository: {
              kind: 'github',
              host: 'evil.example',
              owner: 'acme',
              repo: 'widgets',
            },
          },
        },
        {
          createGitHubClient: async ({ host }) => {
            calls.push(`github:${host}`);
            return { kind: 'github-client' } as unknown as GitHubClient;
          },
          createAzureDevOpsClient: async () => {
            calls.push('ado');
            return {
              kind: 'azure-devops-client',
            } as unknown as AzureDevOpsClient;
          },
        }
      )
    ).rejects.toThrow(
      "Pull request provider 'github' returned unsupported GitHub host 'evil.example'"
    );
    expect(calls).toEqual([]);
  });
});

type ControlledTransportState = {
  started: number;
  aborted: number;
  completed: number;
  settled: number;
  signals: AbortSignal[];
};

function controlledTransportState(): ControlledTransportState {
  return { started: 0, aborted: 0, completed: 0, settled: 0, signals: [] };
}

function finalAbortSignal(args: readonly unknown[]): AbortSignal | undefined {
  const candidate = args[args.length - 1];
  return candidate instanceof AbortSignal ? candidate : undefined;
}

function lateMutationResult<T>(
  state: ControlledTransportState,
  args: readonly unknown[],
  value: T
): Promise<T> {
  state.started += 1;
  const signal = finalAbortSignal(args);
  if (signal !== undefined) {
    state.signals.push(signal);
    signal.addEventListener(
      'abort',
      () => {
        state.aborted += 1;
      },
      { once: true }
    );
  }
  return new Promise((resolve) => {
    setTimeout(() => {
      state.completed += 1;
      state.settled += 1;
      resolve(value);
    }, 40);
  });
}

function cancellableReadResult<T>(
  state: ControlledTransportState,
  args: readonly unknown[],
  value: T
): Promise<T> {
  state.started += 1;
  const signal = finalAbortSignal(args);
  if (signal !== undefined) state.signals.push(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.completed += 1;
      state.settled += 1;
      resolve(value);
    }, 40);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        state.aborted += 1;
        state.settled += 1;
        reject(signal.reason);
      },
      { once: true }
    );
  });
}

function expectIndeterminateMutation(
  error: unknown,
  providerId: string,
  operation: string
): void {
  expect(error).toBeInstanceOf(PullRequestProviderMutationIndeterminateError);
  expect(error).toMatchObject({
    _tag: 'PullRequestProviderMutationIndeterminateError',
    pluginId: providerId,
    providerId,
    operation,
  });
  expect((error as Error).message).toBe(
    `Pull request mutation outcome is indeterminate for provider '${providerId}' from plugin '${providerId}' during ${operation}: the operation may have succeeded; do not retry blindly. Verify the remote state before taking further action.`
  );
  expect((error as Error).message).not.toContain('SECRET');
  expect(Object.hasOwn(error as object, 'cause')).toBe(false);
}

describe('truthful built-in pull request cancellation and mutation timeouts', () => {
  const githubRemote = 'git@github.com:acme/widgets.git';
  const azureRemote = 'git@ssh.dev.azure.com:v3/acme/Platform/widgets';

  test('GitHub create/update label warnings use fixed text for unsupported and SDK rejection paths', async () => {
    const unsupportedPlugin = createGitHubPlugin({
      createClient: async () => ({
        listPullRequests: async () => [],
        getPullRequest: async (_owner, _repo, number) =>
          fakeGitHubPullRequest({ number, title: 'Updated' }),
        getPullRequestFiles: async () => [],
        getIssueComments: async () => [],
        getReviewComments: async () => [],
        createPullRequest: async () =>
          fakeGitHubPullRequest({ number: 31, title: 'Created' }),
      }),
    });
    const unsupportedProviders = [
      {
        pluginId: unsupportedPlugin.id,
        capability: unsupportedPlugin.capabilities!.pullRequestProvider!,
      },
    ];
    const unsupportedCreate = await Effect.runPromise(
      createPullRequestForRemote(unsupportedProviders, githubRemote, {
        title: 'Created',
        sourceBranch: 'feature',
        targetBranch: 'main',
        labels: ['SECRET-GITHUB-CREATE-LABEL'],
      })
    );
    const unsupportedUpdate = await Effect.runPromise(
      updatePullRequestForRemote(unsupportedProviders, githubRemote, {
        pullRequest: { number: 90210 },
        labelsToAdd: ['SECRET-GITHUB-ADD-LABEL'],
        labelsToRemove: ['SECRET-GITHUB-REMOVE-LABEL'],
      })
    );

    expect(unsupportedCreate.warnings).toEqual([
      'Failed to add labels: GitHub client does not support labels',
    ]);
    expect(unsupportedUpdate.warnings).toEqual([
      'Failed to add labels: GitHub client does not support labels',
      'Failed to remove label: GitHub client does not support labels',
    ]);

    const plugin = createGitHubPlugin({
      createClient: async () => ({
        listPullRequests: async () => [],
        getPullRequest: async (_owner, _repo, number) =>
          fakeGitHubPullRequest({ number, title: 'Updated' }),
        getPullRequestFiles: async () => [],
        getIssueComments: async () => [],
        getReviewComments: async () => [],
        createPullRequest: async () =>
          fakeGitHubPullRequest({ number: 31, title: 'Created' }),
        addLabels: async () => {
          throw new Error('SECRET-RAW-GITHUB-SDK-FAILURE');
        },
        removeLabel: async () => {
          throw new Error('SECRET-GITHUB-NOT-FOUND-SDK-FAILURE');
        },
      }),
    });
    const providers = [
      {
        pluginId: plugin.id,
        capability: plugin.capabilities!.pullRequestProvider!,
      },
    ];

    const createResult = await Effect.runPromise(
      createPullRequestForRemote(providers, githubRemote, {
        title: 'Created',
        sourceBranch: 'feature',
        targetBranch: 'main',
        labels: ['SECRET-GITHUB-SDK-CREATE-LABEL'],
      })
    );
    const updateResult = await Effect.runPromise(
      updatePullRequestForRemote(providers, githubRemote, {
        pullRequest: { number: 90211 },
        labelsToAdd: ['SECRET-GITHUB-SDK-ADD-LABEL'],
        labelsToRemove: ['SECRET-GITHUB-SDK-REMOVE-LABEL'],
      })
    );

    expect(createResult.warnings).toEqual([
      'Failed to add labels: provider request failed',
    ]);
    expect(updateResult.warnings).toEqual([
      'Failed to add labels: provider request failed',
      'Failed to remove label: provider request failed',
    ]);
    expect(
      JSON.stringify([unsupportedCreate.warnings, unsupportedUpdate.warnings])
    ).not.toContain('SECRET');
    expect(
      JSON.stringify([unsupportedCreate.warnings, unsupportedUpdate.warnings])
    ).not.toContain('90210');
    expect(
      JSON.stringify([createResult.warnings, updateResult.warnings])
    ).not.toContain('SECRET');
    expect(
      JSON.stringify([createResult.warnings, updateResult.warnings])
    ).not.toContain('90211');
  });

  test('Azure DevOps create/update tag warnings use fixed text for unsupported and not-found paths', async () => {
    const plugin = createAzureDevOpsPlugin({
      createClient: async () => ({
        config: {
          orgUrl: 'https://dev.azure.com/acme',
          pat: 'token',
          authMethod: 'pat',
        },
        client: {
          listPullRequests: async () => ({ value: [] }),
          getPullRequest: async (_project, _repo, number) =>
            fakeAzureDevOpsPullRequest({
              pullRequestId: number,
              title: 'Updated',
            }),
          getPullRequestLabels: async () => ({
            value: [
              {
                id: 'present-label-id',
                name: 'SECRET-AZURE-PRESENT-LABEL',
                active: true,
                url: 'https://dev.azure.com/acme/labels/present-label-id',
              },
            ],
          }),
          getAllPullRequestChanges: async () => [],
          getAllComments: async () => [],
          createPullRequest: async () =>
            fakeAzureDevOpsPullRequest({
              pullRequestId: 41,
              title: 'Created',
            }),
        },
      }),
    });
    const providers = [
      {
        pluginId: plugin.id,
        capability: plugin.capabilities!.pullRequestProvider!,
      },
    ];

    const createResult = await Effect.runPromise(
      createPullRequestForRemote(providers, azureRemote, {
        title: 'Created',
        sourceBranch: 'feature',
        targetBranch: 'main',
        labels: ['SECRET-AZURE-CREATE-LABEL'],
      })
    );
    const updateResult = await Effect.runPromise(
      updatePullRequestForRemote(providers, azureRemote, {
        pullRequest: { number: 90212 },
        labelsToAdd: ['SECRET-AZURE-ADD-LABEL'],
        labelsToRemove: [
          'SECRET-AZURE-MISSING-LABEL',
          'SECRET-AZURE-PRESENT-LABEL',
        ],
      })
    );

    expect(createResult.warnings).toEqual([
      'Failed to add tag: Azure DevOps client does not support labels',
    ]);
    expect(updateResult.warnings).toEqual([
      'Failed to remove tag: requested tag was not found on the pull request',
      'Failed to remove tag: Azure DevOps client does not support labels',
      'Failed to add tag: Azure DevOps client does not support labels',
    ]);
    expect(
      JSON.stringify([createResult.warnings, updateResult.warnings])
    ).not.toContain('SECRET');
    expect(
      JSON.stringify([createResult.warnings, updateResult.warnings])
    ).not.toContain('90212');
  });

  test('Azure DevOps create/update tag warnings redact SDK rejection details', async () => {
    const plugin = createAzureDevOpsPlugin({
      createClient: async () => ({
        config: {
          orgUrl: 'https://dev.azure.com/acme',
          pat: 'token',
          authMethod: 'pat',
        },
        client: {
          listPullRequests: async () => ({ value: [] }),
          getPullRequest: async (_project, _repo, number) =>
            fakeAzureDevOpsPullRequest({
              pullRequestId: number,
              title: 'Updated',
            }),
          getPullRequestLabels: async () => ({
            value: [
              {
                id: 'remove-label-id',
                name: 'SECRET-AZURE-SDK-REMOVE-LABEL',
                active: true,
                url: 'https://dev.azure.com/acme/labels/remove-label-id',
              },
            ],
          }),
          getAllPullRequestChanges: async () => [],
          getAllComments: async () => [],
          createPullRequest: async () =>
            fakeAzureDevOpsPullRequest({
              pullRequestId: 42,
              title: 'Created',
            }),
          addPullRequestLabel: async () => {
            throw new Error('SECRET-AZURE-ADD-SDK-MESSAGE');
          },
          removePullRequestLabel: async () => {
            throw new Error('SECRET-AZURE-REMOVE-SDK-MESSAGE');
          },
        },
      }),
    });
    const providers = [
      {
        pluginId: plugin.id,
        capability: plugin.capabilities!.pullRequestProvider!,
      },
    ];

    const createResult = await Effect.runPromise(
      createPullRequestForRemote(providers, azureRemote, {
        title: 'Created',
        sourceBranch: 'feature',
        targetBranch: 'main',
        labels: ['SECRET-AZURE-SDK-CREATE-LABEL'],
      })
    );
    const updateResult = await Effect.runPromise(
      updatePullRequestForRemote(providers, azureRemote, {
        pullRequest: { number: 90213 },
        labelsToAdd: ['SECRET-AZURE-SDK-ADD-LABEL'],
        labelsToRemove: ['SECRET-AZURE-SDK-REMOVE-LABEL'],
      })
    );

    expect(createResult.warnings).toEqual([
      'Failed to add tag: provider request failed',
    ]);
    expect(updateResult.warnings).toEqual([
      'Failed to remove tag: provider request failed',
      'Failed to add tag: provider request failed',
    ]);
    expect(
      JSON.stringify([createResult.warnings, updateResult.warnings])
    ).not.toContain('SECRET');
    expect(
      JSON.stringify([createResult.warnings, updateResult.warnings])
    ).not.toContain('90213');
  });

  for (const family of ['create', 'update', 'comment', 'reply'] as const) {
    test(`GitHub ${family} reports an indeterminate timeout while late transport settlement remains observed`, async () => {
      const state = controlledTransportState();
      const plugin = createGitHubPlugin({
        createClient: async () => ({
          listPullRequests: async () => [],
          getPullRequest: async (_owner, _repo, number) =>
            fakeGitHubPullRequest({ number, title: 'GitHub result' }),
          getPullRequestFiles: async () => [],
          getIssueComments: async () => [],
          getReviewComments: async () => [],
          createPullRequest: (
            ...args: Parameters<GitHubClient['createPullRequest']>
          ) =>
            family === 'create'
              ? lateMutationResult(
                  state,
                  args,
                  fakeGitHubPullRequest({
                    number: 31,
                    title: 'Created GitHub PR',
                  })
                )
              : Promise.resolve(
                  fakeGitHubPullRequest({ number: 31, title: 'Unused' })
                ),
          updatePullRequest: (
            ...args: Parameters<GitHubClient['updatePullRequest']>
          ) =>
            family === 'update'
              ? lateMutationResult(
                  state,
                  args,
                  fakeGitHubPullRequest({ number: 7, title: 'Updated' })
                )
              : Promise.resolve(
                  fakeGitHubPullRequest({ number: 7, title: 'Unused' })
                ),
          createIssueComment: (
            ...args: Parameters<GitHubClient['createIssueComment']>
          ) =>
            family === 'comment'
              ? lateMutationResult(
                  state,
                  args,
                  fakeGitHubIssueComment({ body: 'Commented' })
                )
              : Promise.resolve(fakeGitHubIssueComment()),
          createReviewComment: async () => fakeGitHubReviewComment(),
          replyToReviewComment: (
            ...args: Parameters<GitHubClient['replyToReviewComment']>
          ) =>
            family === 'reply'
              ? lateMutationResult(
                  state,
                  args,
                  fakeGitHubReviewComment({ body: 'Replied' })
                )
              : Promise.resolve(fakeGitHubReviewComment()),
        }),
      });
      const providers = [
        {
          pluginId: plugin.id,
          capability: plugin.capabilities!.pullRequestProvider!,
        },
      ];
      const effect: Effect.Effect<unknown, unknown, never> =
        family === 'create'
          ? createPullRequestForRemote(
              providers,
              githubRemote,
              {
                title: 'Created GitHub PR',
                sourceBranch: 'feature',
                targetBranch: 'main',
              },
              { operationTimeout: '5 millis' }
            )
          : family === 'update'
            ? updatePullRequestForRemote(
                providers,
                githubRemote,
                { pullRequest: { number: 7 }, title: 'Updated' },
                { operationTimeout: '5 millis' }
              )
            : family === 'comment'
              ? addPullRequestCommentForRemote(
                  providers,
                  githubRemote,
                  { pullRequest: { number: 7 }, body: 'Commented' },
                  { operationTimeout: '5 millis' }
                )
              : replyToPullRequestCommentForRemote(
                  providers,
                  githubRemote,
                  {
                    pullRequest: { number: 7 },
                    threadId: 22,
                    body: 'Replied',
                  },
                  { operationTimeout: '5 millis' }
                );

      const error = await Effect.runPromise(effect.pipe(Effect.flip));
      expectIndeterminateMutation(
        error,
        'github',
        family === 'create'
          ? 'createPullRequest'
          : family === 'update'
            ? 'updatePullRequest'
            : family === 'comment'
              ? 'addPullRequestComment'
              : 'replyToPullRequestComment'
      );
      expect(state).toMatchObject({
        started: 1,
        aborted: 1,
        completed: 0,
        settled: 0,
      });
      expect(state.signals).toHaveLength(1);
      expect(state.signals[0]?.aborted).toBe(true);
      await Bun.sleep(60);
      expect(state).toMatchObject({ completed: 1, settled: 1 });
    });

    test(`Azure DevOps ${family} reports an indeterminate timeout while late transport settlement remains observed`, async () => {
      const state = controlledTransportState();
      const plugin = createAzureDevOpsPlugin({
        createClient: async () => ({
          config: {
            orgUrl: 'https://dev.azure.com/acme',
            pat: 'token',
            authMethod: 'pat',
          },
          client: {
            listPullRequests: async () => ({ value: [] }),
            getPullRequest: async (_project, _repo, number) =>
              fakeAzureDevOpsPullRequest({
                pullRequestId: number,
                title: 'Azure DevOps result',
              }),
            getPullRequestLabels: async () => ({ value: [] }),
            getAllPullRequestChanges: async () => [],
            getAllComments: async () => [],
            createPullRequest: (
              ...args: Parameters<AzureDevOpsClient['createPullRequest']>
            ) =>
              family === 'create'
                ? lateMutationResult(
                    state,
                    args,
                    fakeAzureDevOpsPullRequest({
                      pullRequestId: 41,
                      title: 'Created Azure DevOps PR',
                    })
                  )
                : Promise.resolve(
                    fakeAzureDevOpsPullRequest({
                      pullRequestId: 41,
                      title: 'Unused',
                    })
                  ),
            updatePullRequest: (
              ...args: Parameters<AzureDevOpsClient['updatePullRequest']>
            ) =>
              family === 'update'
                ? lateMutationResult(
                    state,
                    args,
                    fakeAzureDevOpsPullRequest({
                      pullRequestId: 7,
                      title: 'Updated',
                    })
                  )
                : Promise.resolve(
                    fakeAzureDevOpsPullRequest({
                      pullRequestId: 7,
                      title: 'Unused',
                    })
                  ),
            createPullRequestThread: (
              ...args: Parameters<AzureDevOpsClient['createPullRequestThread']>
            ) =>
              family === 'comment'
                ? lateMutationResult(state, args, fakeAzureDevOpsThread())
                : Promise.resolve(fakeAzureDevOpsThread()),
            createThreadComment: (
              ...args: Parameters<AzureDevOpsClient['createThreadComment']>
            ) =>
              family === 'reply'
                ? lateMutationResult(
                    state,
                    args,
                    fakeAzureDevOpsCreatedComment({ content: 'Replied' })
                  )
                : Promise.resolve(fakeAzureDevOpsCreatedComment()),
          },
        }),
      });
      const providers = [
        {
          pluginId: plugin.id,
          capability: plugin.capabilities!.pullRequestProvider!,
        },
      ];
      const effect: Effect.Effect<unknown, unknown, never> =
        family === 'create'
          ? createPullRequestForRemote(
              providers,
              azureRemote,
              {
                title: 'Created Azure DevOps PR',
                sourceBranch: 'feature',
                targetBranch: 'main',
              },
              { operationTimeout: '5 millis' }
            )
          : family === 'update'
            ? updatePullRequestForRemote(
                providers,
                azureRemote,
                { pullRequest: { number: 7 }, title: 'Updated' },
                { operationTimeout: '5 millis' }
              )
            : family === 'comment'
              ? addPullRequestCommentForRemote(
                  providers,
                  azureRemote,
                  { pullRequest: { number: 7 }, body: 'Commented' },
                  { operationTimeout: '5 millis' }
                )
              : replyToPullRequestCommentForRemote(
                  providers,
                  azureRemote,
                  {
                    pullRequest: { number: 7 },
                    threadId: 22,
                    body: 'Replied',
                  },
                  { operationTimeout: '5 millis' }
                );

      const error = await Effect.runPromise(effect.pipe(Effect.flip));
      expectIndeterminateMutation(
        error,
        'azure-devops',
        family === 'create'
          ? 'createPullRequest'
          : family === 'update'
            ? 'updatePullRequest'
            : family === 'comment'
              ? 'addPullRequestComment'
              : 'replyToPullRequestComment'
      );
      expect(state).toMatchObject({
        started: 1,
        aborted: 1,
        completed: 0,
        settled: 0,
      });
      expect(state.signals).toHaveLength(1);
      expect(state.signals[0]?.aborted).toBe(true);
      await Bun.sleep(60);
      expect(state).toMatchObject({ completed: 1, settled: 1 });
    });
  }

  for (const providerId of ['github', 'azure-devops'] as const) {
    for (const family of [
      'list',
      'get',
      'diff',
      'comments',
      'branch',
    ] as const) {
      test(`${providerId} ${family} read timeout aborts every started transport and performs no post-exit work`, async () => {
        const state = controlledTransportState();
        const plugin =
          providerId === 'github'
            ? createGitHubPlugin({
                createClient: async () => ({
                  listPullRequests: (
                    ...args: Parameters<GitHubClient['listPullRequests']>
                  ) =>
                    cancellableReadResult(state, args, [
                      fakeGitHubPullRequest({ number: 1, title: 'Branch PR' }),
                    ]),
                  getPullRequest: (
                    ...args: Parameters<GitHubClient['getPullRequest']>
                  ) =>
                    cancellableReadResult(
                      state,
                      args,
                      fakeGitHubPullRequest({ number: 1, title: 'Read PR' })
                    ),
                  getPullRequestFiles: (
                    ...args: Parameters<GitHubClient['getPullRequestFiles']>
                  ) => cancellableReadResult(state, args, []),
                  getIssueComments: (
                    ...args: Parameters<GitHubClient['getIssueComments']>
                  ) => cancellableReadResult(state, args, []),
                  getReviewComments: (
                    ...args: Parameters<GitHubClient['getReviewComments']>
                  ) => cancellableReadResult(state, args, []),
                }),
              })
            : createAzureDevOpsPlugin({
                createClient: async () => ({
                  config: {
                    orgUrl: 'https://dev.azure.com/acme',
                    pat: 'token',
                    authMethod: 'pat',
                  },
                  client: {
                    listPullRequests: (
                      ...args: Parameters<AzureDevOpsClient['listPullRequests']>
                    ) =>
                      cancellableReadResult(state, args, {
                        value: [
                          fakeAzureDevOpsPullRequest({
                            pullRequestId: 1,
                            title: 'Branch PR',
                          }),
                        ],
                      }),
                    getPullRequest: (
                      ...args: Parameters<AzureDevOpsClient['getPullRequest']>
                    ) =>
                      cancellableReadResult(
                        state,
                        args,
                        fakeAzureDevOpsPullRequest({
                          pullRequestId: 1,
                          title: 'Read PR',
                        })
                      ),
                    getPullRequestLabels: (
                      ...args: Parameters<
                        AzureDevOpsClient['getPullRequestLabels']
                      >
                    ) => cancellableReadResult(state, args, { value: [] }),
                    getAllPullRequestChanges: (
                      ...args: Parameters<
                        AzureDevOpsClient['getAllPullRequestChanges']
                      >
                    ) => cancellableReadResult(state, args, []),
                    getAllComments: (
                      ...args: Parameters<AzureDevOpsClient['getAllComments']>
                    ) => cancellableReadResult(state, args, []),
                  },
                }),
              });
        const remote = providerId === 'github' ? githubRemote : azureRemote;
        const providers = [
          {
            pluginId: plugin.id,
            capability: plugin.capabilities!.pullRequestProvider!,
          },
        ];
        const effect: Effect.Effect<unknown, unknown, never> =
          family === 'list'
            ? listPullRequestsForRemote(
                providers,
                remote,
                {},
                {
                  operationTimeout: '5 millis',
                }
              )
            : family === 'get'
              ? getPullRequestForRemote(
                  providers,
                  remote,
                  {
                    pullRequest: { number: 1 },
                  },
                  {
                    operationTimeout: '5 millis',
                  }
                )
              : family === 'diff'
                ? getPullRequestDiffForRemote(
                    providers,
                    remote,
                    {
                      pullRequest: { number: 1 },
                    },
                    {
                      operationTimeout: '5 millis',
                    }
                  )
                : family === 'comments'
                  ? listPullRequestCommentsForRemote(
                      providers,
                      remote,
                      {
                        pullRequest: { number: 1 },
                      },
                      {
                        operationTimeout: '5 millis',
                      }
                    )
                  : findPullRequestForBranchForRemote(
                      providers,
                      remote,
                      {
                        branch: 'feature',
                      },
                      {
                        operationTimeout: '5 millis',
                      }
                    );
        const error = await Effect.runPromise(effect.pipe(Effect.flip));

        expect(error).toMatchObject({
          _tag: 'PullRequestProviderOperationTimeoutError',
          providerId,
          operation:
            family === 'list'
              ? 'listPullRequests'
              : family === 'get'
                ? 'getPullRequest'
                : family === 'diff'
                  ? 'getPullRequestDiff'
                  : family === 'comments'
                    ? 'listPullRequestComments'
                    : 'findPullRequestForBranch',
        });
        const expectedStarted =
          providerId === 'github'
            ? family === 'diff' || family === 'comments'
              ? 2
              : 1
            : family === 'get'
              ? 2
              : family === 'diff'
                ? 3
                : 1;
        expect(state).toMatchObject({
          started: expectedStarted,
          aborted: expectedStarted,
          completed: 0,
          settled: expectedStarted,
        });
        expect(state.signals).toHaveLength(expectedStarted);
        expect(state.signals.every((signal) => signal.aborted)).toBe(true);
        await Bun.sleep(60);
        expect(state).toMatchObject({ completed: 0, settled: expectedStarted });
      });
    }
  }

  test.each(['github', 'azure-devops'] as const)(
    '%s branch lookup forwards one signal through both composite phases',
    async (providerId) => {
      const signals: AbortSignal[] = [];
      const recordSignal = (args: readonly unknown[]) => {
        const signal = finalAbortSignal(args);
        expect(signal).toBeInstanceOf(AbortSignal);
        signals.push(signal!);
      };
      const plugin =
        providerId === 'github'
          ? createGitHubPlugin({
              createClient: async () => ({
                listPullRequests: async (
                  ...args: Parameters<GitHubClient['listPullRequests']>
                ) => {
                  recordSignal(args);
                  return [
                    fakeGitHubPullRequest({ number: 7, title: 'Branch PR' }),
                  ];
                },
                getPullRequest: async (
                  ...args: Parameters<GitHubClient['getPullRequest']>
                ) => {
                  recordSignal(args);
                  return fakeGitHubPullRequest({
                    number: 7,
                    title: 'Branch PR',
                  });
                },
                getPullRequestFiles: async () => [],
                getIssueComments: async () => [],
                getReviewComments: async () => [],
              }),
            })
          : createAzureDevOpsPlugin({
              createClient: async () => ({
                config: {
                  orgUrl: 'https://dev.azure.com/acme',
                  pat: 'token',
                  authMethod: 'pat',
                },
                client: {
                  listPullRequests: async (
                    ...args: Parameters<AzureDevOpsClient['listPullRequests']>
                  ) => {
                    recordSignal(args);
                    return {
                      value: [
                        fakeAzureDevOpsPullRequest({
                          pullRequestId: 7,
                          title: 'Branch PR',
                          sourceRefName: 'refs/heads/feature',
                          targetRefName: 'refs/heads/main',
                        }),
                      ],
                    };
                  },
                  getPullRequest: async (
                    ...args: Parameters<AzureDevOpsClient['getPullRequest']>
                  ) => {
                    recordSignal(args);
                    return fakeAzureDevOpsPullRequest({
                      pullRequestId: 7,
                      title: 'Branch PR',
                      sourceRefName: 'refs/heads/feature',
                      targetRefName: 'refs/heads/main',
                    });
                  },
                  getPullRequestLabels: async (
                    ...args: Parameters<
                      AzureDevOpsClient['getPullRequestLabels']
                    >
                  ) => {
                    recordSignal(args);
                    return { value: [] };
                  },
                  getAllPullRequestChanges: async () => [],
                  getAllComments: async () => [],
                },
              }),
            });
      const result = await Effect.runPromise(
        findPullRequestForBranchForRemote(
          [
            {
              pluginId: plugin.id,
              capability: plugin.capabilities!.pullRequestProvider!,
            },
          ],
          providerId === 'github' ? githubRemote : azureRemote,
          { branch: 'feature' }
        )
      );

      expect(result.pullRequest.id).toBe(7);
      expect(signals).toHaveLength(providerId === 'github' ? 2 : 3);
      expect(signals.every((signal) => signal === signals[0])).toBe(true);
      expect(signals[0]?.aborted).toBe(false);
    }
  );
});

describe('host mutation timeout policy and genuine interruption', () => {
  const provider = fakeProvider('external-timeout', 'external-timeout', 100);
  const providers = [
    {
      ...provider,
      capability: {
        ...provider.capability,
        operations: {
          createPullRequest: () => Effect.never,
        },
      },
    },
  ];
  const request = {
    title: 'Timeout probe',
    sourceBranch: 'feature',
    targetBranch: 'main',
  } as const;

  test('mutation deadlines create fresh fixed indeterminate failures after finalizers', async () => {
    let finalizers = 0;
    const finalizedProviders = [
      {
        ...providers[0]!,
        capability: {
          ...providers[0]!.capability,
          operations: {
            createPullRequest: () =>
              Effect.never.pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    finalizers += 1;
                  })
                )
              ),
          },
        },
      },
    ];
    const run = () =>
      Effect.runPromise(
        createPullRequestForRemote(
          finalizedProviders,
          'external-timeout-remote',
          request,
          { operationTimeout: '5 millis' }
        ).pipe(Effect.flip)
      );

    const first = await run();
    const second = await run();
    expect(first).not.toBe(second);
    expectIndeterminateMutation(first, 'external-timeout', 'createPullRequest');
    expectIndeterminateMutation(
      second,
      'external-timeout',
      'createPullRequest'
    );
    expect(finalizers).toBe(2);
  });

  test('signal-blind external mutation settlement remains compatible with indeterminate timeout classification', async () => {
    let started = 0;
    let completed = 0;
    const signalBlindProviders = [
      {
        ...providers[0]!,
        capability: {
          ...providers[0]!.capability,
          operations: {
            createPullRequest: () =>
              Effect.tryPromise({
                try: () =>
                  new Promise<{
                    readonly repository: ReturnType<typeof externalRepository>;
                    readonly repositoryLabel: string;
                    readonly pullRequest: {
                      readonly id: number;
                      readonly title: string;
                      readonly status: 'active';
                      readonly author: { readonly displayName: string };
                      readonly createdAt: string;
                      readonly sourceBranch: string;
                      readonly targetBranch: string;
                    };
                  }>((resolve) => {
                    started += 1;
                    setTimeout(() => {
                      completed += 1;
                      resolve({
                        repository: externalRepository('external-timeout'),
                        repositoryLabel: 'external-timeout/repository',
                        pullRequest: {
                          id: 77,
                          title: 'Eventually created',
                          status: 'active',
                          author: { displayName: 'External provider' },
                          createdAt: '2026-01-01T00:00:00Z',
                          sourceBranch: 'feature',
                          targetBranch: 'main',
                        },
                      });
                    }, 40);
                  }),
                catch: (error) => error,
              }),
          },
        },
      },
    ];

    const error = await Effect.runPromise(
      createPullRequestForRemote(
        signalBlindProviders,
        'external-timeout-remote',
        request,
        { operationTimeout: '5 millis' }
      ).pipe(Effect.flip)
    );

    expectIndeterminateMutation(error, 'external-timeout', 'createPullRequest');
    expect({ started, completed }).toEqual({ started: 1, completed: 0 });
    await Bun.sleep(60);
    expect({ started, completed }).toEqual({ started: 1, completed: 1 });
  });

  test('caller cancellation remains an Interrupt Cause and joins finalizers', async () => {
    let started = 0;
    let finalized = 0;
    const interruptibleProviders = [
      {
        ...providers[0]!,
        capability: {
          ...providers[0]!.capability,
          operations: {
            createPullRequest: () =>
              Effect.sync(() => {
                started += 1;
              }).pipe(
                Effect.zipRight(Effect.never),
                Effect.ensuring(
                  Effect.sync(() => {
                    finalized += 1;
                  })
                )
              ),
          },
        },
      },
    ];
    const controller = new AbortController();
    const pending = Effect.runPromiseExit(
      createPullRequestForRemote(
        interruptibleProviders,
        'external-timeout-remote',
        request,
        { operationTimeout: '1 second' }
      ),
      { signal: controller.signal }
    );
    while (started === 0) await Bun.sleep(1);
    controller.abort();
    const exit = await pending;

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isSuccess(exit)) throw new Error('Expected interruption');
    expect(Cause.isInterruptedOnly(exit.cause)).toBe(true);
    expect(finalized).toBe(1);
  });
});
