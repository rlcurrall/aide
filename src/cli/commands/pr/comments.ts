/**
 * PR comments command - Get comments from a pull request
 * Supports Azure DevOps and GitHub
 * @see https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-threads?view=azure-devops-rest-7.1
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
import type { AdoFlattenedComment } from '@lib/types.js';
import { validateArgs } from '@lib/validation.js';
import {
  CommentsArgsSchema,
  type CommentsArgs,
  type OutputFormat,
} from '@schemas/pr/comments.js';
import type { ArgumentsCamelCase, CommandModule } from 'yargs';

// ============================================================================
// Shared Types
// ============================================================================

/**
 * Represents an ADO thread with its root comment and replies grouped together
 */
interface GroupedThread {
  threadId: number;
  threadStatus: string;
  filePath?: string;
  lineNumber?: number;
  rootComment: AdoFlattenedComment | null;
  replies: AdoFlattenedComment[];
}

/**
 * Represents a GitHub thread (review comment thread or standalone issue comment)
 */
interface GitHubGroupedThread {
  threadId: number | string;
  filePath?: string;
  lineNumber?: number | null;
  rootComment: {
    author: string;
    body: string;
    date: string;
    id: number;
    type: 'review' | 'issue';
  };
  replies: Array<{ author: string; body: string; date: string; id: number }>;
}

// ============================================================================
// Azure DevOps Comment Helpers
// ============================================================================

/**
 * Filter ADO comments based on provided criteria
 */
function filterComments(
  comments: AdoFlattenedComment[],
  filter: {
    author?: string;
    sinceDate?: string;
    latest?: number;
    includeSystem?: boolean;
    threadStatus?: string;
  }
): AdoFlattenedComment[] {
  let filtered = [...comments];

  // Filter by comment type
  if (!filter.includeSystem) {
    filtered = filtered.filter((c) => c.comment.commentType !== 'system');
  }

  // Filter by thread status
  if (filter.threadStatus) {
    filtered = filtered.filter(
      (c) => c.threadStatus.toLowerCase() === filter.threadStatus!.toLowerCase()
    );
  }

  // Filter by author
  if (filter.author) {
    const authorLower = filter.author.toLowerCase();
    filtered = filtered.filter((c) => {
      const displayName = c.comment.author?.displayName?.toLowerCase() || '';
      const uniqueName = c.comment.author?.uniqueName?.toLowerCase() || '';
      return (
        displayName.includes(authorLower) || uniqueName.includes(authorLower)
      );
    });
  }

  // Filter by date
  if (filter.sinceDate) {
    const sinceTime = new Date(filter.sinceDate).getTime();
    filtered = filtered.filter(
      (c) => new Date(c.comment.publishedDate).getTime() >= sinceTime
    );
  }

  // Sort by date (newest first)
  filtered.sort(
    (a, b) =>
      new Date(b.comment.publishedDate).getTime() -
      new Date(a.comment.publishedDate).getTime()
  );

  // Limit to latest N
  if (filter.latest && filter.latest > 0) {
    filtered = filtered.slice(0, filter.latest);
  }

  return filtered;
}

/**
 * Group ADO comments by thread, separating root comments from replies
 */
function groupCommentsByThread(
  comments: AdoFlattenedComment[]
): GroupedThread[] {
  const threadMap = new Map<number, GroupedThread>();

  for (const comment of comments) {
    const { threadId, threadStatus, filePath, lineNumber } = comment;

    if (!threadMap.has(threadId)) {
      threadMap.set(threadId, {
        threadId,
        threadStatus,
        filePath,
        lineNumber,
        rootComment: null,
        replies: [],
      });
    }

    const thread = threadMap.get(threadId)!;

    // In Azure DevOps, multiple comments can have parentCommentId === 0
    // (top-level thread replies). The one with the lowest ID is the true root.
    if (comment.comment.parentCommentId === 0) {
      if (
        thread.rootComment === null ||
        comment.comment.id < thread.rootComment.comment.id
      ) {
        // This is the new root (either first or has lower ID)
        if (thread.rootComment !== null) {
          // Demote the old root to a reply
          thread.replies.push(thread.rootComment);
        }
        thread.rootComment = comment;
      } else {
        // Another top-level comment, but not the root - treat as reply
        thread.replies.push(comment);
      }
    } else {
      thread.replies.push(comment);
    }
  }

  // Sort replies within each thread by comment ID (chronological order)
  for (const thread of threadMap.values()) {
    thread.replies.sort((a, b) => a.comment.id - b.comment.id);
  }

  // Convert to array and sort threads by most recent activity
  const threads = Array.from(threadMap.values());
  threads.sort((a, b) => {
    const aLatest = getLatestDate(a);
    const bLatest = getLatestDate(b);
    return bLatest - aLatest; // Newest first
  });

  return threads;
}

