/**
 * Repo service commands
 * Routes to repository/worktree commands (list)
 */

import type { CommandModule } from 'yargs';
import listCommand from './list.js';

export const repoCommands: CommandModule = {
  command: 'repo <command>',
  describe: 'Inspect local git repositories and worktrees',
  builder: (yargs) =>
    yargs
      .command(listCommand)
      .demandCommand(1, 'Please specify a repo command')
      .example('$0 repo list', 'List worktrees under $CODE_ROOT')
      .example('$0 repo list ~/Code', 'List worktrees under a specific root'),
  handler: () => {
    // This won't be called due to demandCommand
  },
};
