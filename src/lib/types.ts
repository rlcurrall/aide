// ============================================================================
// Atlassian Document Format (ADF) Types
// ============================================================================

/**
 * ADF Mark - formatting applied to text (bold, italic, links, etc.)
 */
export interface AdfMark {
  type: string;
  attrs?: Record<string, string | number | boolean | null | undefined>;
}

/**
 * ADF Node - represents a single node in the ADF document tree
 */
export interface AdfNode {
  type: string;
  content?: AdfNode[];
  attrs?: Record<string, string | number | boolean | null | undefined>;
  text?: string;
  marks?: AdfMark[];
  version?: number;
}

/**
 * ADF Document - root node of an ADF document
 */
export interface AdfDocument extends AdfNode {
  type: 'doc';
  version: 1;
  content: AdfNode[];
}

/**
 * Input that can be converted to/from ADF - either a proper ADF document or a string
 */
export type AdfInput = AdfDocument | AdfNode | string | null | undefined;

// ============================================================================
// Jira Types
// ============================================================================

// JiraConfig is defined and exported from ../schemas/config.ts
export type { JiraConfig } from '../schemas/config.js';

export interface JiraUser {
  displayName: string;
  emailAddress: string;
  accountId: string;
}

export interface JiraStatus {
  name: string;
  id: string;
}

export interface JiraPriority {
  name: string;
  id: string;
}

export interface JiraProject {
  key: string;
  name: string;
  id: string;
}

export interface JiraIssueType {
  name: string;
  id: string;
}

export interface JiraAttachment {
  id: string;
  filename: string;
  size: number;
  author: JiraUser;
  created: string;
  mimeType: string;
  content?: string; // URL to download the attachment
}

export interface JiraComment {
  id: string;
  author: JiraUser;
  body: AdfNode | string;
  created: string;
  updated: string;
}

export interface JiraSubtask {
  key: string;
  fields: {
    summary: string;
    status: JiraStatus;
  };
}

export interface JiraIssueFields {
  key: string;
  summary: string;
  description?: AdfNode;
  status: JiraStatus;
  assignee?: JiraUser;
  reporter: JiraUser;
  priority: JiraPriority;
  project: JiraProject;
  issuetype: JiraIssueType;
  created: string;
  updated: string;
  resolutiondate?: string;
  labels?: string[];
  comment?: {
    total: number;
    comments: JiraComment[];
  };
  attachment?: JiraAttachment[];
  subtasks?: JiraSubtask[];
}

export interface JiraIssue {
  key: string;
  fields: JiraIssueFields;
}

export interface JiraSearchResponse {
  total: number;
  issues: JiraIssue[];
  errorMessages?: string[];
  errors?: Record<string, string>;
}

export interface JiraIssueResponse extends JiraIssue {
  errorMessages?: string[];
  errors?: Record<string, string>;
}

/**
 * Response from Jira's GET /issue/{issueKey}/comment endpoint
 */
export interface JiraCommentsResponse {
  startAt: number;
  maxResults: number;
  total: number;
  comments: JiraComment[];
}

/**
 * Response from Jira's POST /issue/{issueKey}/comment endpoint
 */
export type JiraAddCommentResponse = JiraComment;

/**
 * Response from Jira's POST /issue endpoint (create issue)
 */
export interface JiraCreateIssueResponse {
  id: string;
  key: string;
  self: string;
}

/**
 * Jira workflow transition
 */
export interface JiraTransition {
  id: string;
  name: string;
  to: JiraStatus;
  hasScreen: boolean;
  isGlobal: boolean;
  isInitial: boolean;
  isConditional: boolean;
}

/**
 * Response from Jira's GET /issue/{issueKey}/transitions endpoint
 */
export interface JiraTransitionsResponse {
  transitions: JiraTransition[];
}

/**
 * Response from Jira's POST /issue/{issueKey}/attachments endpoint
 */
export interface JiraAttachmentUploadResponse {
  id: string;
  filename: string;
  size: number;
  mimeType: string;
  content: string; // URL to download the attachment
  created: string;
  author: JiraUser;
}

