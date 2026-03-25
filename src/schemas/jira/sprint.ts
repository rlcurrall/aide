/**
 * Valibot schema for Jira sprint command arguments
 */

import * as v from 'valibot';
import { OutputFormatSchema, PositiveIntegerSchema } from '@schemas/common.js';

const SprintStateSchema = v.picklist(
  ['future', 'active', 'closed'],
  'Sprint state must be one of: future, active, closed'
);

/**
 * Schema for sprint command arguments
 *
 * - boardId: Board ID (required, positive integer)
 * - state: Sprint state filter (optional, defaults to 'active')
 * - format: Output format (optional, defaults to 'text')
 */
export const SprintArgsSchema = v.object({
  boardId: PositiveIntegerSchema,
  state: v.optional(SprintStateSchema, 'active'),
  format: v.optional(OutputFormatSchema, 'text'),
});

export type SprintArgs = v.InferOutput<typeof SprintArgsSchema>;
