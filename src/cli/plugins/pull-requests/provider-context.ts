import { Effect } from 'effect';

import type { CommandRegistry } from '@cli/host/command-registry.js';
import type { ResolvedPullRequestProvider } from './provider-resolver.js';
import { resolvePullRequestProviderFromRegistryForRemote } from './provider-resolver.js';
import { AzureDevOpsClient } from '@lib/azure-devops-client.js';
import { loadAzureDevOpsConfig } from '@lib/config.js';
import { GitHubClient } from '@lib/github-client.js';
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

function stringContext(
  provider: ResolvedPullRequestProvider,
  key: string
): string {
  const value = provider.match.context?.[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(
      `Pull request provider '${provider.capability.providerId}' did not provide required context '${key}'`
    );
  }
  return value;
}

export async function platformContextFromPullRequestProvider(
  provider: ResolvedPullRequestProvider,
  clients: PullRequestProviderContextClients = defaultClients
): Promise<PlatformContext> {
  switch (provider.capability.providerId) {
    case 'github': {
      const host = stringContext(provider, 'host');
      const owner = stringContext(provider, 'owner');
      const repo = stringContext(provider, 'repo');
      return {
        platform: 'github',
        host,
        owner,
        repo,
        client: await clients.createGitHubClient({ host }),
        autoDiscovered: true,
      };
    }
    case 'azure-devops': {
      const org = stringContext(provider, 'org');
      const project = stringContext(provider, 'project');
      const repo = stringContext(provider, 'repo');
      return {
        platform: 'azure-devops',
        org,
        project,
        repo,
        client: await clients.createAzureDevOpsClient(),
        autoDiscovered: true,
      };
    }
    default:
      throw new Error(
        `Pull request provider '${provider.capability.providerId}' cannot create a legacy platform context`
      );
  }
}

export async function resolvePullRequestPlatformContextForRemote(
  registry: CommandRegistry,
  remoteUrl: string,
  clients: PullRequestProviderContextClients = defaultClients
): Promise<PlatformContext> {
  const provider = await Effect.runPromise(
    resolvePullRequestProviderFromRegistryForRemote(registry, remoteUrl)
  );
  return platformContextFromPullRequestProvider(provider, clients);
}