/**
 * Jira issue type metadata for create screen
 */
export interface JiraIssueTypeMeta {
  id: string;
  name: string;
  subtask: boolean;
  fields: Record<string, JiraFieldMeta>;
}

/**
 * Jira field metadata
 */
export interface JiraFieldMeta {
  required: boolean;
  name: string;
  key: string;
  schema: {
    type: string;
    items?: string;
    custom?: string;
    system?: string;
  };
  allowedValues?: Array<{
    id: string;
    name: string;
    value?: string;
  }>;
  hasDefaultValue?: boolean;
  defaultValue?: unknown;
}

/**
 * Response from Jira's GET /issue/createmeta endpoint
 */
export interface JiraCreateMetaResponse {
  projects: Array<{
    key: string;
    name: string;
    id: string;
    issuetypes: JiraIssueTypeMeta[];
  }>;
}

/**
 * Options for creating a Jira issue
 */
export interface JiraCreateIssueOptions {
  projectKey: string;
  issueType: string;
  summary: string;
  description?: AdfDocument;
  assignee?: string; // Account ID
  priority?: string; // Priority ID or name
  labels?: string[];
  components?: string[];
  parent?: string; // Parent issue key for subtasks
  customFields?: Record<string, unknown>;
}

/**
 * Options for updating a Jira issue
 */
export interface JiraUpdateIssueOptions {
  summary?: string;
  description?: AdfDocument;
  assignee?: { accountId: string } | null; // null to unassign
  priority?: { id: string } | { name: string };
  labels?: string[];
  components?: string[]; // Component names (transformed to objects by client)
  customFields?: Record<string, unknown>;
}

/**
 * Options for transitioning a Jira issue
 */
export interface JiraTransitionOptions {
  comment?: AdfDocument;
  resolution?: string;
  fields?: Record<string, unknown>;
}

// ============================================================================
// Azure DevOps Types
// ============================================================================

// AzureDevOpsConfig is defined and exported from ../schemas/config.ts
export type { AzureDevOpsConfig } from '../schemas/config.js';

export interface AzureDevOpsIdentity {
  displayName: string;
  uniqueName?: string;
  id: string;
}

export interface AzureDevOpsPRThread {
  id: number;
  publishedDate: string;
  lastUpdatedDate: string;
  comments: AzureDevOpsPRComment[];
  status: 'active' | 'fixed' | 'wontFix' | 'closed' | 'byDesign' | 'pending';
  threadContext?: {
    filePath?: string;
    rightFileStart?: { line: number; offset: number };
    rightFileEnd?: { line: number; offset: number };
  };
  properties?: unknown;
}

export interface AzureDevOpsPRComment {
  id: number;
  parentCommentId: number;
  author: AzureDevOpsIdentity;
  content: string;
  publishedDate: string;
  lastUpdatedDate: string;
  lastContentUpdatedDate: string;
  commentType: 'text' | 'system';
}

/**
 * Response from creating a comment in a PR thread
 * @see https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-thread-comments/create?view=azure-devops-rest-7.1
 */
export interface AzureDevOpsCreateCommentResponse {
  id: number;
  parentCommentId: number;
  author: AzureDevOpsIdentity;
  content: string;
  publishedDate: string;
  lastUpdatedDate: string;
  lastContentUpdatedDate: string;
  commentType: 'text' | 'system';
}

/**
 * Options for creating a PR thread comment
 * @see https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-threads/create?view=azure-devops-rest-7.1
 */
export interface CreateThreadOptions {
  /** File path for file-specific comments (e.g., "/src/utils.ts") */
  filePath?: string;
  /** Starting line number for file comments */
  line?: number;
  /** Ending line number for file comments (defaults to line if not specified) */
  endLine?: number;
  /** Thread status: 1=active, 2=fixed, 3=wontFix, 4=closed, 5=byDesign, 6=pending */
  status?: number;
}

