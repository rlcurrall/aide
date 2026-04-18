/**
 * Jira fields command
 * List available fields for a project and issue type
 */

import type { ArgumentsCamelCase, CommandModule } from 'yargs';
import { loadConfig } from '@lib/config.js';
import { JiraClient } from '@lib/jira-client.js';
import { validateArgs } from '@lib/validation.js';
import {
  FieldsArgsSchema,
  type FieldsArgs,
  type FieldFilter,
} from '@schemas/jira/fields.js';
import { handleCommandError } from '@lib/errors.js';
import { logProgress } from '@lib/jira-utils.js';
import type { JiraFieldMeta, JiraIssueTypeMeta } from '@lib/types.js';

/**
 * Check if a field matches the filter criteria
 */
function matchesFilter(field: JiraFieldMeta, filter: FieldFilter): boolean {
  switch (filter) {
    case 'required':
      return field.required;
    case 'optional':
      return !field.required;
    case 'custom':
      return field.key.startsWith('customfield_');
    case 'system':
      return !field.key.startsWith('customfield_');
    case 'all':
    default:
      return true;
  }
}

/**
 * Get display type string from field schema
 */
function getTypeDisplay(field: JiraFieldMeta): string {
  const { type, items, custom } = field.schema;

  if (type === 'array' && items) {
    return `array<${items}>`;
  }

  if (custom) {
    // Extract readable type from custom field type
    // e.g., "com.atlassian.jira.plugin.system.customfieldtypes:select" -> "select"
    const match = custom.match(/:([^:]+)$/);
    if (match && match[1]) {
      return match[1];
    }
  }

  return type;
}

/**
 * Format allowed values for display
 */
function formatAllowedValues(
  values: Array<{ id: string; name?: string; value?: string }> | undefined,
  maxValues: number
): string {
  if (!values || values.length === 0) {
    return '';
  }

  const displayValues = values
    .map((v) => v.value || v.name || v.id)
    .filter(Boolean);

  if (displayValues.length <= maxValues) {
    return displayValues.join(', ');
  }

  const shown = displayValues.slice(0, maxValues);
  const remaining = displayValues.length - maxValues;
  return `${shown.join(', ')} ... (+${remaining} more)`;
}

/**
 * Format text output for a single field
 */
function formatFieldText(
  field: JiraFieldMeta,
  showValues: boolean,
  maxValues: number
): string {
  const lines: string[] = [];

  const typeStr = getTypeDisplay(field);
  const requiredStr = field.required ? ' (required)' : '';

  lines.push(`  - ${field.name} (${field.key}) - ${typeStr}${requiredStr}`);

  if (showValues && field.allowedValues && field.allowedValues.length > 0) {
    const valuesStr = formatAllowedValues(field.allowedValues, maxValues);
    lines.push(`    Values: ${valuesStr}`);
  }

  return lines.join('\n');
}

/**
 * Format JSON output for fields
 */
function formatFieldsJson(
  fields: JiraFieldMeta[],
  projectKey: string,
  issueType: string | undefined
): object {
  return {
    project: projectKey,
    issueType: issueType || 'all',
    fieldCount: fields.length,
    fields: fields.map((f) => ({
      key: f.key,
      name: f.name,
      type: getTypeDisplay(f),
      required: f.required,
      hasAllowedValues: (f.allowedValues?.length || 0) > 0,
      allowedValues: f.allowedValues?.map((v) => ({
        id: v.id,
        name: v.name,
        value: v.value,
      })),
      hasDefaultValue: f.hasDefaultValue,
      defaultValue: f.defaultValue,
      schema: f.schema,
    })),
  };
}

/**
 * Format markdown output for fields
 */
function formatFieldsMarkdown(
  fields: JiraFieldMeta[],
  projectKey: string,
  issueType: string | undefined,
  showValues: boolean,
  maxValues: number
): string {
  const lines: string[] = [];

  lines.push(`# Fields for ${projectKey}${issueType ? ` - ${issueType}` : ''}`);
  lines.push('');

  // Group by required/optional
  const required = fields.filter((f) => f.required);
  const optional = fields.filter((f) => !f.required);

  if (required.length > 0) {
    lines.push('## Required Fields');
    lines.push('');
    lines.push('| Field | Key | Type |');
    lines.push('|-------|-----|------|');
    for (const f of required) {
      lines.push(`| ${f.name} | \`${f.key}\` | ${getTypeDisplay(f)} |`);
    }
    lines.push('');
  }

  if (optional.length > 0) {
    lines.push('## Optional Fields');
    lines.push('');
    lines.push('| Field | Key | Type |');
    lines.push('|-------|-----|------|');
    for (const f of optional) {
      lines.push(`| ${f.name} | \`${f.key}\` | ${getTypeDisplay(f)} |`);
    }
    lines.push('');
  }

  // Add values section if requested
  if (showValues) {
    const fieldsWithValues = fields.filter(
      (f) => f.allowedValues && f.allowedValues.length > 0
    );

    if (fieldsWithValues.length > 0) {
      lines.push('## Field Values');
      lines.push('');

      for (const f of fieldsWithValues) {
        lines.push(`### ${f.name}`);
        lines.push('');
        const valuesStr = formatAllowedValues(f.allowedValues, maxValues);
        lines.push(`Allowed values: ${valuesStr}`);
        lines.push('');
      }
    }
  }

  return lines.join('\n');
}

