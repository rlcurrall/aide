/**
 * Configuration schemas for Jira and Azure DevOps
 *
 * These schemas validate configuration loaded from environment variables
 * and provide type-safe access to configuration values.
 */

import * as v from 'valibot';

// ============================================================================
// Shared Transforms
// ============================================================================

/**
 * URL schema with trailing slash removal
 * Validates that the value is a valid URL and removes any trailing slash
 */
const UrlWithTrailingSlashRemoval = v.pipe(
  v.string('URL must be a string'),
  v.url('URL must be a valid URL'),
  v.transform((url) => url.replace(/\/$/, ''))
);

// ============================================================================
// Jira Configuration Schema
// ============================================================================

/**
 * Jira configuration schema
 * - url: Jira instance URL (required, valid URL, trailing slash removed)
 * - email: User email for authentication (required, non-empty)
 * - apiToken: API token for authentication (required, non-empty)
 * - defaultProject: Optional default project key
 */
export const JiraConfigSchema = v.object({
  url: UrlWithTrailingSlashRemoval,
  email: v.pipe(
    v.string('Email must be a string'),
    v.minLength(1, 'Email cannot be empty')
  ),
  apiToken: v.pipe(
    v.string('API token must be a string'),
    v.minLength(1, 'API token cannot be empty')
  ),
  defaultProject: v.optional(v.string()),
});

export type JiraConfig = v.InferOutput<typeof JiraConfigSchema>;

// ============================================================================
// Azure DevOps Configuration Schema
// ============================================================================

/**
 * Azure DevOps authentication method
 * - pat: Personal Access Token (default)
 * - bearer: Bearer token authentication
 */
export const AuthMethodSchema = v.optional(
  v.picklist(['pat', 'bearer'], 'Auth method must be one of: pat, bearer'),
  'pat'
);

export type AuthMethod = v.InferOutput<typeof AuthMethodSchema>;

/**
 * Azure DevOps configuration schema
 * - orgUrl: Organization URL (required, valid URL, trailing slash removed)
 * - pat: Personal Access Token (required, non-empty)
 * - authMethod: Authentication method (optional, default: 'pat')
 * - defaultProject: Optional default project name
 */
export const AzureDevOpsConfigSchema = v.object({
  orgUrl: UrlWithTrailingSlashRemoval,
  pat: v.pipe(
    v.string('PAT must be a string'),
    v.minLength(1, 'PAT cannot be empty')
  ),
  authMethod: AuthMethodSchema,
  defaultProject: v.optional(v.string()),
});

export type AzureDevOpsConfig = v.InferOutput<typeof AzureDevOpsConfigSchema>;

// ============================================================================
// GitHub Configuration Schema
// ============================================================================

/**
 * GitHub configuration schema
 * - token: GitHub personal access token (optional, fallback when gh CLI unavailable)
 * - useGhCli: Whether the gh CLI is available for authentication
 */
export const GitHubConfigSchema = v.object({
  token: v.optional(v.string()),
  useGhCli: v.boolean(),
});

export type GitHubConfig = v.InferOutput<typeof GitHubConfigSchema>;
