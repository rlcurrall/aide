/**
 * Barrel export for all Valibot schemas
 *
 * This file re-exports all schemas from the schemas directory for convenient imports:
 * import { TicketKeySchema, PrIdSchema, JiraConfigSchema } from '@schemas';
 */

// ============================================================================
// Common schemas - reusable validation primitives
// ============================================================================
export {
  // Output format
  OutputFormatSchema,
  type OutputFormat,
  // Ticket key schemas
  TicketKeySchema,
  type TicketKey,
  TicketKeyLooseSchema,
  type TicketKeyLoose,
  isValidTicketKeyFormat,
  // PR and thread ID schemas
  PrIdSchema,
  type PrId,
  ThreadIdSchema,
  type ThreadId,
  // Generic validation schemas
  NonEmptyStringSchema,
  type NonEmptyString,
  PositiveIntegerSchema,
  type PositiveInteger,
  NonNegativeIntegerSchema,
  type NonNegativeInteger,
} from './common.js';

// ============================================================================
// Configuration schemas
// ============================================================================
export {
  JiraConfigSchema,
  type JiraConfig,
  AuthMethodSchema,
  type AuthMethod,
  AzureDevOpsConfigSchema,
  type AzureDevOpsConfig,
} from './config.js';

// ============================================================================
// Jira command schemas
// ============================================================================
export { TicketArgsSchema, type TicketArgs } from './jira/ticket.js';

export { SearchArgsSchema, type SearchArgs } from './jira/search.js';

export { CommentArgsSchema, type CommentArgs } from './jira/comment.js';

export {
  CommentsArgsSchema as JiraCommentsArgsSchema,
  type CommentsArgs as JiraCommentsArgs,
} from './jira/comments.js';

export { DescArgsSchema, type DescArgs } from './jira/desc.js';

// ============================================================================
// Azure DevOps command schemas
// ============================================================================
export {
  PrStatusSchema,
  type PrStatus,
  PrsArgsSchema,
  type PrsArgs,
} from './pr/list.js';

export {
  CommentsArgsSchema as AdoCommentsArgsSchema,
  type CommentsArgs as AdoCommentsArgs,
} from './pr/comments.js';

export { PrCommentArgsSchema, type PrCommentArgs } from './pr/pr-comment.js';

export {
  TrimmedNonEmptyStringSchema,
  PrReplyArgsSchema,
  type PrReplyArgs,
} from './pr/pr-reply.js';

export { PrCreateArgsSchema, type PrCreateArgs } from './pr/pr-create.js';

export { PrUpdateArgsSchema, type PrUpdateArgs } from './pr/pr-update.js';