/**
 * Note on yargs camelCase handling:
 * yargs automatically converts kebab-case options to camelCase in argv:
 * - 'show-values' becomes 'showValues'
 * - 'max-values' becomes 'maxValues'
 * The FieldsArgsSchema uses camelCase property names to match this behavior.
 */
async function handler(argv: ArgumentsCamelCase<FieldsArgs>): Promise<void> {
  const args = validateArgs(FieldsArgsSchema, argv, 'fields arguments');
  const {
    project,
    type: issueType,
    filter,
    showValues,
    maxValues,
    format,
  } = args;

  try {
    const { config } = await loadConfig();
    const client = new JiraClient(config);

    logProgress(`Fetching field metadata for project ${project}...`, format);

    const createMeta = await client.getCreateMeta(project);

    // Find the project
    const projectMeta = createMeta.projects.find(
      (p) => p.key.toUpperCase() === project.toUpperCase()
    );

    if (!projectMeta) {
      throw new Error(`Project '${project}' not found`);
    }

    // If issue type specified, find it
    let issueTypes: JiraIssueTypeMeta[];
    if (issueType) {
      const foundType = projectMeta.issuetypes.find(
        (it) => it.name.toLowerCase() === issueType.toLowerCase()
      );

      if (!foundType) {
        const available = projectMeta.issuetypes
          .map((it) => it.name)
          .join(', ');
        throw new Error(
          `Issue type '${issueType}' not found in project ${project}\nAvailable types: ${available}`
        );
      }

      issueTypes = [foundType];
    } else {
      issueTypes = projectMeta.issuetypes;
    }

    // Collect all fields across issue types
    const allFields = new Map<string, JiraFieldMeta>();
    for (const it of issueTypes) {
      for (const [key, meta] of Object.entries(it.fields)) {
        // If field already exists, prefer the version that's marked as required
        const existing = allFields.get(key);
        if (!existing || meta.required) {
          allFields.set(key, { ...meta, key });
        }
      }
    }

    // Filter fields (filter defaults to 'all' from schema validation)
    const filterValue = filter ?? 'all';
    const filteredFields = Array.from(allFields.values())
      .filter((f) => matchesFilter(f, filterValue))
      .sort((a, b) => {
        // Sort: required first, then alphabetically by name
        if (a.required !== b.required) {
          return a.required ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });

    if (filteredFields.length === 0) {
      console.log(`No fields found matching filter '${filter}'`);
      return;
    }

    // Defaults from schema validation
    const showValuesFlag = showValues ?? false;
    const maxValuesCount = maxValues ?? 10;

    // Output based on format
    if (format === 'json') {
      const output = formatFieldsJson(filteredFields, project, issueType);
      console.log(JSON.stringify(output, null, 2));
    } else if (format === 'markdown') {
      const output = formatFieldsMarkdown(
        filteredFields,
        project,
        issueType,
        showValuesFlag,
        maxValuesCount
      );
      console.log(output);
    } else {
      // Text format
      console.log('');
      console.log(
        `Fields for ${project}${issueType ? ` - ${issueType}` : ''} (${filteredFields.length} fields):`
      );
      console.log('');

      const required = filteredFields.filter((f) => f.required);
      const optional = filteredFields.filter((f) => !f.required);

      if (required.length > 0) {
        console.log('Required fields:');
        for (const f of required) {
          console.log(formatFieldText(f, showValuesFlag, maxValuesCount));
        }
        console.log('');
      }

      if (optional.length > 0) {
        console.log('Optional fields:');
        for (const f of optional) {
          console.log(formatFieldText(f, showValuesFlag, maxValuesCount));
        }
        console.log('');
      }

      // Show usage hint
      if (
        !showValuesFlag &&
        filteredFields.some((f) => f.allowedValues?.length)
      ) {
        console.log(
          'Tip: Use --show-values to see allowed values for select fields'
        );
      }
    }
  } catch (error) {
    handleCommandError(error);
  }
}

export default {
  command: 'fields <project>',
  describe: 'List available fields for a project and issue type',
  builder: {
    project: {
      type: 'string',
      describe: 'Project key (e.g., PROJ)',
      demandOption: true,
    },
    type: {
      type: 'string',
      alias: 't',
      describe:
        'Issue type (e.g., Task, Bug, Story). If omitted, shows fields for all types.',
    },
    filter: {
      type: 'string',
      alias: 'f',
      choices: ['all', 'required', 'optional', 'custom', 'system'] as const,
      default: 'all' as const,
      describe: 'Filter fields by category',
    },
    'show-values': {
      type: 'boolean',
      alias: 'v',
      default: false,
      describe: 'Show allowed values for select/option fields',
    },
    'max-values': {
      type: 'number',
      default: 10,
      describe: 'Maximum number of allowed values to display per field',
    },
    format: {
      type: 'string',
      choices: ['text', 'json', 'markdown'] as const,
      default: 'text' as const,
      describe: 'Output format',
    },
  },
  handler,
} satisfies CommandModule<object, FieldsArgs>;
