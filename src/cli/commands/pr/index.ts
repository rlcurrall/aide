/**
 * Pull Request service commands
 * Routes to PR-related commands (list, create, update, comments, comment, reply)
 * Supports Azure DevOps (with GitHub support planned)
 */

import type { CommandModule } from 'yargs';
import commentsCommand from './comments.js';
import diffCommand from './diff.js';
import listCommand from './list.js';
import prCommentCommand from './pr-comment.js';
import prCreateCommand from './pr-create.js';
import prReplyCommand from './pr-reply.js';
import prUpdateCommand from './pr-update.js';
import viewCommand from './view.js';

export const prCommands: CommandModule = {
  command: 'pr <command>',
  describe: 'Pull request commands (GitHub/Azure DevOps)',
  builder: (yargs) =>
    yargs
      .command(listCommand)
      .command(viewCommand)
      .command(diffCommand)
      .command(prCreateCommand)
      .command(prUpdateCommand)
      .command(commentsCommand)
      .command(prCommentCommand)
      .command(prReplyCommand)
      .demandCommand(1, 'Please specify a pr command')
      .example('$0 pr view --pr 123', 'View PR details')
      .example('$0 pr view', 'View PR for current branch')
      .example('$0 pr diff --pr 123', 'View PR diff')
      .example('$0 pr diff --stat', 'View diff summary for current branch PR')
      .example('$0 pr diff --files', 'List changed files in PR')
      .example('$0 pr list --status active', 'List active PRs')
      .example('$0 pr list --created-by "your.email"', 'List your PRs')
      .example('$0 pr create --title "My PR" --base main', 'Create a PR')
      .example('$0 pr update --pr 123 --title "New title"', 'Update PR title')
      .example('$0 pr update --pr 123 --publish', 'Publish a draft PR')
      .example('$0 pr comments --pr 24094 --latest 5', 'Get recent PR comments')
      .example(
        '$0 pr comment "This looks good!" --pr 123',
        'Post a general comment on PR'
      )
      .example(
        '$0 pr comment "Use const" --pr 123 --file src/utils.ts --line 42',
        'Comment on specific file/line'
      )
      .example(
        '$0 pr reply 456 "Thanks, I\'ll fix that" --pr 123',
        'Reply to a thread'
      )
      .example(
        '$0 pr reply 456 "Good point" --parent 2 --pr 123',
        'Reply to a specific comment'
      ),
  handler: () => {
    // This won't be called due to demandCommand
  },
};
