/**
 * PR list command - List pull requests
 * Supports Azure DevOps and GitHub
 */

import { Effect } from 'effect';
import type { ArgumentsCamelCase, CommandModule } from 'yargs';

import type {
  AidePullRequestListItem,
  AidePullRequestListItemStatus,
  AidePullRequestListResult,
  AidePullRequestRepositoryRef,
} from '@cli/host/plugin-descriptor.js';
import { getAideHostContext } from '@cli/host/runtime-context.js';
import { logProgress } from '@lib/cli-utils.js';
import { handleCommandError } from '@lib/errors.js';
import { getGitRemoteUrl } from '@lib/git-utils.js';
import type { GitHubPullRequest } from '@lib/github-types.js';
import {
  getGitHubPRStatus,
  mapStatusToGitHubState,
} from '@lib/github-utils.js';
import { resolvePlatformContext, type PlatformContext } from '@lib/platform.js';
import type { AzureDevOpsPullRequest } from '@lib/types.js';
import { validateArgs } from '@lib/validation.js';
import {
  ListArgsSchema,
  type ListArgs,
  type OutputFormat,
} from '@schemas/pr/list.js';

// ============================================================================
// Provider-neutral Formatting
// ============================================================================

export function formatPullRequestListOutput(
  result: AidePullRequestListResult,
  format: OutputFormat
): string {
  const prs = result.pullRequests;
  if (format === 'json') {
    return JSON.stringify(prs, null, 2);
  }

  if (prs.length === 0) {
    return format === 'markdown'
      ? `# Pull Requests\n\nNo pull requests found.`
      : `No pull requests found.`;
  }

  if (format === 'markdown') {
    let output = `# Pull Requests`;
    if (result.repositoryLabel) {
      output += ` - ${result.repositoryLabel}`;
    }
    output += `\n\nTotal: ${prs.length} PR${prs.length === 1 ? '' : 's'}\n\n`;

    for (const pr of prs) {
      const date = new Date(pr.createdAt).toISOString().split('T')[0];
      output += `## #${pr.id}: ${pr.title}\n`;
      output += `**Status:** ${pr.status} | **Created:** ${date} | **By:** ${pr.author.displayName}\n`;
      if (pr.description) {
        output += `\n${pr.description}\n`;
      }
      output += `\n---\n\n`;
    }

    return output;
  }

  let output = `Pull Requests`;
  if (result.repositoryLabel) {
    output += ` - ${result.repositoryLabel}`;
  }
  output += ` (${prs.length} total)\n`;
  output += '='.repeat(70) + '\n\n';

  for (const pr of prs) {
    const date = new Date(pr.createdAt).toLocaleDateString();
    output += `[PR #${pr.id}] ${pr.title}\n`;
    output += `  Status: ${pr.status}\n`;
    output += `  Created: ${date} by ${pr.author.displayName}\n`;
    if (pr.description) {
      const shortDesc =
        pr.description.length > 100
          ? pr.description.substring(0, 97) + '...'
          : pr.description;
      output += `  Description: ${shortDesc}\n`;
    }
    output += `\n`;
  }

  return output;
}

// ============================================================================
// Handler
// ============================================================================

async function listGitHubPullRequests(
  ctx: Extract<PlatformContext, { platform: 'github' }>,
  args: ListArgs
): Promise<AidePullRequestListResult> {
  const { status, limit } = args;
  const createdBy = args.createdBy ?? args.author;

  const ghState = mapStatusToGitHubState(status);
  let prs = await ctx.client.listPullRequests(ctx.owner, ctx.repo, {
    state: ghState,
    per_page: limit,
  });

  if (status === 'abandoned') {
    prs = prs.filter((pr) => !pr.merged);
  }
  if (status === 'completed') {
    prs = prs.filter((pr) => pr.merged);
  }
  if (limit && prs.length > limit) {
    prs = prs.slice(0, limit);
  }
  if (createdBy) {
    const searchTerm = createdBy.toLowerCase();
    prs = prs.filter((pr) => pr.user.login.toLowerCase().includes(searchTerm));
  }

  const repository = {
    kind: 'github',
    host: ctx.host,
    owner: ctx.owner,
    repo: ctx.repo,
  } as const;

  return {
    repository,
    repositoryLabel: repositoryLabel(repository),
    pullRequests: prs.map(githubPullRequestToListItem),
  };
}

