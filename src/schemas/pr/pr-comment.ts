/**
 * Valibot schema for PR comment command arguments
 */

import * as v from 'valibot';
import {
  OutputFormatSchema,
  NonEmptyStringSchema,
  PositiveIntegerSchema,
  type OutputFormat,
} from '../common.js';

// Re-export OutputFormat for use in command files
export type { OutputFormat };

/**
 * Schema for PR comment command arguments
 */
export const PrCommentArgsSchema = v.object({
  pr: v.optional(v.string()),
  comment: NonEmptyStringSchema,
  provider: v.optional(v.string()),
  host: v.optional(v.string()),
  owner: v.optional(v.string()),
  org: v.optional(v.string()),
  project: v.optional(v.string()),
  repo: v.optional(v.string()),
  format: v.optional(OutputFormatSchema, 'text'),
  file: v.optional(v.string()),
  line: v.optional(PositiveIntegerSchema),
  endLine: v.optional(PositiveIntegerSchema),
});

export type PrCommentArgs = v.InferOutput<typeof PrCommentArgsSchema>;
