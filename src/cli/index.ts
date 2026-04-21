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

// Import service command modules
import { jiraCommands } from './commands/jira/index.js';
import { prCommands } from './commands/pr/index.js';
import { pluginCommands } from './commands/plugin/index.js';
import primeCommand from './commands/prime.js';
import upgradeCommand from './commands/upgrade.js';
import loginCommand from './commands/login.js';
import logoutCommand from './commands/logout.js';
import whoamiCommand from './commands/whoami.js';

async function main(): Promise<number> {
  // Clean up any old backup files from previous upgrades
  cleanupOldBackup();

  try {
    await yargs(hideBin(process.argv))
      .scriptName(CLI_NAME)
      .version(VERSION)
      .help()
      .alias('h', 'help')
      .alias('v', 'version')
      .command(jiraCommands)
      .command(prCommands)
      .command(pluginCommands)
      .command(primeCommand)
      .command(upgradeCommand)
      .command(loginCommand)
      .command(logoutCommand)
      .command(whoamiCommand)
      .demandCommand(
        1,
        'Please specify a command (jira, pr, plugin, prime, upgrade, login, logout, whoami)'
      )
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
  main().then((code) => {
    // Respect process.exitCode set by handlers (e.g. `jira api` on non-2xx
    // wants exit 1 without an error message). Only let it override on a
    // clean 0 — if main() itself failed, the thrown error already logged.
    const preset = process.exitCode;
    const finalCode = code === 0 && preset != null ? Number(preset) : code;
    process.exit(finalCode);
  });
}

export { main };
