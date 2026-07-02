/**
 * PR list command - List pull requests
 * Supports Azure DevOps and GitHub
 */

import { Effect } from 'effect';
import type { ArgumentsCamelCase, CommandModule } from 'yargs';

import type { AidePullRequestListResult } from '@cli/host/plugin-descriptor.js';
import { getAideHostContext } from '@cli/host/runtime-context.js';
import { logProgress } from '@lib/cli-utils.js';
import { handleCommandError } from '@lib/errors.js';
import { getGitRemoteUrl } from '@lib/git-utils.js';
import { validateArgs } from '@lib/validation.js';
import {
  ListArgsSchema,
  type ListArgs,
  type OutputFormat,
} from '@schemas/pr/list.js';
import { resolveExplicitPullRequestRepositoryRef } from './repository-ref.js';

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
  if (hostContext === null) {
    throw new Error('Pull request provider services are unavailable.');
  }

  const hasExplicitRepoContext =
    args.project !== undefined || args.repo !== undefined;

  const request = {
    status: args.status,
    limit: args.limit,
    createdBy: args.createdBy ?? args.author,
  };

  if (hasExplicitRepoContext) {
    const { repository, autoDiscovered } =
      await resolveExplicitPullRequestRepositoryRef(args.project, args.repo);
    const result = await Effect.runPromise(
      hostContext.services.listPullRequestsForRepository(repository, request)
    );
    return { result, autoDiscovered };
  }

  const remoteUrl = getGitRemoteUrl();
  if (remoteUrl === null) {
    throw new Error(
      'Could not determine repository context. Run this command from a git repository with a supported remote or specify --project and --repo.'
    );
  }

  const result = await Effect.runPromise(
    hostContext.services.listPullRequestsForRemote(remoteUrl, request)
  );
  return { result, autoDiscovered: true };
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