/**
 * Get the latest comment date in an ADO thread
 */
function getLatestDate(thread: GroupedThread): number {
  let latest = 0;

  if (thread.rootComment) {
    latest = new Date(thread.rootComment.comment.publishedDate).getTime();
  }

  for (const reply of thread.replies) {
    const replyTime = new Date(reply.comment.publishedDate).getTime();
    if (replyTime > latest) {
      latest = replyTime;
    }
  }

  return latest;
}

function getCommentContent(comment: AdoFlattenedComment['comment']): string {
  return comment.content ?? '[deleted comment]';
}

function getAuthorName(comment: AdoFlattenedComment['comment']): string {
  return comment.author?.displayName?.trim() || 'Unknown';
}

/**
 * Format ADO comments output based on format type
 */
function formatAdoOutput(
  comments: AdoFlattenedComment[],
  format: OutputFormat,
  prId: number
): string {
  if (format === 'json') {
    return JSON.stringify(comments, null, 2);
  }

  if (comments.length === 0) {
    return format === 'markdown'
      ? `# PR #${prId} Comments\n\nNo comments found.`
      : `No comments found for PR #${prId}.`;
  }

  // Group comments by thread for structured output
  const threads = groupCommentsByThread(comments);

  if (format === 'markdown') {
    return formatAdoMarkdown(threads, comments.length, prId);
  }

  // Text format
  return formatAdoText(threads, comments.length, prId);
}

/**
 * Format ADO threads as markdown with heading hierarchy
 */
function formatAdoMarkdown(
  threads: GroupedThread[],
  totalComments: number,
  prId: number
): string {
  let output = `# PR #${prId} Comments\n\n`;
  output += `Total: ${totalComments} comment${totalComments === 1 ? '' : 's'} in ${threads.length} thread${threads.length === 1 ? '' : 's'}\n\n`;

  for (const thread of threads) {
    const fileInfo = thread.filePath
      ? ` (${thread.filePath}:${thread.lineNumber || '?'})`
      : '';

    // Thread header with root comment author (or first reply if root is filtered out)
    const firstComment = thread.rootComment || thread.replies[0];
    if (!firstComment) continue;

    const authorName = getAuthorName(firstComment.comment);
    const rootDate = new Date(firstComment.comment.publishedDate)
      .toISOString()
      .split('T')[0];

    output += `## Thread #${thread.threadId} - ${authorName}${fileInfo}\n`;
    output += `**Date:** ${rootDate} | **Status:** ${thread.threadStatus}\n\n`;

    // Root comment content
    if (thread.rootComment) {
      output += `${getCommentContent(thread.rootComment.comment)}\n\n`;
    }

    // Replies
    for (const reply of thread.replies) {
      const replyDate = new Date(reply.comment.publishedDate)
        .toISOString()
        .split('T')[0];
      output += `### Reply - ${getAuthorName(reply.comment)}\n`;
      output += `**Date:** ${replyDate}\n\n`;
      output += `${getCommentContent(reply.comment)}\n\n`;
    }

    output += `---\n\n`;
  }

  return output;
}

/**
 * Format ADO threads as plain text with indentation for replies
 */
