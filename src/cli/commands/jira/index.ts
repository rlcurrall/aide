/**
 * Jira service commands
 * Routes to Jira-related commands
 */

import type { CommandModule } from 'yargs';

// Import all command modules
import searchCommand from './search.js';
import viewCommand from './view.js';
import createCommand from './create.js';
import updateCommand from './update.js';
import transitionCommand from './transition.js';
import commentCommand from './comment.js';
import commentsCommand from './comments.js';
import deleteCommentCommand from './delete-comment.js';
import editCommentCommand from './edit-comment.js';
import attachCommand from './attach.js';
import fieldsCommand from './fields.js';
import boardsCommand from './boards.js';
import sprintCommand from './sprint.js';
import apiCommand from './api.js';

export const jiraCommands: CommandModule = {
  command: 'jira <command>',
  describe: 'Jira ticket management commands',
  builder: (yargs) =>
    yargs
      // Primary commands
      .command(searchCommand)
      .command(viewCommand)
      .command(createCommand)
      .command(updateCommand)
      .command(transitionCommand)
      .command(commentCommand)
      .command(commentsCommand)
      .command(deleteCommentCommand)
      .command(editCommentCommand)
      .command(attachCommand)
      .command(fieldsCommand)
      .command(boardsCommand)
      .command(sprintCommand)
      .command(apiCommand)
      .demandCommand(1, 'Please specify a jira command')
      .example('$0 jira search "assignee = currentUser()"', 'Search tickets')
      .example('$0 jira view PROJ-123', 'Get ticket details')
      .example('$0 jira create -p PROJ -t Task -s "Summary"', 'Create a ticket')
      .example('$0 jira update PROJ-123 --assignee me', 'Update ticket fields')
      .example('$0 jira transition PROJ-123 "In Progress"', 'Change status')
      .example('$0 jira comment PROJ-123 "Comment text"', 'Add a comment')
      .example('$0 jira comments PROJ-123 --latest 5', 'Get recent comments')
      .example('$0 jira delete-comment PROJ-123 10001', 'Delete a comment')
      .example(
        '$0 jira edit-comment PROJ-123 10001 "Updated"',
        'Edit a comment'
      )
      .example('$0 jira attach PROJ-123 --list', 'List attachments')
      .example(
        '$0 jira fields VNT -t Task --show-values',
        'List fields with values'
      )
      .example('$0 jira boards PROJ', 'List boards for a project')
      .example('$0 jira sprint 123', 'Get active sprint for board')
      .example(
        '$0 jira search "assignee = currentUser()" --sprint-board 123',
        'Search in active sprint'
      )
      .example('$0 jira api rest/api/3/myself', 'Raw API passthrough (current user)'),
  handler: () => {
    // This won't be called due to demandCommand
  },
};
