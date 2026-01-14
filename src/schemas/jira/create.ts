/**
 * Valibot schema for Jira create command arguments
 */

import * as v from 'valibot';
import { OutputFormatSchema, NonEmptyStringSchema } from '@schemas/common.js';

/**
 * Schema for create command arguments
 */
export const CreateArgsSchema = v.object({
  project: NonEmptyStringSchema,
  type: NonEmptyStringSchema,
  summary: NonEmptyStringSchema,
  description: v.optional(v.string()),
  file: v.optional(v.string()),
  assignee: v.optional(v.string()),
  priority: v.optional(v.string()),
  labels: v.optional(v.string()), // Comma-separated
  component: v.optional(v.array(v.string())), // Can be repeated
  parent: v.optional(v.string()), // Parent issue key for subtasks
  field: v.optional(v.array(v.string())), // Custom fields in fieldName=value format
  format: v.optional(OutputFormatSchema, 'text'),
});

export type CreateArgs = v.InferOutput<typeof CreateArgsSchema>;
