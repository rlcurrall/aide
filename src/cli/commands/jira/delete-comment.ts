/**
 * Jira delete-comment command
 * Delete a comment from a specific Jira ticket
 */

import type { ArgumentsCamelCase, CommandModule } from 'yargs';
import { loadConfig } from '@lib/config.js';
import { JiraClient } from '@lib/jira-client.js';
import { validateArgs } from '@lib/validation.js';
import {
  DeleteCommentArgsSchema,
  type DeleteCommentArgs,
} from '@schemas/jira/delete-comment.js';
import { handleCommandError } from '@lib/errors.js';
import { validateTicketKeyWithWarning, logProgress } from '@lib/jira-utils.js';

async function handler(
  argv: ArgumentsCamelCase<DeleteCommentArgs>
): Promise<void> {
  const args = validateArgs(
    DeleteCommentArgsSchema,
    argv,
    'delete-comment arguments'
  );
  const { ticketKey, commentId, format } = args;

  // Validate ticket key format (soft validation with warning)
  validateTicketKeyWithWarning(ticketKey);

  try {
    const { config } = await loadConfig();
    const client = new JiraClient(config);

    logProgress(
      `Deleting comment ${commentId} from ticket: ${ticketKey}`,
      format
    );

    await client.deleteComment(ticketKey, commentId);

    if (format === 'json') {
      console.log(
        JSON.stringify(
          {
            success: true,
            ticketKey,
            commentId,
            message: 'Comment deleted successfully',
          },
          null,
          2
        )
      );
    } else if (format === 'markdown') {
      console.log(`## Comment Deleted\n`);
      console.log(`- **Ticket:** ${ticketKey}`);
      console.log(`- **Comment ID:** ${commentId}`);
    } else {
      console.log(`Comment deleted successfully!`);
      console.log(`Ticket: ${ticketKey}`);
      console.log(`Comment ID: ${commentId}`);
    }
  } catch (error) {
    handleCommandError(error);
  }
}

export default {
  command: 'delete-comment <ticketKey> <commentId>',
  describe: 'Delete a comment from a ticket',
  builder: {
    ticketKey: {
      type: 'string',
      describe: 'Jira ticket key (e.g., PROJ-123)',
      demandOption: true,
    },
    commentId: {
      type: 'string',
      describe: 'Comment ID to delete',
      demandOption: true,
    },
    format: {
      type: 'string',
      choices: ['text', 'json', 'markdown'] as const,
      default: 'text' as const,
      describe: 'Output format',
    },
  },
  handler,
} satisfies CommandModule<object, DeleteCommentArgs>;
