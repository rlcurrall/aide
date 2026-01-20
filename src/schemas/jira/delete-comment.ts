/**
 * Valibot schema for Jira delete-comment command arguments
 */

import * as v from 'valibot';
import { OutputFormatSchema, TicketKeyLooseSchema } from '@schemas/common.js';

/**
 * Schema for delete-comment command arguments
 *
 * Uses loose ticket key validation - the command will warn but not fail
 * on non-standard ticket key formats.
 */
export const DeleteCommentArgsSchema = v.object({
  ticketKey: TicketKeyLooseSchema,
  commentId: v.pipe(
    v.string('Comment ID must be a string'),
    v.minLength(1, 'Comment ID cannot be empty')
  ),
  format: v.optional(OutputFormatSchema, 'text'),
});

export type DeleteCommentArgs = v.InferOutput<typeof DeleteCommentArgsSchema>;
