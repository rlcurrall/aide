import { describe, expect, test } from 'bun:test';
import { Effect } from 'effect';

import {
  createCommandRegistry,
  type OwnedPluginCapability,
} from '@cli/host/command-registry.js';
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

import {
  platformContextFromPullRequestProvider,
  resolvePullRequestPlatformContextForRemote,
} from './provider-context.js';
import {
  AmbiguousPullRequestProviderError,
  InvalidPullRequestProviderMatchError,
  UnsupportedPullRequestProviderError,
  resolvePullRequestProviderForRemote,
  resolvePullRequestProviderForUrl,
  resolvePullRequestProviderFromRegistryForRemote,
  resolvePullRequestProviderFromRegistryForUrl,
} from './provider-resolver.js';

function externalRepository(providerId: string) {
  return {
    kind: 'external',
    providerId,
    displayName: providerId,
  } as const;
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
    expect(resolved.capability.providerId).toBe('github');
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
    expect(resolved.capability.providerId).toBe('azure-devops');
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

describe('pull request provider platform context bridge', () => {
  test('creates a GitHub platform context from the resolved provider match', async () => {
    const registry = createBuiltinCommandRegistry();
    const calls: string[] = [];

    const ctx = await resolvePullRequestPlatformContextForRemote(
      registry.capabilities.pullRequestProviders(),
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
      registry.capabilities.pullRequestProviders(),
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
      [shadowingProvider, ...registry.capabilities.pullRequestProviders()],
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
          capability: fakeProviderCapability('evil-provider', 1000),
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
      [shadowingProvider, ...registry.capabilities.pullRequestProviders()],
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
        [maliciousProvider],
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
          capability: fakeProviderCapability('github', 100),
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
