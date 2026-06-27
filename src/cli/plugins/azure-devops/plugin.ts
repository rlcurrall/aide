import { Effect } from 'effect';

import {
  defineAidePlugin,
  type AidePluginAuthStatus,
} from '@cli/host/plugin-descriptor.js';
import { parseGitRemote, parsePRUrl } from '@lib/ado-utils.js';
import { probeAdoConfig, type ConfigStatus } from '@lib/config.js';
import type { AzureDevOpsConfig } from '@schemas/config.js';

type ProbeAdoConfig = () => Promise<ConfigStatus<AzureDevOpsConfig>>;

interface AzureDevOpsPluginOptions {
  readonly probeConfig?: ProbeAdoConfig;
}

function mapAzureDevOpsAuthStatus(
  status: ConfigStatus<AzureDevOpsConfig>
): AidePluginAuthStatus {
  switch (status.kind) {
    case 'env':
      return {
        state: 'configured',
        detail: `configured via environment (${status.value.authMethod})`,
      };
    case 'keyring':
      return {
        state: 'configured',
        detail: `configured via keyring (${status.value.authMethod})`,
      };
    case 'missing':
      return {
        state: 'not-configured',
        detail: "run 'aide login ado'",
      };
    case 'malformed':
      return { state: 'misconfigured', detail: status.reason };
    case 'unreachable':
      return {
        state: 'unavailable',
        detail:
          'system keyring is unreachable and Azure DevOps env vars are not set',
      };
  }
}

export function createAzureDevOpsPlugin(opts: AzureDevOpsPluginOptions = {}) {
  const probeConfig = opts.probeConfig ?? (() => probeAdoConfig());
  const authStatus = () =>
    Effect.tryPromise({
      try: () => probeConfig(),
      catch: (error) => error,
    }).pipe(Effect.map(mapAzureDevOpsAuthStatus));

  return defineAidePlugin({
    id: 'azure-devops',
    summary: 'Azure DevOps pull request provider',
    commands: [],
    capabilities: {
      auth: { status: authStatus },
      pullRequestProvider: {
        providerId: 'azure-devops',
        priority: 100,
        features: {
          draftPullRequests: true,
          threadedComments: true,
        },
        authStatus,
        matchRemote: (remoteUrl) => {
          const parsed = parseGitRemote(remoteUrl);
          if (parsed === null) return null;
          return {
            source: 'git-remote',
            priority: 100,
            detail: `${parsed.org}/${parsed.project}/${parsed.repo}`,
            repository: {
              kind: 'azure-devops',
              org: parsed.org,
              project: parsed.project,
              repo: parsed.repo,
            },
            context: {
              org: parsed.org,
              project: parsed.project,
              repo: parsed.repo,
            },
          };
        },
        matchPullRequestUrl: (url) => {
          const parsed = parsePRUrl(url);
          if (parsed === null) return null;
          return {
            source: 'pull-request-url',
            priority: 100,
            detail: `${parsed.org}/${parsed.project}/${parsed.repo}#${parsed.prId}`,
            repository: {
              kind: 'azure-devops',
              org: parsed.org,
              project: parsed.project,
              repo: parsed.repo,
            },
            pullRequest: {
              number: parsed.prId,
            },
            context: {
              org: parsed.org,
              project: parsed.project,
              repo: parsed.repo,
              number: parsed.prId,
            },
          };
        },
      },
    },
  });
}

export const azureDevOpsPlugin = createAzureDevOpsPlugin();
