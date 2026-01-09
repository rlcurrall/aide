/**
 * Valibot schema for PR update command arguments
 */

import * as v from 'valibot';
import { OutputFormatSchema, type OutputFormat } from '../common.js';

// Re-export OutputFormat for use in command files
export type { OutputFormat };

/**
 * Schema for PR update command arguments
 */
export const PrUpdateArgsSchema = v.object({
  pr: v.optional(v.string()),
  project: v.optional(v.string()),
  repo: v.optional(v.string()),
  format: v.optional(OutputFormatSchema, 'text'),
  title: v.optional(v.string()),
  description: v.optional(v.string()),
  target: v.optional(v.string()),
  draft: v.optional(v.boolean()),
  publish: v.optional(v.boolean()),
  abandon: v.optional(v.boolean()),
  activate: v.optional(v.boolean()),
});

export type PrUpdateArgs = v.InferOutput<typeof PrUpdateArgsSchema>;
