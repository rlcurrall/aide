/**
 * PR reply command - Reply to a comment thread on a pull request
 * Supports Azure DevOps and GitHub
 * @see https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-thread-comments/create?view=azure-devops-rest-7.1
 * @see https://docs.github.com/en/rest/pulls/comments#create-a-reply-for-a-review-comment
 */

import { MissingRepoContextError } from '@lib/ado-utils.js';
import { handleCommandError } from '@lib/errors.js';
import type { GitHubReviewComment } from '@lib/github-types.js';
import {
  resolvePlatformContext,
  resolvePRId,
  GitHubAuthError,
  type PlatformContext,
} from '@lib/platform.js';
import type { AzureDevOpsCreateCommentResponse } from '@lib/types.js';
import { validateArgs } from '@lib/validation.js';
import {
  PrReplyArgsSchema,
  type OutputFormat,
  type PrReplyArgs,
} from '@schemas/pr/pr-reply.js';
import type { ArgumentsCamelCase, Argv, CommandModule } from 'yargs';

// ============================================================================
// Azure DevOps Output Formatting
// ============================================================================

/**
 * Format the ADO reply output based on format type
 */
function formatAdoOutput(
  comment: AzureDevOpsCreateCommentResponse,
  format: OutputFormat,
  prId: number,
  threadId: number
): string {
  if (format === 'json') {
    return JSON.stringify(
      {
        success: true,
        prId,
        threadId,
        commentId: comment.id,
        parentCommentId: comment.parentCommentId,
        content: comment.content,
        author: comment.author.displayName,
        publishedDate: comment.publishedDate,
      },
      null,
      2
    );
  }

  if (format === 'markdown') {
    let output = `# Reply Posted Successfully\n\n`;
    output += `- **PR:** #${prId}\n`;
    output += `- **Thread ID:** ${threadId}\n`;
    output += `- **Comment ID:** ${comment.id}\n`;
    if (comment.parentCommentId > 0) {
      output += `- **Parent Comment ID:** ${comment.parentCommentId}\n`;
    }
    output += `- **Author:** ${comment.author.displayName}\n`;
    output += `- **Posted:** ${new Date(comment.publishedDate).toLocaleString()}\n\n`;
    output += `## Content\n\n${comment.content}`;
    return output;
  }

  // Text format
  let output = `Reply posted successfully!\n`;
  output += `PR #${prId} | Thread ${threadId} | Comment ID: ${comment.id}\n`;
  if (comment.parentCommentId > 0) {
    output += `In reply to comment #${comment.parentCommentId}\n`;
  }
  output += `Posted by: ${comment.author.displayName}\n`;
  output += `Posted at: ${new Date(comment.publishedDate).toLocaleString()}`;
  return output;
}

// ============================================================================
// GitHub Output Formatting
// ============================================================================

/**
 * Format the GitHub reply output based on format type
 */
function formatGitHubReplyOutput(
  comment: GitHubReviewComment,
  format: OutputFormat,
  prId: number,
  commentId: number
): string {
  if (format === 'json') {
    return JSON.stringify(
      {
        success: true,
        prId,
        inReplyToCommentId: commentId,
        commentId: comment.id,
        body: comment.body,
        author: comment.user.login,
        createdAt: comment.created_at,
        url: comment.html_url,
      },
      null,
      2
    );
  }

  const date = new Date(comment.created_at).toISOString().split('T')[0];

  if (format === 'markdown') {
    let output = `# Reply Posted Successfully\n\n`;
    output += `- **PR:** #${prId}\n`;
    output += `- **In Reply To:** comment ${commentId}\n`;
    output += `- **Comment ID:** ${comment.id}\n`;
    output += `- **Author:** ${comment.user.login}\n`;
    output += `- **Date:** ${date}\n`;
    output += `- **URL:** ${comment.html_url}\n\n`;
    output += `## Content\n\n${comment.body}`;
    return output;
  }

  // Text format
  let output = `Reply posted successfully!\n`;
  output += `PR #${prId} | In reply to comment ${commentId} | Comment ID: ${comment.id}\n`;
  output += `Author: ${comment.user.login}\n`;
  output += `Date: ${date}\n`;
  output += `URL: ${comment.html_url}`;
  return output;
}

// ============================================================================
// Command Handler
// ============================================================================

async function handler(argv: ArgumentsCamelCase<PrReplyArgs>): Promise<void> {
  const args = validateArgs(PrReplyArgsSchema, argv, 'pr-reply arguments');
  const { format, thread, parent, replyText } = args;

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
    if (ctx.platform === 'github') {
      // GitHub path
      // On GitHub, the thread parameter is a review comment ID.
      // GitHub only supports one level of threading, so --parent doesn't apply.
      if (parent !== undefined && parent > 0) {
        console.warn(
          'Warning: --parent is ignored on GitHub. GitHub review comment threads only support one level of nesting.'
        );
      }

      if (format !== 'json') {
        console.log(`Posting reply to PR #${prId}, comment ${thread}...`);
        console.log('');
      }

      const response = await ctx.client.replyToReviewComment(
        ctx.owner,
        ctx.repo,
        prId,
        thread,
        replyText
      );

      const output = formatGitHubReplyOutput(response, format, prId, thread);
      console.log(output);
    } else {
      // Azure DevOps path
      if (format !== 'json') {
        console.log(`Posting reply to PR #${prId}, thread ${thread}...`);
        if (parent !== undefined && parent > 0) {
          console.log(`Replying to comment #${parent}`);
        }
        console.log('');
      }

      const response = await ctx.client.createThreadComment(
        ctx.project,
        ctx.repo,
        prId,
        thread,
        replyText,
        parent
      );

      const output = formatAdoOutput(response, format, prId, thread);
      console.log(output);
    }
  } catch (error) {
    handleCommandError(error);
  }
}

export default {
  command: 'reply <thread> <replyText>',
  describe: 'Reply to a comment thread on a pull request',
  builder: (yargs: Argv) =>
    yargs
      .positional('thread', {
        type: 'number',
        describe: 'Thread ID to reply to',
        demandOption: true,
      })
      .positional('replyText', {
        type: 'string',
        describe: 'The reply text content',
        demandOption: true,
        coerce: (val: unknown) => (val !== undefined ? String(val) : undefined),
      })
      .option('pr', {
        type: 'string',
        describe:
          'PR ID or full PR URL (auto-detected from current branch if omitted)',
        coerce: (val: unknown) => (val !== undefined ? String(val) : undefined),
      })
      .option('parent', {
        type: 'number',
        describe:
          'Parent comment ID to reply to a specific comment (optional, 0 or omit for root-level reply)',
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
      }) as Argv<PrReplyArgs>,
  handler,
} satisfies CommandModule<object, PrReplyArgs>;
