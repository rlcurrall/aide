/**
 * PR comments command - Get comments from a pull request
 * Supports Azure DevOps (with GitHub support planned)
 * @see https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-threads?view=azure-devops-rest-7.1
 */

import {
  findPRByCurrentBranch,
  getMissingRepoErrorMessage,
  parsePRUrl,
  resolveRepoContext,
  validatePRId,
} from '@lib/ado-utils.js';
import { AzureDevOpsClient } from '@lib/azure-devops-client.js';
import { loadAzureDevOpsConfig } from '@lib/config.js';
import { handleCommandError } from '@lib/errors.js';
import type { AdoFlattenedComment } from '@lib/types.js';
import { validateArgs } from '@lib/validation.js';
import {
  CommentsArgsSchema,
  type CommentsArgs,
  type OutputFormat,
} from '@schemas/pr/comments.js';
import type { ArgumentsCamelCase, CommandModule } from 'yargs';

/**
 * Represents a thread with its root comment and replies grouped together
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
 * Filter comments based on provided criteria
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
      const displayName = c.comment.author.displayName.toLowerCase();
      const uniqueName = c.comment.author.uniqueName?.toLowerCase() || '';
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
 * Group comments by thread, separating root comments from replies
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
 * Get the latest comment date in a thread
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

/**
 * Format comments output based on format type
 */
function formatOutput(
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
    return formatMarkdown(threads, comments.length, prId);
  }

  // Text format
  return formatText(threads, comments.length, prId);
}

/**
 * Format threads as markdown with heading hierarchy
 */
function formatMarkdown(
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

    const authorName = firstComment.comment.author.displayName;
    const rootDate = new Date(firstComment.comment.publishedDate)
      .toISOString()
      .split('T')[0];

    output += `## Thread #${thread.threadId} - ${authorName}${fileInfo}\n`;
    output += `**Date:** ${rootDate} | **Status:** ${thread.threadStatus}\n\n`;

    // Root comment content
    if (thread.rootComment) {
      output += `${thread.rootComment.comment.content}\n\n`;
    }

    // Replies
    for (const reply of thread.replies) {
      const replyDate = new Date(reply.comment.publishedDate)
        .toISOString()
        .split('T')[0];
      output += `### Reply - ${reply.comment.author.displayName}\n`;
      output += `**Date:** ${replyDate}\n\n`;
      output += `${reply.comment.content}\n\n`;
    }

    output += `---\n\n`;
  }

  return output;
}

/**
 * Format threads as plain text with indentation for replies
 */
function formatText(
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

    const authorName = firstComment.comment.author.displayName;
    const rootDate = new Date(
      firstComment.comment.publishedDate
    ).toLocaleString();

    output += `Thread #${thread.threadId} - ${authorName}${fileInfo}\n`;
    output += `Date: ${rootDate} | Status: ${thread.threadStatus}\n\n`;

    // Root comment content
    if (thread.rootComment) {
      output += `${thread.rootComment.comment.content}\n\n`;
    }

    // Replies (indented)
    for (const reply of thread.replies) {
      const replyDate = new Date(reply.comment.publishedDate).toLocaleString();
      output += `    Reply - ${reply.comment.author.displayName} (${replyDate})\n`;
      // Indent reply content
      const indentedContent = reply.comment.content
        .split('\n')
        .map((line) => `    ${line}`)
        .join('\n');
      output += `${indentedContent}\n\n`;
    }

    output += '='.repeat(50) + '\n\n';
  }

  return output;
}

async function handler(argv: ArgumentsCamelCase<CommentsArgs>): Promise<void> {
  const args = validateArgs(CommentsArgsSchema, argv, 'comments arguments');
  let prId: number | undefined;
  let project: string | undefined = args.project;
  let repo: string | undefined = args.repo;
  const { format, author, since, latest, includeSystem, threadStatus } = args;

  // Try auto-discover project/repo from git remote first (needed for PR auto-detection)
  try {
    const context = resolveRepoContext(project, repo);
    if (context.autoDiscovered && context.repoInfo && format !== 'json') {
      console.log(
        `Auto-discovered: ${context.repoInfo.org}/${context.repoInfo.project}/${context.repoInfo.repo}`
      );
      console.log('');
    }
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
    // We need project/repo for this
    if (!project || !repo) {
      console.error(
        getMissingRepoErrorMessage('Provide a PR ID or full PR URL')
      );
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

  // Validate we have project/repo (should be set by now, but double-check)
  if (!project || !repo) {
    console.error(getMissingRepoErrorMessage('Provide a full PR URL'));
    process.exit(1);
  }

  // Validate prId is set (should be set by now via URL parsing or branch detection)
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

    if (format !== 'json') {
      console.log(`Fetching comments for PR #${prId}...`);
      if (author) console.log(`Filtering by author: ${author}`);
      if (since) console.log(`Since date: ${since}`);
      if (latest) console.log(`Latest: ${latest} comments`);
      if (threadStatus) console.log(`Thread status: ${threadStatus}`);
      console.log('');
    }

    // Fetch all comments
    const allComments = await client.getAllComments(project, repo, prId);

    // Apply filters
    const filtered = filterComments(allComments, {
      author,
      sinceDate: since,
      latest,
      includeSystem,
      threadStatus,
    });

    // Format and output
    const output = formatOutput(filtered, format, prId);
    console.log(output);
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
