/**
 * PR list command - List pull requests
 * Supports Azure DevOps and GitHub
 */

import { MissingRepoContextError } from '@lib/ado-utils.js';
import { handleCommandError } from '@lib/errors.js';
import type { AzureDevOpsPullRequest } from '@lib/types.js';
import type { GitHubPullRequest } from '@lib/github-types.js';
import {
  resolvePlatformContext,
  GitHubAuthError,
  type PlatformContext,
} from '@lib/platform.js';
import {
  getGitHubPRStatus,
  mapStatusToGitHubState,
} from '@lib/github-utils.js';
import { validateArgs } from '@lib/validation.js';
import {
  ListArgsSchema,
  type ListArgs,
  type OutputFormat,
} from '@schemas/pr/list.js';
import type { ArgumentsCamelCase, CommandModule } from 'yargs';

// ============================================================================
// Azure DevOps Formatting
// ============================================================================

function formatAdoOutput(
  prs: AzureDevOpsPullRequest[],
  format: OutputFormat,
  repoInfo?: { project: string; repo: string }
): string {
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
    if (repoInfo) {
      output += ` - ${repoInfo.project}/${repoInfo.repo}`;
    }
    output += `\n\nTotal: ${prs.length} PR${prs.length === 1 ? '' : 's'}\n\n`;

    for (const pr of prs) {
      const date = new Date(pr.creationDate).toISOString().split('T')[0];
      output += `## #${pr.pullRequestId}: ${pr.title}\n`;
      output += `**Status:** ${pr.status} | **Created:** ${date} | **By:** ${pr.createdBy.displayName}\n`;
      if (pr.description) {
        output += `\n${pr.description}\n`;
      }
      output += `\n---\n\n`;
    }

    return output;
  }

  // Text format
  let output = `Pull Requests`;
  if (repoInfo) {
    output += ` - ${repoInfo.project}/${repoInfo.repo}`;
  }
  output += ` (${prs.length} total)\n`;
  output += '='.repeat(70) + '\n\n';

  for (const pr of prs) {
    const date = new Date(pr.creationDate).toLocaleDateString();
    output += `[PR #${pr.pullRequestId}] ${pr.title}\n`;
    output += `  Status: ${pr.status}\n`;
    output += `  Created: ${date} by ${pr.createdBy.displayName}\n`;
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
// GitHub Formatting
// ============================================================================

function formatGitHubOutput(
  prs: GitHubPullRequest[],
  format: OutputFormat,
  repoInfo?: { owner: string; repo: string }
): string {
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
    if (repoInfo) {
      output += ` - ${repoInfo.owner}/${repoInfo.repo}`;
    }
    output += `\n\nTotal: ${prs.length} PR${prs.length === 1 ? '' : 's'}\n\n`;

    for (const pr of prs) {
      const date = new Date(pr.created_at).toISOString().split('T')[0];
      const status = getGitHubPRStatus(pr);
      output += `## #${pr.number}: ${pr.title}\n`;
      output += `**Status:** ${status} | **Created:** ${date} | **By:** ${pr.user.login}\n`;
      if (pr.body) {
        output += `\n${pr.body}\n`;
      }
      output += `\n---\n\n`;
    }

    return output;
  }

  // Text format
  let output = `Pull Requests`;
  if (repoInfo) {
    output += ` - ${repoInfo.owner}/${repoInfo.repo}`;
  }
  output += ` (${prs.length} total)\n`;
  output += '='.repeat(70) + '\n\n';

  for (const pr of prs) {
    const date = new Date(pr.created_at).toLocaleDateString();
    const status = getGitHubPRStatus(pr);
    output += `[PR #${pr.number}] ${pr.title}\n`;
    output += `  Status: ${status}\n`;
    output += `  Created: ${date} by ${pr.user.login}\n`;
    if (pr.body) {
      const shortDesc =
        pr.body.length > 100 ? pr.body.substring(0, 97) + '...' : pr.body;
      output += `  Description: ${shortDesc}\n`;
    }
    output += `\n`;
  }

  return output;
}

// ============================================================================
// Handler
// ============================================================================

async function handleGitHub(
  ctx: Extract<PlatformContext, { platform: 'github' }>,
  args: ListArgs
): Promise<void> {
  const { format, status, limit } = args;
  const createdBy = args.createdBy ?? args.author;

  if (format !== 'json') {
    console.log(`Fetching pull requests...`);
    if (status) console.log(`Status: ${status}`);
    if (createdBy) console.log(`Created by: ${createdBy}`);
    if (limit) console.log(`Limit: ${limit}`);
    console.log('');
  }

  const ghState = mapStatusToGitHubState(status);
  let prs = await ctx.client.listPullRequests(ctx.owner, ctx.repo, {
    state: ghState,
    per_page: limit,
  });

  // For "abandoned" status, filter to closed-but-not-merged
  if (status === 'abandoned') {
    prs = prs.filter((pr) => !pr.merged);
  }
  // For "completed" status, filter to merged only
  if (status === 'completed') {
    prs = prs.filter((pr) => pr.merged);
  }

  // Apply limit after client-side filtering
  if (limit && prs.length > limit) {
    prs = prs.slice(0, limit);
  }

  // Client-side filtering by creator
  if (createdBy) {
    const searchTerm = createdBy.toLowerCase();
    prs = prs.filter((pr) => pr.user.login.toLowerCase().includes(searchTerm));
  }

  const output = formatGitHubOutput(prs, format ?? 'text', {
    owner: ctx.owner,
    repo: ctx.repo,
  });
  console.log(output);
}

async function handleAdo(
  ctx: Extract<PlatformContext, { platform: 'azure-devops' }>,
  args: ListArgs
): Promise<void> {
  const { format, status, limit } = args;
  const createdBy = args.createdBy ?? args.author;

  if (format !== 'json') {
    console.log(`Fetching pull requests...`);
    if (status) console.log(`Status: ${status}`);
    if (createdBy) console.log(`Created by: ${createdBy}`);
    if (limit) console.log(`Limit: ${limit}`);
    console.log('');
  }

  const response = await ctx.client.listPullRequests(ctx.project, ctx.repo, {
    status,
    top: limit,
  });

  let prs = response.value;

  // Client-side filtering by creator
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

  const output = formatAdoOutput(prs, format ?? 'text', {
    project: ctx.project,
    repo: ctx.repo,
  });
  console.log(output);
}

async function handler(argv: ArgumentsCamelCase<ListArgs>): Promise<void> {
  const args = validateArgs(ListArgsSchema, argv, 'list arguments');

  let ctx: PlatformContext;
  try {
    ctx = resolvePlatformContext(args.project, args.repo);
    if (ctx.autoDiscovered && args.format !== 'json') {
      if (ctx.platform === 'github') {
        console.log(`Auto-discovered: github.com/${ctx.owner}/${ctx.repo}`);
      } else {
        console.log(`Auto-discovered: ${ctx.org}/${ctx.project}/${ctx.repo}`);
      }
      console.log('');
    }
  } catch (error) {
    if (
      error instanceof MissingRepoContextError ||
      error instanceof GitHubAuthError
    ) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  try {
    if (ctx.platform === 'github') {
      await handleGitHub(ctx, args);
    } else {
      await handleAdo(ctx, args);
    }
  } catch (error) {
    handleCommandError(error);
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
