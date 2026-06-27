#!/usr/bin/env bun

/**
 * Main entry point for the aide CLI
 * Uses yargs for command parsing and routing
 */

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { VERSION, CLI_NAME } from './help.js';
import { cleanupOldBackup } from './update.js';
import { UserCancelledError } from '@lib/prompts.js';
import { registerCommands } from './host/yargs-adapter.js';
import { createBuiltinCommandRegistry } from './plugins/builtin.js';

async function main(): Promise<number> {
  // Clean up any old backup files from previous upgrades
  cleanupOldBackup();
  const registry = createBuiltinCommandRegistry();

  try {
    await registerCommands(
      yargs(hideBin(process.argv))
        .scriptName(CLI_NAME)
        .version(VERSION)
        .help()
        .alias('h', 'help')
        .alias('v', 'version'),
      registry
    )
      .demandCommand(1, registry.demandMessage())
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
    if (error instanceof UserCancelledError) {
      return error.exitCode; // 130, silent
    }
    console.error(`Error: ${error instanceof Error ? error.message : error}`);
    return 1;
  }
}

if (import.meta.main) {
  main().then(process.exit);
}

export { main };
