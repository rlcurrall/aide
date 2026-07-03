/**
 * Valibot schema for PR reply command arguments
 */

import * as v from 'valibot';
import {
  OutputFormatSchema,
  ThreadIdSchema,
  NonNegativeIntegerSchema,
  type OutputFormat,
} from '../common.js';

// Re-export OutputFormat for use in command files
export type { OutputFormat };

/**
 * Non-empty string that is trimmed
 * Used for reply text that must have content after trimming
 */
export const TrimmedNonEmptyStringSchema = v.pipe(
  v.string('Reply text must be a string'),
  v.trim(),
  v.minLength(1, 'Reply text cannot be empty')
);

/**
 * Schema for PR reply command arguments
 */
export const PrReplyArgsSchema = v.object({
  pr: v.optional(v.string()),
  replyText: TrimmedNonEmptyStringSchema,
  thread: ThreadIdSchema,
  parent: v.optional(NonNegativeIntegerSchema),
  provider: v.optional(v.string()),
  host: v.optional(v.string()),
  owner: v.optional(v.string()),
  org: v.optional(v.string()),
  project: v.optional(v.string()),
  repo: v.optional(v.string()),
  format: v.optional(OutputFormatSchema, 'text'),
});

export type PrReplyArgs = v.InferOutput<typeof PrReplyArgsSchema>;
