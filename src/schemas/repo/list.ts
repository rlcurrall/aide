/**
 * Valibot schema for `repo list` command arguments
 */

import * as v from 'valibot';
import { OutputFormatSchema, type OutputFormat } from '../common.js';

// Re-export OutputFormat for use in command files
export type { OutputFormat };

/**
 * Sort mode for worktree listing
 * - path: sort by absolute path (default)
 * - repo: cluster by repo name, then path
 */
export const SortModeSchema = v.picklist(
  ['path', 'repo'],
  'Sort must be one of: path, repo'
);

export type SortMode = v.InferOutput<typeof SortModeSchema>;

/**
 * Schema for `repo list` command arguments
 */
export const ListArgsSchema = v.object({
  paths: v.optional(v.array(v.string()), []),
  format: v.optional(OutputFormatSchema, 'text'),
  sort: v.optional(SortModeSchema, 'path'),
  headers: v.optional(v.boolean(), true),
  printHook: v.optional(v.boolean(), false),
});

export type ListArgs = v.InferOutput<typeof ListArgsSchema>;
