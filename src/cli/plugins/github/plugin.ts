import { Effect } from 'effect';
import * as v from 'valibot';

import {
  defineAidePlugin,
  type AideAuthInputField,
  type AideAuthLoginRequest,
  type AidePullRequestBranchLookupRequest,
  type AidePullRequestBranchLookupResult,
  type AidePullRequestListRequest,
  type AidePullRequestListResult,
  type AidePullRequestListItemStatus,
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
  GitHubListPROptions,
  GitHubPullRequest,
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
  'listPullRequests' | 'getPullRequest'
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
