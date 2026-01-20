/**
 * Jira field value formatting utilities
 * Automatically formats values based on field type
 */

import type { ResolvedField, AllowedValue } from './field-resolver.js';

/**
 * Result of value formatting
 */
export interface FormattingResult {
  success: boolean;
  formattedValue?: unknown;
  originalValue: unknown;
  formatDescription?: string;
  error?: string;
}

/**
 * Check if a value is already formatted as an object
 */
function isAlreadyFormatted(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const obj = value as Record<string, unknown>;
  // Check for common Jira object structures
  return (
    'value' in obj ||
    'name' in obj ||
    'id' in obj ||
    'accountId' in obj ||
    'key' in obj
  );
}

/**
 * Check if a value is an array of formatted objects
 */
function isFormattedArray(value: unknown): boolean {
  if (!Array.isArray(value)) {
    return false;
  }
  return value.length === 0 || value.every(isAlreadyFormatted);
}

/**
 * Detect the format style for allowed values
 * Inspects the allowedValues to determine if the field expects:
 * - 'name': Fields like components that use { name: "..." }
 * - 'value': Fields like options that use { value: "..." }
 * - 'id': Fields that require ID references
 */
function detectAllowedValueFormat(
  allowedValues: AllowedValue[] | undefined
): 'name' | 'value' | 'id' {
  if (!allowedValues || allowedValues.length === 0) {
    return 'value'; // Default fallback
  }

  // Sample the first few allowed values to detect the pattern
  const sample = allowedValues.slice(0, 3);

  // Check if values primarily use 'name' (like components)
  // These typically have name but NOT value
  const hasNameOnly = sample.some((av) => av.name && !av.value);
  if (hasNameOnly) {
    return 'name';
  }

  // Check if values primarily use 'value' (like options)
  const hasValue = sample.some((av) => av.value);
  if (hasValue) {
    return 'value';
  }

  // Check if we only have IDs
  const hasIdOnly = sample.every((av) => av.id && !av.name && !av.value);
  if (hasIdOnly) {
    return 'id';
  }

  // Default to name if we have names but couldn't determine otherwise
  const hasName = sample.some((av) => av.name);
  if (hasName) {
    return 'name';
  }

  return 'value'; // Ultimate fallback
}

/**
 * Find matching allowed value (returns the actual value to use)
 */
function findMatchingAllowedValue(
  input: string,
  allowedValues: AllowedValue[] | undefined
): AllowedValue | undefined {
  if (!allowedValues || allowedValues.length === 0) {
    return undefined;
  }

  const inputLower = input.toLowerCase();

  for (const av of allowedValues) {
    if (
      (av.name && av.name.toLowerCase() === inputLower) ||
      (av.value && av.value.toLowerCase() === inputLower) ||
      av.id === input
    ) {
      return av;
    }
  }

  return undefined;
}

/**
 * Format a value for an option/select field
 */
function formatOptionValue(
  value: unknown,
  field: ResolvedField
): FormattingResult {
  // Already formatted
  if (isAlreadyFormatted(value)) {
    return {
      success: true,
      formattedValue: value,
      originalValue: value,
      formatDescription: 'pre-formatted object',
    };
  }

  const stringValue = String(value);
  const allowedValues = field.metadata.allowedValues as
    | AllowedValue[]
    | undefined;

  // Try to find matching allowed value
  const match = findMatchingAllowedValue(stringValue, allowedValues);

  if (match) {
    // Use the value field if available, otherwise use name
    const formattedValue = { value: match.value || match.name };
    return {
      success: true,
      formattedValue,
      originalValue: value,
      formatDescription: `{"value": "${match.value || match.name}"}`,
    };
  }

  // No match found - still format it, validation will catch invalid values
  return {
    success: true,
    formattedValue: { value: stringValue },
    originalValue: value,
    formatDescription: `{"value": "${stringValue}"}`,
  };
}

/**
 * Format a value for an array field (multi-select)
 */
