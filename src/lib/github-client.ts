/**
 * GitHub API Client
 *
 * Uses `gh` CLI as primary transport (leveraging existing auth), with
 * direct HTTP + GITHUB_TOKEN as fallback for CI/headless environments.
 * Falls back to a keyring-stored token as a third credential source.
 */

import { spawnSync } from 'bun';
import * as v from 'valibot';
import type {
  GitHubPullRequest,
  GitHubIssueComment,
  GitHubReviewComment,
  GitHubPRFile,
  GitHubLabel,
  GitHubPRUpdateOptions,
  GitHubListPROptions,
  GitHubCreateReviewCommentOptions,
} from './github-types.js';
import { isGhCliAvailable } from './gh-utils.js';
import { getSecret, KeyringUnavailableError } from './secrets.js';
import { StoredGithubSchema } from '@schemas/config.js';

type TransportMode = 'gh-cli' | 'token';

/**
 * Error thrown when GitHub authentication is not available.
 */
export class GitHubAuthError extends Error {
  constructor() {
    super(
      'GitHub authentication not available.\n\n' +
        'Either:\n' +
        '  1. Install the GitHub CLI and run: gh auth login\n' +
        "  2. Run 'aide login github' to save a token\n" +
        '  3. Set the GITHUB_TOKEN or GH_TOKEN environment variable'
    );
    this.name = 'GitHubAuthError';
  }
}

async function tryReadStoredToken(): Promise<string | null> {
  let raw: string | null;
  try {
    raw = await getSecret('github');
  } catch (err) {
    if (err instanceof KeyringUnavailableError) return null;
    throw err;
  }
  if (raw === null) return null;
  try {
    const parsed = v.parse(StoredGithubSchema, JSON.parse(raw));
    return parsed.token;
  } catch {
    return null;
  }
}

export class GitHubClient {
  private mode: TransportMode;
  private token?: string;

  private constructor(mode: TransportMode, token?: string) {
    this.mode = mode;
    this.token = token;
  }

  /**
   * Create a GitHubClient, checking gh CLI, env vars, and keyring in order.
   * @throws {GitHubAuthError} if no auth source is available
   */
  static async create(): Promise<GitHubClient> {
    if (isGhCliAvailable()) {
      return new GitHubClient('gh-cli');
    }
    const envToken = Bun.env.GITHUB_TOKEN || Bun.env.GH_TOKEN;
    if (envToken) {
      return new GitHubClient('token', envToken);
    }
    const stored = await tryReadStoredToken();
    if (stored) {
      return new GitHubClient('token', stored);
    }
    throw new GitHubAuthError();
  }

  // ===========================================================================
  // Transport Layer
  // ===========================================================================

  private async apiCall<T>(
    method: string,
    endpoint: string,
    body?: unknown
  ): Promise<T> {
    if (this.mode === 'gh-cli') {
      return this.ghApiCall<T>(method, endpoint, body);
    }
    return this.fetchApiCall<T>(method, endpoint, body);
  }

  private ghApiCall<T>(method: string, endpoint: string, body?: unknown): T {
    const args = [
      'gh',
      'api',
      '-X',
      method,
      '-H',
      'Accept: application/vnd.github+json',
      '-H',
      'X-GitHub-Api-Version: 2022-11-28',
      endpoint,
    ];

    let result;
    if (body) {
      result = spawnSync(args.concat(['--input', '-']), {
        stdin: Buffer.from(JSON.stringify(body)),
        stderr: 'pipe',
      });
    } else {
      result = spawnSync(args, {
        stderr: 'pipe',
      });
    }

    if (result.exitCode !== 0) {
      const stderr = result.stderr.toString().trim();
      throw new Error(`GitHub API error: ${stderr}`);
    }

    const stdout = result.stdout.toString().trim();
    if (!stdout) {
      return undefined as T;
    }

    return JSON.parse(stdout) as T;
  }

  /**
   * Make a paginated GET request via gh CLI, fetching all pages
   */
  private ghApiCallPaginated<T>(endpoint: string): T[] {
    const args = [
      'gh',
      'api',
      '-X',
      'GET',
      '-H',
      'Accept: application/vnd.github+json',
      '-H',
      'X-GitHub-Api-Version: 2022-11-28',
      '--paginate',
      endpoint,
    ];

    const result = spawnSync(args, { stderr: 'pipe' });

    if (result.exitCode !== 0) {
      const stderr = result.stderr.toString().trim();
      throw new Error(`GitHub API error: ${stderr}`);
    }

    const stdout = result.stdout.toString().trim();
    if (!stdout) {
      return [];
    }

    // gh --paginate concatenates JSON arrays (e.g., [a,b][c,d]).
    // First try a direct parse (works when only one page).
    try {
      const parsed = JSON.parse(stdout);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      // Multiple arrays concatenated: replace "][" boundaries, wrap, and flatten.
      // This is safer than bracket-counting which breaks on brackets inside strings.
      const wrapped = `[${stdout.replace(/\]\s*\[/g, '],[')}]`;
      const parsed = JSON.parse(wrapped) as T[][];
      return parsed.flat();
    }
  }