function formatAdoText(
  threads: GroupedThread[],
  totalComments: number,
  prId: number
): string {
  let output = `PR #${prId} Comments (${totalComments} total in ${threads.length} thread${threads.length === 1 ? '' : 's'})\n`;
  output += '='.repeat(50) + '\n\n';

  for (const thread of threads) {
    const fileInfo = thread.filePath
      ? `\nFile: ${thread.filePath}:${thread.lineNumber || '?'}`
      : '';

    // Thread header with root comment author (or first reply if root is filtered out)
    const firstComment = thread.rootComment || thread.replies[0];
    if (!firstComment) continue;

    const authorName = getAuthorName(firstComment.comment);
    const rootDate = new Date(
      firstComment.comment.publishedDate
    ).toLocaleString();

    output += `Thread #${thread.threadId} - ${authorName}${fileInfo}\n`;
    output += `Date: ${rootDate} | Status: ${thread.threadStatus}\n\n`;

    // Root comment content
    if (thread.rootComment) {
      output += `${getCommentContent(thread.rootComment.comment)}\n\n`;
    }

    // Replies (indented)
    for (const reply of thread.replies) {
      const replyDate = new Date(reply.comment.publishedDate).toLocaleString();
      output += `    Reply - ${getAuthorName(reply.comment)} (${replyDate})\n`;
      // Indent reply content
      const indentedContent = getCommentContent(reply.comment)
        .split('\n')
        .map((line) => `    ${line}`)
        .join('\n');
      output += `${indentedContent}\n\n`;
    }

    output += '='.repeat(50) + '\n\n';
  }

  return output;
}

// ============================================================================
// GitHub Comment Helpers
// ============================================================================

/**
 * Build a unified comment object from a GitHub issue comment
 */
function issueCommentToUnified(c: GitHubIssueComment) {
  return {
    author: c.user.login,
    body: c.body,
    date: c.created_at,
    id: c.id,
    type: 'issue' as const,
  };
}

/**
 * Build a unified comment object from a GitHub review comment
 */
function reviewCommentToUnified(c: GitHubReviewComment) {
  return {
    author: c.user.login,
    body: c.body,
    date: c.created_at,
    id: c.id,
    type: 'review' as const,
    path: c.path,
    line: c.line ?? c.original_line,
    inReplyToId: c.in_reply_to_id,
  };
}

/**
 * Group GitHub comments into threads.
 *
 * Review comments without in_reply_to_id are thread roots.
 * Review comments with in_reply_to_id are replies.
 * Issue comments are standalone (no threading).
 */
function groupGitHubComments(
  issueComments: GitHubIssueComment[],
  reviewComments: GitHubReviewComment[],
  filter: { author?: string; sinceDate?: string; latest?: number }
): GitHubGroupedThread[] {
  const threads: GitHubGroupedThread[] = [];

  // Build review comment threads
  const reviewRoots = new Map<number, GitHubGroupedThread>();
  const reviewReplies: Array<ReturnType<typeof reviewCommentToUnified>> = [];

  for (const rc of reviewComments) {
    const unified = reviewCommentToUnified(rc);
    if (rc.in_reply_to_id) {
      reviewReplies.push(unified);
    } else {
      reviewRoots.set(rc.id, {
        threadId: rc.id,
        filePath: rc.path,
        lineNumber: rc.line ?? rc.original_line,
        rootComment: {
          author: unified.author,
          body: unified.body,
          date: unified.date,
          id: unified.id,
          type: 'review',
        },
        replies: [],
      });
    }
  }

  // Build an index mapping any comment ID to its root thread.
  // This handles nested replies where in_reply_to_id points to a non-root comment.
  const commentIdToRoot = new Map<number, GitHubGroupedThread>();
  for (const [id, thread] of reviewRoots) {
    commentIdToRoot.set(id, thread);
  }

  // Attach replies to their root threads by walking the chain
  for (const reply of reviewReplies) {
    let rootThread: GitHubGroupedThread | undefined;
    if (reply.inReplyToId) {
      rootThread = commentIdToRoot.get(reply.inReplyToId);
    }
    if (rootThread) {
      rootThread.replies.push({
        author: reply.author,
        body: reply.body,
        date: reply.date,
        id: reply.id,
      });
      // Map this reply's ID to the same root thread so deeper replies find it
      commentIdToRoot.set(reply.id, rootThread);
    } else {
      // Orphan reply, create its own thread
      const orphanThread: GitHubGroupedThread = {
        threadId: reply.id,
        filePath: reply.path,
        lineNumber: reply.line,
        rootComment: {
          author: reply.author,
          body: reply.body,
          date: reply.date,
          id: reply.id,
          type: 'review',
        },
        replies: [],
      };
      reviewRoots.set(reply.id, orphanThread);
      commentIdToRoot.set(reply.id, orphanThread);
    }
  }

  threads.push(...reviewRoots.values());

  // Add issue comments as standalone threads
  for (const ic of issueComments) {
    const unified = issueCommentToUnified(ic);
    threads.push({
      threadId: `issue-${ic.id}`,
      rootComment: {
        author: unified.author,
        body: unified.body,
        date: unified.date,
        id: unified.id,
        type: 'issue',
      },
      replies: [],
    });
  }

  // Sort replies within each thread chronologically
  for (const thread of threads) {
    thread.replies.sort(
      (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
    );
  }

  // Apply filters to the full list of comments across threads
  let allComments = threads.flatMap((t) => [
    { ...t.rootComment, threadRef: t },
    ...t.replies.map((r) => ({ ...r, type: 'reply' as const, threadRef: t })),
  ]);

  // Filter by author
  if (filter.author) {
    const authorLower = filter.author.toLowerCase();
    allComments = allComments.filter((c) =>
      c.author.toLowerCase().includes(authorLower)
    );
  }

  // Filter by date
  if (filter.sinceDate) {
    const sinceTime = new Date(filter.sinceDate).getTime();
    allComments = allComments.filter(
      (c) => new Date(c.date).getTime() >= sinceTime
    );
  }

  // Sort newest first
  allComments.sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
  );

  // Limit to latest N
  if (filter.latest && filter.latest > 0) {
    allComments = allComments.slice(0, filter.latest);
  }

  // Rebuild threads from filtered comments
  const filteredThreadIds = new Set(
    allComments.map((c) => c.threadRef.threadId)
  );
  const filteredThreads = threads.filter((t) =>
    filteredThreadIds.has(t.threadId)
  );

  // If author or latest filter applied, only keep matched comments within threads
  if (filter.author || filter.latest) {
    const matchedIds = new Set(allComments.map((c) => c.id));
    for (const thread of filteredThreads) {
      if (!matchedIds.has(thread.rootComment.id)) {
        // Root was filtered out but a reply matched, keep root for context
      }
      thread.replies = thread.replies.filter((r) => matchedIds.has(r.id));
    }
  }

  // Sort threads by most recent activity
  filteredThreads.sort((a, b) => {
    const aLatest = getGitHubLatestDate(a);
    const bLatest = getGitHubLatestDate(b);
    return bLatest - aLatest;
  });

  return filteredThreads;
}

