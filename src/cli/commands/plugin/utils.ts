/**
 * Shared utilities for plugin commands
 */

import { $ } from 'bun';

/**
 * Check if Claude CLI is available in PATH
 */
export async function isClaudeCliAvailable(): Promise<boolean> {
  try {
    await $`claude --version`.quiet();
    return true;
  } catch {
    return false;
  }
}

/**
 * Print error message when Claude CLI is not found
 * @param alternativeCommand - Optional manual command to show as alternative
 */
export function printClaudeCliNotFoundError(alternativeCommand?: string): void {
  console.error('Error: Claude CLI not found in PATH.');
  console.error('');
  console.error('Please install Claude Code first:');
  console.error('  https://claude.ai/code');
  if (alternativeCommand) {
    console.error('');
    console.error('Or run manually from within Claude Code:');
    console.error(`  ${alternativeCommand}`);
  }
}

/**
 * Standard restart message after plugin changes
 */
export const RESTART_MESSAGE = 'Restart Claude Code to apply changes.';
