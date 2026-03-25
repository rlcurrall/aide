/**
 * Valibot schema for Jira boards command arguments
 */

import * as v from 'valibot';
import { OutputFormatSchema } from '@schemas/common.js';

/**
 * Schema for boards command arguments
 *
 * - project: Project key to filter boards (optional)
 * - format: Output format (optional, defaults to 'text')
 */
export const BoardsArgsSchema = v.object({
  project: v.optional(v.string()),
  format: v.optional(OutputFormatSchema, 'text'),
});

export type BoardsArgs = v.InferOutput<typeof BoardsArgsSchema>;
