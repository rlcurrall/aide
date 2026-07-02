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
  type AidePullRequestCommentMutationResult,
  type AidePullRequestCommentThread,
  type AidePullRequestCommentsRequest,
  type AidePullRequestCommentsResult,
  type AidePullRequestDiffFileStatus,
  type AidePullRequestDiffRequest,
  type AidePullRequestDiffResult,
  type AidePullRequestListRequest,
  type AidePullRequestListResult,
  type AidePullRequestListItemStatus,
  type AidePullRequestReplyCommentRequest,
  type AidePullRequestViewRequest,
  type AidePullRequestViewResult,
  type AidePluginAuthStatus,
} from '@cli/host/plugin-descriptor.js';
import {
  probeGithubConfig,
  readGithubEnvForMigration,
  type ConfigStatus,
  type GithubConfigValue,
} from '@lib/config.js';
import { isGhCliAvailable } from '@lib/gh-utils.js';
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
  parseGitHubPRUrl,
  parseGitHubRemote,
} from '@lib/github-utils.js';
import { deleteSecret, setSecret } from '@lib/secrets.js';
import { StoredGithubSchema } from '@schemas/config.js';
import {
  formatMigrationError,
  formatUnsetHint,
  messages,
  promptAuthField,
} from '../auth-operation-utils.js';

type ProbeGithubConfig = () => Promise<ConfigStatus<GithubConfigValue>>;
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
      'createIssueComment' | 'createReviewComment' | 'replyToReviewComment'
    >
  >;
type CreateGitHubClient = (options: {
  readonly host: string;
}) => Promise<GitHubPullRequestClient>;

interface GitHubPluginOptions {
  readonly probeConfig?: ProbeGithubConfig;
  readonly createClient?: CreateGitHubClient;
  readonly ghAvailable?: () => boolean;
}

const githubTokenField = {
  kind: 'secret',
  key: 'token',
  label: 'GitHub token',
  description: 'GitHub token',
  required: true,
  stdin: true,
} as const satisfies AideAuthInputField;

const githubLoginFields = Object.freeze([githubTokenField] as const);

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

function loginGitHubAuth(
  request: AideAuthLoginRequest,
  ghAvailable: () => boolean
) {
  return Effect.gen(function* () {
    if (request.fromEnv) {
      const result = readGithubEnvForMigration();
      if (result.kind !== 'ok') {
        return yield* Effect.fail(
          new Error(formatMigrationError('GitHub', result))
        );
      }

      yield* Effect.tryPromise({
        try: () => setSecret('github', JSON.stringify(result.value)),
        catch: (error) => error,
      });
      return {
        status: 'stored' as const,
        messages: messages(
          'Migrated GitHub credentials from env to keyring.',
          formatUnsetHint(result.varsUsed)
        ),
      };
    }

    if (ghAvailable()) {
      return {
        status: 'external' as const,
        messages: ['Using gh CLI auth. Nothing to do.'],
      };
    }

    const token = yield* promptAuthField(request, githubTokenField);
    const validated = yield* Effect.try({
      try: () => v.parse(StoredGithubSchema, { token }),
      catch: (error) => error,
    });
    yield* Effect.tryPromise({
      try: () => setSecret('github', JSON.stringify(validated)),
      catch: (error) => error,
    });

    return {
      status: 'stored' as const,
      messages: ['Saved credentials for github.'],
    };
  });
}

function logoutGitHubAuth() {
  return Effect.tryPromise({
    try: () => deleteSecret('github'),
    catch: (error) => error,
  }).pipe(
    Effect.map((removed) => ({
      status: removed ? ('removed' as const) : ('not-found' as const),
      messages: [
        removed
          ? 'Removed stored credentials for github.'
          : 'No stored credentials for github.',
      ],
    }))
  );
}