  private async fetchApiCall<T>(
    method: string,
    endpoint: string,
    body?: unknown
  ): Promise<T> {
    const response = await fetch(`https://api.github.com${endpoint}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`GitHub API error (${response.status}): ${errorText}`);
    }

    const text = await response.text();
    if (!text) {
      return undefined as T;
    }
    return JSON.parse(text) as T;
  }

  /**
   * Make a paginated GET request via fetch, following Link headers
   */
  private async fetchApiCallPaginated<T>(endpoint: string): Promise<T[]> {
    const results: T[] = [];
    let nextUrl: string | null = `https://api.github.com${endpoint}`;

    while (nextUrl) {
      const currentUrl = nextUrl;
      nextUrl = null;

      const resp: Response = await fetch(currentUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });

      if (!resp.ok) {
        const errorText = await resp.text();
        throw new Error(`GitHub API error (${resp.status}): ${errorText}`);
      }

      const data = (await resp.json()) as T[];
      results.push(...data);

      // Parse Link header for next page
      const linkHeader: string | null = resp.headers.get('Link');
      if (linkHeader) {
        const nextMatch: RegExpMatchArray | null = linkHeader.match(
          /<([^>]+)>;\s*rel="next"/
        );
        if (nextMatch?.[1]) {
          nextUrl = nextMatch[1];
        }
      }
    }

    return results;
  }

  // ===========================================================================
  // Pull Request Operations
  // ===========================================================================

  async getPullRequest(
    owner: string,
    repo: string,
    number: number
  ): Promise<GitHubPullRequest> {
    return this.apiCall<GitHubPullRequest>(
      'GET',
      `/repos/${owner}/${repo}/pulls/${number}`
    );
  }

  async listPullRequests(
    owner: string,
    repo: string,
    options?: GitHubListPROptions
  ): Promise<GitHubPullRequest[]> {
    const params = new URLSearchParams();
    if (options?.state) params.set('state', options.state);
    if (options?.head) params.set('head', options.head);
    if (options?.base) params.set('base', options.base);
    if (options?.sort) params.set('sort', options.sort);
    if (options?.direction) params.set('direction', options.direction);

    // GitHub max per_page is 100. If limit fits in one page, skip pagination.
    const limit = options?.per_page;
    const perPage = limit && limit <= 100 ? limit : 100;
    params.set('per_page', String(perPage));

    const query = params.toString();
    const endpoint = `/repos/${owner}/${repo}/pulls${query ? `?${query}` : ''}`;

    // Skip pagination when a small limit is requested (fits in one page)
    if (limit && limit <= 100) {
      return this.apiCall<GitHubPullRequest[]>('GET', endpoint);
    }

    if (this.mode === 'gh-cli') {
      return this.ghApiCallPaginated<GitHubPullRequest>(endpoint);
    }
    return this.fetchApiCallPaginated<GitHubPullRequest>(endpoint);
  }

  async createPullRequest(
    owner: string,
    repo: string,
    head: string,
    base: string,
    title: string,
    body?: string,
    options?: { draft?: boolean }
  ): Promise<GitHubPullRequest> {
    return this.apiCall<GitHubPullRequest>(
      'POST',
      `/repos/${owner}/${repo}/pulls`,
      {
        title,
        head,
        base,
        body: body ?? '',
        draft: options?.draft ?? false,
      }
    );
  }

  async updatePullRequest(
    owner: string,
    repo: string,
    number: number,
    updates: GitHubPRUpdateOptions
  ): Promise<GitHubPullRequest> {
    return this.apiCall<GitHubPullRequest>(
      'PATCH',
      `/repos/${owner}/${repo}/pulls/${number}`,
      updates
    );
  }

  // ===========================================================================
  // Draft PR Operations (require GraphQL)
  // ===========================================================================

