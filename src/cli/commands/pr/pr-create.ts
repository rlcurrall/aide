/**
 * PR create command - Create a pull request
 * Supports Azure DevOps (with GitHub support planned)
 * @see https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-requests/create?view=azure-devops-rest-7.2
 */

import {
  MissingRepoContextError,
  buildPrUrl,
  ensureRefPrefix,
  getCurrentBranch,
  getMissingRepoErrorMessage,
  resolveRepoContext,
} from '@lib/ado-utils.js';
import { AzureDevOpsClient } from '@lib/azure-devops-client.js';
import { loadAzureDevOpsConfig } from '@lib/config.js';
import { handleCommandError } from '@lib/errors.js';
import type { AzureDevOpsPullRequest, GitRemoteInfo } from '@lib/types.js';
import { validateArgs } from '@lib/validation.js';
import {
  PrCreateArgsSchema,
  type OutputFormat,
  type PrCreateArgs,
} from '@schemas/pr/pr-create.js';
import type { ArgumentsCamelCase, CommandModule } from 'yargs';

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

async function handler(argv: ArgumentsCamelCase<PrCreateArgs>): Promise<void> {
  const args = validateArgs(PrCreateArgsSchema, argv, 'pr-create arguments');
  const { title, body, draft, format } = args;
  let { head, base } = args;

  // Resolve repository context (auto-discover if needed)
  let project: string;
  let repo: string;
  let repoInfo: GitRemoteInfo | undefined;
  try {
    const context = resolveRepoContext(args.project, args.repo);
    project = context.project;
    repo = context.repo;
    repoInfo = context.repoInfo;
    if (context.autoDiscovered && context.repoInfo && format !== 'json') {
      console.log(
        `Auto-discovered: ${context.repoInfo.org}/${context.repoInfo.project}/${context.repoInfo.repo}`
      );
      console.log('');
    }
  } catch (error) {
    if (error instanceof MissingRepoContextError) {
      console.error(getMissingRepoErrorMessage());
      process.exit(1);
    }
    throw error;
  }

  // Auto-detect source branch from current git branch if not specified
  if (!head) {
    const currentBranch = getCurrentBranch();
    if (currentBranch) {
      head = currentBranch;
      if (format !== 'json') {
        console.log(`Using current branch as head: ${head}`);
      }
    } else {
      console.error('Error: Could not detect current branch.');
      console.error('Please specify --head branch explicitly.');
      process.exit(1);
    }
  }

  // Default target to main if not specified
  if (!base) {
    base = 'main';
    if (format !== 'json') {
      console.log(`Using default base branch: ${base}`);
    }
  }

  // Ensure branch names have refs/heads/ prefix
  const sourceRefName = ensureRefPrefix(head);
  const targetRefName = ensureRefPrefix(base);

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
      body || '',
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
    handleCommandError(error);
  }
}

export default {
  command: 'create',
  describe: 'Create a pull request',
  builder: {
    title: {
      type: 'string',
      describe: 'Pull request title',
      demandOption: true,
      alias: 't',
    },
    body: {
      type: 'string',
      describe: 'Pull request description/body',
      alias: ['b', 'description'],
    },
    head: {
      type: 'string',
      describe:
        'Source/head branch name (auto-detected from current branch if omitted)',
      alias: ['H', 'source', 's', 'source-branch'],
    },
    base: {
      type: 'string',
      describe: 'Target/base branch name (defaults to main)',
      alias: ['B', 'target', 'target-branch'],
    },
    draft: {
      type: 'boolean',
      default: false,
      describe: 'Create as draft pull request',
      alias: 'd',
    },
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
  },
  handler,
} satisfies CommandModule<object, PrCreateArgs>;
