import { Effect } from 'effect';

import {
  defineAidePlugin,
  type AidePullRequestBranchLookupRequest,
  type AidePullRequestBranchLookupResult,
  type AidePullRequestListRequest,
  type AidePullRequestListResult,
  type AidePullRequestViewRequest,
  type AidePullRequestViewResult,
  type AidePluginAuthStatus,
} from '@cli/host/plugin-descriptor.js';
import { AzureDevOpsClient } from '@lib/azure-devops-client.js';
import { parseGitRemote, parsePRUrl } from '@lib/ado-utils.js';
import {
  loadAzureDevOpsConfig,
  probeAdoConfig,
  type ConfigStatus,
} from '@lib/config.js';
import { extractBranchName } from '@lib/git-utils.js';
import type { AzureDevOpsPullRequest } from '@lib/types.js';
import type { AzureDevOpsConfig } from '@schemas/config.js';

type ProbeAdoConfig = () => Promise<ConfigStatus<AzureDevOpsConfig>>;
type AzureDevOpsPullRequestClient = Pick<
  AzureDevOpsClient,
  'listPullRequests' | 'getPullRequest' | 'getPullRequestLabels'
>;
type CreateAzureDevOpsClient = () => Promise<{
  readonly client: AzureDevOpsPullRequestClient;
  readonly config: AzureDevOpsConfig;
}>;

interface AzureDevOpsPluginOptions {
  readonly probeConfig?: ProbeAdoConfig;
  readonly createClient?: CreateAzureDevOpsClient;
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
  const createClient =
    opts.createClient ??
    (async () => {
      const { config } = await loadAzureDevOpsConfig();
      return { client: new AzureDevOpsClient(config), config };
    });
  const authStatus = () =>
    Effect.tryPromise({
      try: () => probeConfig(),
      catch: (error) => error,
    }).pipe(Effect.map(mapAzureDevOpsAuthStatus));

  const listPullRequests = (
    request: AidePullRequestListRequest
  ): Effect.Effect<AidePullRequestListResult, unknown, never> =>
    Effect.tryPromise({
      try: async () => {
        const repository = request.match.repository;
        if (repository.kind !== 'azure-devops') {
          throw new Error(
            `Azure DevOps provider cannot list pull requests for '${repository.kind}' repository refs`
          );
        }

        const { client, config } = await createClient();
        const configuredOrg = azureDevOpsOrgFromUrl(config.orgUrl);
        if (configuredOrg !== null && configuredOrg !== repository.org) {
          throw new Error(
            `Azure DevOps remote org '${repository.org}' does not match configured org '${configuredOrg}'`
          );
        }

        const response = await client.listPullRequests(
          repository.project,
          repository.repo,
          {
            status: request.status,
            top: request.limit,
          }
        );

        let prs = response.value;
        if (request.createdBy) {
          const searchTerm = request.createdBy.toLowerCase();
          prs = prs.filter((pr) => {
            const displayName = pr.createdBy.displayName.toLowerCase();
            const uniqueName = pr.createdBy.uniqueName?.toLowerCase() || '';
            return (
              displayName.includes(searchTerm) ||
              uniqueName.includes(searchTerm)
            );
          });
        }

        return {
          repository,
          repositoryLabel: `${repository.org}/${repository.project}/${repository.repo}`,
          pullRequests: prs.map(azureDevOpsPullRequestToListItem),
        };
      },
      catch: (error) => error,
    });

  const getPullRequest = (
    request: AidePullRequestViewRequest
  ): Effect.Effect<AidePullRequestViewResult, unknown, never> =>
    Effect.tryPromise({
      try: async () => {
        const repository = request.match.repository;
        if (repository.kind !== 'azure-devops') {
          throw new Error(
            `Azure DevOps provider cannot get pull requests for '${repository.kind}' repository refs`
          );
        }

        const { client, config } = await createClient();
        const configuredOrg = azureDevOpsOrgFromUrl(config.orgUrl);
        if (configuredOrg !== null && configuredOrg !== repository.org) {
          throw new Error(
            `Azure DevOps remote org '${repository.org}' does not match configured org '${configuredOrg}'`
          );
        }

        const [pr, labelsResponse] = await Promise.all([
          client.getPullRequest(
            repository.project,
            repository.repo,
            request.pullRequest.number
          ),
          client.getPullRequestLabels(
            repository.project,
            repository.repo,
            request.pullRequest.number
          ),
        ]);

        return {
          repository,
          repositoryLabel: `${repository.org}/${repository.project}/${repository.repo}`,
          pullRequest: azureDevOpsPullRequestToViewItem(
            pr,
            labelsResponse.value
              .filter((label) => label.active)
              .map((label) => label.name)
          ),
        };
      },
      catch: (error) => error,
    });

