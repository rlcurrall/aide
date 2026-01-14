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
import attachCommand from './attach.js';

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
      .command(attachCommand)
      .demandCommand(1, 'Please specify a jira command')
      .example('$0 jira search "assignee = currentUser()"', 'Search tickets')
      .example('$0 jira view PROJ-123', 'Get ticket details')
      .example('$0 jira create -p PROJ -t Task -s "Summary"', 'Create a ticket')
      .example('$0 jira update PROJ-123 --assignee me', 'Update ticket fields')
      .example('$0 jira transition PROJ-123 "In Progress"', 'Change status')
      .example('$0 jira comment PROJ-123 "Comment text"', 'Add a comment')
      .example('$0 jira comments PROJ-123 --latest 5', 'Get recent comments')
      .example('$0 jira attach PROJ-123 --list', 'List attachments'),
  handler: () => {
    // This won't be called due to demandCommand
  },
};
