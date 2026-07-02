/**
 * PR reply command - Reply to a comment thread on a pull request.
 */

import { Effect } from 'effect';
import type { ArgumentsCamelCase, Argv, CommandModule } from 'yargs';

import { logProgress } from '@lib/cli-utils.js';
import { handleCommandError } from '@lib/errors.js';
import { validateArgs } from '@lib/validation.js';
import { PrReplyArgsSchema, type PrReplyArgs } from '@schemas/pr/pr-reply.js';
import {
  formatPullRequestCommentMutationOutput,
  resolvePullRequestMutationContext,
} from './comment.js';

async function handler(argv: ArgumentsCamelCase<PrReplyArgs>): Promise<void> {
  try {
    const args = validateArgs(PrReplyArgsSchema, argv, 'pr-reply arguments');
    const { format, thread, parent, replyText } = args;

    const resolved = await resolvePullRequestMutationContext(
      argv,
      args,
      format
    );
    if (
      resolved.autoDiscovered &&
      resolved.context.result.repositoryLabel !== undefined
    ) {
      logProgress(
        `Auto-discovered: ${resolved.context.result.repositoryLabel}`,
        format
      );
      logProgress('', format);
    }

    const prNumber = resolved.context.result.pullRequest.id;
    if (
      resolved.context.provider.providerId === 'github' &&
      parent !== undefined &&
      parent > 0
    ) {
      console.warn(
        'Warning: --parent is ignored on GitHub. GitHub review comment threads only support one level of nesting.'
      );
    }

    logProgress(
      `Posting reply to PR #${prNumber}, thread ${thread}...`,
      format
    );
    if (parent !== undefined && parent > 0) {
      logProgress(`Replying to comment #${parent}`, format);
    }
    logProgress('', format);

    const result = await Effect.runPromise(
      resolved.context.replyToPullRequestComment({
        pullRequest: { number: prNumber },
        threadId: thread,
        body: replyText,
        ...(parent === undefined ? {} : { parentCommentId: parent }),
      })
    );

    console.log(
      formatPullRequestCommentMutationOutput(result, format, {
        action: 'reply',
        targetId: thread,
      })
    );
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
