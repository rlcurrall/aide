/**
 * PR comment command - Post a comment on a pull request
 * Supports Azure DevOps and GitHub
 * @see https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-threads/create?view=azure-devops-rest-7.1
 * @see https://docs.github.com/en/rest/issues/comments
 * @see https://docs.github.com/en/rest/pulls/comments
 */

import { MissingRepoContextError } from '@lib/ado-utils.js';
import { handleCommandError } from '@lib/errors.js';
import type {
  GitHubIssueComment,
  GitHubReviewComment,
} from '@lib/github-types.js';
import {
  resolvePlatformContext,
  resolvePRId,
  GitHubAuthError,
  type PlatformContext,
} from '@lib/platform.js';
import type { CreateThreadResponse } from '@lib/types.js';
import { validateArgs } from '@lib/validation.js';
import {
  PrCommentArgsSchema,
  type OutputFormat,
  type PrCommentArgs,
} from '@schemas/pr/pr-comment.js';
import type { ArgumentsCamelCase, Argv, CommandModule } from 'yargs';

// ============================================================================
// Azure DevOps Output Formatting
// ============================================================================

/**
 * Format ADO thread response for output
 */
function formatAdoOutput(
  thread: CreateThreadResponse,
  format: OutputFormat,
  prId: number,
  filePath?: string,
  line?: number
): string {
  if (format === 'json') {
    return JSON.stringify(thread, null, 2);
  }

  const comment = thread.comments[0];
  const date = new Date(thread.publishedDate).toISOString().split('T')[0];
  const locationInfo = filePath
    ? ` on ${filePath}${line ? `:${line}` : ''}`
    : '';

  if (format === 'markdown') {
    let output = `# Comment Posted on PR #${prId}\n\n`;
    output += `**Thread ID:** ${thread.id}\n`;
    output += `**Status:** ${thread.status}\n`;
    output += `**Date:** ${date}\n`;
    if (filePath) {
      output += `**Location:** \`${filePath}\``;
      if (line) {
        output += ` (line ${line}${thread.threadContext?.rightFileEnd?.line && thread.threadContext.rightFileEnd.line !== line ? `-${thread.threadContext.rightFileEnd.line}` : ''})`;
      }
      output += '\n';
    }
    output += `\n---\n\n`;
    output += `${comment?.content || ''}\n`;

    return output;
  }

  // Text format
  let output = `Comment posted successfully${locationInfo}!\n`;
  output += '='.repeat(50) + '\n\n';
  output += `Thread ID: ${thread.id}\n`;
  output += `PR: #${prId}\n`;
  output += `Status: ${thread.status}\n`;
  output += `Date: ${date}\n`;
  if (filePath) {
    output += `File: ${filePath}`;
    if (line) {
      output += `:${line}`;
      if (
        thread.threadContext?.rightFileEnd?.line &&
        thread.threadContext.rightFileEnd.line !== line
      ) {
        output += `-${thread.threadContext.rightFileEnd.line}`;
      }
    }
    output += '\n';
  }
  output += `\nComment:\n  ${comment?.content || ''}\n`;

  return output;
}

// ============================================================================
// GitHub Output Formatting
// ============================================================================

/**
 * Format a GitHub comment response for output.
 * Handles both issue comments (general) and review comments (file-level).
 */
function formatGitHubOutput(
  response: GitHubIssueComment | GitHubReviewComment,
  format: OutputFormat,
  prId: number,
  filePath?: string,
  line?: number
): string {
  const isReview = 'path' in response && !!response.path;

  if (format === 'json') {
    return JSON.stringify(response, null, 2);
  }

  const date = new Date(response.created_at).toISOString().split('T')[0];
  const author = response.user.login;
  const locationInfo = filePath
    ? ` on ${filePath}${line ? `:${line}` : ''}`
    : '';

  if (format === 'markdown') {
    let output = `# Comment Posted on PR #${prId}\n\n`;
    output += `**Comment ID:** ${response.id}\n`;
    output += `**Type:** ${isReview ? 'Review comment' : 'Issue comment'}\n`;
    output += `**Author:** ${author}\n`;
    output += `**Date:** ${date}\n`;
    if (filePath) {
      output += `**Location:** \`${filePath}\``;
      if (line) {
        output += ` (line ${line})`;
      }
      output += '\n';
    }
    output += `**URL:** ${response.html_url}\n`;
    output += `\n---\n\n`;
    output += `${response.body}\n`;

    return output;
  }

  // Text format
  let output = `Comment posted successfully${locationInfo}!\n`;
  output += '='.repeat(50) + '\n\n';
  output += `Comment ID: ${response.id}\n`;
  output += `Type: ${isReview ? 'Review comment' : 'Issue comment'}\n`;
  output += `PR: #${prId}\n`;
  output += `Author: ${author}\n`;
  output += `Date: ${date}\n`;
  if (filePath) {
    output += `File: ${filePath}`;
    if (line) {
      output += `:${line}`;
    }
    output += '\n';
  }
  output += `URL: ${response.html_url}\n`;
  output += `\nComment:\n  ${response.body}\n`;

  return output;
}

