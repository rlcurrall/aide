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
import { DEFAULT_GITHUB_HOST, githubApiBase } from './github-utils.js';
import { getSecret, KeyringUnavailableError } from './secrets.js';
import { StoredGithubSchema } from '@schemas/config.js';
import { ConfigError } from './config.js';

type TransportMode = 'gh-cli' | 'token';

/**
 * Minimal subset of `bun`'s `spawnSync` result this client relies on.
 */
export interface SpawnResult {
  exitCode: number | null;
  stdout: { toString(): string };
  stderr: { toString(): string };
}

/**
 * Options passed to the injectable spawn function. A subset of bun's
 * SpawnOptions covering only what the gh CLI transport uses.
 */
export interface SpawnOptions {
  stdin?: Uint8Array;
  stderr?: 'pipe';
  stdout?: 'pipe';
}

/**
 * Injectable synchronous spawn used by the gh CLI transport. Defaults to
 * bun's `spawnSync`; tests pass a stub to assert the args (e.g. `--hostname`)
 * without invoking the real `gh` binary.
 */
export type SpawnSyncFn = (
  cmd: string[],
  options?: SpawnOptions
) => SpawnResult;

/**
 * Injectable fetch used by the token transport. Defaults to global `fetch`;
 * tests pass a stub to assert the request URL without hitting the network.
 */
export type FetchFn = typeof globalThis.fetch;

/**
 * Transport dependencies. Injectable so the gh CLI and token paths can be
 * unit-tested without spawning `gh` or making real HTTP requests.
 */
export interface GitHubClientDeps {
  spawn?: SpawnSyncFn;
  fetch?: FetchFn;
}

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

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ConfigError(
      "Stored GitHub credentials are malformed. Re-run 'aide login github' to reconfigure."
    );
  }
  const parsed = v.safeParse(StoredGithubSchema, json);
  if (!parsed.success) {
    throw new ConfigError(
      'Stored GitHub credentials failed validation. ' +
        "Re-run 'aide login github' to reconfigure."
    );
  }
  return parsed.output.token;
}

export class GitHubClient {
  private mode: TransportMode;
  private token?: string;
  private host: string;
  private spawn: SpawnSyncFn;
  private fetchImpl: FetchFn;

  private constructor(
    mode: TransportMode,
    host: string,
    token?: string,
    deps: GitHubClientDeps = {}
  ) {
    this.mode = mode;
    this.host = host;
    this.token = token;
    this.spawn = deps.spawn ?? (spawnSync as unknown as SpawnSyncFn);
    this.fetchImpl = deps.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * Create a GitHubClient, checking gh CLI, env vars, and keyring in order.
   *
   * @param opts.host - GitHub web host (e.g. `github.com` or `acme.ghe.com`).
   *   Defaults to `github.com`. Used to derive the REST/GraphQL API base and,
   *   for the gh CLI transport, the `--hostname` passed to `gh api`.
   * @param opts.spawn - Test seam overriding the gh CLI spawn function.
   * @param opts.fetch - Test seam overriding the token transport's fetch.
   * @throws {GitHubAuthError} if no auth source is available
   */
  static async create(
    opts: {
      ghAvailable?: () => boolean;
      host?: string;
      spawn?: SpawnSyncFn;
      fetch?: FetchFn;
    } = {}
  ): Promise<GitHubClient> {
    const host = opts.host ?? DEFAULT_GITHUB_HOST;
    const deps: GitHubClientDeps = { spawn: opts.spawn, fetch: opts.fetch };
    const ghCheck = opts.ghAvailable ?? isGhCliAvailable;
    if (ghCheck()) {
      return new GitHubClient('gh-cli', host, undefined, deps);
    }
    const envToken = Bun.env.GITHUB_TOKEN || Bun.env.GH_TOKEN;
    if (envToken) {
      return new GitHubClient('token', host, envToken, deps);
    }
    const stored = await tryReadStoredToken();
    if (stored) {
      return new GitHubClient('token', host, stored, deps);
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
      '--hostname',
      this.host,
      '-H',
      'Accept: application/vnd.github+json',
      '-H',
      'X-GitHub-Api-Version: 2022-11-28',
      endpoint,
    ];

    let result;
    if (body) {
      result = this.spawn(args.concat(['--input', '-']), {
        stdin: Buffer.from(JSON.stringify(body)),
        stderr: 'pipe',
      });
    } else {
      result = this.spawn(args, {
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
      '--hostname',
      this.host,
      '-H',
      'Accept: application/vnd.github+json',
      '-H',
      'X-GitHub-Api-Version: 2022-11-28',
      '--paginate',
      endpoint,
    ];

    const result = this.spawn(args, { stderr: 'pipe' });

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
    const response = await this.fetchImpl(
      `${githubApiBase(this.host)}${endpoint}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
      }
    );

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
    const apiBase = githubApiBase(this.host);
    const apiHost = new URL(apiBase).host;
    let nextUrl: string | null = `${apiBase}${endpoint}`;

    while (nextUrl) {
      const currentUrl = nextUrl;
      nextUrl = null;

      const resp: Response = await this.fetchImpl(currentUrl, {
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

      // Parse Link header for next page. Only follow links that stay on the
      // configured API host so a stray/cross-host `next` can never receive the
      // bearer token. GitHub's own API always returns same-host links.
      const linkHeader: string | null = resp.headers.get('Link');
      if (linkHeader) {
        const nextMatch: RegExpMatchArray | null = linkHeader.match(
          /<([^>]+)>;\s*rel="next"/
        );
        const candidate = nextMatch?.[1];
        if (candidate) {
          let candidateHost: string | null = null;
          try {
            candidateHost = new URL(candidate).host;
          } catch {
            candidateHost = null;
          }
          if (candidateHost === apiHost) {
            nextUrl = candidate;
          }
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
      const args = [
        'gh',
        'api',
        'graphql',
        '--hostname',
        this.host,
        '-f',
        `query=${query}`,
      ];
      for (const [key, value] of Object.entries(variables)) {
        args.push('-f', `${key}=${value}`);
      }
      const result = this.spawn(args, { stderr: 'pipe', stdout: 'pipe' });
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
      const response = await this.fetchImpl(
        `${githubApiBase(this.host)}/graphql`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ query, variables }),
        }
      );
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
