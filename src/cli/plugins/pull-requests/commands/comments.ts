/**
 * PR comments command - Get comments from a pull request.
 * Supports provider-backed GitHub and Azure DevOps comments.
 */

import { Effect } from 'effect';
import type { ArgumentsCamelCase, CommandModule } from 'yargs';

import type {
  AidePullRequestComment,
  AidePullRequestCommentThread,
  AidePullRequestCommentsRequest,
  AidePullRequestCommentsResult,
  AidePullRequestViewResult,
} from '@cli/host/plugin-descriptor.js';
import { getAideHostContext } from '@cli/host/runtime-context.js';
import { validatePRId } from '@lib/ado-utils.js';
import { logProgress } from '@lib/cli-utils.js';
import { handleCommandError } from '@lib/errors.js';
import { getCurrentBranch, getGitRemoteUrl } from '@lib/git-utils.js';
import { validateArgs } from '@lib/validation.js';
import {
  CommentsArgsSchema,
  type CommentsArgs,
  type OutputFormat,
} from '@schemas/pr/comments.js';
import { resolveExplicitPullRequestRepositoryRef } from './repository-ref.js';

interface ProviderCommentsContext {
  readonly result: AidePullRequestViewResult;
  readonly listPullRequestComments: (
    request: Pick<AidePullRequestCommentsRequest, 'pullRequest'>
  ) => Effect.Effect<AidePullRequestCommentsResult, unknown, never>;
}

interface ResolvedComments {
  readonly result: AidePullRequestCommentsResult;
  readonly autoDiscovered: boolean;
}

interface CommentFilter {
  readonly author?: string;
  readonly since?: string;
  readonly latest?: number;
  readonly includeSystem?: boolean;
  readonly threadStatus?: string;
}

interface ThreadCommentRef {
  readonly thread: AidePullRequestCommentThread;
  readonly comment: AidePullRequestComment;
}

function allThreadComments(
  thread: AidePullRequestCommentThread
): readonly AidePullRequestComment[] {
  return [
    ...(thread.rootComment === undefined ? [] : [thread.rootComment]),
    ...thread.replies,
  ];
}

function latestThreadDate(thread: AidePullRequestCommentThread): number {
  return Math.max(
    ...allThreadComments(thread).map((comment) =>
      new Date(comment.createdAt).getTime()
    )
  );
}

function commentAuthorMatches(
  comment: AidePullRequestComment,
  author: string
): boolean {
  const authorLower = author.toLowerCase();
  const values = [
    comment.author.displayName,
    comment.author.username,
    comment.author.email,
  ].filter((value): value is string => value !== undefined);
  return values.some((value) => value.toLowerCase().includes(authorLower));
}

function commentMatchesFilter(
  thread: AidePullRequestCommentThread,
  comment: AidePullRequestComment,
  filter: CommentFilter
): boolean {
  if (
    !filter.includeSystem &&
    (comment.kind === 'system' || comment.providerType === 'system')
  ) {
    return false;
  }

  if (
    filter.threadStatus !== undefined &&
    thread.status !== undefined &&
    thread.status.toLowerCase() !== filter.threadStatus.toLowerCase()
  ) {
    return false;
  }

  if (
    filter.author !== undefined &&
    !commentAuthorMatches(comment, filter.author)
  ) {
    return false;
  }

  if (
    filter.since !== undefined &&
    new Date(comment.createdAt).getTime() < new Date(filter.since).getTime()
  ) {
    return false;
  }

  return true;
}

export function filterPullRequestCommentThreads(
  threads: readonly AidePullRequestCommentThread[],
  filter: CommentFilter
): readonly AidePullRequestCommentThread[] {
  let refs: ThreadCommentRef[] = threads.flatMap((thread) =>
    allThreadComments(thread).map((comment) => ({ thread, comment }))
  );

  refs = refs.filter(({ thread, comment }) =>
    commentMatchesFilter(thread, comment, filter)
  );
  refs.sort(
    (a, b) =>
      new Date(b.comment.createdAt).getTime() -
      new Date(a.comment.createdAt).getTime()
  );

  if (filter.latest !== undefined && filter.latest > 0) {
    refs = refs.slice(0, filter.latest);
  }

  const matchedIds = new Set(refs.map(({ comment }) => comment.id));
  return Object.freeze(
    threads
      .map((thread) => {
        const rootComment =
          thread.rootComment !== undefined &&
          matchedIds.has(thread.rootComment.id)
            ? thread.rootComment
            : undefined;
        const replies = thread.replies.filter((reply) =>
          matchedIds.has(reply.id)
        );
        if (rootComment === undefined && replies.length === 0) {
          return null;
        }
        return Object.freeze({
          id: thread.id,
          ...(thread.status === undefined ? {} : { status: thread.status }),
          ...(thread.filePath === undefined
            ? {}
            : { filePath: thread.filePath }),
          ...(thread.lineNumber === undefined
            ? {}
            : { lineNumber: thread.lineNumber }),
          ...(rootComment === undefined ? {} : { rootComment }),
          replies: Object.freeze(replies),
        });
      })
      .filter(
        (thread): thread is AidePullRequestCommentThread => thread !== null
      )
      .sort((a, b) => latestThreadDate(b) - latestThreadDate(a))
  );
}

