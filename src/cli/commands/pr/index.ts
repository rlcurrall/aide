/**
 * Pull Request service commands
 * Routes to PR-related commands (list, create, update, comments, comment, reply)
 * Supports Azure DevOps and GitHub
 */

import type { CommandModule } from 'yargs';
import commentsCommandModule from './comments.js';
import diffCommandModule from './diff.js';
import listCommandModule from './list.js';
import prCommentCommandModule from './pr-comment.js';
import prCreateCommandModule from './pr-create.js';
import prReplyCommandModule from './pr-reply.js';
import prUpdateCommandModule from './pr-update.js';
import viewCommandModule from './view.js';

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

function createPrCommandGroup(): CommandModule {
  return {
    command: 'pr <command>',
    describe: 'Pull request commands (GitHub/Azure DevOps)',
    builder: (yargs) => {
      let configured = yargs.demandCommand(1, 'Please specify a pr command');
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

export const prListCommand = listCommandModule;
export const prViewCommand = viewCommandModule;
export const prDiffCommand = diffCommandModule;
export const prCreateCommand = prCreateCommandModule;
export const prUpdateCommand = prUpdateCommandModule;
export const prCommentsCommand = commentsCommandModule;
export const prCommentCommand = prCommentCommandModule;
export const prReplyCommand = prReplyCommandModule;

export const prCommandGroup: CommandModule = createPrCommandGroup();

/** @deprecated Register `prCommandGroup` children through the command registry. */
export const prCommands: CommandModule = prCommandGroup;
