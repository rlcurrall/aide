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
import type { GitHubPullRequest } from '@lib/github-types.js';
import type { AzureDevOpsPullRequest } from '@lib/types.js';

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
  getPullRequestForRemote,
  getPullRequestForUrl,
  listPullRequestsForRemote,
  resolvePullRequestProviderForRemote,
  resolvePullRequestProviderForUrl,
  resolvePullRequestProviderFromRegistryForRemote,
  resolvePullRequestProviderFromRegistryForUrl,
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
