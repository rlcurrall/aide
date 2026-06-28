import { Effect } from 'effect';

import type { OwnedPluginCapability } from '@cli/host/command-registry.js';
import type { AidePullRequestProviderCapability } from '@cli/host/plugin-descriptor.js';
import { corePullRequestProviderOwner } from '@cli/host/plugin-descriptor.js';
import type { ResolvedPullRequestProvider } from './provider-resolver.js';
import { resolvePullRequestProviderForRemote } from './provider-resolver.js';
import { AzureDevOpsClient } from '@lib/azure-devops-client.js';
import { loadAzureDevOpsConfig } from '@lib/config.js';
import { GitHubClient } from '@lib/github-client.js';
import { normalizeGitHubHost } from '@lib/github-utils.js';
import type { PlatformContext } from '@lib/platform.js';

export interface PullRequestProviderContextClients {
  readonly createGitHubClient: (options: {
    readonly host: string;
  }) => Promise<GitHubClient>;
  readonly createAzureDevOpsClient: () => Promise<AzureDevOpsClient>;
}

const defaultClients: PullRequestProviderContextClients = {
  createGitHubClient: ({ host }) => GitHubClient.create({ host }),
  createAzureDevOpsClient: async () => {
    const { config } = await loadAzureDevOpsConfig();
    return new AzureDevOpsClient(config);
  },
};

function assertTrustedCoreRef(
  provider: ResolvedPullRequestProvider,
  kind: 'github' | 'azure-devops'
): void {
  const expectedOwner = corePullRequestProviderOwner(kind);
  if (
    expectedOwner === undefined ||
    provider.pluginId !== expectedOwner ||
    provider.capability.providerId !== kind
  ) {
    throw new Error(
      `Pull request provider '${provider.capability.providerId}' from plugin '${provider.pluginId}' cannot provide '${kind}' repository refs to the legacy platform bridge`
    );
  }
}

function isTrustedCoreProvider(provider: ResolvedPullRequestProvider): boolean {
  const expectedOwner = corePullRequestProviderOwner(
    provider.capability.providerId
  );
  return expectedOwner !== undefined && provider.pluginId === expectedOwner;
}

export async function platformContextFromPullRequestProvider(
  provider: ResolvedPullRequestProvider,
  clients: PullRequestProviderContextClients = defaultClients
): Promise<PlatformContext> {
  const { repository } = provider.match;

  switch (repository.kind) {
    case 'github': {
      assertTrustedCoreRef(provider, 'github');
      const host = normalizeGitHubHost(repository.host);
      if (host === null) {
        throw new Error(
          `Pull request provider 'github' returned unsupported GitHub host '${repository.host}'`
        );
      }
      return {
        platform: 'github',
        host,
        owner: repository.owner,
        repo: repository.repo,
        client: await clients.createGitHubClient({ host }),
        autoDiscovered: true,
      };
    }
    case 'azure-devops':
      assertTrustedCoreRef(provider, 'azure-devops');
      return {
        platform: 'azure-devops',
        org: repository.org,
        project: repository.project,
        repo: repository.repo,
        client: await clients.createAzureDevOpsClient(),
        autoDiscovered: true,
      };
    default:
      throw new Error(
        `Pull request provider '${repository.providerId}' cannot create a legacy platform context`
      );
  }
}

export async function resolvePullRequestPlatformContextForRemote(
  providers: readonly OwnedPluginCapability<AidePullRequestProviderCapability>[],
  remoteUrl: string,
  clients: PullRequestProviderContextClients = defaultClients
): Promise<PlatformContext> {
  const provider = await Effect.runPromise(
    resolvePullRequestProviderForRemote(providers, remoteUrl, {
      preferred: isTrustedCoreProvider,
    })
  );
  return platformContextFromPullRequestProvider(provider, clients);
}
