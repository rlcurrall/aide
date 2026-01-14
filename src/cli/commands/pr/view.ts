/**
 * PR view command - Get details for a pull request
 * Supports Azure DevOps (with GitHub support planned)
 * @see https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-requests/get-pull-request
 */

import {
  extractBranchName,
  findPRByCurrentBranch,
  parsePRUrl,
  printMissingRepoError,
  resolveRepoContext,
  validatePRId,
} from '@lib/ado-utils.js';
import { AzureDevOpsClient } from '@lib/azure-devops-client.js';
import { loadAzureDevOpsConfig } from '@lib/config.js';
import { handleCommandError } from '@lib/errors.js';
import type { AzureDevOpsPullRequest } from '@lib/types.js';
import { validateArgs } from '@lib/validation.js';
import {
  ViewArgsSchema,
  type OutputFormat,
  type ViewArgs,
} from '@schemas/pr/view.js';
import type { ArgumentsCamelCase, CommandModule } from 'yargs';

/**
 * Format PR details based on output format
 */
function formatOutput(
  pr: AzureDevOpsPullRequest,
  format: OutputFormat
): string {
  if (format === 'json') {
    return JSON.stringify(pr, null, 2);
  }

  const sourceBranch = extractBranchName(pr.sourceRefName);
  const targetBranch = extractBranchName(pr.targetRefName);
  const createdDate = new Date(pr.creationDate).toLocaleString();
  const statusDisplay = pr.isDraft ? `${pr.status} (draft)` : pr.status;

  if (format === 'markdown') {
    let output = `# PR #${pr.pullRequestId}: ${pr.title}\n\n`;
    output += `| Field | Value |\n`;
    output += `|-------|-------|\n`;
    output += `| **Status** | ${statusDisplay} |\n`;
    output += `| **Author** | ${pr.createdBy.displayName} |\n`;
    output += `| **Created** | ${createdDate} |\n`;
    output += `| **Source** | ${sourceBranch} |\n`;
    output += `| **Target** | ${targetBranch} |\n`;
    output += `| **Repository** | ${pr.repository.name} |\n`;
    output += `| **Project** | ${pr.repository.project.name} |\n`;

    if (pr.description) {
      output += `\n## Description\n\n${pr.description}\n`;
    }

    return output;
  }

  // Text format
  let output = `PR #${pr.pullRequestId}: ${pr.title}\n`;
  output += '='.repeat(50) + '\n\n';
  output += `Status:     ${statusDisplay}\n`;
  output += `Author:     ${pr.createdBy.displayName}\n`;
  output += `Created:    ${createdDate}\n`;
  output += `Source:     ${sourceBranch}\n`;
  output += `Target:     ${targetBranch}\n`;
  output += `Repository: ${pr.repository.name}\n`;
  output += `Project:    ${pr.repository.project.name}\n`;

  if (pr.description) {
    output += `\nDescription:\n${'-'.repeat(20)}\n${pr.description}\n`;
  }

  return output;
}

async function handler(argv: ArgumentsCamelCase<ViewArgs>): Promise<void> {
  const args = validateArgs(ViewArgsSchema, argv, 'view arguments');
  let prId: number | undefined;
  let project: string | undefined = args.project;
  let repo: string | undefined = args.repo;
  const { format } = args;

  // Try auto-discover project/repo from git remote first (needed for PR auto-detection)
  try {
    const context = resolveRepoContext(project, repo, { format });
    project = context.project;
    repo = context.repo;
  } catch {
    // May still succeed if PR URL is provided
  }

  // Parse PR ID or URL, or auto-detect from current branch
  if (args.pr) {
    if (args.pr.startsWith('http')) {
      const parsed = parsePRUrl(args.pr);
      if (!parsed) {
        console.error(
          `Error: Invalid PR URL (expected Azure DevOps format): ${args.pr}`
        );
        console.error(
          'Expected format: https://dev.azure.com/{org}/{project}/_git/{repo}/pullrequest/{id}'
        );
        process.exit(1);
      }
      prId = parsed.prId;
      // URL overrides discovered project/repo
      project = parsed.project;
      repo = parsed.repo;
    } else {
      const validation = validatePRId(args.pr);
      if (validation.valid) {
        prId = validation.value;
      } else {
        console.error(
          `Error: Could not parse '${args.pr}' as a PR ID. Expected a positive number or full PR URL.`
        );
        process.exit(1);
      }
    }
  } else {
    // No PR ID provided - auto-detect from current branch
    if (!project || !repo) {
      printMissingRepoError('Provide a PR ID or full PR URL');
      process.exit(1);
    }

    const result = await findPRByCurrentBranch(project, repo);

    if (format !== 'json' && result.branch) {
      console.log(`Searching for PR from branch '${result.branch}'...`);
    }

    if (!result.success || !result.pr) {
      console.error(`Error: ${result.error}`);
      process.exit(1);
    }

    prId = result.pr.pullRequestId;
    if (format !== 'json') {
      console.log(`Found PR #${prId}: ${result.pr.title}`);
      console.log('');
    }
  }

  // Validate we have project/repo
  if (!project || !repo) {
    printMissingRepoError('Provide a full PR URL');
    process.exit(1);
  }

  // Validate prId is set
  if (prId === undefined) {
    console.error('Error: Could not determine PR ID.');
    console.error(
      'Please provide a PR ID, full PR URL, or run from a branch with an associated PR.'
    );
    process.exit(1);
  }

  try {
    const config = loadAzureDevOpsConfig();
    const client = new AzureDevOpsClient(config);

    const pr = await client.getPullRequest(project, repo, prId);
    const output = formatOutput(pr, format);
    console.log(output);
  } catch (error) {
    handleCommandError(error);
  }
}

export default {
  command: 'view',
  describe: 'View pull request details',
  builder: {
    pr: {
      type: 'string',
      describe:
        'PR ID or full PR URL (auto-detected from current branch if omitted)',
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
} satisfies CommandModule<object, ViewArgs>;