  /**
   * Execute a GraphQL mutation and check for errors in the response.
   * GraphQL can return HTTP 200 with errors in the body, so we must parse.
   */
  private async graphqlMutation(
    query: string,
    variables: Record<string, string>,
    errorPrefix: string
  ): Promise<void> {
    if (this.mode === 'gh-cli') {
      const args = ['gh', 'api', 'graphql', '-f', `query=${query}`];
      for (const [key, value] of Object.entries(variables)) {
        args.push('-f', `${key}=${value}`);
      }
      const result = spawnSync(args, { stderr: 'pipe', stdout: 'pipe' });
      if (result.exitCode !== 0) {
        throw new Error(`${errorPrefix}: ${result.stderr.toString().trim()}`);
      }
      // Check for GraphQL-level errors in stdout
      const stdout = result.stdout.toString().trim();
      if (stdout) {
        const parsed = JSON.parse(stdout) as {
          errors?: Array<{ message: string }>;
        };
        if (parsed.errors && parsed.errors.length > 0) {
          throw new Error(
            `${errorPrefix}: ${parsed.errors.map((e) => e.message).join(', ')}`
          );
        }
      }
    } else {
      const response = await fetch('https://api.github.com/graphql', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query, variables }),
      });
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`${errorPrefix}: ${errorText}`);
      }
      const body = (await response.json()) as {
        errors?: Array<{ message: string }>;
      };
      if (body.errors && body.errors.length > 0) {
        throw new Error(
          `${errorPrefix}: ${body.errors.map((e) => e.message).join(', ')}`
        );
      }
    }
  }

  /**
   * Publish a draft PR (mark as ready for review).
   * Requires GraphQL since the REST API doesn't support this.
   */
  async publishDraftPR(
    owner: string,
    repo: string,
    number: number
  ): Promise<void> {
    const pr = await this.getPullRequest(owner, repo, number);
    await this.graphqlMutation(
      `mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { number } } }`,
      { id: pr.node_id },
      'Failed to publish draft PR'
    );
  }

  /**
   * Convert a PR to draft.
   * Requires GraphQL since the REST API doesn't support this.
   */
  async convertToDraft(
    owner: string,
    repo: string,
    number: number
  ): Promise<void> {
    const pr = await this.getPullRequest(owner, repo, number);
    await this.graphqlMutation(
      `mutation($id: ID!) { convertPullRequestToDraft(input: { pullRequestId: $id }) { pullRequest { number } } }`,
      { id: pr.node_id },
      'Failed to convert PR to draft'
    );
  }

  // ===========================================================================
  // Comment Operations
  // ===========================================================================

  /**
   * Get issue comments (general PR discussion comments)
   */
  async getIssueComments(
    owner: string,
    repo: string,
    number: number
  ): Promise<GitHubIssueComment[]> {
    const endpoint = `/repos/${owner}/${repo}/issues/${number}/comments`;
    if (this.mode === 'gh-cli') {
      return this.ghApiCallPaginated<GitHubIssueComment>(endpoint);
    }
    return this.fetchApiCallPaginated<GitHubIssueComment>(endpoint);
  }

  /**
   * Get review comments (code-level comments on the diff)
   */
  async getReviewComments(
    owner: string,
    repo: string,
    number: number
  ): Promise<GitHubReviewComment[]> {
    const endpoint = `/repos/${owner}/${repo}/pulls/${number}/comments`;
    if (this.mode === 'gh-cli') {
      return this.ghApiCallPaginated<GitHubReviewComment>(endpoint);
    }
    return this.fetchApiCallPaginated<GitHubReviewComment>(endpoint);
  }

  /**
   * Create an issue comment (general PR discussion)
   */
  async createIssueComment(
    owner: string,
    repo: string,
    number: number,
    body: string
  ): Promise<GitHubIssueComment> {
    return this.apiCall<GitHubIssueComment>(
      'POST',
      `/repos/${owner}/${repo}/issues/${number}/comments`,
      { body }
    );
  }

  /**
   * Create a review comment (code-level, attached to a file/line)
   */
  async createReviewComment(
    owner: string,
    repo: string,
    number: number,
    body: string,
    options: GitHubCreateReviewCommentOptions
  ): Promise<GitHubReviewComment> {
    return this.apiCall<GitHubReviewComment>(
      'POST',
      `/repos/${owner}/${repo}/pulls/${number}/comments`,
      {
        body,
        path: options.path,
        line: options.line,
        commit_id: options.commit_id,
        side: options.side ?? 'RIGHT',
        ...(options.start_line ? { start_line: options.start_line } : {}),
      }
    );
  }

  /**
   * Reply to a review comment thread
   */
  async replyToReviewComment(
    owner: string,
    repo: string,
    number: number,
    commentId: number,
    body: string
  ): Promise<GitHubReviewComment> {
    return this.apiCall<GitHubReviewComment>(
      'POST',
      `/repos/${owner}/${repo}/pulls/${number}/comments/${commentId}/replies`,
      { body }
    );
  }

  // ===========================================================================
  // File/Diff Operations
  // ===========================================================================

  /**
   * Get the list of files changed in a PR
   */
  async getPullRequestFiles(
    owner: string,
    repo: string,
    number: number
  ): Promise<GitHubPRFile[]> {
    const endpoint = `/repos/${owner}/${repo}/pulls/${number}/files`;
    if (this.mode === 'gh-cli') {
      return this.ghApiCallPaginated<GitHubPRFile>(endpoint);
    }
    return this.fetchApiCallPaginated<GitHubPRFile>(endpoint);
  }

  // ===========================================================================
  // Label Operations
  // ===========================================================================

  async addLabels(
    owner: string,
    repo: string,
    number: number,
    labels: string[]
  ): Promise<GitHubLabel[]> {
    return this.apiCall<GitHubLabel[]>(
      'POST',
      `/repos/${owner}/${repo}/issues/${number}/labels`,
      { labels }
    );
  }

  async removeLabel(
    owner: string,
    repo: string,
    number: number,
    label: string
  ): Promise<void> {
    await this.apiCall<void>(
      'DELETE',
      `/repos/${owner}/${repo}/issues/${number}/labels/${encodeURIComponent(label)}`
    );
  }
}
