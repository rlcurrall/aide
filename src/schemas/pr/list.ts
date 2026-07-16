/**
 * Valibot schema for PR list command arguments
 */

import * as v from 'valibot';
import { OutputFormatSchema, type OutputFormat } from '../common.js';

// Re-export OutputFormat for use in command files
export type { OutputFormat };

/**
 * PR status filter options
 */
export const PrStatusSchema = v.picklist(
  ['active', 'completed', 'abandoned', 'all'],
  'Status must be one of: active, completed, abandoned, all'
);

export type PrStatus = v.InferOutput<typeof PrStatusSchema>;

/**
 * Schema for PR list command arguments
 */
export const ListArgsSchema = v.object({
  provider: v.optional(v.string()),
  host: v.optional(v.string()),
  owner: v.optional(v.string()),
  org: v.optional(v.string()),
  project: v.optional(v.string()),
  repo: v.optional(v.string()),
  format: v.optional(OutputFormatSchema, 'text'),
  status: v.optional(PrStatusSchema, 'active'),
  limit: v.optional(
    v.pipe(
      v.number('Limit must be a number'),
      v.integer('Limit must be an integer'),
      v.minValue(1, 'Limit must be at least 1')
    ),
    20
  ),
  createdBy: v.optional(v.string()),
  author: v.optional(v.string()),
});

export type ListArgs = v.InferOutput<typeof ListArgsSchema>;