/**
 * Get the latest date in a GitHub thread
 */
function getGitHubLatestDate(thread: GitHubGroupedThread): number {
  let latest = new Date(thread.rootComment.date).getTime();
  for (const reply of thread.replies) {
    const t = new Date(reply.date).getTime();
    if (t > latest) latest = t;
  }
  return latest;
}

/**
 * Count total comments across GitHub threads
 */
function countGitHubComments(threads: GitHubGroupedThread[]): number {
  return threads.reduce((sum, t) => sum + 1 + t.replies.length, 0);
}

/**
 * Format GitHub comments for output
 */
function formatGitHubOutput(
  threads: GitHubGroupedThread[],
  format: OutputFormat,
  prId: number,
  rawIssueComments: GitHubIssueComment[],
  rawReviewComments: GitHubReviewComment[]
): string {
  if (format === 'json') {
    return JSON.stringify(
      { issueComments: rawIssueComments, reviewComments: rawReviewComments },
      null,
      2
    );
  }

  if (threads.length === 0) {
    return format === 'markdown'
      ? `# PR #${prId} Comments\n\nNo comments found.`
      : `No comments found for PR #${prId}.`;
  }

  const total = countGitHubComments(threads);

  if (format === 'markdown') {
    return formatGitHubMarkdown(threads, total, prId);
  }

  return formatGitHubText(threads, total, prId);
}

/**
 * Format GitHub threads as markdown
 */
function formatGitHubMarkdown(
  threads: GitHubGroupedThread[],
  totalComments: number,
  prId: number
): string {
  let output = `# PR #${prId} Comments\n\n`;
  output += `Total: ${totalComments} comment${totalComments === 1 ? '' : 's'} in ${threads.length} thread${threads.length === 1 ? '' : 's'}\n\n`;

  for (const thread of threads) {
    const fileInfo = thread.filePath
      ? ` (${thread.filePath}:${thread.lineNumber ?? '?'})`
      : '';
    const typeLabel =
      thread.rootComment.type === 'review' ? 'Review' : 'Comment';
    const rootDate = new Date(thread.rootComment.date)
      .toISOString()
      .split('T')[0];

    output += `## ${typeLabel} - ${thread.rootComment.author}${fileInfo}\n`;
    output += `**Date:** ${rootDate}\n\n`;
    output += `${thread.rootComment.body}\n\n`;

    for (const reply of thread.replies) {
      const replyDate = new Date(reply.date).toISOString().split('T')[0];
      output += `### Reply - ${reply.author}\n`;
      output += `**Date:** ${replyDate}\n\n`;
      output += `${reply.body}\n\n`;
    }

    output += `---\n\n`;
  }

  return output;
}

