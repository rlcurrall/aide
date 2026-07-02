import { Effect } from 'effect';
import * as v from 'valibot';

import {
  defineAidePlugin,
  type AideAuthInputField,
  type AideAuthLoginRequest,
  type AidePullRequestAddCommentRequest,
  type AidePullRequestBranchLookupRequest,
  type AidePullRequestBranchLookupResult,
  type AidePullRequestComment,
  type AidePullRequestCommentKind,
  type AidePullRequestCommentMutationResult,
  type AidePullRequestCommentThread,
  type AidePullRequestCommentsRequest,
  type AidePullRequestCommentsResult,
  type AidePullRequestDiffFileStatus,
  type AidePullRequestDiffRequest,
  type AidePullRequestDiffResult,
  type AidePullRequestListRequest,
  type AidePullRequestListResult,
  type AidePullRequestRepositoryRef,
  type AidePullRequestReplyCommentRequest,
  type AidePullRequestUpdateRequest,
  type AidePullRequestUpdateResult,
  type AidePullRequestViewRequest,
  type AidePullRequestViewResult,
  type AidePluginAuthStatus,
} from '@cli/host/plugin-descriptor.js';
import { AzureDevOpsClient } from '@lib/azure-devops-client.js';
import { buildPrUrl, parseGitRemote, parsePRUrl } from '@lib/ado-utils.js';
import {
  loadAzureDevOpsConfig,
  probeAdoConfig,
  readAdoEnvForMigration,
  type ConfigStatus,
} from '@lib/config.js';
import { ensureRefPrefix, extractBranchName } from '@lib/git-utils.js';
import { deleteSecret, setSecret } from '@lib/secrets.js';
import type {
  AzureDevOpsChangeType,
  AzureDevOpsCreateCommentResponse,
  AzureDevOpsPRChange,
  AzureDevOpsPRComment,
  AzureDevOpsPullRequest,
  AdoFlattenedComment,
  CreateThreadResponse,
  PullRequestUpdateOptions,
} from '@lib/types.js';
import {
  StoredAdoSchema,
  type AuthMethod,
  type AzureDevOpsConfig,
} from '@schemas/config.js';
import {
  authInputString,
  formatMigrationError,
  formatUnsetHint,
  messages,
  promptAuthField,
  validateUrl,
} from '../auth-operation-utils.js';

type ProbeAdoConfig = () => Promise<ConfigStatus<AzureDevOpsConfig>>;
type AzureDevOpsPullRequestClient = Pick<
  AzureDevOpsClient,
  | 'listPullRequests'
  | 'getPullRequest'
  | 'getPullRequestLabels'
  | 'getAllPullRequestChanges'
  | 'getAllComments'
> &
  Partial<
    Pick<
      AzureDevOpsClient,
      | 'createPullRequestThread'
      | 'createThreadComment'
      | 'updatePullRequest'
      | 'addPullRequestLabel'
      | 'removePullRequestLabel'
    >
  >;
type CreateAzureDevOpsClient = () => Promise<{
  readonly client: AzureDevOpsPullRequestClient;
  readonly config: AzureDevOpsConfig;
}>;

interface AzureDevOpsPluginOptions {
  readonly probeConfig?: ProbeAdoConfig;
  readonly createClient?: CreateAzureDevOpsClient;
}

const azureDevOpsOrgUrlField = {
  kind: 'text',
  key: 'orgUrl',
  label: 'Azure DevOps org URL',
  description: 'ADO org URL',
  required: true,
  validate: validateUrl,
} as const satisfies AideAuthInputField;

const azureDevOpsPatField = {
  kind: 'secret',
  key: 'pat',
  label: 'PAT',
  description: 'ADO PAT',
  required: true,
  stdin: true,
} as const satisfies AideAuthInputField;

const azureDevOpsAuthMethodField = {
  kind: 'select',
  key: 'authMethod',
  label: 'Auth method',
  description: 'Auth method',
  choices: [
    { value: 'pat', label: 'PAT' },
    { value: 'bearer', label: 'Bearer' },
  ],
  default: 'pat',
} as const satisfies AideAuthInputField;

