export interface JiraConfig {
  url: string;
  email: string;
  apiToken: string;
  defaultProject?: string;
}

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
  filename: string;
  size: number;
  author: JiraUser;
  created: string;
  mimeType: string;
}

export interface JiraComment {
  id: string;
  author: JiraUser;
  body:
    | {
        content?: Array<{
          content?: Array<{
            text?: string;
          }>;
        }>;
      }
    | string;
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
  description?: {
    content?: Array<{
      content?: Array<{
        text?: string;
      }>;
    }>;
  };
  status: JiraStatus;
  assignee?: JiraUser;
  reporter: JiraUser;
  priority: JiraPriority;
  project: JiraProject;
  issuetype: JiraIssueType;
  created: string;
  updated: string;
  resolutiondate?: string;
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

export interface CliOptions {
  help?: boolean;
}

// Azure DevOps Types
export interface AzureDevOpsConfig {
  orgUrl: string;
  pat: string;
  authMethod: 'pat' | 'bearer';
  defaultProject?: string;
}

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
  properties?: any;
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
  createdBy: AzureDevOpsIdentity;
  creationDate: string;
  repository: AzureDevOpsRepository;
}

export interface GitRemoteInfo {
  org: string;
  project: string;
  repo: string;
}