async function listAzureDevOpsPullRequests(
  ctx: Extract<PlatformContext, { platform: 'azure-devops' }>,
  args: ListArgs
): Promise<AidePullRequestListResult> {
  const { status, limit } = args;
  const createdBy = args.createdBy ?? args.author;

  const response = await ctx.client.listPullRequests(ctx.project, ctx.repo, {
    status,
    top: limit,
  });

  let prs = response.value;
  if (createdBy) {
    const searchTerm = createdBy.toLowerCase();
    prs = prs.filter((pr) => {
      const displayName = pr.createdBy.displayName.toLowerCase();
      const uniqueName = pr.createdBy.uniqueName?.toLowerCase() || '';
      return (
        displayName.includes(searchTerm) || uniqueName.includes(searchTerm)
      );
    });
  }

  const repository = {
    kind: 'azure-devops',
    org: ctx.org,
    project: ctx.project,
    repo: ctx.repo,
  } as const;

  return {
    repository,
    repositoryLabel: repositoryLabel(repository),
    pullRequests: prs.map(azureDevOpsPullRequestToListItem),
  };
}

async function handler(argv: ArgumentsCamelCase<ListArgs>): Promise<void> {
  const args = validateArgs(ListArgsSchema, argv, 'list arguments');
  const format = args.format ?? 'text';

  try {
    logListRequest(args, format);

    const resolved = await resolvePullRequestList(argv, args);
    if (resolved.autoDiscovered) {
      logProgress(
        `Auto-discovered: ${resolved.result.repositoryLabel}`,
        format
      );
      logProgress('', format);
    }

    console.log(formatPullRequestListOutput(resolved.result, format));
  } catch (error) {
    handleCommandError(error);
  }
}

async function resolvePullRequestList(
  argv: ArgumentsCamelCase<ListArgs>,
  args: ListArgs
): Promise<{
  readonly result: AidePullRequestListResult;
  readonly autoDiscovered: boolean;
}> {
  const hostContext = getAideHostContext(argv);
  const remoteUrl = getGitRemoteUrl();
  const hasExplicitRepoContext =
    args.project !== undefined || args.repo !== undefined;

  if (hostContext && remoteUrl && !hasExplicitRepoContext) {
    const result = await Effect.runPromise(
      hostContext.services.listPullRequestsForRemote(remoteUrl, {
        status: args.status,
        limit: args.limit,
        createdBy: args.createdBy ?? args.author,
      })
    );
    return { result, autoDiscovered: true };
  }

  const ctx = await resolvePlatformContext(args.project, args.repo);
  const result =
    ctx.platform === 'github'
      ? await listGitHubPullRequests(ctx, args)
      : await listAzureDevOpsPullRequests(ctx, args);
  return { result, autoDiscovered: ctx.autoDiscovered };
}

function logListRequest(args: ListArgs, format: OutputFormat): void {
  const { status, limit } = args;
  const createdBy = args.createdBy ?? args.author;

  logProgress('Fetching pull requests...', format);
  if (status) logProgress(`Status: ${status}`, format);
  if (createdBy) logProgress(`Created by: ${createdBy}`, format);
  if (limit) logProgress(`Limit: ${limit}`, format);
  logProgress('', format);
}

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

function githubPullRequestToListItem(
  pr: GitHubPullRequest
): AidePullRequestListItem {
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
  };
}

function azureDevOpsPullRequestToListItem(
  pr: AzureDevOpsPullRequest
): AidePullRequestListItem {
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
  };
}

function repositoryLabel(repository: AidePullRequestRepositoryRef): string {
  switch (repository.kind) {
    case 'github':
      return `${repository.host}/${repository.owner}/${repository.repo}`;
    case 'azure-devops':
      return `${repository.org}/${repository.project}/${repository.repo}`;
    case 'external':
      return repository.displayName;
  }
}

export default {
  command: 'list',
  describe: 'List pull requests',
  builder: {
    project: {
      type: 'string',
      describe: 'Project name (auto-discovered from git remote)',
    },
    repo: {
      type: 'string',
      describe: 'Repository name (auto-discovered from git remote)',
    },
    format: {
      type: 'string',
      choices: ['text', 'json', 'markdown'] as const,
      default: 'text' as const,
      describe: 'Output format',
    },
    status: {
      type: 'string',
      choices: ['active', 'completed', 'abandoned', 'all'] as const,
      default: 'active' as const,
      describe: 'Filter by status',
    },
    limit: {
      type: 'number',
      default: 20,
      describe: 'Maximum number of PRs to return',
    },
    'created-by': {
      type: 'string',
      describe: 'Filter by creator email or display name',
    },
    author: {
      type: 'string',
      describe: 'Alias for --created-by',
    },
  },
  handler,
} satisfies CommandModule<object, ListArgs>;