/**
 * Response from creating a PR thread
 * @see https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-threads/create?view=azure-devops-rest-7.1
 */
export interface CreateThreadResponse {
  id: number;
  publishedDate: string;
  lastUpdatedDate: string;
  comments: AzureDevOpsPRComment[];
  status: 'active' | 'fixed' | 'wontFix' | 'closed' | 'byDesign' | 'pending';
  threadContext?: {
    filePath?: string;
    rightFileStart?: { line: number; offset: number };
    rightFileEnd?: { line: number; offset: number };
  };
  properties?: unknown;
}

export interface AzureDevOpsRepository {
  id: string;
  name: string;
  project: {
    id: string;
    name: string;
  };
}

export interface AzureDevOpsPullRequest {
  pullRequestId: number;
  title: string;
  description?: string;
  status: 'active' | 'abandoned' | 'completed';
  isDraft?: boolean;
  createdBy: AzureDevOpsIdentity;
  creationDate: string;
  repository: AzureDevOpsRepository;
  sourceRefName?: string; // e.g., "refs/heads/feature-branch"
  targetRefName?: string; // e.g., "refs/heads/main"
}

/**
 * Options for updating a pull request
 * @see https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-requests/update?view=azure-devops-rest-7.1
 */
export interface PullRequestUpdateOptions {
  /** New title for the PR */
  title?: string;
  /** New description for the PR */
  description?: string;
  /** Whether the PR is a draft */
  isDraft?: boolean;
  /** New status for the PR (active, abandoned, completed) */
  status?: 'active' | 'abandoned' | 'completed';
  /** New target branch (e.g., "refs/heads/main") */
  targetRefName?: string;
}

/**
 * Flattened comment structure from Azure DevOps PR threads
 * This is the structure returned by AzureDevOpsClient.getAllComments()
 */
export interface AdoFlattenedComment {
  threadId: number;
  threadStatus: string;
  filePath?: string;
  lineNumber?: number;
  comment: {
    id: number;
    parentCommentId: number;
    author: {
      displayName: string;
      uniqueName?: string;
      id: string;
    };
    content: string;
    publishedDate: string;
    lastUpdatedDate: string;
    commentType: string;
  };
}

// ============================================================================
// CLI Types
// ============================================================================

export interface CliOptions {
  help?: boolean;
}

export interface GitRemoteInfo {
  org: string;
  project: string;
  repo: string;
}

// ============================================================================
// Azure DevOps PR Iteration/Diff Types
// ============================================================================

/**
 * Pull Request Iteration - represents a push to the source branch
 * @see https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-iterations/list
 */
export interface AzureDevOpsPRIteration {
  id: number;
  description?: string;
  author?: AzureDevOpsIdentity;
  createdDate?: string;
  updatedDate?: string;
  sourceRefCommit?: { commitId: string };
  targetRefCommit?: { commitId: string };
  commonRefCommit?: { commitId: string };
}

/**
 * Response from PR Iteration Changes API
 * @see https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-iteration-changes/get
 */
export interface AzureDevOpsPRIterationChanges {
  changeEntries: AzureDevOpsPRChange[];
  nextSkip?: number;
  nextTop?: number;
}

/**
 * A single file change in a PR iteration
 * @see https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-iteration-changes/get
 */
export interface AzureDevOpsPRChange {
  changeId: number;
  changeTrackingId: number;
  changeType: AzureDevOpsChangeType;
  item?: {
    objectId?: string;
    originalObjectId?: string;
    path?: string;
  };
  originalPath?: string;
  sourceServerItem?: string;
}

/**
 * Types of changes that can occur to a file in version control
 * @see https://learn.microsoft.com/en-us/rest/api/azure/devops/git/gitchange
 */
export type AzureDevOpsChangeType =
  | 'add'
  | 'edit'
  | 'delete'
  | 'rename'
  | 'branch'
  | 'merge'
  | 'lock'
  | 'rollback'
  | 'sourceRename'
  | 'targetRename'
  | 'none'
  | 'all';
