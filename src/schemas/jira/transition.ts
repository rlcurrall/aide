/**
 * Valibot schema for Jira transition command arguments
 */

import * as v from 'valibot';
import { OutputFormatSchema, TicketKeyLooseSchema } from '@schemas/common.js';

/**
 * Schema for transition command arguments
 */
export const TransitionArgsSchema = v.object({
  ticketKey: TicketKeyLooseSchema,
  status: v.optional(v.string()), // Target status name
  list: v.optional(v.boolean()), // List available transitions
  comment: v.optional(v.string()), // Add comment with transition
  resolution: v.optional(v.string()), // Set resolution (for Done/Resolved transitions)
  format: v.optional(OutputFormatSchema, 'text'),
});

export type TransitionArgs = v.InferOutput<typeof TransitionArgsSchema>;
