/**
 * Valibot schema for PR diff command arguments
 */

import * as v from 'valibot';
import { OutputFormatSchema, type OutputFormat } from '../common.js';

// Re-export OutputFormat for use in command files
export type { OutputFormat };

/**
 * Schema for PR diff command arguments
 */
export const DiffArgsSchema = v.object({
  pr: v.optional(v.string()),
  project: v.optional(v.string()),
  repo: v.optional(v.string()),
  format: v.optional(OutputFormatSchema, 'text'),
  stat: v.optional(v.boolean(), false),
  files: v.optional(v.boolean(), false),
  file: v.optional(v.string()),
  fetch: v.optional(v.boolean(), true),
});

export type DiffArgs = v.InferOutput<typeof DiffArgsSchema>;
