/**
 * Valibot schema for PR comments command arguments
 */

import * as v from 'valibot';
import {
  OutputFormatSchema,
  PositiveIntegerSchema,
  type OutputFormat,
} from '../common.js';

// Re-export OutputFormat for use in command files
export type { OutputFormat };

/**
 * Schema for PR comments command arguments
 */
export const CommentsArgsSchema = v.object({
  pr: v.optional(v.string()),
  project: v.optional(v.string()),
  repo: v.optional(v.string()),
  format: v.optional(OutputFormatSchema, 'text'),
  author: v.optional(v.string()),
  since: v.optional(v.string()),
  latest: v.optional(PositiveIntegerSchema),
  includeSystem: v.optional(v.boolean(), false),
  threadStatus: v.optional(v.string()),
});

export type CommentsArgs = v.InferOutput<typeof CommentsArgsSchema>;
