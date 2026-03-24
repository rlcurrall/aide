/**
 * PR view command - Get details for a pull request
 * Supports Azure DevOps and GitHub
 */

import { MissingRepoContextError, validatePRId } from '@lib/ado-utils.js';
import { extractBranchName } from '@lib/git-utils.js';
import { handleCommandError } from '@lib/errors.js';
import type { AzureDevOpsPullRequest } from '@lib/types.js';
import type { GitHubPullRequest } from '@lib/github-types.js';
import {
  resolvePlatformContext,
  parsePRUrlAny,
  findPRByCurrentBranchAny,
  GitHubAuthError,
  type PlatformContext,
} from '@lib/platform.js';
import { buildGitHubPrUrl, getGitHubPRStatus } from '@lib/github-utils.js';
import { validateArgs } from '@lib/validation.js';
import {
  ViewArgsSchema,
  type OutputFormat,
  type ViewArgs,
} from '@schemas/pr/view.js';
import type { ArgumentsCamelCase, CommandModule } from 'yargs';

// ============================================================================
// Azure DevOps Formatting
// ============================================================================

function formatAdoOutput(
  pr: AzureDevOpsPullRequest,
  format: OutputFormat,
  tags?: string[]
): string {
  if (format === 'json') {
    return JSON.stringify({ ...pr, tags: tags ?? [] }, null, 2);
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
    if (tags && tags.length > 0) {
      output += `| **Tags** | ${tags.join(', ')} |\n`;
    }

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
  if (tags && tags.length > 0) {
    output += `Tags:       ${tags.join(', ')}\n`;
  }

  if (pr.description) {
    output += `\nDescription:\n${'-'.repeat(20)}\n${pr.description}\n`;
  }

  return output;
}

// ============================================================================
// GitHub Formatting
// ============================================================================

function formatGitHubOutput(
  pr: GitHubPullRequest,
  format: OutputFormat,
  url: string
): string {
  if (format === 'json') {
    return JSON.stringify(pr, null, 2);
  }

  const status = getGitHubPRStatus(pr);
  const statusDisplay = pr.draft ? `${status} (draft)` : status;
  const createdDate = new Date(pr.created_at).toLocaleString();
  const labels = pr.labels.map((l) => l.name);

  if (format === 'markdown') {
    let output = `# PR #${pr.number}: ${pr.title}\n\n`;
    output += `| Field | Value |\n`;
    output += `|-------|-------|\n`;
    output += `| **Status** | ${statusDisplay} |\n`;
    output += `| **Author** | ${pr.user.login} |\n`;
    output += `| **Created** | ${createdDate} |\n`;
    output += `| **Source** | ${pr.head.ref} |\n`;
    output += `| **Target** | ${pr.base.ref} |\n`;
    output += `| **URL** | ${url} |\n`;
    if (labels.length > 0) {
      output += `| **Labels** | ${labels.join(', ')} |\n`;
    }

    if (pr.body) {
      output += `\n## Description\n\n${pr.body}\n`;
    }

    return output;
  }

  // Text format
  let output = `PR #${pr.number}: ${pr.title}\n`;
  output += '='.repeat(50) + '\n\n';
  output += `Status:     ${statusDisplay}\n`;
  output += `Author:     ${pr.user.login}\n`;
  output += `Created:    ${createdDate}\n`;
  output += `Source:     ${pr.head.ref}\n`;
  output += `Target:     ${pr.base.ref}\n`;
  output += `URL:        ${url}\n`;
  if (labels.length > 0) {
    output += `Labels:     ${labels.join(', ')}\n`;
  }

  if (pr.body) {
    output += `\nDescription:\n${'-'.repeat(20)}\n${pr.body}\n`;
  }

  return output;
}

// ============================================================================
// Handler
// ============================================================================

async function handler(argv: ArgumentsCamelCase<ViewArgs>): Promise<void> {
  const args = validateArgs(ViewArgsSchema, argv, 'view arguments');
  const { format } = args;

  let ctx: PlatformContext | undefined;
  try {
    ctx = resolvePlatformContext(args.project, args.repo);
    if (ctx.autoDiscovered && format !== 'json') {
      if (ctx.platform === 'github') {
        console.log(`Auto-discovered: github.com/${ctx.owner}/${ctx.repo}`);
      } else {
        console.log(`Auto-discovered: ${ctx.org}/${ctx.project}/${ctx.repo}`);
      }
      console.log('');
    }
  } catch (error) {
    // May still succeed if PR URL is provided
    if (
      !(
        error instanceof MissingRepoContextError ||
        error instanceof GitHubAuthError
      ) ||
      !args.pr?.startsWith('http')
    ) {
      if (
        error instanceof MissingRepoContextError ||
        error instanceof GitHubAuthError
      ) {
        console.error(error.message);
        process.exit(1);
      }
      throw error;
    }
    // Will handle below via URL parsing
    ctx = undefined;
  }

  let prId: number | undefined;

  // Parse PR ID or URL, or auto-detect from current branch
  if (args.pr) {
    if (args.pr.startsWith('http')) {
      const parsed = parsePRUrlAny(args.pr);
      if (!parsed) {
        console.error(`Error: Invalid PR URL: ${args.pr}`);
        console.error('Expected Azure DevOps or GitHub PR URL format.');
        process.exit(1);
      }
      prId = parsed.prId;

      // URL overrides context - rebuild for the right platform
      if (parsed.platform === 'github' && parsed.owner && parsed.ghRepo) {
        const { GitHubClient } = await import('@lib/github-client.js');
        ctx = {
          platform: 'github',
          owner: parsed.owner,
          repo: parsed.ghRepo,
          client: new GitHubClient(),
          autoDiscovered: false,
        };
      } else if (
        parsed.platform === 'azure-devops' &&
        parsed.project &&
        parsed.repo
      ) {
        const { loadAzureDevOpsConfig } = await import('@lib/config.js');
        const { AzureDevOpsClient } = await import(
          '@lib/azure-devops-client.js'
        );
        const config = loadAzureDevOpsConfig();
        ctx = {
          platform: 'azure-devops',
          org: parsed.org ?? '',
          project: parsed.project,
          repo: parsed.repo,
          client: new AzureDevOpsClient(config),
          autoDiscovered: false,
        };
      }
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
    if (!ctx) {
      console.error(
        'Error: Could not determine repository context. Provide a PR ID or full PR URL.'
      );
      process.exit(1);
    }

    const result = await findPRByCurrentBranchAny(ctx);

    if (format !== 'json' && result.branch) {
      console.log(`Searching for PR from branch '${result.branch}'...`);
    }

    if (!result.success) {
      console.error(`Error: ${result.error}`);
      process.exit(1);
    }

    if (ctx.platform === 'github' && result.githubPr) {
      prId = result.githubPr.number;
      if (format !== 'json') {
        console.log(`Found PR #${prId}: ${result.githubPr.title}`);
        console.log('');
      }
    } else if (result.pr) {
      prId = result.pr.pullRequestId;
      if (format !== 'json') {
        console.log(`Found PR #${prId}: ${result.pr.title}`);
        console.log('');
      }
    }
  }

  if (prId === undefined) {
    console.error('Error: Could not determine PR ID.');
    console.error(
      'Please provide a PR ID, full PR URL, or run from a branch with an associated PR.'
    );
    process.exit(1);
  }

  if (!ctx) {
    console.error(
      'Error: Could not determine repository context. Provide a full PR URL.'
    );
    process.exit(1);
  }

  try {
    if (ctx.platform === 'github') {
      const pr = await ctx.client.getPullRequest(ctx.owner, ctx.repo, prId);
      const url = buildGitHubPrUrl(ctx.owner, ctx.repo, prId);
      const output = formatGitHubOutput(pr, format, url);
      console.log(output);
    } else {
      const [pr, labelsResponse] = await Promise.all([
        ctx.client.getPullRequest(ctx.project, ctx.repo, prId),
        ctx.client.getPullRequestLabels(ctx.project, ctx.repo, prId),
      ]);

      const tags = labelsResponse.value
        .filter((l) => l.active)
        .map((l) => l.name);

      const output = formatAdoOutput(pr, format, tags);
      console.log(output);
    }
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
