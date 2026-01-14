/**
 * Plugin uninstall command
 * Removes the aide Claude Code plugin from specified scopes
 */

import { $ } from 'bun';
import type { ArgumentsCamelCase, CommandModule } from 'yargs';
import {
  isClaudeCliAvailable,
  printClaudeCliNotFoundError,
  RESTART_MESSAGE,
} from './utils.js';

export interface UninstallArgv {
  user: boolean;
  project: boolean;
  local: boolean;
  all: boolean;
}

async function handler(argv: ArgumentsCamelCase<UninstallArgv>): Promise<void> {
  // Check if Claude CLI is available
  if (!(await isClaudeCliAvailable())) {
    printClaudeCliNotFoundError('/plugin uninstall aide@aide-marketplace');
    process.exit(1);
  }

  // Validate conflicting flags
  const scopeFlags = [argv.user, argv.project, argv.local].filter(Boolean);
  if (scopeFlags.length > 1 && !argv.all) {
    console.error(
      'Error: Cannot specify multiple scope flags (--user, --project, --local) together.'
    );
    console.error(
      'Use --all to uninstall from all scopes, or specify a single scope.'
    );
    process.exit(1);
  }

  // Determine which scopes to uninstall from
  const scopes: string[] = argv.all
    ? ['user', 'project', 'local']
    : [argv.project ? 'project' : argv.local ? 'local' : 'user'];

  console.log(`Uninstalling aide plugin from ${scopes.join(', ')} scope(s)...`);
  console.log('');

  let successCount = 0;
  let errorCount = 0;

  for (const scope of scopes) {
    try {
      console.log(`Removing from ${scope} scope...`);
      const result =
        await $`claude plugin uninstall aide@aide-marketplace --scope ${scope}`.quiet();

      if (result.exitCode === 0) {
        console.log(`[OK] Removed from ${scope} scope`);
        successCount++;
      } else {
        // Non-zero exit code but no exception - likely not installed
        const stderr = result.stderr.toString().toLowerCase();
        if (stderr.includes('not installed') || stderr.includes('not found')) {
          console.log(`[-] Not installed in ${scope} scope`);
        } else {
          console.error(
            `[ERROR] Failed to remove from ${scope} scope: ${result.stderr}`
          );
          errorCount++;
        }
      }
    } catch (error) {
      // Check if the error indicates "not installed" vs actual failure
      const errorMessage =
        error instanceof Error
          ? error.message.toLowerCase()
          : String(error).toLowerCase();

      if (
        errorMessage.includes('not installed') ||
        errorMessage.includes('not found')
      ) {
        console.log(`[-] Not installed in ${scope} scope`);
      } else {
        console.error(
          `[ERROR] Failed to remove from ${scope} scope: ${error instanceof Error ? error.message : error}`
        );
        errorCount++;
      }
    }
  }

  console.log('');

  if (successCount > 0) {
    console.log(`Uninstall complete. ${RESTART_MESSAGE}`);
  } else if (errorCount > 0) {
    console.error(
      'Uninstall failed. Please check the errors above and try again.'
    );
    process.exit(1);
  } else {
    console.log('No aide plugin installation found in the specified scope(s).');
  }
}

export default {
  command: 'uninstall',
  describe: 'Remove the aide plugin from Claude Code',
  builder: {
    user: {
      type: 'boolean',
      default: false,
      describe: 'Remove from user scope (default)',
      conflicts: ['project', 'local'],
    },
    project: {
      type: 'boolean',
      default: false,
      describe: 'Remove from project scope',
      conflicts: ['user', 'local'],
    },
    local: {
      type: 'boolean',
      default: false,
      describe: 'Remove from local scope',
      conflicts: ['user', 'project'],
    },
    all: {
      type: 'boolean',
      default: false,
      describe: 'Remove from all scopes',
    },
  },
  handler,
} satisfies CommandModule<object, UninstallArgv>;
