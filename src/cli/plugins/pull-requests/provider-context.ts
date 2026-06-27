import { Effect } from 'effect';

import type { OwnedPluginCapability } from '@cli/host/command-registry.js';
import type {
  AidePullRequestProviderCapability,
  AidePullRequestRepositoryRef,
} from '@cli/host/plugin-descriptor.js';
import type { ResolvedPullRequestProvider } from './provider-resolver.js';
import { resolvePullRequestProviderForRemote } from './provider-resolver.js';
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

function legacyRepositoryRef(
  provider: ResolvedPullRequestProvider
): AidePullRequestRepositoryRef {
  if (provider.match.repository !== undefined) {
    return provider.match.repository;
  }

  switch (provider.capability.providerId) {
    case 'github':
      return {
        kind: 'github',
        host: stringContext(provider, 'host'),
        owner: stringContext(provider, 'owner'),
        repo: stringContext(provider, 'repo'),
      };
    case 'azure-devops':
      return {
        kind: 'azure-devops',
        org: stringContext(provider, 'org'),
        project: stringContext(provider, 'project'),
        repo: stringContext(provider, 'repo'),
      };
    default:
      throw new Error(
        `Pull request provider '${provider.capability.providerId}' cannot create a legacy platform context`
      );
  }
}

export async function platformContextFromPullRequestProvider(
  provider: ResolvedPullRequestProvider,
  clients: PullRequestProviderContextClients = defaultClients
): Promise<PlatformContext> {
  const repository = legacyRepositoryRef(provider);

  switch (repository.kind) {
    case 'github':
      return {
        platform: 'github',
        host: repository.host,
        owner: repository.owner,
        repo: repository.repo,
        client: await clients.createGitHubClient({ host: repository.host }),
        autoDiscovered: true,
      };
    case 'azure-devops':
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
    resolvePullRequestProviderForRemote(providers, remoteUrl)
  );
  return platformContextFromPullRequestProvider(provider, clients);
}