/**
 * Format GitHub threads as plain text
 */
function formatGitHubText(
  threads: GitHubGroupedThread[],
  totalComments: number,
  prId: number
): string {
  let output = `PR #${prId} Comments (${totalComments} total in ${threads.length} thread${threads.length === 1 ? '' : 's'})\n`;
  output += '='.repeat(50) + '\n\n';

  for (const thread of threads) {
    const fileInfo = thread.filePath
      ? `\nFile: ${thread.filePath}:${thread.lineNumber ?? '?'}`
      : '';
    const typeLabel =
      thread.rootComment.type === 'review' ? 'Review' : 'Comment';
    const rootDate = new Date(thread.rootComment.date).toLocaleString();

    output += `${typeLabel} - ${thread.rootComment.author}${fileInfo}\n`;
    output += `Date: ${rootDate}\n\n`;
    output += `${thread.rootComment.body}\n\n`;

    for (const reply of thread.replies) {
      const replyDate = new Date(reply.date).toLocaleString();
      output += `    Reply - ${reply.author} (${replyDate})\n`;
      const indentedContent = reply.body
        .split('\n')
        .map((line) => `    ${line}`)
        .join('\n');
      output += `${indentedContent}\n\n`;
    }

    output += '='.repeat(50) + '\n\n';
  }

  return output;
}

// ============================================================================
// Command Handler
// ============================================================================

async function handler(argv: ArgumentsCamelCase<CommentsArgs>): Promise<void> {
  const args = validateArgs(CommentsArgsSchema, argv, 'comments arguments');
  const { format, author, since, latest, includeSystem, threadStatus } = args;

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

  const resolved = await resolvePRId(args.pr, ctx, format);
  const prId = resolved.prId;
  ctx = resolved.ctx;

  try {
    if (format !== 'json') {
      console.log(`Fetching comments for PR #${prId}...`);
      if (author) console.log(`Filtering by author: ${author}`);
      if (since) console.log(`Since date: ${since}`);
      if (latest) console.log(`Latest: ${latest} comments`);
      if (threadStatus && ctx.platform === 'azure-devops') {
        console.log(`Thread status: ${threadStatus}`);
      }
      console.log('');
    }

    if (ctx.platform === 'github') {
      // Fetch both issue comments and review comments in parallel
      const [issueComments, reviewComments] = await Promise.all([
        ctx.client.getIssueComments(ctx.owner, ctx.repo, prId),
        ctx.client.getReviewComments(ctx.owner, ctx.repo, prId),
      ]);

      // Group and filter
      const threads = groupGitHubComments(issueComments, reviewComments, {
        author,
        sinceDate: since,
        latest,
      });

      // Format and output
      const output = formatGitHubOutput(
        threads,
        format,
        prId,
        issueComments,
        reviewComments
      );
      console.log(output);
    } else {
      // Azure DevOps path
      const allComments = await ctx.client.getAllComments(
        ctx.project,
        ctx.repo,
        prId
      );

      // Apply filters
      const filtered = filterComments(allComments, {
        author,
        sinceDate: since,
        latest,
        includeSystem,
        threadStatus,
      });

      // Format and output
      const output = formatAdoOutput(filtered, format, prId);
      console.log(output);
    }
  } catch (error) {
    handleCommandError(error);
  }
}

export default {
  command: 'comments',
  describe: 'Get comments from a pull request',
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
    author: {
      type: 'string',
      describe: 'Filter comments by author name or email',
    },
    since: {
      type: 'string',
      describe: 'Show comments since date (YYYY-MM-DD)',
    },
    latest: {
      type: 'number',
      describe: 'Show only N most recent comments',
    },
    'include-system': {
      type: 'boolean',
      default: false,
      describe: 'Include system comments',
    },
    'thread-status': {
      type: 'string',
      describe: 'Filter by thread status (active, fixed, wontFix, closed)',
    },
  },
  handler,
} satisfies CommandModule<object, CommentsArgs>;
