/**
 * Jira command shared utilities
 * Common patterns extracted from Jira commands to reduce duplication
 */

import { isValidTicketKeyFormat } from '@schemas/common.js';

/**
 * Read content from either a file path or an argument string
 * @param content - The content string (if provided directly)
 * @param filePath - The file path to read from (if provided)
 * @param contentName - Name of the content for error messages (e.g., "comment", "description")
 * @returns The content string
 * @throws Exits process with code 1 if neither content nor file is provided, or if file read fails
 */
export async function readContentFromFileOrArg(
  content: string | undefined,
  filePath: string | undefined,
  contentName: string = 'content'
): Promise<string> {
  if (filePath) {
    try {
      const file = Bun.file(filePath);
      return await file.text();
    } catch (error) {
      console.error(`Error: Could not read file '${filePath}'`);
      if (error instanceof Error) {
        console.error(`Details: ${error.message}`);
      }
      process.exit(1);
    }
  }

  if (content) {
    return content;
  }

  console.error(`Error: ${capitalize(contentName)} content is required.`);
  console.error(
    `Provide ${contentName} text as an argument or use -f/--file to specify a file.`
  );
  process.exit(1);
}

/**
 * Validate ticket key format and print a warning if it doesn't match typical format
 * This is a soft validation - it warns but doesn't prevent the operation
 * @param ticketKey - The ticket key to validate
 */
export function validateTicketKeyWithWarning(ticketKey: string): void {
  if (!isValidTicketKeyFormat(ticketKey)) {
    console.log(
      `Warning: '${ticketKey}' doesn't match typical Jira ticket format (PROJECT-123)`
    );
    console.log('Proceeding anyway...');
    console.log('');
  }
}

/**
 * Parse comma-separated values into an array
 * @param value - Comma-separated string (e.g., "bug,urgent,p1")
 * @returns Array of trimmed strings, or empty array if value is undefined
 */
export function parseCommaSeparated(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Parse custom field arguments in the format "fieldName=value"
 * @param fields - Array of field strings in "fieldName=value" format
 * @returns Record of field names to values
 */
export function parseCustomFields(
  fields: string[] | undefined
): Record<string, unknown> {
  if (!fields || fields.length === 0) {
    return {};
  }

  const result: Record<string, unknown> = {};

  for (const field of fields) {
    const eqIndex = field.indexOf('=');
    if (eqIndex === -1) {
      console.error(
        `Warning: Invalid field format '${field}', expected 'fieldName=value'`
      );
      continue;
    }

    const key = field.substring(0, eqIndex).trim();
    const value = field.substring(eqIndex + 1).trim();

    if (!key) {
      console.error(`Warning: Empty field name in '${field}'`);
      continue;
    }

    // Try to parse JSON values, otherwise use as string
    try {
      result[key] = JSON.parse(value);
    } catch {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Format a success message for a Jira operation
 * @param operation - The operation performed (e.g., "created", "updated")
 * @param ticketKey - The ticket key
 * @param jiraUrl - The base Jira URL
 * @returns Formatted success message with ticket URL
 */
export function formatSuccessMessage(
  operation: string,
  ticketKey: string,
  jiraUrl: string
): string {
  return [
    `Ticket ${operation} successfully!`,
    `Ticket: ${ticketKey}`,
    `View ticket: ${jiraUrl}/browse/${ticketKey}`,
  ].join('\n');
}

/**
 * Capitalize the first letter of a string
 */
function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Output type for format selection
 */
export type OutputFormat = 'text' | 'json' | 'markdown';

/**
 * Check if we should show progress messages (not json format)
 */
export function shouldShowProgress(format: OutputFormat): boolean {
  return format !== 'json';
}

/**
 * Log a progress message if not in json format
 */
export function logProgress(message: string, format: OutputFormat): void {
  if (shouldShowProgress(format)) {
    console.log(message);
  }
}
