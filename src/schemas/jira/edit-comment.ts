/**
 * Valibot schema for Jira edit-comment command arguments
 */

import * as v from 'valibot';
import { OutputFormatSchema, TicketKeyLooseSchema } from '@schemas/common.js';

/**
 * Schema for edit-comment command arguments
 *
 * Uses loose ticket key validation - the command will warn but not fail
 * on non-standard ticket key formats.
 *
 * Note: Either comment or file must be provided, but this is validated
 * in the command handler since it requires runtime logic.
 */
export const EditCommentArgsSchema = v.object({
  ticketKey: TicketKeyLooseSchema,
  commentId: v.pipe(
    v.string('Comment ID must be a string'),
    v.minLength(1, 'Comment ID cannot be empty')
  ),
  comment: v.optional(v.string()),
  file: v.optional(v.string()),
  format: v.optional(OutputFormatSchema, 'text'),
});

export type EditCommentArgs = v.InferOutput<typeof EditCommentArgsSchema>;