function formatArrayValue(
  value: unknown,
  field: ResolvedField
): FormattingResult {
  // Already a formatted array
  if (isFormattedArray(value)) {
    return {
      success: true,
      formattedValue: value,
      originalValue: value,
      formatDescription: 'pre-formatted array',
    };
  }

  // Parse comma-separated string into array
  let items: string[];
  if (typeof value === 'string') {
    items = value
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  } else if (Array.isArray(value)) {
    items = value.map(String);
  } else {
    items = [String(value)];
  }

  const itemType = field.metadata.schema.items;
  const allowedValues = field.metadata.allowedValues as
    | AllowedValue[]
    | undefined;

  // Format each item based on the items type
  if (itemType === 'option' || itemType === 'string') {
    const formattedItems = items.map((item) => {
      const match = findMatchingAllowedValue(item, allowedValues);
      return { value: match?.value || match?.name || item };
    });

    return {
      success: true,
      formattedValue: formattedItems,
      originalValue: value,
      formatDescription: `[${formattedItems.map((i) => `{"value": "${i.value}"}`).join(', ')}]`,
    };
  }

  if (itemType === 'user') {
    const formattedItems = items.map((item) => ({ accountId: item }));
    return {
      success: true,
      formattedValue: formattedItems,
      originalValue: value,
      formatDescription: `[${formattedItems.map((i) => `{"accountId": "${i.accountId}"}`).join(', ')}]`,
    };
  }

  // Determine the correct format by inspecting allowedValues structure
  // Jira fields use different formats: { name }, { value }, { id }, etc.
  // We detect this by checking what properties the allowedValues have
  const formatStyle = detectAllowedValueFormat(allowedValues);

  const formattedItems: Array<
    { name: string } | { id: string } | { value: string }
  > = [];
  const descriptions: string[] = [];

  for (const item of items) {
    const match = findMatchingAllowedValue(item, allowedValues);
    if (formatStyle === 'name') {
      const val = match?.name || item;
      formattedItems.push({ name: val });
      descriptions.push(`{"name": "${val}"}`);
    } else if (formatStyle === 'id') {
      const val = match?.id || item;
      formattedItems.push({ id: val });
      descriptions.push(`{"id": "${val}"}`);
    } else {
      const val = match?.value || match?.name || item;
      formattedItems.push({ value: val });
      descriptions.push(`{"value": "${val}"}`);
    }
  }

  return {
    success: true,
    formattedValue: formattedItems,
    originalValue: value,
    formatDescription: `[${descriptions.join(', ')}]`,
  };
}

/**
 * Format a value for a user field
 */
function formatUserValue(
  value: unknown,
  _field: ResolvedField
): FormattingResult {
  // Already formatted
  if (isAlreadyFormatted(value)) {
    return {
      success: true,
      formattedValue: value,
      originalValue: value,
      formatDescription: 'pre-formatted user object',
    };
  }

  const stringValue = String(value);

  // Check if it looks like an account ID (alphanumeric string)
  // Account IDs are typically 24-character hex strings
  const formatted = { accountId: stringValue };

  return {
    success: true,
    formattedValue: formatted,
    originalValue: value,
    formatDescription: `{"accountId": "${stringValue}"}`,
  };
}

/**
 * Format a value for a priority field
 */
function formatPriorityValue(
  value: unknown,
  field: ResolvedField
): FormattingResult {
  if (isAlreadyFormatted(value)) {
    return {
      success: true,
      formattedValue: value,
      originalValue: value,
      formatDescription: 'pre-formatted priority object',
    };
  }

  const stringValue = String(value);
  const allowedValues = field.metadata.allowedValues as
    | AllowedValue[]
    | undefined;
  const match = findMatchingAllowedValue(stringValue, allowedValues);

  // Use ID if we found a match, otherwise use name
  const formatted = match ? { id: match.id } : { name: stringValue };

  return {
    success: true,
    formattedValue: formatted,
    originalValue: value,
    formatDescription: match
      ? `{"id": "${match.id}"}`
      : `{"name": "${stringValue}"}`,
  };
}

/**
 * Format a value for version/component fields
 */
function formatNamedObjectValue(
  value: unknown,
  _field: ResolvedField,
  objectType: string
): FormattingResult {
  if (isAlreadyFormatted(value)) {
    return {
      success: true,
      formattedValue: value,
      originalValue: value,
      formatDescription: `pre-formatted ${objectType} object`,
    };
  }

  const stringValue = String(value);
  const formatted = { name: stringValue };

  return {
    success: true,
    formattedValue: formatted,
    originalValue: value,
    formatDescription: `{"name": "${stringValue}"}`,
  };
}

/**
 * Format a number value
 */
function formatNumberValue(value: unknown): FormattingResult {
  if (typeof value === 'number') {
    return {
      success: true,
      formattedValue: value,
      originalValue: value,
      formatDescription: 'number',
    };
  }

  const num = Number(value);
  if (isNaN(num)) {
    return {
      success: false,
      originalValue: value,
      error: `Invalid number value: ${value}`,
    };
  }

  return {
    success: true,
    formattedValue: num,
    originalValue: value,
    formatDescription: `${num}`,
  };
}

/**
 * Format a date value
 */
