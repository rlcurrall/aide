import { describe, expect, test } from 'bun:test';
import { Effect } from 'effect';

import {
  createCommandRegistry,
  type OwnedPluginCapability,
} from '@cli/host/command-registry.js';
import {
  createAideHostServices,
  type AideHostServices,
} from '@cli/host/runtime-context.js';
import {
  defineAidePlugin,
  type AidePullRequestProviderCapability,
  type AidePullRequestRemoteMatch,
  type AidePullRequestUrlMatch,
} from '@cli/host/plugin-descriptor.js';
import { createAzureDevOpsPlugin } from '@cli/plugins/azure-devops/plugin.js';
import { createBuiltinCommandRegistry } from '@cli/plugins/builtin.js';
import { createGitHubPlugin } from '@cli/plugins/github/plugin.js';
import type { AzureDevOpsClient } from '@lib/azure-devops-client.js';
import type { GitHubClient } from '@lib/github-client.js';
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

import {
  platformContextFromPullRequestProvider,
  resolvePullRequestPlatformContextForRemote,
} from './provider-context.js';
import {
  AmbiguousPullRequestProviderError,
  InvalidPullRequestProviderMatchError,
  InvalidPullRequestProviderOperationResultError,
  PullRequestProviderOperationError,
  PullRequestProviderOperationTimeoutError,
  PullRequestProviderInvocationError,
  UnsupportedPullRequestProviderOperationError,
  UnsupportedPullRequestProviderError,
  addPullRequestCommentForRemote,
  addPullRequestCommentForRepository,
  addPullRequestCommentForUrl,
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
  resolvePullRequestProviderForUrl,
  resolvePullRequestProviderFromRegistryForRemote,
  resolvePullRequestProviderFromRegistryForUrl,
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
): OwnedPluginCapability<AidePullRequestProviderCapability> {
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
): AidePullRequestProviderCapability {
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
): OwnedPluginCapability<AidePullRequestProviderCapability> {
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
  providers: readonly OwnedPluginCapability<AidePullRequestProviderCapability>[]
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

describe('pull request provider resolution', () => {
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
    expect(error.reason).toBe('missing repository ref');
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
    expect(error.reason).toBe('match must be an object or null');
  });

  test('wraps throwing provider matchers as typed invocation errors', async () => {
    const providers: OwnedPluginCapability<AidePullRequestProviderCapability>[] =
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
    expect(error.message).toContain('boom');
  });

  test('wraps throwing provider match object getters as typed invalid matches', async () => {
    const providers = [
      malformedProvider('broken-plugin', 'broken-provider', 100, {
        remote: () =>
          new Proxy(
            {},
            {
              get: () => {
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
    expect(error.reason).toBe('match validation failed: getter boom');
  });

  test('snapshots validated provider matches before returning them', async () => {
    let repositoryReads = 0;
    const providers = [
      malformedProvider('shape-plugin', 'shape-provider', 100, {
        remote: () => ({
          source: 'git-remote',
          priority: 100,
          get repository() {
            repositoryReads += 1;
            return repositoryReads === 1
              ? externalRepository('shape-provider')
              : {
                  kind: 'github',
                  host: 'evil.example',
                  owner: 'acme',
                  repo: 'widgets',
                };
          },
        }),
      }),
    ];

    const resolved = await Effect.runPromise(
      resolvePullRequestProviderForRemote(providers, 'matched-remote')
    );

    expect(repositoryReads).toBe(1);
    expect(Object.isFrozen(resolved.match)).toBe(true);
    expect(Object.isFrozen(resolved.match.repository)).toBe(true);
    const repository = resolved.match.repository;
    expect(repository).toEqual(externalRepository('shape-provider'));
    expect(resolved.match.repository).toBe(repository);
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
    expect(error.reason).toBe(
      "expected source 'git-remote' but got 'pull-request-url'"
    );
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
    expect(error.reason).toBe('missing pull request ref');
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
    expect(error.reason).toBe(
      'git-remote match must not include pull request ref'
    );
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
    expect(error.reason).toBe('invalid repository ref');
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
            } as unknown as AidePullRequestProviderCapability,
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
      plugin.capabilities!.pullRequestProvider!.authStatus()
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
      plugin.capabilities!.pullRequestProvider!.authStatus()
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
      createClient: async ({ host }) => {
        calls.push(host);
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
      'github.com',
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
      createClient: async () => ({
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
      }),
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
    expect(error.message).toContain('sync boom');
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
    expect(error.reason).toBe('invalid pull request item');
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
    expect(error.message).toContain(
      "Azure DevOps remote org 'acme' does not match configured org 'other'"
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
      createClient: async ({ host }) => {
        calls.push(host);
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
      'github.com',
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
      createClient: async () => ({
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
      }),
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
      "Tag 'missing' not found on PR #42",
      "Failed to add tag 'blocked': label add denied",
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
      createClient: async ({ host }) => {
        calls.push(host);
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
      'github.com',
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
      createClient: async () => ({
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
        'git@ssh.dev.azure.com:v3/acme/Platform/widgets',
        { branch: 'feature/ado-detail' }
      )
    );

    expect(calls).toEqual([
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
    const calls: string[] = [];

    const ctx = await resolvePullRequestPlatformContextForRemote(
      createAideHostServices(registry),
      'git@github.com:acme/widgets.git',
      {
        createGitHubClient: async ({ host }) => {
          calls.push(`github:${host}`);
          return { kind: 'github-client' } as unknown as GitHubClient;
        },
        createAzureDevOpsClient: async () => {
          throw new Error('Azure DevOps client should not be created');
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

  test('creates an Azure DevOps platform context from the resolved provider match', async () => {
    const registry = createBuiltinCommandRegistry();
    const calls: string[] = [];

    const ctx = await resolvePullRequestPlatformContextForRemote(
      createAideHostServices(registry),
      'git@ssh.dev.azure.com:v3/acme/Platform/widgets',
      {
        createGitHubClient: async () => {
          throw new Error('GitHub client should not be created');
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
