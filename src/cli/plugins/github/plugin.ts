import { Effect } from 'effect';
import * as v from 'valibot';

import {
  defineAidePlugin,
  type AideAuthAccount,
  type AideAuthInputField,
  type AideAuthLoginRequest,
  type AideAuthLogoutRequest,
  type AidePullRequestAddCommentRequest,
  type AidePullRequestBranchLookupRequest,
  type AidePullRequestBranchLookupResult,
  type AidePullRequestComment,
  type AidePullRequestCommentMutationResult,
  type AidePullRequestCommentThread,
  type AidePullRequestCommentsRequest,
  type AidePullRequestCommentsResult,
  type AidePullRequestCreateRequest,
  type AidePullRequestCreateResult,
  type AidePullRequestDiffFileStatus,
  type AidePullRequestDiffRequest,
  type AidePullRequestDiffResult,
  type AidePullRequestListRequest,
  type AidePullRequestListResult,
  type AidePullRequestListItemStatus,
  type AidePullRequestReplyCommentRequest,
  type AidePullRequestUpdateRequest,
  type AidePullRequestUpdateResult,
  type AidePullRequestViewRequest,
  type AidePullRequestViewResult,
  type AidePluginAuthStatus,
} from '@cli/host/plugin-descriptor.js';
import { defineImmutableBuiltinPlugin } from '@cli/host/immutable-builtin-plugin.js';
import {
  probeGithubConfigEffect,
  readGithubEnvForMigration,
  type ConfigStatus,
  type GithubConfigValue,
} from '@lib/config.js';
import { probeGhCliAuth, type GitHubAuthProbe } from '@lib/gh-utils.js';
import { GitHubClient } from '@lib/github-client.js';
import type {
  GitHubIssueComment,
  GitHubListPROptions,
  GitHubPRFile,
  GitHubPullRequest,
  GitHubReviewComment,
} from '@lib/github-types.js';
import {
  getGitHubPRStatus,
  mapStatusToGitHubState,
  normalizeGitHubHost,
  parseGitHubPRUrl,
  parseGitHubRemote,
} from '@lib/github-utils.js';
import {
  deleteAuthSecretEffect,
  type AuthStoreScope,
  writeAuthSecretEffect,
} from '@lib/auth-store.js';
import {
  GitHubAuthRequestError,
  githubStoredCredentialPayload,
  resolveGitHubAuthRequest,
  type CanonicalGitHubAuthRequest,
} from '@lib/github-auth.js';
import { githubRepositoryAuthScope } from '@lib/repository-auth-scope.js';
import { StoredGithubSchema } from '@schemas/config.js';
import {
  formatMigrationError,
  formatUnsetHint,
  messages,
  promptAuthField,
} from '../auth-operation-utils.js';
import {
  discoverGitHubAuthAccountsEffect,
  discoverGitHubAuthStatusEffect,
} from './auth-discovery.js';

type ProbeGithubConfig = (options: {
  readonly host?: string;
  readonly scope?: AuthStoreScope;
}) => Promise<ConfigStatus<GithubConfigValue>>;
type ProbeGithubConfigEffect = (options: {
  readonly host?: string;
  readonly scope?: AuthStoreScope;
}) => ReturnType<typeof probeGithubConfigEffect>;
type GitHubPullRequestClient = Pick<
  GitHubClient,
  | 'listPullRequests'
  | 'getPullRequest'
  | 'getPullRequestFiles'
  | 'getIssueComments'
  | 'getReviewComments'
> &
  Partial<
    Pick<
      GitHubClient,
      | 'createPullRequest'
      | 'createIssueComment'
      | 'createReviewComment'
      | 'replyToReviewComment'
      | 'updatePullRequest'
      | 'publishDraftPR'
      | 'convertToDraft'
      | 'addLabels'
      | 'removeLabel'
    >
  >;
type CreateGitHubClient = (options: {
  readonly host: string;
  readonly scope: AuthStoreScope;
}) => Promise<GitHubPullRequestClient>;

interface GitHubPluginOptions {
  readonly probeConfig?: ProbeGithubConfig;
  readonly createClient?: CreateGitHubClient;
  readonly ghAuthProbe?: GitHubAuthProbe;
}

function createGitHubLoginFields() {
  const tokenField = {
    kind: 'secret',
    key: 'token',
    label: 'GitHub token',
    description: 'GitHub token',
    required: true,
    stdin: true,
  } as const satisfies AideAuthInputField;
  return [tokenField] as const;
}

