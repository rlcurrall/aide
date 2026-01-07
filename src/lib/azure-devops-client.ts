import type {
  AzureDevOpsConfig,
  AzureDevOpsPRThread,
  AzureDevOpsPullRequest,
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

    return response.json();
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
  ): Promise<
    Array<{
      threadId: number;
      threadStatus: string;
      filePath?: string;
      lineNumber?: number;
      comment: {
        id: number;
        parentCommentId: number;
        author: { displayName: string; uniqueName?: string; id: string };
        content: string;
        publishedDate: string;
        lastUpdatedDate: string;
        commentType: string;
      };
    }>
  > {
    const threadsResponse = await this.getPullRequestThreads(
      project,
      repo,
      prId
    );

    const allComments: Array<{
      threadId: number;
      threadStatus: string;
      filePath?: string;
      lineNumber?: number;
      comment: any;
    }> = [];

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
}
