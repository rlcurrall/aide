import type {
  AzureDevOpsConfig,
  AzureDevOpsPRThread,
  AzureDevOpsPullRequest,
  AdoFlattenedComment,
  CreateThreadOptions,
  CreateThreadResponse,
  PullRequestUpdateOptions,
  AzureDevOpsCreateCommentResponse,
} from './types.js';

export class AzureDevOpsClient {
  private config: AzureDevOpsConfig;
  private baseUrl: string;

  constructor(config: AzureDevOpsConfig) {
    this.config = config;
    this.baseUrl = config.orgUrl.replace(/\/$/, '');
  }

  /**
   * Get authorization header based on auth method
   */
  private getAuthHeader(): string {
    if (this.config.authMethod === 'bearer') {
      return `Bearer ${this.config.pat}`;
    }
    // PAT uses basic auth with empty username
    const encoded = Buffer.from(`:${this.config.pat}`).toString('base64');
    return `Basic ${encoded}`;
  }

  /**
   * Make a GET request to Azure DevOps API
   */
  private async get<T>(url: string): Promise<T> {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: this.getAuthHeader(),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Azure DevOps API error (${response.status}): ${errorText}`
      );
    }

    return response.json() as Promise<T>;
  }

  /**
   * Make a POST request to Azure DevOps API
   * @see https://learn.microsoft.com/en-us/rest/api/azure/devops/?view=azure-devops-rest-7.1
   */
  private async post<T>(url: string, body: unknown): Promise<T> {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: this.getAuthHeader(),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Azure DevOps API error (${response.status}): ${errorText}`
      );
    }

    return response.json() as Promise<T>;
  }

  /**
   * Make a PATCH request to Azure DevOps API
   * @see https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-requests/update?view=azure-devops-rest-7.1
   */
  private async patch<T>(url: string, body: unknown): Promise<T> {
    const response = await fetch(url, {
      method: 'PATCH',
      headers: {
        Authorization: this.getAuthHeader(),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Azure DevOps API error (${response.status}): ${errorText}`
      );
    }

    return response.json() as Promise<T>;
  }

  /**
   * Get pull request details
   * https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-requests/get-pull-request
   */
  async getPullRequest(
    project: string,
    repo: string,
    prId: number
  ): Promise<AzureDevOpsPullRequest> {
    const url = `${this.baseUrl}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repo)}/pullRequests/${prId}?api-version=7.2-preview.1`;
    return this.get<AzureDevOpsPullRequest>(url);
  }

  /**
   * Get pull request threads (comments)
   * https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-threads/list
   */
  async getPullRequestThreads(
    project: string,
    repo: string,
    prId: number
  ): Promise<{ value: AzureDevOpsPRThread[] }> {
    const url = `${this.baseUrl}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repo)}/pullRequests/${prId}/threads?api-version=7.2-preview.1`;
    return this.get<{ value: AzureDevOpsPRThread[] }>(url);
  }

  /**
   * List pull requests in a repository
   * https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-requests/get-pull-requests
   */
  async listPullRequests(
    project: string,
    repo: string,
    options?: {
      status?: 'active' | 'completed' | 'abandoned' | 'all';
      creatorId?: string;
      top?: number;
      sourceRefName?: string;
    }
  ): Promise<{ value: AzureDevOpsPullRequest[] }> {
    const params = new URLSearchParams();
    params.append('api-version', '7.2-preview.1');

    if (options?.status && options.status !== 'all') {
      params.append('searchCriteria.status', options.status);
    }
    if (options?.creatorId) {
      params.append('searchCriteria.creatorId', options.creatorId);
    }
    if (options?.top) {
      params.append('$top', options.top.toString());
    }
    if (options?.sourceRefName) {
      params.append('searchCriteria.sourceRefName', options.sourceRefName);
    }

    const url = `${this.baseUrl}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repo)}/pullRequests?${params.toString()}`;
    return this.get<{ value: AzureDevOpsPullRequest[] }>(url);
  }

  /**
   * Get all comments from all threads in a pull request
   * Flattens thread structure for easier processing
   */
  async getAllComments(
    project: string,
    repo: string,
    prId: number
  ): Promise<AdoFlattenedComment[]> {
    const threadsResponse = await this.getPullRequestThreads(
      project,
      repo,
      prId
    );

    const allComments: AdoFlattenedComment[] = [];

    for (const thread of threadsResponse.value) {
      for (const comment of thread.comments) {
        allComments.push({
          threadId: thread.id,
          threadStatus: thread.status,
          filePath: thread.threadContext?.filePath,
          lineNumber: thread.threadContext?.rightFileStart?.line,
          comment: {
            id: comment.id,
            parentCommentId: comment.parentCommentId,
            author: comment.author,
            content: comment.content,
            publishedDate: comment.publishedDate,
            lastUpdatedDate: comment.lastUpdatedDate,
            commentType: comment.commentType,
          },
        });
      }
    }

    return allComments;
  }

  /**
   * Create a comment thread on a pull request
   * @see https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-threads/create?view=azure-devops-rest-7.1
   *
   * @param project - Azure DevOps project name
   * @param repo - Repository name
   * @param prId - Pull request ID
   * @param content - Comment text content
   * @param options - Optional parameters for file location and thread status
   * @returns Created thread response with thread ID and comment details
   */
  async createPullRequestThread(
    project: string,
    repo: string,
    prId: number,
    content: string,
    options?: CreateThreadOptions
  ): Promise<CreateThreadResponse> {
    const url = `${this.baseUrl}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repo)}/pullRequests/${prId}/threads?api-version=7.1`;

    // Build the request body
    // Thread status values: 1=active, 2=fixed, 3=wontFix, 4=closed, 5=byDesign, 6=pending
    const body: {
      comments: Array<{
        parentCommentId: number;
        content: string;
        commentType: number;
      }>;
      status: number;
      threadContext?: {
        filePath: string;
        rightFileStart: { line: number; offset: number };
        rightFileEnd: { line: number; offset: number };
      };
    } = {
      comments: [
        {
          parentCommentId: 0,
          content,
          commentType: 1, // 1 = text comment
        },
      ],
      status: options?.status ?? 1, // Default to active
    };

    // Add file context if specified
    if (options?.filePath && options?.line) {
      const endLine = options.endLine ?? options.line;
      body.threadContext = {
        filePath: options.filePath.startsWith('/')
          ? options.filePath
          : `/${options.filePath}`,
        rightFileStart: { line: options.line, offset: 1 },
        rightFileEnd: { line: endLine, offset: 1 },
      };
    }

    return this.post<CreateThreadResponse>(url, body);
  }

  /**
   * Create a comment reply in a pull request thread
   * @see https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-thread-comments/create?view=azure-devops-rest-7.1
   *
   * @param project - Azure DevOps project name
   * @param repo - Repository name
   * @param prId - Pull request ID
   * @param threadId - Thread ID to reply to
   * @param content - Comment text content
   * @param parentCommentId - Optional parent comment ID to reply to a specific comment (0 or omit for root-level reply)
   * @returns Created comment response with comment ID and details
   */
  async createThreadComment(
    project: string,
    repo: string,
    prId: number,
    threadId: number,
    content: string,
    parentCommentId?: number
  ): Promise<AzureDevOpsCreateCommentResponse> {
    const url = `${this.baseUrl}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repo)}/pullRequests/${prId}/threads/${threadId}/comments?api-version=7.1`;

    const body: {
      content: string;
      parentCommentId: number;
      commentType: number;
    } = {
      content,
      parentCommentId: parentCommentId ?? 0,
      commentType: 1, // 1 = text comment
    };

    return this.post<AzureDevOpsCreateCommentResponse>(url, body);
  }

  /**
   * Create a pull request
   * @see https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-requests/create?view=azure-devops-rest-7.1
   *
   * @param project - Azure DevOps project name
   * @param repo - Repository name
   * @param sourceRefName - Source branch (e.g., "refs/heads/feature-branch")
   * @param targetRefName - Target branch (e.g., "refs/heads/main")
   * @param title - PR title
   * @param description - PR description
   * @param options - Optional parameters (isDraft, reviewers)
   * @returns Created pull request details
   */
  async createPullRequest(
    project: string,
    repo: string,
    sourceRefName: string,
    targetRefName: string,
    title: string,
    description: string,
    options?: {
      isDraft?: boolean;
      reviewers?: Array<{ id: string }>;
    }
  ): Promise<AzureDevOpsPullRequest> {
    const url = `${this.baseUrl}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repo)}/pullrequests?api-version=7.2-preview.1`;

    const body: {
      sourceRefName: string;
      targetRefName: string;
      title: string;
      description: string;
      isDraft?: boolean;
      reviewers?: Array<{ id: string }>;
    } = {
      sourceRefName,
      targetRefName,
      title,
      description,
    };

    if (options?.isDraft !== undefined) {
      body.isDraft = options.isDraft;
    }

    if (options?.reviewers && options.reviewers.length > 0) {
      body.reviewers = options.reviewers;
    }

    return this.post<AzureDevOpsPullRequest>(url, body);
  }

  /**
   * Update a pull request
   * @see https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-requests/update?view=azure-devops-rest-7.1
   *
   * @param project - Azure DevOps project name
   * @param repo - Repository name
   * @param prId - Pull request ID
   * @param updates - Properties to update (title, description, isDraft, status, targetRefName)
   * @returns Updated pull request details
   */
  async updatePullRequest(
    project: string,
    repo: string,
    prId: number,
    updates: PullRequestUpdateOptions
  ): Promise<AzureDevOpsPullRequest> {
    const url = `${this.baseUrl}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repo)}/pullRequests/${prId}?api-version=7.1`;

    // Build the request body with only defined properties
    const body: Record<string, unknown> = {};

    if (updates.title !== undefined) {
      body.title = updates.title;
    }
    if (updates.description !== undefined) {
      body.description = updates.description;
    }
    if (updates.isDraft !== undefined) {
      body.isDraft = updates.isDraft;
    }
    if (updates.status !== undefined) {
      body.status = updates.status;
    }
    if (updates.targetRefName !== undefined) {
      body.targetRefName = updates.targetRefName;
    }

    return this.patch<AzureDevOpsPullRequest>(url, body);
  }
}