  const findPullRequestForBranch = (
    request: AidePullRequestBranchLookupRequest
  ): Effect.Effect<AidePullRequestBranchLookupResult, unknown, never> =>
    Effect.tryPromise({
      try: async () => {
        const repository = request.match.repository;
        if (repository.kind !== 'azure-devops') {
          throw new Error(
            `Azure DevOps provider cannot find pull requests for '${repository.kind}' repository refs`
          );
        }

        const { client, config } = await createClient();
        const configuredOrg = azureDevOpsOrgFromUrl(config.orgUrl);
        if (configuredOrg !== null && configuredOrg !== repository.org) {
          throw new Error(
            `Azure DevOps remote org '${repository.org}' does not match configured org '${configuredOrg}'`
          );
        }

        const response = await client.listPullRequests(
          repository.project,
          repository.repo,
          {
            sourceRefName: `refs/heads/${request.branch}`,
            status: 'all',
          }
        );
        const selected = selectAzureDevOpsPullRequestForBranch(response.value);
        if (selected === undefined) {
          throw new Error(
            `No pull request found for branch '${request.branch}'.\n\nTo create a PR, push your branch and create one in Azure DevOps, or specify a PR ID directly:\n  aide ado comments <pr-id>`
          );
        }

        const [pr, labelsResponse] = await Promise.all([
          client.getPullRequest(
            repository.project,
            repository.repo,
            selected.pullRequestId
          ),
          client.getPullRequestLabels(
            repository.project,
            repository.repo,
            selected.pullRequestId
          ),
        ]);

        return {
          branch: request.branch,
          repository,
          repositoryLabel: `${repository.org}/${repository.project}/${repository.repo}`,
          pullRequest: azureDevOpsPullRequestToViewItem(
            pr,
            labelsResponse.value
              .filter((label) => label.active)
              .map((label) => label.name)
          ),
        };
      },
      catch: (error) => error,
    });

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
          };
        },
        operations: {
          listPullRequests,
          getPullRequest,
          findPullRequestForBranch,
        },
      },
    },
  });
}

export const azureDevOpsPlugin = createAzureDevOpsPlugin();

function azureDevOpsOrgFromUrl(orgUrl: string): string | null {
  try {
    const url = new URL(orgUrl);
    if (url.hostname === 'dev.azure.com') {
      return url.pathname.split('/').filter(Boolean)[0] ?? null;
    }
    if (url.hostname.endsWith('.visualstudio.com')) {
      return url.hostname.replace(/\.visualstudio\.com$/, '');
    }
    return null;
  } catch {
    return null;
  }
}

function azureDevOpsPullRequestToListItem(pr: AzureDevOpsPullRequest) {
  return {
    id: pr.pullRequestId,
    title: pr.title,
    status: pr.isDraft ? 'draft' : pr.status,
    createdAt: pr.creationDate,
    author: {
      displayName: pr.createdBy.displayName,
      ...(pr.createdBy.uniqueName === undefined
        ? {}
        : { email: pr.createdBy.uniqueName }),
    },
    ...(pr.description === undefined ? {} : { description: pr.description }),
    draft: pr.isDraft ?? false,
  } as const;
}

function selectAzureDevOpsPullRequestForBranch(
  prs: readonly AzureDevOpsPullRequest[]
): AzureDevOpsPullRequest | undefined {
  if (prs.length === 1) {
    return prs[0];
  }

  const activePRs = prs.filter((pr) => pr.status === 'active');
  if (activePRs.length === 1) {
    return activePRs[0];
  }

  const candidates = activePRs.length > 0 ? activePRs : prs;
  return [...candidates].sort(
    (a, b) =>
      new Date(b.creationDate).getTime() - new Date(a.creationDate).getTime()
  )[0];
}

function azureDevOpsPullRequestToViewItem(
  pr: AzureDevOpsPullRequest,
  labels: readonly string[]
) {
  return {
    ...azureDevOpsPullRequestToListItem(pr),
    ...(pr.sourceRefName === undefined
      ? {}
      : { sourceBranch: extractBranchName(pr.sourceRefName) }),
    ...(pr.targetRefName === undefined
      ? {}
      : { targetBranch: extractBranchName(pr.targetRefName) }),
    labels,
  } as const;
}
