# Field Formatting Improvement Specification

This document provides a comprehensive implementation specification for improving how the aide CLI formats Jira field values.

## Table of Contents

1. [Problem Statement](#problem-statement)
2. [Solution Overview](#solution-overview)
3. [Detailed Implementation](#detailed-implementation)
4. [Explicit Format Parsing](#explicit-format-parsing)
5. [Simplified Format Detection](#simplified-format-detection)
6. [Verbose Error Generation](#verbose-error-generation)
7. [Test Cases](#test-cases)
8. [Documentation Updates](#documentation-updates)

---

## Problem Statement

### Current Issues

The current field value formatting implementation in `src/lib/value-formatter.ts` has several reliability and usability problems:

#### 1. Unreliable Format Detection

The `detectAllowedValueFormat()` function samples only the first 3 items from `allowedValues` to determine the format:

```typescript
// Current problematic code
function detectAllowedValueFormat(
  allowedValues: AllowedValue[] | undefined
): 'name' | 'value' | 'id' {
  if (!allowedValues || allowedValues.length === 0) {
    return 'value'; // Default fallback
  }

  // Sample the first few allowed values to detect the pattern
  const sample = allowedValues.slice(0, 3);  // <-- PROBLEM: Only samples 3 items

  // ... complex logic that can produce incorrect results
}
```

**Problems:**
- If the first 3 items don't represent the full pattern, wrong format is detected
- Fields with mixed properties (both `name` and `value`) may be misclassified
- The heuristics are complex and hard to debug

#### 2. Silent Failures

When the wrong format is detected:
- Values are formatted incorrectly (e.g., `{name: "X"}` instead of `{value: "X"}`)
- Jira API rejects the request with cryptic errors
- Users have no visibility into what format was attempted

#### 3. No Explicit User Control

Users cannot override the auto-detection when it fails. If `detectAllowedValueFormat()` chooses wrong, the only workaround is to pass pre-formatted JSON objects.

#### 4. Case Sensitivity Inconsistency

In `findMatchingAllowedValue()` and `validateFieldValue()`:
- Name and value matching is case-insensitive: `av.name.toLowerCase() === inputLower`
- ID matching is case-sensitive: `av.id === input`

This can cause issues when users provide IDs with different casing.

---

## Solution Overview

Implement a three-pronged approach:

### 1. Explicit Format Syntax

Allow users to prefix values with `@name:`, `@value:`, or `@id:` to explicitly specify the format:

```bash
# Explicitly use name format
aide jira update PROJ-123 --field "Components=@name:Backend"

# Explicitly use value format
aide jira update PROJ-123 --field "Severity=@value:High"

# Explicitly use ID format
aide jira update PROJ-123 --field "Priority=@id:3"
```

### 2. Simplified Auto-Detection

Replace the complex sampling logic with a simpler approach that checks only the **first** `allowedValue` item:

- If first item has `value` property -> use `value` format
- If first item has `name` but no `value` -> use `name` format
- If first item has only `id` -> use `id` format
- Default to `value` if no allowedValues

### 3. Verbose Actionable Errors

When formatting fails, provide detailed error messages showing:
- What format was attempted
- What the actual allowedValues look like
- How to use explicit format syntax to fix

---

## Detailed Implementation

### Files to Modify

| File | Changes |
|------|---------|
| `src/lib/value-formatter.ts` | Add `parseExplicitFormat()`, simplify `detectAllowedValueFormat()`, update formatting functions |
| `src/lib/field-resolver.ts` | Make ID matching case-insensitive, improve error messages |

---

## Explicit Format Parsing

### Add to `src/lib/value-formatter.ts`

Add a new interface and function at the top of the file (after the imports):

```typescript
/**
 * Result of parsing a value for explicit format prefix
 */
export interface ParsedValue {
  /** The format explicitly requested, or null if none */
  format: 'name' | 'value' | 'id' | null;
  /** The actual value (with prefix stripped if present) */
  value: string;
}

/**
 * Supported explicit format prefixes
 */
const FORMAT_PREFIXES = {
  '@name:': 'name',
  '@value:': 'value',
  '@id:': 'id',
} as const;

/**
 * Parse a value string for explicit format prefix
 *
 * Supports prefixes: @name:, @value:, @id:
 *
 * @example
 * parseExplicitFormat("@name:Backend")  // { format: 'name', value: 'Backend' }
 * parseExplicitFormat("@value:High")    // { format: 'value', value: 'High' }
 * parseExplicitFormat("@id:10001")      // { format: 'id', value: '10001' }
 * parseExplicitFormat("Normal Value")   // { format: null, value: 'Normal Value' }
 */
export function parseExplicitFormat(input: string): ParsedValue {
  const inputLower = input.toLowerCase();

  for (const [prefix, format] of Object.entries(FORMAT_PREFIXES)) {
    if (inputLower.startsWith(prefix)) {
      return {
        format: format as 'name' | 'value' | 'id',
        value: input.slice(prefix.length),
      };
    }
  }

  return {
    format: null,
    value: input,
  };
}
```

### Update `findMatchingAllowedValue()` Function

Modify to support explicit format and case-insensitive ID matching:

```typescript
/**
 * Find matching allowed value
 *
 * @param input - The user-provided value (may have @format: prefix)
 * @param allowedValues - The list of allowed values from field metadata
 * @param explicitFormat - Optional explicit format from parseExplicitFormat()
 */
function findMatchingAllowedValue(
  input: string,
  allowedValues: AllowedValue[] | undefined,
  explicitFormat: 'name' | 'value' | 'id' | null = null
): AllowedValue | undefined {
  if (!allowedValues || allowedValues.length === 0) {
    return undefined;
  }

  const inputLower = input.toLowerCase();

  // If explicit format specified, only search that field
  if (explicitFormat) {
    for (const av of allowedValues) {
      switch (explicitFormat) {
        case 'name':
          if (av.name && av.name.toLowerCase() === inputLower) {
            return av;
          }
          break;
        case 'value':
          if (av.value && av.value.toLowerCase() === inputLower) {
            return av;
          }
          break;
        case 'id':
          // Case-insensitive ID matching
          if (av.id && av.id.toLowerCase() === inputLower) {
            return av;
          }
          break;
      }
    }
    return undefined;
  }

  // No explicit format - try all fields (existing behavior with case-insensitive ID)
  for (const av of allowedValues) {
    if (
      (av.name && av.name.toLowerCase() === inputLower) ||
      (av.value && av.value.toLowerCase() === inputLower) ||
      (av.id && av.id.toLowerCase() === inputLower)  // Now case-insensitive
    ) {
      return av;
    }
  }

  return undefined;
}
```

---

## Simplified Format Detection

### Replace `detectAllowedValueFormat()` Function

Replace the existing complex function with this simplified version:

```typescript
/**
 * Detect the format style for allowed values by inspecting the first item
 *
 * This simplified approach checks only the first allowedValue to determine format:
 * - If it has 'value' property -> 'value' format (most common for selects)
 * - If it has 'name' but no 'value' -> 'name' format (components, versions)
 * - If it has only 'id' -> 'id' format (rare)
 *
 * @param allowedValues - The allowed values from field metadata
 * @returns The detected format style
 */
function detectAllowedValueFormat(
  allowedValues: AllowedValue[] | undefined
): 'name' | 'value' | 'id' {
  if (!allowedValues || allowedValues.length === 0) {
    return 'value'; // Default fallback for fields without allowedValues
  }

  const first = allowedValues[0];
  if (!first) {
    return 'value';
  }

  // Priority: value > name > id
  // Most Jira select fields use {value: "..."}
  if (first.value !== undefined) {
    return 'value';
  }

  // Components, versions use {name: "..."}
  if (first.name !== undefined) {
    return 'name';
  }

  // Fallback to ID if that's all we have
  if (first.id !== undefined) {
    return 'id';
  }

  return 'value'; // Ultimate fallback
}
```

### Update `formatArrayValue()` to Use Explicit Format

Modify the `formatArrayValue()` function to parse explicit format prefixes:

```typescript
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

  // Check if any items have explicit format prefix
  // If so, use that format for all items
  let explicitFormat: 'name' | 'value' | 'id' | null = null;
  const parsedItems: string[] = [];

  for (const item of items) {
    const parsed = parseExplicitFormat(item);
    if (parsed.format && !explicitFormat) {
      explicitFormat = parsed.format;
    }
    parsedItems.push(parsed.value);
  }

  // Format each item based on the items type
  if (itemType === 'option' || itemType === 'string') {
    const formattedItems = parsedItems.map((item) => {
      const match = findMatchingAllowedValue(item, allowedValues, explicitFormat);
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
    const formattedItems = parsedItems.map((item) => ({ accountId: item }));
    return {
      success: true,
      formattedValue: formattedItems,
      originalValue: value,
      formatDescription: `[${formattedItems.map((i) => `{"accountId": "${i.accountId}"}`).join(', ')}]`,
    };
  }

  // Determine format: explicit > auto-detect
  const formatStyle = explicitFormat || detectAllowedValueFormat(allowedValues);

  const formattedItems: Array<{ name: string } | { id: string } | { value: string }> = [];
  const descriptions: string[] = [];
  const errors: string[] = [];

  for (const item of parsedItems) {
    const match = findMatchingAllowedValue(item, allowedValues, explicitFormat);

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

    // Track if we didn't find a match
    if (!match && allowedValues && allowedValues.length > 0) {
      errors.push(item);
    }
  }

  // Generate verbose error if values weren't matched
  if (errors.length > 0) {
    return {
      success: true,  // Still succeed but include warning
      formattedValue: formattedItems,
      originalValue: value,
      formatDescription: `[${descriptions.join(', ')}]`,
      // Add warning about unmatched values (would need to add this field to FormattingResult)
    };
  }

  return {
    success: true,
    formattedValue: formattedItems,
    originalValue: value,
    formatDescription: `[${descriptions.join(', ')}]`,
  };
}
```

### Update `formatOptionValue()` to Use Explicit Format

```typescript
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

  // Parse explicit format prefix
  const parsed = parseExplicitFormat(stringValue);

  // Try to find matching allowed value
  const match = findMatchingAllowedValue(parsed.value, allowedValues, parsed.format);

  if (match) {
    // Determine which property to use based on explicit format or what's available
    if (parsed.format === 'name' && match.name) {
      return {
        success: true,
        formattedValue: { name: match.name },
        originalValue: value,
        formatDescription: `{"name": "${match.name}"}`,
      };
    }
    if (parsed.format === 'id' && match.id) {
      return {
        success: true,
        formattedValue: { id: match.id },
        originalValue: value,
        formatDescription: `{"id": "${match.id}"}`,
      };
    }
    // Default to value format
    const formattedValue = { value: match.value || match.name };
    return {
      success: true,
      formattedValue,
      originalValue: value,
      formatDescription: `{"value": "${match.value || match.name}"}`,
    };
  }

  // No match found - format with the value and let validation catch it
  // Use explicit format if specified, otherwise default to value
  if (parsed.format === 'name') {
    return {
      success: true,
      formattedValue: { name: parsed.value },
      originalValue: value,
      formatDescription: `{"name": "${parsed.value}"}`,
    };
  }
  if (parsed.format === 'id') {
    return {
      success: true,
      formattedValue: { id: parsed.value },
      originalValue: value,
      formatDescription: `{"id": "${parsed.value}"}`,
    };
  }

  return {
    success: true,
    formattedValue: { value: parsed.value },
    originalValue: value,
    formatDescription: `{"value": "${parsed.value}"}`,
  };
}
```

---

## Verbose Error Generation

### Update `FormattingResult` Interface

Add fields to track formatting details for better error messages:

```typescript
/**
 * Result of value formatting
 */
export interface FormattingResult {
  success: boolean;
  formattedValue?: unknown;
  originalValue: unknown;
  formatDescription?: string;
  error?: string;
  /** The format style that was used (for debugging) */
  formatUsed?: 'name' | 'value' | 'id';
  /** Whether explicit format was specified */
  explicitFormat?: boolean;
  /** Warning message (non-fatal issue) */
  warning?: string;
}
```

### Add Verbose Error Generation Function

Add this function to `src/lib/value-formatter.ts`:

```typescript
/**
 * Generate a verbose, actionable error message for formatting failures
 */
export function generateFormattingError(
  fieldName: string,
  inputValue: string,
  attemptedFormat: 'name' | 'value' | 'id',
  allowedValues: AllowedValue[] | undefined
): string {
  const lines: string[] = [];

  lines.push(`Failed to format value "${inputValue}" for field "${fieldName}"`);
  lines.push('');
  lines.push(`Attempted format: ${attemptedFormat}`);

  if (allowedValues && allowedValues.length > 0) {
    lines.push('');
    lines.push('Allowed values structure (first item):');
    const first = allowedValues[0];
    if (first) {
      if (first.id) lines.push(`  - id: "${first.id}"`);
      if (first.name) lines.push(`  - name: "${first.name}"`);
      if (first.value) lines.push(`  - value: "${first.value}"`);
    }

    lines.push('');
    lines.push('Available values:');
    const maxShow = 5;
    const displayValues = allowedValues.slice(0, maxShow);
    for (const av of displayValues) {
      const display = av.value || av.name || av.id || '(unknown)';
      lines.push(`  - ${display}`);
    }
    if (allowedValues.length > maxShow) {
      lines.push(`  ... and ${allowedValues.length - maxShow} more`);
    }
  }

  lines.push('');
  lines.push('To fix this, try one of these explicit format prefixes:');
  lines.push(`  @value:${inputValue}  - Format as {"value": "${inputValue}"}`);
  lines.push(`  @name:${inputValue}   - Format as {"name": "${inputValue}"}`);
  lines.push(`  @id:${inputValue}     - Format as {"id": "${inputValue}"}`);
  lines.push('');
  lines.push('Example:');
  lines.push(`  aide jira update PROJ-123 --field "${fieldName}=@value:${inputValue}"`);

  return lines.join('\n');
}
```

### Update `src/lib/field-resolver.ts` for Better Errors

#### Make ID Matching Case-Insensitive in `validateFieldValue()`

Update the validation loop:

```typescript
/**
 * Check if a value is valid for a field and provide helpful error if not
 */
export function validateFieldValue(
  field: ResolvedField,
  value: unknown
): ValueValidationResult {
  const allowedValues = field.metadata.allowedValues;

  // If no allowed values defined, assume any value is valid
  if (!allowedValues || allowedValues.length === 0) {
    return { valid: true, normalizedValue: value };
  }

  // Handle array values - validate each item
  if (Array.isArray(value)) {
    for (const item of value) {
      const itemResult = validateFieldValue(field, item);
      if (!itemResult.valid) {
        return itemResult;
      }
    }
    return { valid: true, normalizedValue: value };
  }

  // For object values (already formatted), extract the comparison value
  let compareValue: string;
  if (typeof value === 'object' && value !== null) {
    const objValue = value as Record<string, unknown>;
    compareValue = String(objValue.value || objValue.name || objValue.id || '');
  } else {
    compareValue = String(value);
  }

  const compareLower = compareValue.toLowerCase();

  // Check for exact match (case-insensitive for all fields including ID)
  for (const av of allowedValues) {
    if (
      (av.name && av.name.toLowerCase() === compareLower) ||
      (av.value && av.value.toLowerCase() === compareLower) ||
      (av.id && av.id.toLowerCase() === compareLower)  // <-- Now case-insensitive
    ) {
      return { valid: true, normalizedValue: value };
    }
  }

  // No match - provide helpful error with suggestions
  const suggestions = findSimilarValues(compareValue, allowedValues);

  return {
    valid: false,
    error: `Invalid value "${compareValue}" for field "${field.displayName}"`,
    allowedValues,
    suggestions: suggestions.length > 0 ? suggestions : undefined,
  };
}
```

#### Improve `formatValidationErrors()` Output

Update to show the structure of allowed values:

```typescript
/**
 * Format validation errors with allowed values for display
 */
export function formatValidationErrors(
  results: Map<string, ValueValidationResult>
): string {
  const lines: string[] = [];

  for (const [fieldName, result] of results) {
    if (!result.valid && result.error) {
      lines.push(`Error: ${result.error}`);

      if (result.suggestions && result.suggestions.length > 0) {
        lines.push(`  Did you mean: ${result.suggestions[0]}?`);
      }

      if (result.allowedValues && result.allowedValues.length > 0) {
        // Show structure of first allowed value
        const first = result.allowedValues[0];
        if (first) {
          const hasName = first.name !== undefined;
          const hasValue = first.value !== undefined;
          const hasId = first.id !== undefined;

          lines.push(`  Field accepts: ${[
            hasValue && 'value',
            hasName && 'name',
            hasId && 'id'
          ].filter(Boolean).join(', ')}`);
        }

        lines.push(
          `  Valid options: ${formatAllowedValues(result.allowedValues)}`
        );

        // Suggest explicit format syntax
        lines.push('');
        lines.push('  Tip: Use explicit format prefix to specify how to match:');
        lines.push(`    --field "${fieldName}=@value:YourValue"`);
        lines.push(`    --field "${fieldName}=@name:YourValue"`);
        lines.push(`    --field "${fieldName}=@id:YourId"`);
      }

      lines.push(''); // Blank line between errors
    }
  }

  return lines.join('\n').trimEnd();
}
```

---

## Test Cases

### Manual Testing Commands

Run these commands to verify the implementation:

#### 1. Explicit Format Works

```bash
# Test @value: prefix
bun run dev jira update TEST-123 --field "Severity=@value:High"

# Test @name: prefix (for components)
bun run dev jira update TEST-123 --field "Components=@name:Backend"

# Test @id: prefix
bun run dev jira update TEST-123 --field "Priority=@id:3"

# Test with multi-value fields
bun run dev jira update TEST-123 --field "Components=@name:Backend,@name:Frontend"
```

#### 2. Auto-Detection Works

```bash
# Standard select field (should auto-detect 'value' format)
bun run dev jira update TEST-123 --field "Severity=High"

# Component field (should auto-detect 'name' format)
bun run dev jira update TEST-123 --field "Components=Backend"

# Check field metadata to verify detection
bun run dev jira fields PROJECT -t Story --show-values
```

#### 3. Error Messages Are Helpful

```bash
# Use invalid value to trigger error
bun run dev jira update TEST-123 --field "Severity=InvalidValue"
# Should show:
# - What format was attempted
# - Structure of allowed values
# - How to use explicit format prefixes

# Use wrong format explicitly to see detailed error
bun run dev jira update TEST-123 --field "Components=@value:Backend"
# Should fail and explain that Components uses 'name' format
```

#### 4. Case-Insensitive ID Matching

```bash
# Test with lowercase ID when actual ID is uppercase/mixed
bun run dev jira update TEST-123 --field "Priority=@id:high"

# Test without explicit format (should still match case-insensitively)
bun run dev jira update TEST-123 --field "Status=done"
```

### Unit Test Cases

Add to test file (create `src/lib/__tests__/value-formatter.test.ts` if needed):

```typescript
import { describe, it, expect } from 'bun:test';
import { parseExplicitFormat, formatFieldValue } from '../value-formatter';

describe('parseExplicitFormat', () => {
  it('should parse @value: prefix', () => {
    const result = parseExplicitFormat('@value:High');
    expect(result).toEqual({ format: 'value', value: 'High' });
  });

  it('should parse @name: prefix', () => {
    const result = parseExplicitFormat('@name:Backend');
    expect(result).toEqual({ format: 'name', value: 'Backend' });
  });

  it('should parse @id: prefix', () => {
    const result = parseExplicitFormat('@id:10001');
    expect(result).toEqual({ format: 'id', value: '10001' });
  });

  it('should handle no prefix', () => {
    const result = parseExplicitFormat('Normal Value');
    expect(result).toEqual({ format: null, value: 'Normal Value' });
  });

  it('should be case-insensitive for prefix', () => {
    const result = parseExplicitFormat('@VALUE:Test');
    expect(result).toEqual({ format: 'value', value: 'Test' });
  });

  it('should preserve value casing', () => {
    const result = parseExplicitFormat('@name:MyComponent');
    expect(result).toEqual({ format: 'name', value: 'MyComponent' });
  });
});

describe('detectAllowedValueFormat', () => {
  it('should detect value format from first item', () => {
    const allowedValues = [
      { id: '1', value: 'High' },
      { id: '2', value: 'Medium' },
    ];
    // detectAllowedValueFormat is internal, test via formatFieldValue
    // ...
  });

  it('should detect name format when no value property', () => {
    const allowedValues = [
      { id: '1', name: 'Backend' },
      { id: '2', name: 'Frontend' },
    ];
    // ...
  });
});

describe('formatFieldValue with explicit format', () => {
  const mockField = (allowedValues: any[]) => ({
    originalName: 'TestField',
    key: 'customfield_12345',
    displayName: 'Test Field',
    type: 'option',
    isCustom: true,
    metadata: {
      required: false,
      name: 'Test Field',
      key: 'customfield_12345',
      schema: { type: 'option' },
      allowedValues,
    },
  });

  it('should use explicit @value: format', () => {
    const field = mockField([
      { id: '1', name: 'High', value: 'high' },
    ]);
    const result = formatFieldValue(field, '@value:high');
    expect(result.formattedValue).toEqual({ value: 'high' });
  });

  it('should use explicit @name: format', () => {
    const field = mockField([
      { id: '1', name: 'Backend' },
    ]);
    const result = formatFieldValue(field, '@name:Backend');
    expect(result.formattedValue).toEqual({ name: 'Backend' });
  });

  it('should use explicit @id: format', () => {
    const field = mockField([
      { id: '10001', name: 'High' },
    ]);
    const result = formatFieldValue(field, '@id:10001');
    expect(result.formattedValue).toEqual({ id: '10001' });
  });
});
```

---

## Documentation Updates

### Update CLAUDE.md

Add documentation for the explicit format syntax in the **Custom Field Handling** section:

```markdown
**Custom Field Handling:**
The `--field` flag on create/update commands supports:

- **Name resolution**: Use human-readable field names (e.g., "Severity") instead of internal IDs (e.g., "customfield_10269")
- **Auto-formatting**: Values are automatically formatted based on field type (select fields get `{value: "..."}`, etc.)
- **Explicit format prefixes**: Override auto-detection with `@value:`, `@name:`, or `@id:` prefixes:
  - `@value:High` - Format as `{"value": "High"}`
  - `@name:Backend` - Format as `{"name": "Backend"}`
  - `@id:10001` - Format as `{"id": "10001"}`
- **Validation**: Invalid values show helpful error messages with the list of allowed values and format suggestions
- **Discovery**: Use `aide jira fields PROJECT -t IssueType --show-values` to discover available fields
```

### Update Skill Files

Update `skills/ticket-update/SKILL.md` and `skills/ticket-create/SKILL.md` to document the format prefixes:

```markdown
## Custom Field Formatting

When setting custom field values, the CLI auto-detects the correct format. If auto-detection fails, use explicit format prefixes:

| Prefix | Format | Example |
|--------|--------|---------|
| `@value:` | `{"value": "X"}` | `--field "Severity=@value:High"` |
| `@name:` | `{"name": "X"}` | `--field "Components=@name:Backend"` |
| `@id:` | `{"id": "X"}` | `--field "Priority=@id:3"` |

### When to Use Explicit Formats

- **Components, Versions**: Usually need `@name:` format
- **Select/Option fields**: Usually need `@value:` format
- **Priority, Status**: May need `@id:` format

Use `aide jira fields PROJECT -t IssueType --show-values` to see the structure of allowed values.
```

---

## Implementation Checklist

- [ ] Add `ParsedValue` interface to `value-formatter.ts`
- [ ] Add `parseExplicitFormat()` function to `value-formatter.ts`
- [ ] Update `findMatchingAllowedValue()` to accept explicit format parameter
- [ ] Replace `detectAllowedValueFormat()` with simplified version
- [ ] Update `formatOptionValue()` to use explicit format
- [ ] Update `formatArrayValue()` to use explicit format
- [ ] Add `generateFormattingError()` function
- [ ] Update `FormattingResult` interface with new fields
- [ ] Make ID matching case-insensitive in `field-resolver.ts`
- [ ] Update `formatValidationErrors()` for better error messages
- [ ] Add unit tests for `parseExplicitFormat()`
- [ ] Add integration tests for explicit format workflow
- [ ] Update CLAUDE.md documentation
- [ ] Update skill documentation files
- [ ] Test with real Jira instance

---

## Summary

This improvement addresses the reliability and usability issues with Jira field value formatting by:

1. **Giving users control** via explicit `@name:`, `@value:`, `@id:` prefixes
2. **Simplifying auto-detection** to check only the first allowedValue
3. **Providing actionable errors** that explain what was tried and how to fix

The changes are backward-compatible - existing commands without prefixes will continue to work with the simplified auto-detection logic.