function mapGithubAuthStatus(
  status: ConfigStatus<GithubConfigValue>
): AidePluginAuthStatus {
  switch (status.kind) {
    case 'env':
      return {
        state: 'configured',
        detail:
          status.value.source === 'gh-cli'
            ? 'authenticated via gh CLI'
            : 'configured via environment token',
      };
    case 'keyring':
      return {
        state: 'configured',
        detail: 'configured via keyring token',
      };
    case 'missing':
      return {
        state: 'not-configured',
        detail: "run 'aide login github' or authenticate with gh CLI",
      };
    case 'malformed':
      return { state: 'misconfigured', detail: status.reason };
    case 'unreachable':
      return {
        state: 'unavailable',
        detail: 'system keyring is unreachable and no GitHub env token is set',
      };
  }
}

function githubAuthAccounts(
  status: ConfigStatus<GithubConfigValue>,
  request: CanonicalGitHubAuthRequest
): readonly AideAuthAccount[] {
  if (status.kind !== 'env' && status.kind !== 'keyring') return [];

  const sourceKind =
    status.kind === 'keyring'
      ? 'keyring'
      : status.value.source === 'gh-cli'
        ? 'external'
        : 'env';
  const sourceLabel =
    status.value.source === 'gh-cli'
      ? 'gh CLI'
      : status.value.source === 'stored'
        ? 'stored token'
        : 'environment token';
  const metadata = { authSource: status.value.source };
  const scopeId =
    request.account === undefined
      ? request.host
      : `${request.host}:${request.account}`;

  return [
    {
      id: `${scopeId}:${status.value.source}`,
      providerId: 'github',
      label: request.account ?? 'GitHub',
      detail: `${scopeId} configured via ${sourceLabel}`,
      sourceKind,
      metadata,
      scope: {
        id: scopeId,
        providerId: 'github',
        host: request.host,
        ...(request.account === undefined ? {} : { account: request.account }),
        label: scopeId,
        sourceKind,
        metadata,
      },
    },
  ];
}

function loginGitHubAuth(
  request: AideAuthLoginRequest,
  probeConfig: ProbeGithubConfigEffect
) {
  return Effect.gen(function* () {
    const authRequest = resolveGitHubAuthRequest({ scope: request.scope });
    if (!authRequest.ok) {
      return yield* Effect.fail(
        new GitHubAuthRequestError(
          authRequest.code,
          authRequest.host,
          authRequest.reason
        )
      );
    }

    if (request.fromEnv) {
      if (authRequest.account !== undefined) {
        return yield* Effect.fail(
          new GitHubAuthRequestError(
            'unqualified-environment-credential',
            authRequest.host,
            'Account-qualified GitHub --from-env is not supported because ' +
              'standard GitHub environment tokens do not prove account identity.',
            authRequest.account
          )
        );
      }
      const result = readGithubEnvForMigration(authRequest.host);
      if (result.kind !== 'ok') {
        return yield* Effect.fail(
          new Error(formatMigrationError('GitHub', result))
        );
      }

      yield* writeAuthSecretEffect(
        'github',
        JSON.stringify(
          githubStoredCredentialPayload(authRequest, result.value.token)
        ),
        authRequest.keyringScope
      );
      return {
        status: 'stored' as const,
        messages: messages(
          'Migrated GitHub credentials from env to keyring.',
          formatUnsetHint(result.varsUsed)
        ),
      };
    }

    if (request.scope === undefined) {
      const status = yield* probeConfig({});
      if (status.kind === 'env' && status.value.source === 'gh-cli') {
        return {
          status: 'external' as const,
          messages: ['Using gh CLI auth. Nothing to do.'],
        };
      }
    }

    const token = yield* promptAuthField(request, createGitHubLoginFields()[0]);
    const validated = yield* Effect.try({
      try: () => v.parse(StoredGithubSchema, { token }),
      catch: (error) => error,
    });

    yield* writeAuthSecretEffect(
      'github',
      JSON.stringify(
        githubStoredCredentialPayload(authRequest, validated.token)
      ),
      authRequest.keyringScope
    );

    return {
      status: 'stored' as const,
      messages: ['Saved credentials for github.'],
    };
  });
}

function logoutGitHubAuth(request?: AideAuthLogoutRequest) {
  return Effect.gen(function* () {
    const authRequest = resolveGitHubAuthRequest({ scope: request?.scope });
    if (!authRequest.ok) {
      return yield* Effect.fail(
        new GitHubAuthRequestError(
          authRequest.code,
          authRequest.host,
          authRequest.reason
        )
      );
    }
    const removed = yield* deleteAuthSecretEffect(
      'github',
      authRequest.keyringScope
    );
    return {
      status: removed ? ('removed' as const) : ('not-found' as const),
      messages: [
        removed
          ? 'Removed stored credentials for github.'
          : 'No stored credentials for github.',
      ],
    };
  });
}

