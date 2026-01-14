/**
 * Valibot schema for Jira attach command arguments
 */

import * as v from 'valibot';
import { OutputFormatSchema, TicketKeyLooseSchema } from '@schemas/common.js';

/**
 * Schema for attach command arguments
 */
export const AttachArgsSchema = v.object({
  ticketKey: TicketKeyLooseSchema,
  upload: v.optional(v.array(v.string())), // Files to upload
  download: v.optional(v.string()), // Attachment ID or filename to download
  output: v.optional(v.string()), // Output path for download
  list: v.optional(v.boolean()), // List all attachments
  delete: v.optional(v.string()), // Attachment ID to delete
  format: v.optional(OutputFormatSchema, 'text'),
});

export type AttachArgs = v.InferOutput<typeof AttachArgsSchema>;
