/**
 * Jira comment command
 * Add a comment to a specific Jira ticket
 */

import type { ArgumentsCamelCase, CommandModule } from 'yargs';
import { loadConfig } from '@lib/config.js';
import { JiraClient } from '@lib/jira-client.js';
import { convert as markdownToAdf } from '@lib/md-to-adf.js';
import { validateArgs } from '@lib/validation.js';
import { CommentArgsSchema, type CommentArgs } from '@schemas/jira/comment.js';
import { handleCommandError } from '@lib/errors.js';
import {
  readContentFromFileOrArg,
  validateTicketKeyWithWarning,
  logProgress,
} from '@lib/jira-utils.js';

async function handler(argv: ArgumentsCamelCase<CommentArgs>): Promise<void> {
  const args = validateArgs(CommentArgsSchema, argv, 'comment arguments');
  const { ticketKey, format } = args;

  // Get comment content from args or file
  const markdownContent = await readContentFromFileOrArg(
    args.comment,
    args.file,
    'comment'
  );

  // Validate ticket key format (soft validation with warning)
  validateTicketKeyWithWarning(ticketKey);

  try {
    const config = loadConfig();
    const client = new JiraClient(config);

    logProgress(`Adding comment to ticket: ${ticketKey}`, format);
    logProgress('Converting markdown to Jira format...', format);

    // Convert markdown to ADF
    const adfBody = markdownToAdf(markdownContent);

    logProgress('Posting comment to Jira...', format);
    logProgress('', format);

    const result = await client.addComment(ticketKey, adfBody);

    if (format === 'json') {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Comment added successfully!`);
      console.log(`Comment ID: ${result.id}`);
      console.log(`Created: ${result.created}`);
      console.log(`Author: ${result.author.displayName}`);
    }
  } catch (error) {
    handleCommandError(error);
  }
}

export default {
  command: 'comment <ticketKey> [comment]',
  describe: 'Add a comment to a ticket',
  builder: {
    ticketKey: {
      type: 'string',
      describe: 'Jira ticket key (e.g., PROJ-123)',
      demandOption: true,
    },
    comment: {
      type: 'string',
      describe: 'Comment text in markdown format',
    },
    file: {
      type: 'string',
      alias: 'f',
      describe: 'Read comment from markdown file',
    },
    format: {
      type: 'string',
      choices: ['text', 'json', 'markdown'] as const,
      default: 'text' as const,
      describe: 'Output format',
    },
  },
  handler,
} satisfies CommandModule<object, CommentArgs>;
