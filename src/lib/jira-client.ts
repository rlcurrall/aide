import type {
  JiraConfig,
  JiraSearchResponse,
  JiraIssueResponse,
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

  async addComment(issueKey: string, adfBody: any): Promise<any> {
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

      return await response.json();
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
  ): Promise<any> {
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

      return await response.json();
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(
          `Failed to get comments for Jira issue: ${error.message}`
        );
      }
      throw new Error('Failed to get comments for Jira issue: Unknown error');
    }
  }

  async setDescription(issueKey: string, adfBody: any): Promise<void> {
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
}
