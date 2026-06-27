/**
 * Pull Request service commands
 * Routes to PR-related commands (list, create, update, comments, comment, reply)
 * Supports Azure DevOps and GitHub
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

const prExamples = [
  ['$0 pr view --pr 123', 'View PR details'],
  ['$0 pr view', 'View PR for current branch'],
  ['$0 pr diff --pr 123', 'View PR diff'],
  ['$0 pr diff --stat', 'View diff summary for current branch PR'],
  ['$0 pr diff --files', 'List changed files in PR'],
  ['$0 pr list --status active', 'List active PRs'],
  ['$0 pr list --created-by "your.email"', 'List your PRs'],
  ['$0 pr create --title "My PR" --base main', 'Create a PR'],
  ['$0 pr update --pr 123 --title "New title"', 'Update PR title'],
  ['$0 pr update --pr 123 --publish', 'Publish a draft PR'],
  ['$0 pr comments --pr 24094 --latest 5', 'Get recent PR comments'],
  ['$0 pr comment "This looks good!" --pr 123', 'Post a general comment on PR'],
  [
    '$0 pr comment "Use const" --pr 123 --file src/utils.ts --line 42',
    'Comment on specific file/line',
  ],
  ['$0 pr reply 456 "Thanks, I\'ll fix that" --pr 123', 'Reply to a thread'],
  [
    '$0 pr reply 456 "Good point" --parent 2 --pr 123',
    'Reply to a specific comment',
  ],
] as const;

function createPrCommandGroup(
  childCommands: readonly unknown[]
): CommandModule {
  return {
    command: 'pr <command>',
    describe: 'Pull request commands (GitHub/Azure DevOps)',
    builder: (yargs) => {
      let configured = yargs;
      for (const command of childCommands) {
        configured = configured.command(command as CommandModule);
      }
      configured = configured.demandCommand(1, 'Please specify a pr command');
      for (const [command, description] of prExamples) {
        configured = configured.example(command, description);
      }
      return configured;
    },
    handler: () => {
      // This won't be called due to demandCommand
    },
  };
}

export const prListCommand = listCommand;

export const prCommandGroup: CommandModule = createPrCommandGroup([
  viewCommand,
  diffCommand,
  prCreateCommand,
  prUpdateCommand,
  commentsCommand,
  prCommentCommand,
  prReplyCommand,
]);

export const prCommands: CommandModule = createPrCommandGroup([
  listCommand,
  viewCommand,
  diffCommand,
  prCreateCommand,
  prUpdateCommand,
  commentsCommand,
  prCommentCommand,
  prReplyCommand,
]);
