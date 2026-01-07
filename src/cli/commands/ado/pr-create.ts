/**
 * ADO pr create command - Create an Azure DevOps pull request
 * @see https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-requests/create?view=azure-devops-rest-7.2
 */

import type { CommandModule, ArgumentsCamelCase } from 'yargs';
import { loadAzureDevOpsConfig } from '@lib/config.js';
import { AzureDevOpsClient } from '@lib/azure-devops-client.js';
import { discoverRepoInfo, getCurrentBranch } from '@lib/ado-utils.js';
import type { AzureDevOpsPullRequest, GitRemoteInfo } from '@lib/types.js';

type OutputFormat = 'text' | 'json' | 'markdown';

export interface PrCreateArgv {
  title: string;
  description?: string;
  source?: string;
  target?: string;
  draft?: boolean;
  project?: string;
  repo?: string;
  format: OutputFormat;
}

/**
 * Ensure branch name has refs/heads/ prefix
 */
function ensureRefPrefix(branch: string): string {
  if (branch.startsWith('refs/heads/')) {
    return branch;
  }
  return `refs/heads/${branch}`;
}

/**
 * Build the PR URL for Azure DevOps
 */
function buildPrUrl(
  repoInfo: GitRemoteInfo,
  prId: number,
  orgUrl?: string
): string {
  // Use the org URL from config if available, otherwise construct from repoInfo
  const baseUrl = orgUrl
    ? orgUrl.replace(/\/$/, '')
    : `https://dev.azure.com/${repoInfo.org}`;
  return `${baseUrl}/${encodeURIComponent(repoInfo.project)}/_git/${encodeURIComponent(repoInfo.repo)}/pullrequest/${prId}`;
}

/**
 * Format PR creation output based on format type
 */
function formatOutput(
  pr: AzureDevOpsPullRequest,
  format: OutputFormat,
  prUrl: string
): string {
  if (format === 'json') {
    return JSON.stringify({ ...pr, url: prUrl }, null, 2);
  }

  if (format === 'markdown') {
    let output = `# Pull Request Created\n\n`;
    output += `**PR #${pr.pullRequestId}**: ${pr.title}\n\n`;
    output += `- **URL:** ${prUrl}\n`;
    output += `- **Status:** ${pr.status}\n`;
    output += `- **Source:** ${pr.sourceRefName?.replace('refs/heads/', '') || 'N/A'}\n`;
    output += `- **Target:** ${pr.targetRefName?.replace('refs/heads/', '') || 'N/A'}\n`;
    output += `- **Created By:** ${pr.createdBy.displayName}\n`;
    if (pr.description) {
      output += `\n## Description\n\n${pr.description}\n`;
    }
    return output;
  }

  // Text format
  let output = `Pull Request Created Successfully!\n`;
  output += '='.repeat(50) + '\n\n';
  output += `PR #${pr.pullRequestId}: ${pr.title}\n\n`;
  output += `URL: ${prUrl}\n`;
  output += `Status: ${pr.status}\n`;
  output += `Source: ${pr.sourceRefName?.replace('refs/heads/', '') || 'N/A'}\n`;
  output += `Target: ${pr.targetRefName?.replace('refs/heads/', '') || 'N/A'}\n`;
  output += `Created By: ${pr.createdBy.displayName}\n`;

  return output;
}

async function handler(argv: ArgumentsCamelCase<PrCreateArgv>): Promise<void> {
  let { project, repo } = argv;
  const { title, description, draft, format } = argv;
  let { source, target } = argv;

  // Auto-discover from git remote if not specified
  let repoInfo: GitRemoteInfo | null = null;
  if (!project || !repo) {
    repoInfo = discoverRepoInfo();
    if (repoInfo) {
      project = project || repoInfo.project;
      repo = repo || repoInfo.repo;
      if (format !== 'json') {
        console.log(
          `Auto-discovered: ${repoInfo.org}/${repoInfo.project}/${repoInfo.repo}`
        );
      }
    }
  }

  // Validate we have project and repo
  if (!project || !repo) {
    console.error('Error: Could not determine project and repository.');
    console.error('');
    console.error('Either:');
    console.error(
      '  1. Run this command from within a git repository with Azure DevOps remote'
    );
    console.error('  2. Specify --project and --repo flags explicitly');
    process.exit(1);
  }

  // Auto-detect source branch from current git branch if not specified
  if (!source) {
    const currentBranch = getCurrentBranch();
    if (currentBranch) {
      source = currentBranch;
      if (format !== 'json') {
        console.log(`Using current branch as source: ${source}`);
      }
    } else {
      console.error('Error: Could not detect current branch.');
      console.error('Please specify --source branch explicitly.');
      process.exit(1);
    }
  }

  // Default target to main if not specified
  if (!target) {
    target = 'main';
    if (format !== 'json') {
      console.log(`Using default target branch: ${target}`);
    }
  }

  // Ensure branch names have refs/heads/ prefix
  const sourceRefName = ensureRefPrefix(source);
  const targetRefName = ensureRefPrefix(target);

  if (format !== 'json') {
    console.log('');
    console.log(`Creating pull request...`);
    console.log(`  Title: ${title}`);
    console.log(`  Source: ${sourceRefName}`);
    console.log(`  Target: ${targetRefName}`);
    if (draft) console.log(`  Draft: yes`);
    console.log('');
  }

  try {
    const config = loadAzureDevOpsConfig();
    const client = new AzureDevOpsClient(config);

    const pr = await client.createPullRequest(
      project,
      repo,
      sourceRefName,
      targetRefName,
      title,
      description || '',
      {
        isDraft: draft,
      }
    );

    // Build PR URL
    const prUrl = buildPrUrl(
      repoInfo || { org: '', project, repo },
      pr.pullRequestId,
      config.orgUrl
    );

    // Format and output
    const output = formatOutput(pr, format, prUrl);
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

export const prCreateCommand: CommandModule<object, PrCreateArgv> = {
  command: 'create',
  describe: 'Create an Azure DevOps pull request',
  builder: {
    title: {
      type: 'string',
      describe: 'Pull request title',
      demandOption: true,
      alias: 't',
    },
    description: {
      type: 'string',
      describe: 'Pull request description',
      alias: 'd',
    },
    source: {
      type: 'string',
      describe:
        'Source branch name (auto-detected from current branch if omitted)',
      alias: 's',
    },
    target: {
      type: 'string',
      describe: 'Target branch name (defaults to main)',
      alias: 'b',
    },
    draft: {
      type: 'boolean',
      default: false,
      describe: 'Create as draft pull request',
    },
    project: {
      type: 'string',
      describe: 'Azure DevOps project name (auto-discovered from git remote)',
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
  },
  handler,
};