const azureDevOpsLoginFields = Object.freeze([
  azureDevOpsOrgUrlField,
  azureDevOpsPatField,
  azureDevOpsAuthMethodField,
] as const);

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

function loginAzureDevOpsAuth(request: AideAuthLoginRequest) {
  return Effect.gen(function* () {
    if (request.fromEnv) {
      const result = readAdoEnvForMigration();
      if (result.kind !== 'ok') {
        return yield* Effect.fail(
          new Error(formatMigrationError('Azure DevOps', result))
        );
      }

      yield* Effect.tryPromise({
        try: () => setSecret('ado', JSON.stringify(result.value)),
        catch: (error) => error,
      });
      return {
        status: 'stored' as const,
        messages: messages(
          'Migrated Azure DevOps credentials from env to keyring.',
          formatUnsetHint(result.varsUsed)
        ),
      };
    }

    const orgUrl = yield* promptAuthField(request, azureDevOpsOrgUrlField);
    const pat = yield* promptAuthField(request, azureDevOpsPatField);
    const authMethod = (authInputString(request, 'authMethod') ??
      'pat') as AuthMethod;

    const validated = yield* Effect.try({
      try: () =>
        v.parse(StoredAdoSchema, {
          orgUrl,
          pat,
          authMethod,
        }),
      catch: (error) => error,
    });
    yield* Effect.tryPromise({
      try: () => setSecret('ado', JSON.stringify(validated)),
      catch: (error) => error,
    });

    return {
      status: 'stored' as const,
      messages: ['Saved credentials for ado.'],
    };
  });
}

