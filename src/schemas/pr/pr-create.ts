/**
 * Valibot schema for PR create command arguments
 */

import * as v from 'valibot';
import {
  OutputFormatSchema,
  NonEmptyStringSchema,
  type OutputFormat,
} from '../common.js';

// Re-export OutputFormat for use in command files
export type { OutputFormat };

/**
 * Schema for PR create command arguments
 */
export const PrCreateArgsSchema = v.object({
  title: NonEmptyStringSchema,
  body: v.optional(v.string()), // --body (gh), --description (az alias)
  head: v.optional(v.string()), // --head (gh), --source (az alias)
  base: v.optional(v.string()), // --base (gh), --target (az alias)
  draft: v.optional(v.boolean(), false),
  tag: v.optional(v.array(v.string()), []),
  project: v.optional(v.string()),
  repo: v.optional(v.string()),
  format: v.optional(OutputFormatSchema, 'text'),
  // Aliases from yargs (for validation compatibility)
  description: v.optional(v.string()), // Alias for body
  source: v.optional(v.string()), // Alias for head
  target: v.optional(v.string()), // Alias for base
  'source-branch': v.optional(v.string()), // Alias for head
  'target-branch': v.optional(v.string()), // Alias for base
});

export type PrCreateArgs = v.InferOutput<typeof PrCreateArgsSchema>;
