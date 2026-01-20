/**
 * Jira edit-comment command
 * Edit an existing comment on a specific Jira ticket
 */

import type { ArgumentsCamelCase, CommandModule } from 'yargs';
import { loadConfig } from '@lib/config.js';
import { JiraClient } from '@lib/jira-client.js';
import { convert as markdownToAdf } from '@lib/md-to-adf.js';
import { validateArgs } from '@lib/validation.js';
import {
  EditCommentArgsSchema,
  type EditCommentArgs,
} from '@schemas/jira/edit-comment.js';
import { handleCommandError } from '@lib/errors.js';
import {
  readContentFromFileOrArg,
  validateTicketKeyWithWarning,
  logProgress,
} from '@lib/jira-utils.js';
import { convertAdfToMarkdown } from '@lib/comment-utils.js';

async function handler(
  argv: ArgumentsCamelCase<EditCommentArgs>
): Promise<void> {
  const args = validateArgs(
    EditCommentArgsSchema,
    argv,
    'edit-comment arguments'
  );
  const { ticketKey, commentId, format } = args;

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

    logProgress(`Editing comment ${commentId} on ticket: ${ticketKey}`, format);
    logProgress('Converting markdown to Jira format...', format);

    // Convert markdown to ADF
    const adfBody = markdownToAdf(markdownContent);

    logProgress('Updating comment in Jira...', format);
    logProgress('', format);

    const result = await client.updateComment(ticketKey, commentId, adfBody);

    // Convert the response body from ADF to markdown for display
    const bodyMarkdown = convertAdfToMarkdown(result.body);

    if (format === 'json') {
      console.log(
        JSON.stringify(
          {
            id: result.id,
            author: result.author.displayName,
            authorEmail: result.author.emailAddress,
            created: result.created,
            updated: result.updated,
            body: bodyMarkdown,
          },
          null,
          2
        )
      );
    } else if (format === 'markdown') {
      console.log(`## Comment Updated\n`);
      console.log(`- **Comment ID:** ${result.id}`);
      console.log(`- **Updated:** ${result.updated}`);
      console.log(`- **Author:** ${result.author.displayName}\n`);
      console.log(`### Content\n`);
      console.log(bodyMarkdown);
    } else {
      console.log(`Comment updated successfully!`);
      console.log(`Comment ID: ${result.id}`);
      console.log(`Updated: ${result.updated}`);
      console.log(`Author: ${result.author.displayName}`);
      console.log(`\nContent:\n${bodyMarkdown}`);
    }
  } catch (error) {
    handleCommandError(error);
  }
}

export default {
  command: 'edit-comment <ticketKey> <commentId> [comment]',
  describe: 'Edit an existing comment on a ticket',
  builder: {
    ticketKey: {
      type: 'string',
      describe: 'Jira ticket key (e.g., PROJ-123)',
      demandOption: true,
    },
    commentId: {
      type: 'string',
      describe: 'Comment ID to edit',
      demandOption: true,
    },
    comment: {
      type: 'string',
      describe: 'New comment text in markdown format',
    },
    file: {
      type: 'string',
      alias: 'f',
      describe: 'Read new comment from markdown file',
    },
    format: {
      type: 'string',
      choices: ['text', 'json', 'markdown'] as const,
      default: 'text' as const,
      describe: 'Output format',
    },
  },
  handler,
} satisfies CommandModule<object, EditCommentArgs>;
