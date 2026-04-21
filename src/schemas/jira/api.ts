/**
 * Valibot schema for `aide jira api` arguments.
 */

import * as v from 'valibot';
import { NonEmptyStringSchema } from '@schemas/common.js';

const HttpMethodSchema = v.picklist(
  ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] as const,
  'Method must be one of GET, POST, PUT, PATCH, DELETE, HEAD'
);

export const ApiArgsSchema = v.object({
  endpoint: NonEmptyStringSchema,
  method: v.optional(HttpMethodSchema, 'GET'),
  field: v.optional(v.array(v.string()), []),
  rawField: v.optional(v.array(v.string()), []),
  header: v.optional(v.array(v.string()), []),
  input: v.optional(v.string()),
});

export type ApiArgs = v.InferOutput<typeof ApiArgsSchema>;
