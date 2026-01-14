/**
 * Plugin install command
 * Installs the aide Claude Code plugin by shelling out to the Claude CLI
 */

import { $ } from 'bun';
import type { ArgumentsCamelCase, CommandModule } from 'yargs';
import {
  isClaudeCliAvailable,
  printClaudeCliNotFoundError,
  RESTART_MESSAGE,
} from './utils.js';

export interface InstallArgv {
  user: boolean;
  project: boolean;
  local: boolean;
}

async function handler(argv: ArgumentsCamelCase<InstallArgv>): Promise<void> {
  // Check if Claude CLI is available
  if (!(await isClaudeCliAvailable())) {
    printClaudeCliNotFoundError('/plugin marketplace add rlcurrall/aide');
    process.exit(1);
  }

  // Determine scope
  let scope = 'user';
  if (argv.project) scope = 'project';
  if (argv.local) scope = 'local';

  console.log(`Installing aide plugin (${scope} scope)...`);
  console.log('');

  try {
    // Add marketplace (idempotent - safe to run multiple times, will succeed if already added)
    console.log('Adding marketplace...');
    await $`claude plugin marketplace add rlcurrall/aide`.quiet();

    // Install plugin with scope
    console.log('Installing plugin...');
    await $`claude plugin install aide@aide-marketplace --scope ${scope}`.quiet();

    console.log('');
    console.log(`Done! ${RESTART_MESSAGE}`);
  } catch (error) {
    console.error('');
    console.error('Error: Plugin installation failed.');
    if (error instanceof Error) {
      console.error(`  ${error.message}`);
    }
    console.error('');
    console.error('You can try installing manually from within Claude Code:');
    console.error('  /plugin marketplace add rlcurrall/aide');
    console.error('  /plugin install aide@aide-marketplace');
    process.exit(1);
  }
}

export default {
  command: 'install',
  describe: 'Install the aide plugin to Claude Code',
  builder: {
    user: {
      type: 'boolean',
      default: false,
      describe: 'Install for current user (default)',
    },
    project: {
      type: 'boolean',
      default: false,
      describe: 'Install to project scope (team-shared)',
    },
    local: {
      type: 'boolean',
      default: false,
      describe: 'Install to local scope (project-specific)',
    },
  },
  handler,
} satisfies CommandModule<object, InstallArgv>;