function explicitString(value: string | undefined): string | undefined {
  return value === undefined || value.length === 0 ? undefined : value;
}

function explicitGitHubHost(
  value: string | undefined
): string | undefined | null {
  const host = explicitString(value);
  if (host === undefined) {
    return undefined;
  }
  return normalizeGitHubHost(host);
}

export function createGitHubPlugin(opts: GitHubPluginOptions = {}) {
  const githubLoginFields = createGitHubLoginFields();
  const ghAuthProbe: GitHubAuthProbe = opts.ghAuthProbe ?? probeGhCliAuth;
  const customProbeConfig = opts.probeConfig;
  const probeConfigEffect: ProbeGithubConfigEffect =
    customProbeConfig === undefined
      ? (options) => probeGithubConfigEffect({ ...options, ghAuthProbe })
      : (options) =>
          Effect.tryPromise({
            try: () => customProbeConfig(options),
            catch: (error) => error,
          });
  const createClient =
    opts.createClient ??
    ((options) => GitHubClient.create({ ...options, ghAuthProbe }));
  const authStatus = (request?: { readonly scope?: AuthStoreScope }) => {
    const authRequest = resolveGitHubAuthRequest({ scope: request?.scope });
    if (!authRequest.ok) {
      return Effect.succeed({
        state: 'misconfigured' as const,
        detail: authRequest.reason,
      });
    }
    return probeConfigEffect({
      scope: authRequest.keyringScope,
    }).pipe(Effect.map(mapGithubAuthStatus));
  };
  const authAccounts = (request?: { readonly scope?: AuthStoreScope }) => {
    const authRequest = resolveGitHubAuthRequest({ scope: request?.scope });
    if (!authRequest.ok) return Effect.succeed([]);
    return probeConfigEffect({
      scope: authRequest.keyringScope,
    }).pipe(Effect.map((status) => githubAuthAccounts(status, authRequest)));
  };
  const authProviderStatus = (request?: { readonly scope?: AuthStoreScope }) =>
    customProbeConfig === undefined && request?.scope === undefined
      ? discoverGitHubAuthStatusEffect()
      : authStatus(request);
  const authProviderAccounts = (request?: {
    readonly scope?: AuthStoreScope;
  }) =>
    customProbeConfig === undefined && request?.scope === undefined
      ? discoverGitHubAuthAccountsEffect()
      : authAccounts(request);

  const listPullRequests = (
    request: AidePullRequestListRequest
  ): Effect.Effect<AidePullRequestListResult, unknown, never> =>
    Effect.tryPromise({
      try: async (signal) => {
        const repository = request.match.repository;
        if (repository.kind !== 'github') {
          throw new Error(
            `GitHub provider cannot list pull requests for '${repository.kind}' repository refs`
          );
        }

        const client = await createClient({
          host: repository.host,
          scope: githubRepositoryAuthScope(repository.host),
        });
        const options: GitHubListPROptions = {
          state: mapStatusToGitHubState(request.status),
          per_page: request.limit,
        };
        let prs = await client.listPullRequests(
          repository.owner,
          repository.repo,
          options,
          signal
        );

        if (request.status === 'abandoned') {
          prs = prs.filter((pr) => !pr.merged);
        }
        if (request.status === 'completed') {
          prs = prs.filter((pr) => pr.merged);
        }
        if (request.limit && prs.length > request.limit) {
          prs = prs.slice(0, request.limit);
        }
        if (request.createdBy) {
          const searchTerm = request.createdBy.toLowerCase();
          prs = prs.filter((pr) =>
            pr.user.login.toLowerCase().includes(searchTerm)
          );
        }

        return {
          repository,
          repositoryLabel: `${repository.host}/${repository.owner}/${repository.repo}`,
          pullRequests: prs.map(githubPullRequestToListItem),
        };
      },
      catch: (error) => error,
    });

  const getPullRequest = (
    request: AidePullRequestViewRequest
  ): Effect.Effect<AidePullRequestViewResult, unknown, never> =>
    Effect.tryPromise({
      try: async (signal) => {
        const repository = request.match.repository;
        if (repository.kind !== 'github') {
          throw new Error(
            `GitHub provider cannot get pull requests for '${repository.kind}' repository refs`
          );
        }

        const client = await createClient({
          host: repository.host,
          scope: githubRepositoryAuthScope(repository.host),
        });
        const pr = await client.getPullRequest(
          repository.owner,
          repository.repo,
          request.pullRequest.number,
          signal
        );

        return {
          repository,
          repositoryLabel: `${repository.host}/${repository.owner}/${repository.repo}`,
          pullRequest: githubPullRequestToViewItem(pr),
        };
      },
      catch: (error) => error,
    });

  const createPullRequest = (
    request: AidePullRequestCreateRequest
  ): Effect.Effect<AidePullRequestCreateResult, unknown, never> =>
    Effect.tryPromise({
      try: async (signal) => {
        const repository = request.match.repository;
        if (repository.kind !== 'github') {
          throw new Error(
            `GitHub provider cannot create pull requests for '${repository.kind}' repository refs`
          );
        }

        const client = await createClient({
          host: repository.host,
          scope: githubRepositoryAuthScope(repository.host),
        });
        if (client.createPullRequest === undefined) {
          throw new Error(
            'GitHub client does not support creating pull requests'
          );
        }

        const warnings: string[] = [];
        const created = await client.createPullRequest(
          repository.owner,
          repository.repo,
          request.sourceBranch,
          request.targetBranch,
          request.title,
          request.description ?? '',
          { draft: request.draft ?? false },
          signal
        );

        let pr = created;
        const labels = request.labels ?? [];
        if (labels.length > 0) {
          if (client.addLabels === undefined) {
            warnings.push(
              'Failed to add labels: GitHub client does not support labels'
            );
          } else {
            try {
              await client.addLabels(
                repository.owner,
                repository.repo,
                created.number,
                [...labels],
                signal
              );
            } catch {
              warnings.push('Failed to add labels: provider request failed');
            }
          }

          if (warnings.length === 0) {
            try {
              pr = await client.getPullRequest(
                repository.owner,
                repository.repo,
                created.number,
                signal
              );
            } catch {
              warnings.push(
                'Failed to refresh labels: provider request failed'
              );
            }
          }
        }

        return {
          repository,
          repositoryLabel: `${repository.host}/${repository.owner}/${repository.repo}`,
          pullRequest: githubPullRequestToViewItem(pr),
          ...(warnings.length === 0 ? {} : { warnings }),
        };
      },
      catch: (error) => error,
    });

  const updatePullRequest = (
    request: AidePullRequestUpdateRequest
  ): Effect.Effect<AidePullRequestUpdateResult, unknown, never> =>
    Effect.tryPromise({
      try: async (signal) => {
        const repository = request.match.repository;
        if (repository.kind !== 'github') {
          throw new Error(
            `GitHub provider cannot update pull requests for '${repository.kind}' repository refs`
          );
        }

        const client = await createClient({
          host: repository.host,
          scope: githubRepositoryAuthScope(repository.host),
        });
        const warnings: string[] = [];
        const updates = {
          ...(request.title === undefined ? {} : { title: request.title }),
          ...(request.description === undefined
            ? {}
            : { body: request.description }),
          ...(request.targetBranch === undefined
            ? {}
            : { base: request.targetBranch }),
          ...(request.status === undefined
            ? {}
            : { state: githubUpdateStatusToState(request.status) }),
        };

        if (Object.keys(updates).length > 0) {
          if (client.updatePullRequest === undefined) {
            throw new Error(
              'GitHub client does not support updating pull requests'
            );
          }
          await client.updatePullRequest(
            repository.owner,
            repository.repo,
            request.pullRequest.number,
            updates,
            signal
          );
        }

        if (request.draft === true) {
          if (client.convertToDraft === undefined) {
            throw new Error(
              'GitHub client does not support converting pull requests to draft'
            );
          }
          await client.convertToDraft(
            repository.owner,
            repository.repo,
            request.pullRequest.number,
            signal
          );
        } else if (request.draft === false) {
          if (client.publishDraftPR === undefined) {
            throw new Error(
              'GitHub client does not support publishing draft pull requests'
            );
          }
          await client.publishDraftPR(
            repository.owner,
            repository.repo,
            request.pullRequest.number,
            signal
          );
        }

        const labelsToAdd = request.labelsToAdd ?? [];
        if (labelsToAdd.length > 0) {
          if (client.addLabels === undefined) {
            warnings.push(
              'Failed to add labels: GitHub client does not support labels'
            );
          } else {
            try {
              await client.addLabels(
                repository.owner,
                repository.repo,
                request.pullRequest.number,
                [...labelsToAdd],
                signal
              );
            } catch {
              warnings.push('Failed to add labels: provider request failed');
            }
          }
        }

        for (const label of request.labelsToRemove ?? []) {
          if (client.removeLabel === undefined) {
            warnings.push(
              'Failed to remove label: GitHub client does not support labels'
            );
            continue;
          }
          try {
            await client.removeLabel(
              repository.owner,
              repository.repo,
              request.pullRequest.number,
              label,
              signal
            );
          } catch {
            warnings.push('Failed to remove label: provider request failed');
          }
        }

        const pr = await client.getPullRequest(
          repository.owner,
          repository.repo,
          request.pullRequest.number,
          signal
        );

        return {
          repository,
          repositoryLabel: `${repository.host}/${repository.owner}/${repository.repo}`,
          pullRequest: githubPullRequestToViewItem(pr),
          ...(warnings.length === 0 ? {} : { warnings }),
        };
      },
      catch: (error) => error,
    });

  const getPullRequestDiff = (
    request: AidePullRequestDiffRequest
  ): Effect.Effect<AidePullRequestDiffResult, unknown, never> =>
    Effect.tryPromise({
      try: async (signal) => {
        const repository = request.match.repository;
        if (repository.kind !== 'github') {
          throw new Error(
            `GitHub provider cannot get pull request diffs for '${repository.kind}' repository refs`
          );
        }

        const client = await createClient({
          host: repository.host,
          scope: githubRepositoryAuthScope(repository.host),
        });
        const [pr, files] = await Promise.all([
          client.getPullRequest(
            repository.owner,
            repository.repo,
            request.pullRequest.number,
            signal
          ),
          client.getPullRequestFiles(
            repository.owner,
            repository.repo,
            request.pullRequest.number,
            signal
          ),
        ]);

        return {
          repository,
          repositoryLabel: `${repository.host}/${repository.owner}/${repository.repo}`,
          pullRequest: githubPullRequestToViewItem(pr),
          files: files.map(githubPullRequestFileToDiffFile),
        };
      },
      catch: (error) => error,
    });

  const listPullRequestComments = (
    request: AidePullRequestCommentsRequest
  ): Effect.Effect<AidePullRequestCommentsResult, unknown, never> =>
    Effect.tryPromise({
      try: async (signal) => {
        const repository = request.match.repository;
        if (repository.kind !== 'github') {
          throw new Error(
            `GitHub provider cannot list pull request comments for '${repository.kind}' repository refs`
          );
        }

        const client = await createClient({
          host: repository.host,
          scope: githubRepositoryAuthScope(repository.host),
        });
        const [issueComments, reviewComments] = await Promise.all([
          client.getIssueComments(
            repository.owner,
            repository.repo,
            request.pullRequest.number,
            signal
          ),
          client.getReviewComments(
            repository.owner,
            repository.repo,
            request.pullRequest.number,
            signal
          ),
        ]);

        return {
          repository,
          repositoryLabel: `${repository.host}/${repository.owner}/${repository.repo}`,
          pullRequest: { number: request.pullRequest.number },
          threads: githubCommentsToThreads(issueComments, reviewComments),
        };
      },
      catch: (error) => error,
    });

  const addPullRequestComment = (
    request: AidePullRequestAddCommentRequest
  ): Effect.Effect<AidePullRequestCommentMutationResult, unknown, never> =>
    Effect.tryPromise({
      try: async (signal) => {
        const repository = request.match.repository;
        if (repository.kind !== 'github') {
          throw new Error(
            `GitHub provider cannot add pull request comments for '${repository.kind}' repository refs`
          );
        }

        const client = await createClient({
          host: repository.host,
          scope: githubRepositoryAuthScope(repository.host),
        });
        const comment =
          request.position === undefined
            ? await (async () => {
                if (client.createIssueComment === undefined) {
                  throw new Error(
                    'GitHub client does not support creating issue comments'
                  );
                }
                return githubIssueCommentToComment(
                  await client.createIssueComment(
                    repository.owner,
                    repository.repo,
                    request.pullRequest.number,
                    request.body,
                    signal
                  )
                );
              })()
            : await (async (position) => {
                if (client.createReviewComment === undefined) {
                  throw new Error(
                    'GitHub client does not support creating review comments'
                  );
                }
                const pr = await client.getPullRequest(
                  repository.owner,
                  repository.repo,
                  request.pullRequest.number,
                  signal
                );
                return githubReviewCommentToComment(
                  await client.createReviewComment(
                    repository.owner,
                    repository.repo,
                    request.pullRequest.number,
                    request.body,
                    {
                      path: githubReviewCommentPath(position.filePath),
                      line: position.endLineNumber ?? position.lineNumber,
                      commit_id: pr.head.sha,
                      ...(position.endLineNumber === undefined
                        ? {}
                        : { start_line: position.lineNumber }),
                    },
                    signal
                  ),
                  'review'
                );
              })(request.position);

        return {
          repository,
          repositoryLabel: `${repository.host}/${repository.owner}/${repository.repo}`,
          pullRequest: { number: request.pullRequest.number },
          comment,
          thread: githubCommentMutationThread(comment),
        };
      },
      catch: (error) => error,
    });

  const replyToPullRequestComment = (
    request: AidePullRequestReplyCommentRequest
  ): Effect.Effect<AidePullRequestCommentMutationResult, unknown, never> =>
    Effect.tryPromise({
      try: async (signal) => {
        const repository = request.match.repository;
        if (repository.kind !== 'github') {
          throw new Error(
            `GitHub provider cannot reply to pull request comments for '${repository.kind}' repository refs`
          );
        }

        const client = await createClient({
          host: repository.host,
          scope: githubRepositoryAuthScope(repository.host),
        });
        if (client.replyToReviewComment === undefined) {
          throw new Error(
            'GitHub client does not support replying to review comments'
          );
        }
        const comment = githubReviewCommentToComment(
          await client.replyToReviewComment(
            repository.owner,
            repository.repo,
            request.pullRequest.number,
            request.threadId,
            request.body,
            signal
          ),
          'reply'
        );

        return {
          repository,
          repositoryLabel: `${repository.host}/${repository.owner}/${repository.repo}`,
          pullRequest: { number: request.pullRequest.number },
          comment,
          thread: Object.freeze({
            id: request.threadId,
            ...(comment.filePath === undefined
              ? {}
              : { filePath: comment.filePath }),
            ...(comment.lineNumber === undefined
              ? {}
              : { lineNumber: comment.lineNumber }),
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
      try: async (signal) => {
        const repository = request.match.repository;
        if (repository.kind !== 'github') {
          throw new Error(
            `GitHub provider cannot find pull requests for '${repository.kind}' repository refs`
          );
        }

        const client = await createClient({
          host: repository.host,
          scope: githubRepositoryAuthScope(repository.host),
        });
        const prs = await client.listPullRequests(
          repository.owner,
          repository.repo,
          {
            head: `${repository.owner}:${request.branch}`,
            state: 'all',
          },
          signal
        );
        const selected = selectGitHubPullRequestForBranch(prs);
        if (selected === undefined) {
          throw new Error(
            `No pull request found for branch '${request.branch}'.\n\nTo create a PR, push your branch and run:\n  aide pr create --title "Your PR title"`
          );
        }

        const pr = await client.getPullRequest(
          repository.owner,
          repository.repo,
          selected.number,
          signal
        );

        return {
          branch: request.branch,
          repository,
          repositoryLabel: `${repository.host}/${repository.owner}/${repository.repo}`,
          pullRequest: githubPullRequestToViewItem(pr),
        };
      },
      catch: (error) => error,
    });

  return defineAidePlugin({
    id: 'github',
    summary: 'GitHub pull request provider',
    commands: [],
    capabilities: {
      auth: { status: authStatus },
      authProvider: {
        providerId: 'github',
        label: 'GitHub',
        login: {
          summary: 'Save a GitHub token for the requested host',
          fields: githubLoginFields,
          envMigration: {
            description:
              'Migrate a host-bound GitHub env token into the keyring',
            variables: [
              'GITHUB_TOKEN',
              'GH_TOKEN',
              'GH_HOST',
              'GH_ENTERPRISE_TOKEN',
              'GITHUB_ENTERPRISE_TOKEN',
            ],
          },
        },
        logout: {
          summary: 'Remove GitHub credentials',
        },
        status: authProviderStatus,
        accounts: authProviderAccounts,
        operations: {
          login: (request) => loginGitHubAuth(request, probeConfigEffect),
          logout: logoutGitHubAuth,
        },
      },
      primeContribution: {
        status: [
          {
            groupId: 'pull-requests',
            groupLabel: 'Pull Requests',
            label: 'GitHub',
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
        providerId: 'github',
        priority: 100,
        features: {
          draftPullRequests: true,
          enterpriseHosts: true,
          reviewComments: true,
        },
        authStatus,
        matchRemote: (remoteUrl) => {
          const parsed = parseGitHubRemote(remoteUrl);
          if (parsed === null) return null;
          return {
            source: 'git-remote',
            priority: 100,
            detail: `${parsed.host}/${parsed.owner}/${parsed.repo}`,
            repository: {
              kind: 'github',
              host: parsed.host,
              owner: parsed.owner,
              repo: parsed.repo,
            },
          };
        },
        matchRepository: (request) =>
          Effect.succeed(
            (() => {
              if (
                request.providerId !== undefined &&
                request.providerId !== 'github'
              ) {
                return null;
              }

              const repo = explicitString(request.repo);
              if (repo === undefined) {
                return null;
              }

              const host = explicitGitHubHost(request.host);
              if (host === null) {
                return null;
              }

              const owner =
                explicitString(request.owner) ??
                (request.providerId === 'github' || host !== undefined
                  ? (explicitString(request.project) ??
                    explicitString(request.org))
                  : undefined);
              if (owner === undefined) {
                return null;
              }

              const repositoryHost = host ?? 'github.com';
              return {
                source: 'repository-ref' as const,
                priority: 100,
                detail: `${repositoryHost}/${owner}/${repo}`,
                repository: {
                  kind: 'github' as const,
                  host: repositoryHost,
                  owner,
                  repo,
                },
              };
            })()
          ),
        matchPullRequestUrl: (url) => {
          const parsed = parseGitHubPRUrl(url);
          if (parsed === null) return null;
          return {
            source: 'pull-request-url',
            priority: 100,
            detail: `${parsed.host}/${parsed.owner}/${parsed.repo}#${parsed.number}`,
            repository: {
              kind: 'github',
              host: parsed.host,
              owner: parsed.owner,
              repo: parsed.repo,
            },
            pullRequest: {
              number: parsed.number,
            },
          };
        },
        operations: {
          listPullRequests,
          getPullRequest,
          createPullRequest,
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

export const githubPlugin = defineImmutableBuiltinPlugin(createGitHubPlugin());

function githubPullRequestStatus(
  pr: GitHubPullRequest
): AidePullRequestListItemStatus {
  const status = getGitHubPRStatus(pr);
  if (
    status === 'active' ||
    status === 'completed' ||
    status === 'abandoned' ||
    status === 'draft'
  ) {
    return status;
  }
  return 'active';
}

function githubPullRequestToListItem(pr: GitHubPullRequest) {
  return {
    id: pr.number,
    title: pr.title,
    status: githubPullRequestStatus(pr),
    createdAt: pr.created_at,
    author: {
      displayName: pr.user.login,
      username: pr.user.login,
    },
    ...(pr.body === null ? {} : { description: pr.body }),
    url: pr.html_url,
    draft: pr.draft,
  } as const;
}

function selectGitHubPullRequestForBranch(
  prs: readonly GitHubPullRequest[]
): GitHubPullRequest | undefined {
  if (prs.length === 1) {
    return prs[0];
  }

  const openPRs = prs.filter((pr) => pr.state === 'open');
  if (openPRs.length === 1) {
    return openPRs[0];
  }

  const candidates = openPRs.length > 0 ? openPRs : prs;
  return [...candidates].sort(
    (a, b) =>
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  )[0];
}

function githubPullRequestToViewItem(pr: GitHubPullRequest) {
  return {
    ...githubPullRequestToListItem(pr),
    sourceBranch: pr.head.ref,
    targetBranch: pr.base.ref,
    labels: pr.labels.map((label) => label.name),
  } as const;
}

function githubUpdateStatusToState(status: 'active' | 'abandoned') {
  switch (status) {
    case 'active':
      return 'open' as const;
    case 'abandoned':
      return 'closed' as const;
  }
}

function githubPullRequestFileToDiffFile(file: GitHubPRFile) {
  return {
    path: file.filename,
    status: githubDiffFileStatus(file.status),
    providerStatus: file.status,
    additions: file.additions,
    deletions: file.deletions,
    changes: file.changes,
    ...(file.previous_filename === undefined
      ? {}
      : { previousPath: file.previous_filename }),
    ...(file.patch === undefined ? {} : { patch: file.patch }),
  } as const;
}

function githubIssueCommentToComment(
  comment: GitHubIssueComment
): AidePullRequestComment {
  return {
    id: comment.id,
    kind: 'issue',
    author: {
      displayName: comment.user.login,
      username: comment.user.login,
    },
    body: comment.body,
    createdAt: comment.created_at,
    updatedAt: comment.updated_at,
    url: comment.html_url,
  };
}

function githubReviewCommentToComment(
  comment: GitHubReviewComment,
  kind: 'review' | 'reply'
): AidePullRequestComment {
  const lineNumber = comment.line ?? comment.original_line ?? undefined;
  return {
    id: comment.id,
    kind,
    author: {
      displayName: comment.user.login,
      username: comment.user.login,
    },
    body: comment.body,
    createdAt: comment.created_at,
    updatedAt: comment.updated_at,
    url: comment.html_url,
    filePath: comment.path,
    ...(lineNumber === undefined ? {} : { lineNumber }),
    ...(comment.in_reply_to_id === undefined
      ? {}
      : { parentId: comment.in_reply_to_id }),
  };
}

function githubReviewCommentPath(path: string): string {
  return path.startsWith('/') ? path.slice(1) : path;
}

function githubCommentMutationThread(
  comment: AidePullRequestComment
): AidePullRequestCommentThread {
  if (comment.kind === 'review') {
    return Object.freeze({
      id: comment.id,
      ...(comment.filePath === undefined ? {} : { filePath: comment.filePath }),
      ...(comment.lineNumber === undefined
        ? {}
        : { lineNumber: comment.lineNumber }),
      rootComment: comment,
      replies: Object.freeze([]),
    });
  }

  return Object.freeze({
    id: `issue-${comment.id}`,
    rootComment: comment,
    replies: Object.freeze([]),
  });
}

function githubCommentsToThreads(
  issueComments: readonly GitHubIssueComment[],
  reviewComments: readonly GitHubReviewComment[]
): readonly AidePullRequestCommentThread[] {
  const reviewRoots = new Map<
    number,
    {
      readonly id: number;
      readonly filePath: string;
      readonly lineNumber?: number;
      readonly rootComment: AidePullRequestComment;
      readonly replies: AidePullRequestComment[];
    }
  >();
  const commentIdToRootId = new Map<number, number>();
  const replies: GitHubReviewComment[] = [];

  for (const comment of reviewComments) {
    if (comment.in_reply_to_id !== undefined) {
      replies.push(comment);
      continue;
    }

    const lineNumber = comment.line ?? comment.original_line ?? undefined;
    const thread = {
      id: comment.id,
      filePath: comment.path,
      ...(lineNumber === undefined ? {} : { lineNumber }),
      rootComment: githubReviewCommentToComment(comment, 'review'),
      replies: [],
    };
    reviewRoots.set(comment.id, thread);
    commentIdToRootId.set(comment.id, comment.id);
  }

  for (const reply of replies) {
    const parentId = reply.in_reply_to_id;
    const rootId =
      parentId === undefined ? undefined : commentIdToRootId.get(parentId);
    const parentThread =
      rootId === undefined ? undefined : reviewRoots.get(rootId);
    if (rootId === undefined || parentThread === undefined) {
      const lineNumber = reply.line ?? reply.original_line ?? undefined;
      const orphanThread = {
        id: reply.id,
        filePath: reply.path,
        ...(lineNumber === undefined ? {} : { lineNumber }),
        rootComment: githubReviewCommentToComment(reply, 'review'),
        replies: [],
      };
      reviewRoots.set(reply.id, orphanThread);
      commentIdToRootId.set(reply.id, reply.id);
      continue;
    }

    parentThread.replies.push(githubReviewCommentToComment(reply, 'reply'));
    commentIdToRootId.set(reply.id, rootId);
  }

  const issueThreads = issueComments.map((comment) =>
    Object.freeze({
      id: `issue-${comment.id}`,
      rootComment: githubIssueCommentToComment(comment),
      replies: Object.freeze([]),
    })
  );

  return Object.freeze(
    [
      ...[...reviewRoots.values()].map((thread) =>
        Object.freeze({
          id: thread.id,
          filePath: thread.filePath,
          ...(thread.lineNumber === undefined
            ? {}
            : { lineNumber: thread.lineNumber }),
          rootComment: thread.rootComment,
          replies: Object.freeze(
            [...thread.replies].sort(
              (a, b) =>
                new Date(a.createdAt).getTime() -
                new Date(b.createdAt).getTime()
            )
          ),
        })
      ),
      ...issueThreads,
    ].sort((a, b) => latestThreadDate(b) - latestThreadDate(a))
  );
}

function latestThreadDate(thread: AidePullRequestCommentThread): number {
  const dates = [
    ...(thread.rootComment === undefined ? [] : [thread.rootComment.createdAt]),
    ...thread.replies.map((reply) => reply.createdAt),
  ];
  return Math.max(...dates.map((date) => new Date(date).getTime()));
}

function githubDiffFileStatus(
  status: GitHubPRFile['status']
): AidePullRequestDiffFileStatus {
  switch (status) {
    case 'added':
      return 'added';
    case 'modified':
    case 'changed':
      return 'modified';
    case 'removed':
      return 'deleted';
    case 'renamed':
      return 'renamed';
    case 'copied':
      return 'copied';
    case 'unchanged':
      return 'unchanged';
  }
}