function formatDateValue(value: unknown): FormattingResult {
  const stringValue = String(value);

  // Try to parse as date
  const date = new Date(stringValue);
  if (isNaN(date.getTime())) {
    return {
      success: false,
      originalValue: value,
      error: `Invalid date value: ${value}. Use format YYYY-MM-DD`,
    };
  }

  // Format as ISO date (YYYY-MM-DD)
  const formatted = date.toISOString().split('T')[0];

  return {
    success: true,
    formattedValue: formatted,
    originalValue: value,
    formatDescription: formatted,
  };
}

/**
 * Format a datetime value
 */
function formatDateTimeValue(value: unknown): FormattingResult {
  const stringValue = String(value);

  const date = new Date(stringValue);
  if (isNaN(date.getTime())) {
    return {
      success: false,
      originalValue: value,
      error: `Invalid datetime value: ${value}. Use ISO format`,
    };
  }

  const formatted = date.toISOString();

  return {
    success: true,
    formattedValue: formatted,
    originalValue: value,
    formatDescription: formatted,
  };
}

/**
 * Main function to format a field value based on its type
 */
export function formatFieldValue(
  field: ResolvedField,
  value: unknown
): FormattingResult {
  const schemaType = field.metadata.schema.type;
  const customType = field.metadata.schema.custom;

  // Handle array types
  if (schemaType === 'array') {
    return formatArrayValue(value, field);
  }

  // Handle option/select types
  if (schemaType === 'option') {
    return formatOptionValue(value, field);
  }

  // Handle user types
  if (schemaType === 'user') {
    return formatUserValue(value, field);
  }

  // Handle priority
  if (schemaType === 'priority' || field.key === 'priority') {
    return formatPriorityValue(value, field);
  }

  // Handle resolution
  if (schemaType === 'resolution' || field.key === 'resolution') {
    return formatNamedObjectValue(value, field, 'resolution');
  }

  // Handle version fields
  if (
    schemaType === 'version' ||
    field.key === 'fixVersions' ||
    field.key === 'versions'
  ) {
    return formatNamedObjectValue(value, field, 'version');
  }

  // Handle component fields
  if (schemaType === 'component' || field.key === 'components') {
    return formatNamedObjectValue(value, field, 'component');
  }

  // Handle number types
  if (schemaType === 'number') {
    return formatNumberValue(value);
  }

  // Handle date types
  if (schemaType === 'date') {
    return formatDateValue(value);
  }

  // Handle datetime types
  if (schemaType === 'datetime') {
    return formatDateTimeValue(value);
  }

  // Check for custom field types that need special handling
  if (customType) {
    // com.atlassian.jira.plugin.system.customfieldtypes:select
    if (customType.includes('select') || customType.includes('radiobuttons')) {
      return formatOptionValue(value, field);
    }

    // com.atlassian.jira.plugin.system.customfieldtypes:multiselect
    if (
      customType.includes('multiselect') ||
      customType.includes('multicheckboxes')
    ) {
      return formatArrayValue(value, field);
    }

    // com.atlassian.jira.plugin.system.customfieldtypes:userpicker
    if (customType.includes('userpicker')) {
      return formatUserValue(value, field);
    }

    // com.atlassian.jira.plugin.system.customfieldtypes:multiuserpicker
    if (customType.includes('multiuserpicker')) {
      return formatArrayValue(value, field);
    }

    // com.atlassian.jira.plugin.system.customfieldtypes:cascadingselect
    if (customType.includes('cascadingselect')) {
      // Cascading select is complex - for now, pass through
      return {
        success: true,
        formattedValue: value,
        originalValue: value,
        formatDescription: 'cascading select (pass-through)',
      };
    }
  }

  // Default: pass through as-is (string, text, etc.)
  return {
    success: true,
    formattedValue: value,
    originalValue: value,
    formatDescription: 'pass-through (text/string)',
  };
}

/**
 * Format multiple field values
 */
export function formatFieldValues(
  resolvedFields: Map<string, ResolvedField>,
  fieldPairs: Array<{ name: string; value: unknown }>
): {
  success: boolean;
  formatted: Map<string, { value: unknown; description: string }>;
  errors: Array<{ name: string; error: string }>;
} {
  const formatted = new Map<string, { value: unknown; description: string }>();
  const errors: Array<{ name: string; error: string }> = [];
  let allSuccess = true;

  for (const { name, value } of fieldPairs) {
    const field = resolvedFields.get(name);

    if (!field) {
      // Field not resolved, pass through as-is
      formatted.set(name, { value, description: 'unresolved (pass-through)' });
      continue;
    }

    const result = formatFieldValue(field, value);

    if (result.success) {
      formatted.set(name, {
        value: result.formattedValue,
        description: result.formatDescription || 'formatted',
      });
    } else {
      errors.push({ name, error: result.error || 'Unknown formatting error' });
      allSuccess = false;
    }
  }

  return { success: allSuccess, formatted, errors };
}
