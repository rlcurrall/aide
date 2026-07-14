/**
 * PR reply command - Reply to a comment thread on a pull request.
 */

import type { ArgumentsCamelCase, Argv, CommandModule } from 'yargs';

import { logProgress } from '@lib/cli-utils.js';
import {
  handlePullRequestCommandError,
  runPullRequestCommandEffect,
} from './error.js';
import { validateArgs } from '@lib/validation.js';
import { PrReplyArgsSchema, type PrReplyArgs } from '@schemas/pr/pr-reply.js';
import { formatPullRequestCommentMutationOutput } from './comment.js';
import { resolvePullRequestOperationContext } from './context.js';
import { pullRequestRepositoryOptions } from './repository-ref.js';

async function handler(argv: ArgumentsCamelCase<PrReplyArgs>): Promise<void> {
  try {
    const args = validateArgs(PrReplyArgsSchema, argv, 'pr-reply arguments');
    const { format, thread, parent, replyText } = args;

    const resolved = await resolvePullRequestOperationContext(
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
      resolved.context.provider.features.threadedComments !== true &&
      parent !== undefined &&
      parent > 0
    ) {
      console.warn(
        'Warning: --parent may be ignored by this provider. The selected pull request provider does not advertise nested comment replies.'
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

    const result = await runPullRequestCommandEffect(
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
    handlePullRequestCommandError(error);
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
      .options(pullRequestRepositoryOptions)
      .option('format', {
        type: 'string',
        choices: ['text', 'json', 'markdown'] as const,
        default: 'text' as const,
        describe: 'Output format',
      }) as Argv<PrReplyArgs>,
  handler,
} satisfies CommandModule<object, PrReplyArgs>;
