import type {
  JiraConfig,
  JiraSearchResponse,
  JiraIssueResponse,
  JiraCommentsResponse,
  JiraAddCommentResponse,
  JiraCreateIssueResponse,
  JiraCreateIssueOptions,
  JiraUpdateIssueOptions,
  JiraTransitionsResponse,
  JiraTransitionOptions,
  JiraAttachmentUploadResponse,
  JiraCreateMetaResponse,
  JiraUser,
  AdfDocument,
} from './types.js';

export class JiraClient {
  constructor(private config: JiraConfig) {}

  private getAuthHeaders(): Record<string, string> {
    const credentials = btoa(`${this.config.email}:${this.config.apiToken}`);
    return {
      Authorization: `Basic ${credentials}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
  }

  async searchIssues(
    jql: string,
    maxResults: number = 50
  ): Promise<JiraSearchResponse> {
    const url = `${this.config.url}/rest/api/3/search/jql`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: this.getAuthHeaders(),
        body: JSON.stringify({
          jql,
          maxResults,
          fields: [
            'key',
            'summary',
            'status',
            'assignee',
            'created',
            'updated',
            'priority',
          ],
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      return (await response.json()) as JiraSearchResponse;
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to search Jira issues: ${error.message}`);
      }
      throw new Error('Failed to search Jira issues: Unknown error');
    }
  }

  async getIssue(issueKey: string): Promise<JiraIssueResponse> {
    const url = `${this.config.url}/rest/api/3/issue/${issueKey}`;

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: this.getAuthHeaders(),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      return (await response.json()) as JiraIssueResponse;
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to get Jira issue: ${error.message}`);
      }
      throw new Error('Failed to get Jira issue: Unknown error');
    }
  }

  async addComment(
    issueKey: string,
    adfBody: AdfDocument
  ): Promise<JiraAddCommentResponse> {
    const url = `${this.config.url}/rest/api/3/issue/${issueKey}/comment`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: this.getAuthHeaders(),
        body: JSON.stringify({
          body: adfBody,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      return (await response.json()) as JiraAddCommentResponse;
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(
          `Failed to add comment to Jira issue: ${error.message}`
        );
      }
      throw new Error('Failed to add comment to Jira issue: Unknown error');
    }
  }

  async getComments(
    issueKey: string,
    startAt: number = 0,
    maxResults: number = 100
  ): Promise<JiraCommentsResponse> {
    const url = `${this.config.url}/rest/api/3/issue/${issueKey}/comment?startAt=${startAt}&maxResults=${maxResults}`;

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: this.getAuthHeaders(),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      return (await response.json()) as JiraCommentsResponse;
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(
          `Failed to get comments for Jira issue: ${error.message}`
        );
      }
      throw new Error('Failed to get comments for Jira issue: Unknown error');
    }
  }

  async setDescription(issueKey: string, adfBody: AdfDocument): Promise<void> {
    const url = `${this.config.url}/rest/api/3/issue/${issueKey}`;

    try {
      const response = await fetch(url, {
        method: 'PUT',
        headers: this.getAuthHeaders(),
        body: JSON.stringify({
          fields: {
            description: adfBody,
          },
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      // PUT request returns 204 No Content on success
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(
          `Failed to set description for Jira issue: ${error.message}`
        );
      }
      throw new Error(
        'Failed to set description for Jira issue: Unknown error'
      );
    }
  }

  /**
   * Create a new Jira issue
   */
  async createIssue(
    options: JiraCreateIssueOptions
  ): Promise<JiraCreateIssueResponse> {
    const url = `${this.config.url}/rest/api/3/issue`;

    // Build the fields object
    const fields: Record<string, unknown> = {
      project: { key: options.projectKey },
      issuetype: { name: options.issueType },
      summary: options.summary,
    };

    if (options.description) {
      fields.description = options.description;
    }
    if (options.assignee) {
      fields.assignee = { accountId: options.assignee };
    }
    if (options.priority) {
      fields.priority = { name: options.priority };
    }
    if (options.labels && options.labels.length > 0) {
      fields.labels = options.labels;
    }
    if (options.components && options.components.length > 0) {
      fields.components = options.components.map((name) => ({ name }));
    }
    if (options.parent) {
      fields.parent = { key: options.parent };
    }

    // Merge custom fields
    if (options.customFields) {
      Object.assign(fields, options.customFields);
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: this.getAuthHeaders(),
        body: JSON.stringify({ fields }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      return (await response.json()) as JiraCreateIssueResponse;
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to create Jira issue: ${error.message}`);
      }
      throw new Error('Failed to create Jira issue: Unknown error');
    }
  }

  /**
   * Update an existing Jira issue's fields
   */
  async updateIssue(
    issueKey: string,
    options: JiraUpdateIssueOptions
  ): Promise<void> {
    const url = `${this.config.url}/rest/api/3/issue/${issueKey}`;

    const fields: Record<string, unknown> = {};

    if (options.summary !== undefined) {
      fields.summary = options.summary;
    }
    if (options.description !== undefined) {
      fields.description = options.description;
    }
    if (options.assignee !== undefined) {
      fields.assignee = options.assignee;
    }
    if (options.priority !== undefined) {
      fields.priority = options.priority;
    }
    if (options.labels !== undefined) {
      fields.labels = options.labels;
    }
    if (options.components !== undefined) {
      fields.components = options.components.map((name) => ({ name }));
    }

    // Merge custom fields
    if (options.customFields) {
      Object.assign(fields, options.customFields);
    }

    try {
      const response = await fetch(url, {
        method: 'PUT',
        headers: this.getAuthHeaders(),
        body: JSON.stringify({ fields }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      // PUT request returns 204 No Content on success
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to update Jira issue: ${error.message}`);
      }
      throw new Error('Failed to update Jira issue: Unknown error');
    }
  }

  /**
   * Get available transitions for an issue
   */
  async getTransitions(issueKey: string): Promise<JiraTransitionsResponse> {
    const url = `${this.config.url}/rest/api/3/issue/${issueKey}/transitions`;

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: this.getAuthHeaders(),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      return (await response.json()) as JiraTransitionsResponse;
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to get transitions: ${error.message}`);
      }
      throw new Error('Failed to get transitions: Unknown error');
    }
  }

  /**
   * Transition an issue to a new status
   */
  async transitionIssue(
    issueKey: string,
    transitionId: string,
    options?: JiraTransitionOptions
  ): Promise<void> {
    const url = `${this.config.url}/rest/api/3/issue/${issueKey}/transitions`;

    const body: Record<string, unknown> = {
      transition: { id: transitionId },
    };

    if (options?.comment) {
      body.update = {
        comment: [{ add: { body: options.comment } }],
      };
    }

    if (options?.resolution) {
      body.fields = {
        ...(body.fields as Record<string, unknown>),
        resolution: { name: options.resolution },
      };
    }

    if (options?.fields) {
      body.fields = {
        ...(body.fields as Record<string, unknown>),
        ...options.fields,
      };
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: this.getAuthHeaders(),
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      // POST returns 204 No Content on success
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to transition issue: ${error.message}`);
      }
      throw new Error('Failed to transition issue: Unknown error');
    }
  }

  /**
   * Upload an attachment to an issue
   */
  async uploadAttachment(
    issueKey: string,
    filePath: string,
    fileName?: string
  ): Promise<JiraAttachmentUploadResponse[]> {
    const url = `${this.config.url}/rest/api/3/issue/${issueKey}/attachments`;

    try {
      const file = Bun.file(filePath);
      const arrayBuffer = await file.arrayBuffer();
      const blob = new Blob([arrayBuffer], {
        type: file.type || 'application/octet-stream',
      });

      const formData = new FormData();
      formData.append('file', blob, fileName || file.name || 'attachment');

      const credentials = btoa(`${this.config.email}:${this.config.apiToken}`);
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${credentials}`,
          'X-Atlassian-Token': 'no-check',
        },
        body: formData,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      return (await response.json()) as JiraAttachmentUploadResponse[];
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to upload attachment: ${error.message}`);
      }
      throw new Error('Failed to upload attachment: Unknown error');
    }
  }

  /**
   * Download an attachment by ID
   */
  async downloadAttachment(
    attachmentId: string,
    outputPath: string
  ): Promise<void> {
    const url = `${this.config.url}/rest/api/3/attachment/content/${attachmentId}`;

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: this.getAuthHeaders(),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      await Bun.write(outputPath, arrayBuffer);
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to download attachment: ${error.message}`);
      }
      throw new Error('Failed to download attachment: Unknown error');
    }
  }

  /**
   * Search for users by query string
   */
  async searchUsers(
    query: string,
    maxResults: number = 50
  ): Promise<JiraUser[]> {
    const url = `${this.config.url}/rest/api/3/user/search?query=${encodeURIComponent(query)}&maxResults=${maxResults}`;

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: this.getAuthHeaders(),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      return (await response.json()) as JiraUser[];
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to search users: ${error.message}`);
      }
      throw new Error('Failed to search users: Unknown error');
    }
  }

  /**
   * Get the current user (myself)
   */
  async getMyself(): Promise<JiraUser> {
    const url = `${this.config.url}/rest/api/3/myself`;

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: this.getAuthHeaders(),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      return (await response.json()) as JiraUser;
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to get current user: ${error.message}`);
      }
      throw new Error('Failed to get current user: Unknown error');
    }
  }

  /**
   * Get issue creation metadata for a project
   */
  async getCreateMeta(projectKey: string): Promise<JiraCreateMetaResponse> {
    const url = `${this.config.url}/rest/api/3/issue/createmeta?projectKeys=${encodeURIComponent(projectKey)}&expand=projects.issuetypes.fields`;

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: this.getAuthHeaders(),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      return (await response.json()) as JiraCreateMetaResponse;
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to get create metadata: ${error.message}`);
      }
      throw new Error('Failed to get create metadata: Unknown error');
    }
  }

  /**
   * Delete an attachment by ID
   */
  async deleteAttachment(attachmentId: string): Promise<void> {
    const url = `${this.config.url}/rest/api/3/attachment/${attachmentId}`;

    try {
      const response = await fetch(url, {
        method: 'DELETE',
        headers: this.getAuthHeaders(),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      // DELETE returns 204 No Content on success
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to delete attachment: ${error.message}`);
      }
      throw new Error('Failed to delete attachment: Unknown error');
    }
  }
}
