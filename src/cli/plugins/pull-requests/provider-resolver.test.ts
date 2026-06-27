import { describe, expect, test } from 'bun:test';
import { Effect } from 'effect';

import type { OwnedPluginCapability } from '@cli/host/command-registry.js';
import type { AidePullRequestProviderCapability } from '@cli/host/plugin-descriptor.js';
import { createAzureDevOpsPlugin } from '@cli/plugins/azure-devops/plugin.js';
import { createBuiltinCommandRegistry } from '@cli/plugins/builtin.js';
import { createGitHubPlugin } from '@cli/plugins/github/plugin.js';
import type { AzureDevOpsClient } from '@lib/azure-devops-client.js';
import type { GitHubClient } from '@lib/github-client.js';

import { resolvePullRequestPlatformContextForRemote } from './provider-context.js';
import {
  AmbiguousPullRequestProviderError,
  UnsupportedPullRequestProviderError,
  resolvePullRequestProviderForRemote,
  resolvePullRequestProviderFromRegistryForRemote,
  resolvePullRequestProviderFromRegistryForUrl,
} from './provider-resolver.js';

function fakeProvider(
  pluginId: string,
  providerId: string,
  priority: number
): OwnedPluginCapability<AidePullRequestProviderCapability> {
  return {
    pluginId,
    capability: {
      providerId,
      priority,
      features: {},
      authStatus: () => Effect.succeed({ state: 'configured' }),
      matchRemote: () => ({ source: 'git-remote', priority }),
      matchPullRequestUrl: () => ({ source: 'pull-request-url', priority }),
    },
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
    expect(resolved.capability.providerId).toBe('github');
    expect(resolved.match.context).toEqual({
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
    expect(resolved.match.context).toEqual({
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
    expect(resolved.match.context).toEqual({
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
    expect(github.match.context?.number).toBe(42);
    expect(ado.pluginId).toBe('azure-devops');
    expect(ado.match.context?.number).toBe(42);
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
      registry,
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
      registry,
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
});
