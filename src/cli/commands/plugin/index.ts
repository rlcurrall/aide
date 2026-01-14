/**
 * Plugin service commands
 * Routes to plugin management commands (install, status, uninstall)
 */

import type { CommandModule } from 'yargs';
import installCommand from './install.js';
import uninstallCommand from './uninstall.js';
import statusCommand from './status.js';

export const pluginCommands: CommandModule = {
  command: 'plugin <command>',
  describe: 'Manage aide Claude Code plugin installation',
  builder: (yargs) =>
    yargs
      .command(installCommand)
      .command(uninstallCommand)
      .command(statusCommand)
      .demandCommand(1, 'Please specify a plugin command')
      .example('$0 plugin install', 'Install plugin for current user')
      .example('$0 plugin install --project', 'Install to project scope')
      .example('$0 plugin status', 'Show installation status')
      .example('$0 plugin uninstall --all', 'Remove from all scopes'),
  handler: () => {
    // This won't be called due to demandCommand
  },
};