function countComments(
  threads: readonly AidePullRequestCommentThread[]
): number {
  return threads.reduce(
    (sum, thread) =>
      sum + (thread.rootComment === undefined ? 0 : 1) + thread.replies.length,
    0
  );
}

function firstThreadComment(
  thread: AidePullRequestCommentThread
): AidePullRequestComment | undefined {
  return thread.rootComment ?? thread.replies[0];
}

function threadTitle(thread: AidePullRequestCommentThread): string {
  const comment = firstThreadComment(thread);
  const author = comment?.author.displayName ?? 'Unknown';
  if (thread.status !== undefined) {
    return `Thread #${thread.id} - ${author}`;
  }
  if (comment?.kind === 'review') {
    return `Review - ${author}`;
  }
  if (comment?.kind === 'system') {
    return `System - ${author}`;
  }
  return `Comment - ${author}`;
}

function fileInfo(thread: AidePullRequestCommentThread): string {
  const filePath = thread.filePath ?? firstThreadComment(thread)?.filePath;
  if (filePath === undefined) {
    return '';
  }
  const lineNumber =
    thread.lineNumber ?? firstThreadComment(thread)?.lineNumber;
  return ` (${filePath}:${lineNumber ?? '?'})`;
}

function formatMarkdown(
  result: AidePullRequestCommentsResult,
  threads: readonly AidePullRequestCommentThread[]
): string {
  const total = countComments(threads);
  if (total === 0) {
    return `# PR #${result.pullRequest.number} Comments\n\nNo comments found.`;
  }

  let output = `# PR #${result.pullRequest.number} Comments\n\n`;
  output += `Total: ${total} comment${total === 1 ? '' : 's'} in ${threads.length} thread${threads.length === 1 ? '' : 's'}\n\n`;

  for (const thread of threads) {
    const first = firstThreadComment(thread);
    if (first === undefined) continue;
    const date = new Date(first.createdAt).toISOString().split('T')[0];
    output += `## ${threadTitle(thread)}${fileInfo(thread)}\n`;
    output += `**Date:** ${date}`;
    if (thread.status !== undefined) {
      output += ` | **Status:** ${thread.status}`;
    }
    output += `\n\n`;

    if (thread.rootComment !== undefined) {
      output += `${thread.rootComment.body}\n\n`;
    }

    for (const reply of thread.replies) {
      const replyDate = new Date(reply.createdAt).toISOString().split('T')[0];
      output += `### Reply - ${reply.author.displayName}\n`;
      output += `**Date:** ${replyDate}\n\n`;
      output += `${reply.body}\n\n`;
    }

    output += `---\n\n`;
  }

  return output;
}

function formatText(
  result: AidePullRequestCommentsResult,
  threads: readonly AidePullRequestCommentThread[]
): string {
  const total = countComments(threads);
  if (total === 0) {
    return `No comments found for PR #${result.pullRequest.number}.`;
  }

  let output = `PR #${result.pullRequest.number} Comments (${total} total in ${threads.length} thread${threads.length === 1 ? '' : 's'})\n`;
  output += '='.repeat(50) + '\n\n';

  for (const thread of threads) {
    const first = firstThreadComment(thread);
    if (first === undefined) continue;
    output += `${threadTitle(thread)}${fileInfo(thread).replace(/^ \(/, '\nFile: ').replace(/\)$/, '')}\n`;
    output += `Date: ${new Date(first.createdAt).toLocaleString()}`;
    if (thread.status !== undefined) {
      output += ` | Status: ${thread.status}`;
    }
    output += `\n\n`;

    if (thread.rootComment !== undefined) {
      output += `${thread.rootComment.body}\n\n`;
    }

    for (const reply of thread.replies) {
      const replyDate = new Date(reply.createdAt).toLocaleString();
      output += `    Reply - ${reply.author.displayName} (${replyDate})\n`;
      const indented = reply.body
        .split('\n')
        .map((line) => `    ${line}`)
        .join('\n');
      output += `${indented}\n\n`;
    }

    output += '='.repeat(50) + '\n\n';
  }

  return output;
}

export function formatPullRequestCommentsOutput(
  result: AidePullRequestCommentsResult,
  threads: readonly AidePullRequestCommentThread[],
  format: OutputFormat
): string {
  if (format === 'json') {
    return JSON.stringify(
      {
        prId: result.pullRequest.number,
        repository: result.repository,
        repositoryLabel: result.repositoryLabel,
        total: countComments(threads),
        threads,
      },
      null,
      2
    );
  }

  if (format === 'markdown') {
    return formatMarkdown(result, threads);
  }

  return formatText(result, threads);
}

