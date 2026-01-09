/**
 * PR list command - List pull requests
 * Supports Azure DevOps (with GitHub support planned)
 * @see https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-requests/list?view=azure-devops-rest-7.1
 */

import type { CommandModule, ArgumentsCamelCase } from 'yargs';
import { loadAzureDevOpsConfig } from '@lib/config.js';
import { AzureDevOpsClient } from '@lib/azure-devops-client.js';
import { discoverRepoInfo } from '@lib/ado-utils.js';
import type { AzureDevOpsPullRequest } from '@lib/types.js';
import { validateArgs } from '@lib/validation.js';
import {
  PrsArgsSchema,
  type PrsArgs,
  type OutputFormat,
} from '@schemas/pr/list.js';

/**
 * Format PR list output based on format type
 */
function formatOutput(
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

async function handler(argv: ArgumentsCamelCase<PrsArgs>): Promise<void> {
  const args = validateArgs(PrsArgsSchema, argv, 'list arguments');
  let { project, repo } = args;
  const { format, status, limit } = args;
  const createdBy = args.createdBy ?? args.author;

  // Auto-discover from git remote if not specified
  if (!project || !repo) {
    const discovered = discoverRepoInfo();
    if (discovered) {
      project = project || discovered.project;
      repo = repo || discovered.repo;
      if (format !== 'json') {
        console.log(
          `Auto-discovered: ${discovered.org}/${discovered.project}/${discovered.repo}`
        );
        console.log('');
      }
    }
  }

  // Validate we have all required info
  if (!project || !repo) {
    console.error('Error: Could not determine project and repository.');
    console.error('');
    console.error('Either:');
    console.error(
      '  1. Run this command from within a git repository with a supported remote (Azure DevOps)'
    );
    console.error('  2. Specify --project and --repo flags explicitly');
    process.exit(1);
  }

  try {
    const config = loadAzureDevOpsConfig();
    const client = new AzureDevOpsClient(config);

    if (format !== 'json') {
      console.log(`Fetching pull requests...`);
      if (status) console.log(`Status: ${status}`);
      if (createdBy) console.log(`Created by: ${createdBy}`);
      if (limit) console.log(`Limit: ${limit}`);
      console.log('');
    }

    // Fetch PRs
    const response = await client.listPullRequests(project, repo, {
      status,
      top: limit,
    });

    let prs = response.value;

    // Client-side filtering by creator (since API only supports ID, not name)
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

    // Format and output
    const output = formatOutput(prs, format, { project, repo });
    console.log(output);
  } catch (error) {
    if (error instanceof Error) {
      console.error(`Error: ${error.message}`);
    } else {
      console.error('Error: Unknown error occurred');
    }
    process.exit(1);
  }
}

export const listCommand: CommandModule<object, PrsArgs> = {
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
};
