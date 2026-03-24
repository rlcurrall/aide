// ============================================================================
// GitHub API Response Types
// ============================================================================

/**
 * GitHub remote repository info extracted from git remote URL
 */
export interface GitHubRemoteInfo {
  owner: string;
  repo: string;
}

/**
 * GitHub user from API responses
 */
export interface GitHubUser {
  login: string;
  id: number;
}

/**
 * GitHub label on a PR/issue
 */
export interface GitHubLabel {
  id: number;
  name: string;
  color: string;
}

/**
 * GitHub pull request from the REST API
 * @see https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request
 */
export interface GitHubPullRequest {
  number: number;
  node_id: string;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  draft: boolean;
  merged: boolean;
  merged_at: string | null;
  user: GitHubUser;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  head: {
    ref: string;
    sha: string;
    label: string;
  };
  base: {
    ref: string;
    sha: string;
    label: string;
  };
  labels: GitHubLabel[];
  html_url: string;
  additions?: number;
  deletions?: number;
  changed_files?: number;
}

/**
 * GitHub issue comment (general PR discussion, not code-level)
 * @see https://docs.github.com/en/rest/issues/comments
 */
export interface GitHubIssueComment {
  id: number;
  user: GitHubUser;
  body: string;
  created_at: string;
  updated_at: string;
  html_url: string;
}

/**
 * GitHub pull request review comment (code-level, attached to a file/line)
 * @see https://docs.github.com/en/rest/pulls/comments
 */
export interface GitHubReviewComment {
  id: number;
  user: GitHubUser;
  body: string;
  path: string;
  line: number | null;
  original_line: number | null;
  start_line: number | null;
  side: 'LEFT' | 'RIGHT';
  created_at: string;
  updated_at: string;
  html_url: string;
  in_reply_to_id?: number;
  commit_id: string;
}

/**
 * GitHub PR file change
 * @see https://docs.github.com/en/rest/pulls/pulls#list-pull-requests-files
 */
export interface GitHubPRFile {
  sha: string;
  filename: string;
  status:
    | 'added'
    | 'removed'
    | 'modified'
    | 'renamed'
    | 'copied'
    | 'changed'
    | 'unchanged';
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
  previous_filename?: string;
}

/**
 * Options for updating a GitHub PR
 */
export interface GitHubPRUpdateOptions {
  title?: string;
  body?: string;
  state?: 'open' | 'closed';
  base?: string;
}

/**
 * Options for listing GitHub PRs
 */
export interface GitHubListPROptions {
  state?: 'open' | 'closed' | 'all';
  head?: string;
  base?: string;
  sort?: 'created' | 'updated' | 'popularity';
  direction?: 'asc' | 'desc';
  per_page?: number;
}

/**
 * Options for creating a GitHub review comment
 */
export interface GitHubCreateReviewCommentOptions {
  path: string;
  line: number;
  commit_id: string;
  side?: 'LEFT' | 'RIGHT';
  start_line?: number;
}
