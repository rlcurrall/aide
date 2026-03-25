/**
 * Valibot schema for Jira search command arguments
 */

import * as v from 'valibot';
import {
  OutputFormatSchema,
  NonEmptyStringSchema,
  PositiveIntegerSchema,
} from '@schemas/common.js';

/**
 * Schema for search command arguments
 *
 * - query: JQL query string (required, non-empty)
 * - maxResults: Maximum results to return (optional positive integer)
 * - limit: Alias for maxResults (optional positive integer)
 * - sprintBoard: Board ID to resolve active sprint from (optional positive integer)
 * - format: Output format (optional, defaults to 'text')
 */
export const SearchArgsSchema = v.object({
  query: v.pipe(NonEmptyStringSchema, v.description('JQL query string')),
  maxResults: v.optional(PositiveIntegerSchema),
  limit: v.optional(PositiveIntegerSchema),
  sprintBoard: v.optional(PositiveIntegerSchema),
  format: v.optional(OutputFormatSchema, 'text'),
});

export type SearchArgs = v.InferOutput<typeof SearchArgsSchema>;