export function createGitHubPlugin(opts: GitHubPluginOptions = {}) {
  const probeConfig =
    opts.probeConfig ??
    (() => probeGithubConfig({ ghAvailable: opts.ghAvailable }));
  const createClient =
    opts.createClient ?? ((options) => GitHubClient.create(options));
  const ghAvailable = opts.ghAvailable ?? isGhCliAvailable;
  const authStatus = () =>
    Effect.tryPromise({
      try: () => probeConfig(),
      catch: (error) => error,
    }).pipe(Effect.map(mapGithubAuthStatus));

  const listPullRequests = (
    request: AidePullRequestListRequest
  ): Effect.Effect<AidePullRequestListResult, unknown, never> =>
    Effect.tryPromise({
      try: async () => {
        const repository = request.match.repository;
        if (repository.kind !== 'github') {
          throw new Error(
            `GitHub provider cannot list pull requests for '${repository.kind}' repository refs`
          );
        }

        const client = await createClient({ host: repository.host });
        const options: GitHubListPROptions = {
          state: mapStatusToGitHubState(request.status),
          per_page: request.limit,
        };
        let prs = await client.listPullRequests(
          repository.owner,
          repository.repo,
          options
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
      try: async () => {
        const repository = request.match.repository;
        if (repository.kind !== 'github') {
          throw new Error(
            `GitHub provider cannot get pull requests for '${repository.kind}' repository refs`
          );
        }

        const client = await createClient({ host: repository.host });
        const pr = await client.getPullRequest(
          repository.owner,
          repository.repo,
          request.pullRequest.number
        );

        return {
          repository,
          repositoryLabel: `${repository.host}/${repository.owner}/${repository.repo}`,
          pullRequest: githubPullRequestToViewItem(pr),
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
        if (repository.kind !== 'github') {
          throw new Error(
            `GitHub provider cannot get pull request diffs for '${repository.kind}' repository refs`
          );
        }

        const client = await createClient({ host: repository.host });
        const [pr, files] = await Promise.all([
          client.getPullRequest(
            repository.owner,
            repository.repo,
            request.pullRequest.number
          ),
          client.getPullRequestFiles(
            repository.owner,
            repository.repo,
            request.pullRequest.number
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
      try: async () => {
        const repository = request.match.repository;
        if (repository.kind !== 'github') {
          throw new Error(
            `GitHub provider cannot list pull request comments for '${repository.kind}' repository refs`
          );
        }

        const client = await createClient({ host: repository.host });
        const [issueComments, reviewComments] = await Promise.all([
          client.getIssueComments(
            repository.owner,
            repository.repo,
            request.pullRequest.number
          ),
          client.getReviewComments(
            repository.owner,
            repository.repo,
            request.pullRequest.number
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
      try: async () => {
        const repository = request.match.repository;
        if (repository.kind !== 'github') {
          throw new Error(
            `GitHub provider cannot add pull request comments for '${repository.kind}' repository refs`
          );
        }

        const client = await createClient({ host: repository.host });
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
                    request.body
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
                  request.pullRequest.number
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
                    }
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
      try: async () => {
        const repository = request.match.repository;
        if (repository.kind !== 'github') {
          throw new Error(
            `GitHub provider cannot reply to pull request comments for '${repository.kind}' repository refs`
          );
        }

        const client = await createClient({ host: repository.host });
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
            request.body
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
      try: async () => {
        const repository = request.match.repository;
        if (repository.kind !== 'github') {
          throw new Error(
            `GitHub provider cannot find pull requests for '${repository.kind}' repository refs`
          );
        }

        const client = await createClient({ host: repository.host });
        const prs = await client.listPullRequests(
          repository.owner,
          repository.repo,
          {
            head: `${repository.owner}:${request.branch}`,
            state: 'all',
          }
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
          selected.number
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
          summary: 'Save GitHub token (only if gh CLI is unavailable)',
          fields: githubLoginFields,
          envMigration: {
            description: 'Migrate GITHUB_TOKEN / GH_TOKEN into the keyring',
            variables: ['GITHUB_TOKEN', 'GH_TOKEN'],
          },
        },
        logout: {
          summary: 'Remove GitHub credentials',
        },
        status: authStatus,
        operations: {
          login: (request) => loginGitHubAuth(request, ghAvailable),
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

export const githubPlugin = createGitHubPlugin();

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
