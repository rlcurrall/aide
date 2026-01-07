/**
 * Azure DevOps service commands
 * Routes to ADO-related commands (prs, create, update, comments, comment, reply)
 */

import type { CommandModule } from 'yargs';
import { prsCommand } from './prs.js';
import { commentsCommand } from './comments.js';
import { prCommentCommand } from './pr-comment.js';
import { prCreateCommand } from './pr-create.js';
import { prUpdateCommand } from './pr-update.js';
import { prReplyCommand } from './pr-reply.js';

export const adoCommands: CommandModule = {
  command: 'ado <command>',
  describe: 'Azure DevOps pull request commands',
  builder: (yargs) =>
    yargs
      .command(prsCommand)
      .command(prCreateCommand)
      .command(prUpdateCommand)
      .command(commentsCommand)
      .command(prCommentCommand)
      .command(prReplyCommand)
      .demandCommand(1, 'Please specify an ado command')
      .example('$0 ado prs --status active', 'List active PRs')
      .example('$0 ado prs --created-by "your.email"', 'List your PRs')
      .example('$0 ado create --title "My PR" --target main', 'Create a PR')
      .example('$0 ado update 123 --title "New title"', 'Update PR title')
      .example('$0 ado update 123 --publish', 'Publish a draft PR')
      .example('$0 ado comments 24094 --latest 5', 'Get recent PR comments')
      .example(
        '$0 ado comment 123 "This looks good!"',
        'Post a general comment on PR'
      )
      .example(
        '$0 ado comment 123 "Use const" --file src/utils.ts --line 42',
        'Comment on specific file/line'
      )
      .example(
        '$0 ado reply 123 --thread 456 "Thanks, I\'ll fix that"',
        'Reply to a thread'
      )
      .example(
        '$0 ado reply 123 --thread 456 --parent 2 "Good point"',
        'Reply to a specific comment'
      ),
  handler: () => {
    // This won't be called due to demandCommand
  },
};
