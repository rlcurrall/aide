#!/usr/bin/env bun

/**
 * Main entry point for the ax CLI
 * Uses yargs for command parsing and routing
 */

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { VERSION, CLI_NAME } from './help.js';

// Import service command modules
import { jiraCommands } from './commands/jira/index.js';
import { adoCommands } from './commands/ado/index.js';
import { pluginCommands } from './commands/plugin/index.js';

async function main(): Promise<number> {
  try {
    await yargs(hideBin(process.argv))
      .scriptName(CLI_NAME)
      .version(VERSION)
      .help()
      .alias('h', 'help')
      .alias('v', 'version')
      .command(jiraCommands)
      .command(adoCommands)
      .command(pluginCommands)
      .demandCommand(1, 'Please specify a service (jira, ado, plugin)')
      .strict()
      .wrap(Math.min(100, process.stdout.columns || 80))
      .fail((msg, err) => {
        if (err) throw err;
        console.error(msg);
        console.error('');
        console.error(`Run '${CLI_NAME} --help' for usage information.`);
        process.exit(1);
      })
      .parse();

    return 0;
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : error}`);
    return 1;
  }
}

if (import.meta.main) {
  main().then(process.exit);
}

export { main };
