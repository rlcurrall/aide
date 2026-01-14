/**
 * Valibot schema for Jira update command arguments
 */

import * as v from 'valibot';
import { OutputFormatSchema, TicketKeyLooseSchema } from '@schemas/common.js';

/**
 * Schema for update command arguments
 */
export const UpdateArgsSchema = v.object({
  ticketKey: TicketKeyLooseSchema,
  summary: v.optional(v.string()),
  description: v.optional(v.string()),
  file: v.optional(v.string()),
  assignee: v.optional(v.string()), // email, account ID, "me", or "none" to unassign
  priority: v.optional(v.string()),
  labels: v.optional(v.string()), // Comma-separated, replaces existing
  addLabels: v.optional(v.string()), // Comma-separated, adds to existing
  removeLabels: v.optional(v.string()), // Comma-separated, removes from existing
  component: v.optional(v.array(v.string())), // Replaces existing
  field: v.optional(v.array(v.string())), // Custom fields in fieldName=value format
  format: v.optional(OutputFormatSchema, 'text'),
});

export type UpdateArgs = v.InferOutput<typeof UpdateArgsSchema>;