// ============================================================================
// Command Handler
// ============================================================================

async function handler(argv: ArgumentsCamelCase<PrCommentArgs>): Promise<void> {
  const args = validateArgs(PrCommentArgsSchema, argv, 'pr-comment arguments');
  const { format, comment, file, line, endLine } = args;

  // Validate file/line requirements
  if (file && !line) {
    console.error('Error: --line is required when --file is specified.');
    console.error(
      'To comment on a specific file location, provide both --file and --line.'
    );
    process.exit(1);
  }

  if (line && !file) {
    console.error('Error: --file is required when --line is specified.');
    console.error(
      'To comment on a specific file location, provide both --file and --line.'
    );
    process.exit(1);
  }

  if (endLine && !line) {
    console.error('Error: --line is required when --end-line is specified.');
    process.exit(1);
  }

  // Resolve platform context
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

  // Resolve PR ID
  const resolved = await resolvePRId(args.pr, ctx, format);
  const prId = resolved.prId;
  ctx = resolved.ctx;

  try {
    if (format !== 'json') {
      console.log(`Posting comment to PR #${prId}...`);
      if (file) {
        console.log(`File: ${file}`);
        console.log(`Line: ${line}${endLine ? `-${endLine}` : ''}`);
      }
      console.log('');
    }

    if (ctx.platform === 'github') {
      // GitHub path
      const { owner, repo } = ctx;
      let response: GitHubIssueComment | GitHubReviewComment;

      if (file && line) {
        // File-specific review comment: need the head SHA from the PR
        const pr = await ctx.client.getPullRequest(owner, repo, prId);
        const commitId = pr.head.sha;

        // GitHub file paths should not have a leading '/'
        const ghFilePath = file.startsWith('/') ? file.slice(1) : file;

        response = await ctx.client.createReviewComment(
          owner,
          repo,
          prId,
          comment,
          {
            path: ghFilePath,
            line,
            commit_id: commitId,
            ...(endLine ? { start_line: line, line: endLine } : {}),
          }
        );
      } else {
        // General issue comment
        response = await ctx.client.createIssueComment(
          owner,
          repo,
          prId,
          comment
        );
      }

      const output = formatGitHubOutput(response, format, prId, file, line);
      console.log(output);
    } else {
      // Azure DevOps path
      const thread = await ctx.client.createPullRequestThread(
        ctx.project,
        ctx.repo,
        prId,
        comment,
        file && line
          ? {
              filePath: file,
              line,
              endLine,
            }
          : undefined
      );

      const output = formatAdoOutput(thread, format, prId, file, line);
      console.log(output);
    }
  } catch (error) {
    handleCommandError(error);
  }
}

export default {
  command: 'comment <comment>',
  describe: 'Post a comment on a pull request',
  builder: (yargs: Argv) =>
    yargs
      .positional('comment', {
        type: 'string',
        demandOption: true,
        describe: 'Comment text to post',
        coerce: (val: unknown) => (val !== undefined ? String(val) : undefined),
      })
      .option('pr', {
        type: 'string',
        describe:
          'PR ID or full PR URL (auto-detected from current branch if omitted)',
        coerce: (val: unknown) => (val !== undefined ? String(val) : undefined),
      })
      .option('project', {
        type: 'string',
        describe: 'Project name (auto-discovered from git remote)',
      })
      .option('repo', {
        type: 'string',
        describe: 'Repository name (auto-discovered from git remote)',
      })
      .option('format', {
        type: 'string',
        choices: ['text', 'json', 'markdown'] as const,
        default: 'text' as const,
        describe: 'Output format',
      })
      .option('file', {
        type: 'string',
        describe: 'File path for file-specific comment (requires --line)',
      })
      .option('line', {
        type: 'number',
        describe: 'Line number for file-specific comment (requires --file)',
      })
      .option('end-line', {
        type: 'number',
        describe: 'End line number for multi-line comment range',
      }) as Argv<PrCommentArgs>,
  handler,
} satisfies CommandModule<object, PrCommentArgs>;