async function loadCommentsFromContext(
  context: ProviderCommentsContext,
  format: OutputFormat
): Promise<AidePullRequestCommentsResult> {
  logProgress(
    `Fetching comments for PR #${context.result.pullRequest.id}...`,
    format
  );
  return Effect.runPromise(
    context.listPullRequestComments({
      pullRequest: { number: context.result.pullRequest.id },
    })
  );
}

async function resolvePullRequestComments(
  argv: ArgumentsCamelCase<CommentsArgs>,
  args: CommentsArgs,
  format: OutputFormat
): Promise<ResolvedComments> {
  const hostContext = getAideHostContext(argv);
  if (hostContext === null) {
    throw new Error('Pull request provider services are unavailable.');
  }

  const hasExplicitRepoContext =
    args.project !== undefined || args.repo !== undefined;

  if (args.pr === undefined) {
    const branch = getCurrentBranch();
    if (!branch) {
      throw new Error(
        'Could not detect current git branch. Are you in a git repository? (Detached HEAD state is not supported)'
      );
    }

    logProgress(`Searching for PR from branch '${branch}'...`, format);
    const found = hasExplicitRepoContext
      ? await (async () => {
          const { repository, autoDiscovered } =
            await resolveExplicitPullRequestRepositoryRef(
              args.project,
              args.repo
            );
          const context = await Effect.runPromise(
            hostContext.services.findPullRequestForBranchContextForRepository(
              repository,
              { branch }
            )
          );
          return { context, autoDiscovered };
        })()
      : await (async () => {
          const remoteUrl = gitRemoteOrThrow(
            'Could not determine repository context. Provide a PR ID, full PR URL, or run from a git repository with a supported remote.'
          );
          const context = await Effect.runPromise(
            hostContext.services.findPullRequestForBranchContextForRemote(
              remoteUrl,
              { branch }
            )
          );
          return { context, autoDiscovered: true };
        })();

    logProgress(
      `Found PR #${found.context.result.pullRequest.id}: ${found.context.result.pullRequest.title}`,
      format
    );
    logProgress('', format);
    return {
      result: await loadCommentsFromContext(found.context, format),
      autoDiscovered: found.autoDiscovered,
    };
  }

  if (args.pr.startsWith('http')) {
    const context = await Effect.runPromise(
      hostContext.services.getPullRequestContextForUrl(args.pr)
    );
    return {
      result: await loadCommentsFromContext(context, format),
      autoDiscovered: false,
    };
  }

  const validation = validatePRId(args.pr);
  if (!validation.valid || validation.value === undefined) {
    throw new Error(
      `Could not parse '${args.pr}' as a PR ID. Expected a positive number or full PR URL.`
    );
  }
  const prNumber = validation.value;

  if (hasExplicitRepoContext) {
    const { repository, autoDiscovered } =
      await resolveExplicitPullRequestRepositoryRef(args.project, args.repo);
    const context = await Effect.runPromise(
      hostContext.services.getPullRequestContextForRepository(repository, {
        pullRequest: { number: prNumber },
      })
    );
    return {
      result: await loadCommentsFromContext(context, format),
      autoDiscovered,
    };
  }

  const remoteUrl = gitRemoteOrThrow(
    'Could not determine repository context. Provide a full PR URL or run from a git repository with a supported remote.'
  );
  const context = await Effect.runPromise(
    hostContext.services.getPullRequestContextForRemote(remoteUrl, {
      pullRequest: { number: prNumber },
    })
  );
  return {
    result: await loadCommentsFromContext(context, format),
    autoDiscovered: true,
  };
}

function gitRemoteOrThrow(message: string): string {
  const remoteUrl = getGitRemoteUrl();
  if (!remoteUrl) {
    throw new Error(message);
  }
  return remoteUrl;
}

async function handler(argv: ArgumentsCamelCase<CommentsArgs>): Promise<void> {
  try {
    const args = validateArgs(CommentsArgsSchema, argv, 'comments arguments');
    const { format, author, since, latest, includeSystem, threadStatus } = args;

    const resolved = await resolvePullRequestComments(argv, args, format);
    if (
      resolved.autoDiscovered &&
      resolved.result.repositoryLabel !== undefined
    ) {
      logProgress(
        `Auto-discovered: ${resolved.result.repositoryLabel}`,
        format
      );
      logProgress('', format);
    }

    if (author) logProgress(`Filtering by author: ${author}`, format);
    if (since) logProgress(`Since date: ${since}`, format);
    if (latest) logProgress(`Latest: ${latest} comments`, format);
    if (threadStatus) logProgress(`Thread status: ${threadStatus}`, format);
    logProgress('', format);

    const threads = filterPullRequestCommentThreads(resolved.result.threads, {
      author,
      since,
      latest,
      includeSystem,
      threadStatus,
    });
    console.log(
      formatPullRequestCommentsOutput(resolved.result, threads, format)
    );
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
