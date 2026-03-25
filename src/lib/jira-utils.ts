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
      const details =
        error instanceof Error ? `\nDetails: ${error.message}` : '';
      throw new Error(`Could not read file '${filePath}'${details}`);
    }
  }

  if (content) {
    return content;
  }

  throw new Error(
    `${capitalize(contentName)} content is required.\n` +
      `Provide ${contentName} text as an argument or use -f/--file to specify a file.`
  );
}

/**
 * Validate ticket key format and print a warning if it doesn't match typical format
 * This is a soft validation - it warns but doesn't prevent the operation
 * @param ticketKey - The ticket key to validate
 */
export function validateTicketKeyWithWarning(ticketKey: string): void {
  if (!isValidTicketKeyFormat(ticketKey)) {
    console.error(
      `Warning: '${ticketKey}' doesn't match typical Jira ticket format (PROJECT-123)`
    );
    console.error('Proceeding anyway...');
    console.error('');
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
 * Parse custom field arguments into name-value pairs without resolution
 * @param fields - Array of field strings in "fieldName=value" format
 * @returns Array of { name, value } pairs
 */
export function parseCustomFieldPairs(
  fields: string[] | undefined
): Array<{ name: string; value: unknown }> {
  if (!fields || fields.length === 0) {
    return [];
  }

  const result: Array<{ name: string; value: unknown }> = [];

  for (const field of fields) {
    const eqIndex = field.indexOf('=');
    if (eqIndex === -1) {
      console.error(
        `Warning: Invalid field format '${field}', expected 'fieldName=value'`
      );
      continue;
    }

    const name = field.substring(0, eqIndex).trim();
    const valueStr = field.substring(eqIndex + 1).trim();

    if (!name) {
      console.error(`Warning: Empty field name in '${field}'`);
      continue;
    }

    // Try to parse JSON values, otherwise use as string
    let value: unknown;
    try {
      value = JSON.parse(valueStr);
    } catch {
      value = valueStr;
    }

    result.push({ name, value });
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

// Re-export from cli-utils for backward compatibility
export {
  type OutputFormat,
  shouldShowProgress,
  logProgress,
} from './cli-utils.js';

import { type OutputFormat, logProgress } from './cli-utils.js';

/**
 * Jira wiki syntax patterns that users might accidentally use
 */
const JIRA_WIKI_PATTERNS = [
  { pattern: /^h[1-6]\./m, description: 'h1., h2., etc. headings' },
  { pattern: /\{\{[^}]+\}\}/, description: '{{code}} inline code' },
  { pattern: /\{noformat\}/, description: '{noformat} blocks' },
  { pattern: /\{code[^}]*\}/, description: '{code} blocks' },
  { pattern: /\{quote\}/, description: '{quote} blocks' },
  { pattern: /\{color:[^}]+\}/, description: '{color} formatting' },
  { pattern: /^\*\s+/, description: '* bullet lists (use - instead)' },
  { pattern: /^#\s+[^#]/, description: '# numbered lists (use 1. instead)' },
];

/**
 * Check if text contains Jira wiki syntax and warn the user
 * Returns true if wiki syntax was detected
 */
export function warnIfJiraWikiSyntax(
  text: string,
  format: OutputFormat
): boolean {
  if (format === 'json') return false;

  const detected: string[] = [];

  for (const { pattern, description } of JIRA_WIKI_PATTERNS) {
    if (pattern.test(text)) {
      detected.push(description);
    }
  }

  if (detected.length > 0) {
    console.error('Warning: Description appears to use Jira wiki syntax.');
    console.error(
      'Tip: Use markdown instead - it will be automatically converted.'
    );
    console.error('');
    console.error('Detected patterns:');
    for (const desc of detected) {
      console.error(`  - ${desc}`);
    }
    console.error('');
    console.error('Quick conversion guide:');
    console.error('  h2. Heading    ->  ## Heading');
    console.error('  {{code}}       ->  `code`');
    console.error('  {code}...{code}->  ```...```');
    console.error('  # list item    ->  1. list item');
    console.error('  * list item    ->  - list item');
    console.error('');
    return true;
  }

  return false;
}

// Import types needed for processCustomFields - these are imported lazily to avoid circular deps
import type { JiraClient } from './jira-client.js';
import type { ResolvedField } from './field-resolver.js';

/**
 * Result of custom field processing
 */
export interface ProcessedCustomFields {
  /** Custom fields object ready for Jira API (key -> formatted value) */
  customFields: Record<string, unknown>;
  /** Map of original names to resolved fields (for logging) */
  resolved: Map<string, ResolvedField>;
}

/**
 * Process custom field arguments through the full pipeline:
 * 1. Parse field strings into name-value pairs
 * 2. Resolve field names to Jira internal IDs
 * 3. Format values based on field type
 * 4. Validate values against allowed values
 *
 * @param client - Jira client for API calls
 * @param projectKey - Project key for field resolution
 * @param issueType - Issue type for field resolution
 * @param fieldArgs - Array of "fieldName=value" strings
 * @param format - Output format (for progress logging)
 * @returns Processed custom fields or exits on error
 */
export async function processCustomFields(
  client: JiraClient,
  projectKey: string,
  issueType: string,
  fieldArgs: string[],
  format: OutputFormat
): Promise<ProcessedCustomFields | null> {
  // Lazy imports to avoid circular dependencies
  const { resolveFieldNames, validateFieldValues, formatValidationErrors } =
    await import('./field-resolver.js');
  const { formatFieldValues } = await import('./value-formatter.js');

  const fieldPairs = parseCustomFieldPairs(fieldArgs);

  if (fieldPairs.length === 0) {
    return null;
  }

  logProgress('Resolving custom field names...', format);

  const fieldNames = fieldPairs.map((f) => f.name);
  const { resolved, errors } = await resolveFieldNames(
    client,
    projectKey,
    issueType,
    fieldNames
  );

  // Report resolution errors
  if (errors.length > 0) {
    const messages = errors.map((err) => {
      let msg = err.error;
      if (err.suggestions && err.suggestions.length > 0) {
        msg += `\n  Did you mean: ${err.suggestions.join(', ')}?`;
      }
      return msg;
    });
    throw new Error(messages.join('\n'));
  }

  // Log resolved field mappings
  for (const [originalName, resolvedField] of resolved) {
    if (originalName !== resolvedField.key) {
      logProgress(
        `  "${originalName}" -> ${resolvedField.key} (${resolvedField.type})`,
        format
      );
    }
  }

  // Auto-format field values based on type
  logProgress('Formatting field values...', format);
  const {
    success: formatSuccess,
    formatted,
    errors: formatErrors,
  } = formatFieldValues(resolved, fieldPairs);

  if (!formatSuccess) {
    const messages = formatErrors.map(
      (err) => `Error formatting "${err.name}": ${err.error}`
    );
    throw new Error(messages.join('\n'));
  }

  // Log formatting applied
  for (const [name, { description }] of formatted) {
    const resolvedField = resolved.get(name);
    if (resolvedField && description !== 'pass-through (text/string)') {
      logProgress(`  ${resolvedField.displayName}: ${description}`, format);
    }
  }

  // Update fieldPairs with formatted values for validation
  const formattedPairs = fieldPairs.map(({ name }) => ({
    name,
    value: formatted.get(name)?.value,
  }));

  // Validate field values against allowed values
  logProgress('Validating field values...', format);
  const { valid, results } = validateFieldValues(resolved, formattedPairs);

  if (!valid) {
    throw new Error(formatValidationErrors(results));
  }

  // Build custom fields object with resolved keys and formatted values
  const customFields: Record<string, unknown> = {};
  for (const { name } of fieldPairs) {
    const resolvedField = resolved.get(name);
    const formattedEntry = formatted.get(name);
    if (resolvedField && formattedEntry) {
      customFields[resolvedField.key] = formattedEntry.value;
    }
  }

  return { customFields, resolved };
}
