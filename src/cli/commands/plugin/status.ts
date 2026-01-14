/**
 * Plugin status command
 * Shows the installation status of the aide Claude Code plugin
 */

import { $ } from 'bun';
import type { CommandModule } from 'yargs';
import { isClaudeCliAvailable, printClaudeCliNotFoundError } from './utils.js';

/** Plugin info from claude plugin list --format json */
interface PluginInfo {
  name: string;
  source: string;
  scope: string;
  path: string;
}

/** Arguments for status command (none currently) */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface StatusArgv {}

/**
 * Parse plugin list output to find aide plugin
 * Tries JSON format first, falls back to text parsing
 */
async function getAidePluginInfo(): Promise<PluginInfo | null> {
  // Try JSON format first (more reliable)
  try {
    const jsonResult = await $`claude plugin list --format json`.quiet();
    const plugins: PluginInfo[] = JSON.parse(jsonResult.text());
    return (
      plugins.find(
        (p) =>
          p.name === 'aide' ||
          p.source === 'aide-marketplace' ||
          (p.name === 'aide' && p.source === 'aide-marketplace')
      ) ?? null
    );
  } catch {
    // JSON format not available or failed, fall back to text parsing
  }

  // Fall back to text format
  try {
    const result = await $`claude plugin list`.quiet();
    const output = result.text();
    const lines = output.split('\n');

    for (const line of lines) {
      // Match exact pattern: aide@aide-marketplace
      // Expected format varies, but we look for the exact identifier
      const trimmedLine = line.trim();
      if (
        trimmedLine === 'aide@aide-marketplace' ||
        trimmedLine.startsWith('aide@aide-marketplace ')
      ) {
        // Parse scope if present (e.g., "aide@aide-marketplace (user)")
        const scopeMatch = trimmedLine.match(/\((\w+)\)/);
        return {
          name: 'aide',
          source: 'aide-marketplace',
          scope: scopeMatch?.[1] ?? 'unknown',
          path: '',
        };
      }
    }
  } catch {
    // Text parsing failed
  }

  return null;
}

async function handler(): Promise<void> {
  // Check if Claude CLI is available
  if (!(await isClaudeCliAvailable())) {
    printClaudeCliNotFoundError();
    process.exit(1);
  }

  console.log('aide Plugin Status');
  console.log('==================');
  console.log('');

  try {
    const pluginInfo = await getAidePluginInfo();

    if (pluginInfo) {
      console.log('[OK] aide plugin is installed');
      console.log('');
      console.log('Plugin details:');
      console.log(`  Name: ${pluginInfo.name}`);
      console.log(`  Source: ${pluginInfo.source}`);
      if (pluginInfo.scope && pluginInfo.scope !== 'unknown') {
        console.log(`  Scope: ${pluginInfo.scope}`);
      }
      if (pluginInfo.path) {
        console.log(`  Path: ${pluginInfo.path}`);
      }
    } else {
      console.log('[-] aide plugin is not installed');
      console.log('');
      console.log('To install, run:');
      console.log('  aide plugin install');
      console.log('');
      console.log('Or from within Claude Code:');
      console.log('  /plugin marketplace add rlcurrall/aide');
      console.log('  /plugin install aide@aide-marketplace');
    }
  } catch (error) {
    console.error('Error: Failed to get plugin status.');
    if (error instanceof Error) {
      console.error(`  ${error.message}`);
    }
    process.exit(1);
  }
}

export default {
  command: 'status',
  describe: 'Show plugin installation status',
  handler,
} satisfies CommandModule<object, StatusArgv>;