function logoutAzureDevOpsAuth() {
  return Effect.tryPromise({
    try: () => deleteSecret('ado'),
    catch: (error) => error,
  }).pipe(
    Effect.map((removed) => ({
      status: removed ? ('removed' as const) : ('not-found' as const),
      messages: [
        removed
          ? 'Removed stored credentials for ado.'
          : 'No stored credentials for ado.',
      ],
    }))
  );
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

  const updatePullRequest = (
    request: AidePullRequestUpdateRequest
  ): Effect.Effect<AidePullRequestUpdateResult, unknown, never> =>
    Effect.tryPromise({
      try: async () => {
        const repository = request.match.repository;
        if (repository.kind !== 'azure-devops') {
          throw new Error(
            `Azure DevOps provider cannot update pull requests for '${repository.kind}' repository refs`
          );
        }

        const { client, config } = await createClient();
        const configuredOrg = azureDevOpsOrgFromUrl(config.orgUrl);
        if (configuredOrg !== null && configuredOrg !== repository.org) {
          throw new Error(
            `Azure DevOps remote org '${repository.org}' does not match configured org '${configuredOrg}'`
          );
        }

        const warnings: string[] = [];
        const updates: PullRequestUpdateOptions = {};
        if (request.title !== undefined) {
          updates.title = request.title;
        }
        if (request.description !== undefined) {
          updates.description = request.description;
        }
        if (request.targetBranch !== undefined) {
          updates.targetRefName = ensureRefPrefix(request.targetBranch);
        }
        if (request.draft !== undefined) {
          updates.isDraft = request.draft;
        }
        if (request.status !== undefined) {
          updates.status = request.status;
        }

        let pr: AzureDevOpsPullRequest;
        if (Object.keys(updates).length > 0) {
          if (client.updatePullRequest === undefined) {
            throw new Error(
              'Azure DevOps client does not support updating pull requests'
            );
          }
          pr = await client.updatePullRequest(
            repository.project,
            repository.repo,
            request.pullRequest.number,
            updates
          );
        } else {
          pr = await client.getPullRequest(
            repository.project,
            repository.repo,
            request.pullRequest.number
          );
        }

        const labelsToRemove = request.labelsToRemove ?? [];
        if (labelsToRemove.length > 0) {
          const labelsResponse = await client.getPullRequestLabels(
            repository.project,
            repository.repo,
            request.pullRequest.number
          );
          for (const labelName of labelsToRemove) {
            const label = labelsResponse.value.find(
              (entry) => entry.name.toLowerCase() === labelName.toLowerCase()
            );
            if (label === undefined) {
              warnings.push(
                `Tag '${labelName}' not found on PR #${request.pullRequest.number}`
              );
              continue;
            }
            if (client.removePullRequestLabel === undefined) {
              warnings.push(
                `Failed to remove tag '${labelName}': Azure DevOps client does not support labels`
              );
              continue;
            }
            try {
              await client.removePullRequestLabel(
                repository.project,
                repository.repo,
                request.pullRequest.number,
                label.id
              );
            } catch (error) {
              warnings.push(
                `Failed to remove tag '${labelName}': ${errorMessage(error)}`
              );
            }
          }
        }

        for (const labelName of request.labelsToAdd ?? []) {
          if (client.addPullRequestLabel === undefined) {
            warnings.push(
              `Failed to add tag '${labelName}': Azure DevOps client does not support labels`
            );
            continue;
          }
          try {
            await client.addPullRequestLabel(
              repository.project,
              repository.repo,
              request.pullRequest.number,
              labelName
            );
          } catch (error) {
            warnings.push(
              `Failed to add tag '${labelName}': ${errorMessage(error)}`
            );
          }
        }

        const labelsResponse = await client.getPullRequestLabels(
          repository.project,
          repository.repo,
          request.pullRequest.number
        );
        const url = buildPrUrl(
          {
            org: repository.org,
            project: repository.project,
            repo: repository.repo,
          },
          request.pullRequest.number,
          config.orgUrl
        );

        return {
          repository,
          repositoryLabel: `${repository.org}/${repository.project}/${repository.repo}`,
          pullRequest: azureDevOpsPullRequestToViewItem(
            pr,
            labelsResponse.value
              .filter((label) => label.active)
              .map((label) => label.name),
            url
          ),
          ...(warnings.length === 0 ? {} : { warnings }),
        };
      },
      catch: (error) => error,
    });

  const getPullRequestDiff = (
    request: AidePullRequestDiffRequest
  ): Effect.Effect<AidePullRequestDiffResult, unknown, never> =>
    Effect.tryPromise({
      try: async () => {
        const repository = request.match.repository;
        if (repository.kind !== 'azure-devops') {
          throw new Error(
            `Azure DevOps provider cannot get pull request diffs for '${repository.kind}' repository refs`
          );
        }

        const { client, config } = await createClient();
        const configuredOrg = azureDevOpsOrgFromUrl(config.orgUrl);
        if (configuredOrg !== null && configuredOrg !== repository.org) {
          throw new Error(
            `Azure DevOps remote org '${repository.org}' does not match configured org '${configuredOrg}'`
          );
        }

        const [pr, labelsResponse, changes] = await Promise.all([
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
          client.getAllPullRequestChanges(
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
          files: changes.map(azureDevOpsPullRequestChangeToDiffFile),
        };
      },
      catch: (error) => error,
    });

  const listPullRequestComments = (
    request: AidePullRequestCommentsRequest
  ): Effect.Effect<AidePullRequestCommentsResult, unknown, never> =>
    Effect.tryPromise({
      try: async () => {
        const repository = request.match.repository;
        if (repository.kind !== 'azure-devops') {
          throw new Error(
            `Azure DevOps provider cannot list pull request comments for '${repository.kind}' repository refs`
          );
        }

        const { client, config } = await createClient();
        const configuredOrg = azureDevOpsOrgFromUrl(config.orgUrl);
        if (configuredOrg !== null && configuredOrg !== repository.org) {
          throw new Error(
            `Azure DevOps remote org '${repository.org}' does not match configured org '${configuredOrg}'`
          );
        }

        const comments = await client.getAllComments(
          repository.project,
          repository.repo,
          request.pullRequest.number
        );

        return {
          repository,
          repositoryLabel: `${repository.org}/${repository.project}/${repository.repo}`,
          pullRequest: { number: request.pullRequest.number },
          threads: azureDevOpsCommentsToThreads(comments),
        };
      },
      catch: (error) => error,
    });

  const addPullRequestComment = (
    request: AidePullRequestAddCommentRequest
  ): Effect.Effect<AidePullRequestCommentMutationResult, unknown, never> =>
    Effect.tryPromise({
      try: async () => {
        const repository = request.match.repository;
        if (repository.kind !== 'azure-devops') {
          throw new Error(
            `Azure DevOps provider cannot add pull request comments for '${repository.kind}' repository refs`
          );
        }

        const { client, config } = await createClient();
        const configuredOrg = azureDevOpsOrgFromUrl(config.orgUrl);
        if (configuredOrg !== null && configuredOrg !== repository.org) {
          throw new Error(
            `Azure DevOps remote org '${repository.org}' does not match configured org '${configuredOrg}'`
          );
        }
        if (client.createPullRequestThread === undefined) {
          throw new Error(
            'Azure DevOps client does not support creating pull request threads'
          );
        }

        const thread = await client.createPullRequestThread(
          repository.project,
          repository.repo,
          request.pullRequest.number,
          request.body,
          request.position === undefined
            ? undefined
            : {
                filePath: request.position.filePath,
                line: request.position.lineNumber,
                endLine: request.position.endLineNumber,
              }
        );

        return azureDevOpsThreadMutationResult(
          repository,
          request.pullRequest.number,
          thread
        );
      },
      catch: (error) => error,
    });

  const replyToPullRequestComment = (
    request: AidePullRequestReplyCommentRequest
  ): Effect.Effect<AidePullRequestCommentMutationResult, unknown, never> =>
    Effect.tryPromise({
      try: async () => {
        const repository = request.match.repository;
        if (repository.kind !== 'azure-devops') {
          throw new Error(
            `Azure DevOps provider cannot reply to pull request comments for '${repository.kind}' repository refs`
          );
        }

        const { client, config } = await createClient();
        const configuredOrg = azureDevOpsOrgFromUrl(config.orgUrl);
        if (configuredOrg !== null && configuredOrg !== repository.org) {
          throw new Error(
            `Azure DevOps remote org '${repository.org}' does not match configured org '${configuredOrg}'`
          );
        }
        if (client.createThreadComment === undefined) {
          throw new Error(
            'Azure DevOps client does not support creating thread comments'
          );
        }

        const response = await client.createThreadComment(
          repository.project,
          repository.repo,
          request.pullRequest.number,
          request.threadId,
          request.body,
          request.parentCommentId
        );
        const comment = azureDevOpsCreatedReplyToComment(response);

        return {
          repository,
          repositoryLabel: `${repository.org}/${repository.project}/${repository.repo}`,
          pullRequest: { number: request.pullRequest.number },
          comment,
          thread: Object.freeze({
            id: request.threadId,
            replies: Object.freeze([comment]),
          }),
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
      authProvider: {
        providerId: 'azure-devops',
        label: 'Azure DevOps',
        login: {
          command: {
            name: 'ado',
          },
          summary: 'Save Azure DevOps credentials',
          fields: azureDevOpsLoginFields,
          envMigration: {
            description:
              'Migrate AZURE_DEVOPS_ORG_URL / AZURE_DEVOPS_PAT into the keyring',
            variables: [
              'AZURE_DEVOPS_ORG_URL',
              'AZURE_DEVOPS_PAT',
              'AZURE_DEVOPS_AUTH_METHOD',
            ],
          },
        },
        logout: {
          command: {
            name: 'ado',
          },
          summary: 'Remove Azure DevOps credentials',
        },
        status: authStatus,
        operations: {
          login: loginAzureDevOpsAuth,
          logout: logoutAzureDevOpsAuth,
        },
      },
      primeContribution: {
        status: [
          {
            groupId: 'pull-requests',
            groupLabel: 'Pull Requests',
            label: 'Azure DevOps',
            messages: {
              misconfigured:
                'run `aide login github` or `aide login ado` to reconfigure',
              notConfigured:
                'run `gh auth login`, `aide login github`, or `aide login ado`',
            },
            status: authStatus,
          },
        ],
      },
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
          updatePullRequest,
          getPullRequestDiff,
          listPullRequestComments,
          addPullRequestComment,
          replyToPullRequestComment,
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
  labels: readonly string[],
  url?: string
) {
  return {
    ...azureDevOpsPullRequestToListItem(pr),
    ...(pr.sourceRefName === undefined
      ? {}
      : { sourceBranch: extractBranchName(pr.sourceRefName) }),
    ...(pr.targetRefName === undefined
      ? {}
      : { targetBranch: extractBranchName(pr.targetRefName) }),
    ...(url === undefined ? {} : { url }),
    labels,
  } as const;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function azureDevOpsPullRequestChangeToDiffFile(entry: AzureDevOpsPRChange) {
  const previousPath = entry.originalPath ?? entry.sourceServerItem;
  return {
    path: entry.item?.path ?? entry.sourceServerItem ?? 'unknown',
    status: azureDevOpsDiffFileStatus(entry.changeType),
    providerStatus: entry.changeType,
    ...(previousPath === undefined ? {} : { previousPath }),
  } as const;
}

function azureDevOpsCommentKind(
  comment: AdoFlattenedComment
): AidePullRequestCommentKind {
  if (comment.comment.commentType === 'system') {
    return 'system';
  }
  if (comment.comment.parentCommentId > 0) {
    return 'reply';
  }
  return comment.filePath === undefined ? 'issue' : 'review';
}

function azureDevOpsCommentToComment(
  comment: AdoFlattenedComment
): AidePullRequestComment {
  return {
    id: comment.comment.id,
    kind: azureDevOpsCommentKind(comment),
    author: {
      displayName: comment.comment.author.displayName,
      ...(comment.comment.author.uniqueName === undefined
        ? {}
        : { email: comment.comment.author.uniqueName }),
    },
    body: comment.comment.content ?? '[deleted comment]',
    createdAt: comment.comment.publishedDate,
    updatedAt: comment.comment.lastUpdatedDate,
    ...(comment.filePath === undefined ? {} : { filePath: comment.filePath }),
    ...(comment.lineNumber === undefined
      ? {}
      : { lineNumber: comment.lineNumber }),
    ...(comment.comment.parentCommentId <= 0
      ? {}
      : { parentId: comment.comment.parentCommentId }),
    providerType: comment.comment.commentType,
  };
}

function azureDevOpsCreatedThreadCommentToComment(
  comment: AzureDevOpsPRComment,
  thread: CreateThreadResponse
): AidePullRequestComment {
  const filePath = thread.threadContext?.filePath;
  const lineNumber = thread.threadContext?.rightFileStart?.line;
  return {
    id: comment.id,
    kind: filePath === undefined ? 'issue' : 'review',
    author: {
      displayName: comment.author.displayName,
      ...(comment.author.uniqueName === undefined
        ? {}
        : { email: comment.author.uniqueName }),
    },
    body: comment.content ?? '[deleted comment]',
    createdAt: comment.publishedDate,
    updatedAt: comment.lastUpdatedDate,
    ...(filePath === undefined ? {} : { filePath }),
    ...(lineNumber === undefined ? {} : { lineNumber }),
    providerType: comment.commentType,
  };
}

function azureDevOpsCreatedReplyToComment(
  comment: AzureDevOpsCreateCommentResponse
): AidePullRequestComment {
  return {
    id: comment.id,
    kind: 'reply',
    author: {
      displayName: comment.author.displayName,
      ...(comment.author.uniqueName === undefined
        ? {}
        : { email: comment.author.uniqueName }),
    },
    body: comment.content,
    createdAt: comment.publishedDate,
    updatedAt: comment.lastUpdatedDate,
    ...(comment.parentCommentId <= 0
      ? {}
      : { parentId: comment.parentCommentId }),
    providerType: comment.commentType,
  };
}

function azureDevOpsThreadMutationResult(
  repository: Extract<AidePullRequestRepositoryRef, { kind: 'azure-devops' }>,
  pullRequestNumber: number,
  thread: CreateThreadResponse
): AidePullRequestCommentMutationResult {
  const rootComment = thread.comments[0];
  if (rootComment === undefined) {
    throw new Error('Azure DevOps created thread did not include a comment');
  }

  const comment = azureDevOpsCreatedThreadCommentToComment(rootComment, thread);
  const filePath = thread.threadContext?.filePath;
  const lineNumber = thread.threadContext?.rightFileStart?.line;

  return {
    repository,
    repositoryLabel: `${repository.org}/${repository.project}/${repository.repo}`,
    pullRequest: { number: pullRequestNumber },
    comment,
    thread: Object.freeze({
      id: thread.id,
      status: thread.status,
      ...(filePath === undefined ? {} : { filePath }),
      ...(lineNumber === undefined ? {} : { lineNumber }),
      rootComment: comment,
      replies: Object.freeze([]),
    }),
  };
}

function azureDevOpsCommentsToThreads(
  comments: readonly AdoFlattenedComment[]
): readonly AidePullRequestCommentThread[] {
  const threads = new Map<
    number,
    {
      readonly id: number;
      readonly status: string;
      readonly filePath?: string;
      readonly lineNumber?: number;
      rootComment?: AidePullRequestComment;
      replies: AidePullRequestComment[];
    }
  >();

  for (const comment of comments) {
    let thread = threads.get(comment.threadId);
    if (thread === undefined) {
      thread = {
        id: comment.threadId,
        status: comment.threadStatus,
        ...(comment.filePath === undefined
          ? {}
          : { filePath: comment.filePath }),
        ...(comment.lineNumber === undefined
          ? {}
          : { lineNumber: comment.lineNumber }),
        replies: [],
      };
      threads.set(comment.threadId, thread);
    }

    const normalized = azureDevOpsCommentToComment(comment);
    if (comment.comment.parentCommentId === 0) {
      if (
        thread.rootComment === undefined ||
        normalized.id < thread.rootComment.id
      ) {
        if (thread.rootComment !== undefined) {
          thread.replies.push(thread.rootComment);
        }
        thread.rootComment = normalized;
      } else {
        thread.replies.push(normalized);
      }
    } else {
      thread.replies.push(normalized);
    }
  }

  return Object.freeze(
    [...threads.values()]
      .map((thread) =>
        Object.freeze({
          id: thread.id,
          status: thread.status,
          ...(thread.filePath === undefined
            ? {}
            : { filePath: thread.filePath }),
          ...(thread.lineNumber === undefined
            ? {}
            : { lineNumber: thread.lineNumber }),
          ...(thread.rootComment === undefined
            ? {}
            : { rootComment: thread.rootComment }),
          replies: Object.freeze(
            [...thread.replies].sort((a, b) => a.id - b.id)
          ),
        })
      )
      .sort((a, b) => latestCommentThreadDate(b) - latestCommentThreadDate(a))
  );
}

function latestCommentThreadDate(thread: AidePullRequestCommentThread): number {
  const dates = [
    ...(thread.rootComment === undefined ? [] : [thread.rootComment.createdAt]),
    ...thread.replies.map((reply) => reply.createdAt),
  ];
  return Math.max(...dates.map((date) => new Date(date).getTime()));
}

function azureDevOpsDiffFileStatus(
  changeType: AzureDevOpsChangeType
): AidePullRequestDiffFileStatus {
  switch (changeType) {
    case 'add':
      return 'added';
    case 'edit':
      return 'modified';
    case 'delete':
      return 'deleted';
    case 'rename':
    case 'sourceRename':
    case 'targetRename':
      return 'renamed';
    case 'none':
      return 'unchanged';
    default:
      return 'unknown';
  }
}
