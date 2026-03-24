/**
 * PR create command - Create a pull request
 * Supports Azure DevOps and GitHub
 */

import { MissingRepoContextError, buildPrUrl } from '@lib/ado-utils.js';
import { ensureRefPrefix, getCurrentBranch } from '@lib/git-utils.js';
import { handleCommandError } from '@lib/errors.js';
import type { AzureDevOpsPullRequest, GitRemoteInfo } from '@lib/types.js';
import type { GitHubPullRequest } from '@lib/github-types.js';
import {
  resolvePlatformContext,
  GitHubAuthError,
  type PlatformContext,
} from '@lib/platform.js';
import { getGitHubPRStatus } from '@lib/github-utils.js';
import { validateArgs } from '@lib/validation.js';
import {
  PrCreateArgsSchema,
  type OutputFormat,
  type PrCreateArgs,
} from '@schemas/pr/pr-create.js';
import type { ArgumentsCamelCase, CommandModule } from 'yargs';

// ============================================================================
// Azure DevOps Formatting
// ============================================================================

function formatAdoOutput(
  pr: AzureDevOpsPullRequest,
  format: OutputFormat,
  prUrl: string,
  tags?: string[]
): string {
  if (format === 'json') {
    return JSON.stringify({ ...pr, url: prUrl, tags: tags ?? [] }, null, 2);
  }

  if (format === 'markdown') {
    let output = `# Pull Request Created\n\n`;
    output += `**PR #${pr.pullRequestId}**: ${pr.title}\n\n`;
    output += `- **URL:** ${prUrl}\n`;
    output += `- **Status:** ${pr.status}\n`;
    output += `- **Source:** ${pr.sourceRefName?.replace('refs/heads/', '') || 'N/A'}\n`;
    output += `- **Target:** ${pr.targetRefName?.replace('refs/heads/', '') || 'N/A'}\n`;
    output += `- **Created By:** ${pr.createdBy.displayName}\n`;
    if (tags && tags.length > 0) {
      output += `- **Tags:** ${tags.join(', ')}\n`;
    }
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
  if (tags && tags.length > 0) {
    output += `Tags: ${tags.join(', ')}\n`;
  }

  return output;
}

// ============================================================================
// GitHub Formatting
// ============================================================================

function formatGitHubOutput(
  pr: GitHubPullRequest,
  format: OutputFormat,
  labels?: string[]
): string {
  if (format === 'json') {
    return JSON.stringify({ ...pr, labels: labels ?? [] }, null, 2);
  }

  const status = getGitHubPRStatus(pr);

  if (format === 'markdown') {
    let output = `# Pull Request Created\n\n`;
    output += `**PR #${pr.number}**: ${pr.title}\n\n`;
    output += `- **URL:** ${pr.html_url}\n`;
    output += `- **Status:** ${status}\n`;
    output += `- **Source:** ${pr.head.ref}\n`;
    output += `- **Target:** ${pr.base.ref}\n`;
    output += `- **Created By:** ${pr.user.login}\n`;
    if (labels && labels.length > 0) {
      output += `- **Labels:** ${labels.join(', ')}\n`;
    }
    if (pr.body) {
      output += `\n## Description\n\n${pr.body}\n`;
    }
    return output;
  }

  // Text format
  let output = `Pull Request Created Successfully!\n`;
  output += '='.repeat(50) + '\n\n';
  output += `PR #${pr.number}: ${pr.title}\n\n`;
  output += `URL: ${pr.html_url}\n`;
  output += `Status: ${status}\n`;
  output += `Source: ${pr.head.ref}\n`;
  output += `Target: ${pr.base.ref}\n`;
  output += `Created By: ${pr.user.login}\n`;
  if (labels && labels.length > 0) {
    output += `Labels: ${labels.join(', ')}\n`;
  }

  return output;
}

// ============================================================================
// Handler
// ============================================================================

async function handler(argv: ArgumentsCamelCase<PrCreateArgs>): Promise<void> {
  const args = validateArgs(PrCreateArgsSchema, argv, 'pr-create arguments');
  const { title, body, draft, format, tag: tags } = args;
  let { head, base } = args;

  let ctx: PlatformContext;
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
    if (
      error instanceof MissingRepoContextError ||
      error instanceof GitHubAuthError
    ) {
      console.error(error.message);
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

  if (format !== 'json') {
    console.log('');
    console.log(`Creating pull request...`);
    console.log(`  Title: ${title}`);
    console.log(`  Source: ${head}`);
    console.log(`  Target: ${base}`);
    if (draft) console.log(`  Draft: yes`);
    if (tags && tags.length > 0) console.log(`  Tags: ${tags.join(', ')}`);
    console.log('');
  }

  try {
    if (ctx.platform === 'github') {
      const pr = await ctx.client.createPullRequest(
        ctx.owner,
        ctx.repo,
        head,
        base,
        title,
        body || '',
        { draft }
      );

      // Add labels if specified
      const addedLabels: string[] = [];
      if (tags && tags.length > 0) {
        try {
          await ctx.client.addLabels(ctx.owner, ctx.repo, pr.number, tags);
          addedLabels.push(...tags);
        } catch (error) {
          console.error(
            `Warning: Failed to add labels: ${error instanceof Error ? error.message : error}`
          );
        }
      }

      const output = formatGitHubOutput(pr, format, addedLabels);
      console.log(output);
    } else {
      // Azure DevOps - use refs/heads/ prefix
      const sourceRefName = ensureRefPrefix(head);
      const targetRefName = ensureRefPrefix(base);

      const { loadAzureDevOpsConfig } = await import('@lib/config.js');
      const config = loadAzureDevOpsConfig();

      const pr = await ctx.client.createPullRequest(
        ctx.project,
        ctx.repo,
        sourceRefName,
        targetRefName,
        title,
        body || '',
        { isDraft: draft }
      );

      // Add tags if specified
      const addedTags: string[] = [];
      if (tags && tags.length > 0) {
        for (const tagName of tags) {
          try {
            await ctx.client.addPullRequestLabel(
              ctx.project,
              ctx.repo,
              pr.pullRequestId,
              tagName
            );
            addedTags.push(tagName);
          } catch (error) {
            console.error(
              `Warning: Failed to add tag '${tagName}': ${error instanceof Error ? error.message : error}`
            );
          }
        }
      }

      const repoInfo: GitRemoteInfo = {
        org: ctx.org,
        project: ctx.project,
        repo: ctx.repo,
      };
      const prUrl = buildPrUrl(repoInfo, pr.pullRequestId, config.orgUrl);
      const output = formatAdoOutput(pr, format, prUrl, addedTags);
      console.log(output);
    }
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
    tag: {
      type: 'array',
      string: true,
      describe: 'Add tag(s)/label(s) to the PR',
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
