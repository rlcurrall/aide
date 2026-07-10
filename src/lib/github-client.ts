/**
 * GitHub API Client
 *
 * Uses `gh` CLI as primary transport (leveraging existing auth), with
 * direct HTTP + host-bound environment credentials as fallback for
 * CI/headless environments. Falls back to a keyring-stored token as a third
 * credential source.
 */

import { isProxy } from 'node:util/types';

import { spawnSync } from 'bun';
import type { AuthStoreScope } from './auth-store.js';
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
import {
  DEFAULT_GITHUB_HOST,
  githubCliEnvironment,
  resolveGitHubAuthRequest,
  type GitHubAuthErrorCode,
} from './github-auth.js';
import {
  resolveGitHubCredential,
  type GitHubCredentialResolverOptions,
} from './github-credential-resolver.js';
import type { GitHubAuthProbe } from './gh-utils.js';
import { githubApiBase, githubGraphqlEndpoint } from './github-utils.js';

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
  env?: Record<string, string | undefined>;
  stdin?: Uint8Array;
  stderr?: 'ignore' | 'pipe';
  stdout?: 'ignore' | 'pipe';
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

interface ValidatedGitHubClientDeps {
  readonly spawn: SpawnSyncFn;
  readonly fetch: FetchFn;
}

type ClientDependencySnapshot =
  | { readonly kind: 'data'; readonly value: unknown }
  | { readonly kind: 'absent' }
  | { readonly kind: 'invalid' };

function snapshotClientDependency(
  options: object,
  name: 'spawn' | 'fetch'
): ClientDependencySnapshot {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(options, name);
    if (descriptor !== undefined) {
      return Object.hasOwn(descriptor, 'value')
        ? { kind: 'data', value: descriptor.value }
        : { kind: 'invalid' };
    }

    let prototype = Object.getPrototypeOf(options);
    while (prototype !== null) {
      if (isProxy(prototype)) return { kind: 'invalid' };
      if (Object.getOwnPropertyDescriptor(prototype, name) !== undefined) {
        return { kind: 'invalid' };
      }
      prototype = Object.getPrototypeOf(prototype);
    }
    return { kind: 'absent' };
  } catch {
    return { kind: 'invalid' };
  }
}

function validatedClientDependencies(
  options: object
): ValidatedGitHubClientDeps | null {
  const spawnProperty = snapshotClientDependency(options, 'spawn');
  const fetchProperty = snapshotClientDependency(options, 'fetch');
  if (
    spawnProperty.kind === 'invalid' ||
    fetchProperty.kind === 'invalid' ||
    (spawnProperty.kind === 'data' &&
      spawnProperty.value !== undefined &&
      typeof spawnProperty.value !== 'function') ||
    (fetchProperty.kind === 'data' &&
      fetchProperty.value !== undefined &&
      typeof fetchProperty.value !== 'function')
  ) {
    return null;
  }

  const dependencies = Object.create(null) as {
    spawn: SpawnSyncFn;
    fetch: FetchFn;
  };
  dependencies.spawn =
    spawnProperty.kind === 'data' && spawnProperty.value !== undefined
      ? (spawnProperty.value as SpawnSyncFn)
      : (spawnSync as unknown as SpawnSyncFn);
  dependencies.fetch =
    fetchProperty.kind === 'data' && fetchProperty.value !== undefined
      ? (fetchProperty.value as FetchFn)
      : globalThis.fetch.bind(globalThis);
  return Object.freeze(dependencies);
}

const AUTHENTICATED_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_AUTHENTICATED_REDIRECTS = 5;

/**
 * Validate a URL before an Authorization header is attached to its request.
 */
function validateAuthenticatedUrl(
  input: string | URL,
  expectedOrigin: string
): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error('Refusing authenticated GitHub request to an invalid URL');
  }

  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error(
      'Refusing authenticated GitHub request: URL userinfo is not allowed'
    );
  }
  if (url.protocol !== 'https:') {
    throw new Error(
      'Refusing authenticated GitHub request: destination must use HTTPS'
    );
  }
  if (url.origin !== expectedOrigin) {
    throw new Error(
      `Refusing authenticated GitHub request outside API origin ${expectedOrigin}`
    );
  }

  return url;
}

/** Apply Fetch redirect method/body semantics without changing the origin. */
function redirectedRequestInit(init: RequestInit, status: number): RequestInit {
  const method = (init.method ?? 'GET').toUpperCase();
  const becomesGet =
    ((status === 301 || status === 302) && method === 'POST') ||
    (status === 303 && method !== 'GET' && method !== 'HEAD');
  if (!becomesGet) return init;

  const headers = new Headers(init.headers);
  for (const name of [
    'Content-Encoding',
    'Content-Language',
    'Content-Location',
    'Content-Type',
  ]) {
    headers.delete(name);
  }
  return { ...init, method: 'GET', body: undefined, headers };
}

/**
 * Error thrown when GitHub authentication is not available.
 */
export class GitHubAuthError extends Error {
  readonly code: GitHubAuthErrorCode;
  readonly host: string;
  readonly account?: string;

  constructor(
    host: string = DEFAULT_GITHUB_HOST,
    code: GitHubAuthErrorCode = 'not-configured',
    detail?: string,
    account?: string
  ) {
    const guidance =
      account !== undefined
        ? 'Environment tokens cannot satisfy an account-qualified request because they do not prove account identity.'
        : host === DEFAULT_GITHUB_HOST
          ? 'Set GITHUB_TOKEN or GH_TOKEN for github.com.'
          : `Set GH_HOST=${host} together with GH_ENTERPRISE_TOKEN or GITHUB_ENTERPRISE_TOKEN.`;
    const message =
      code === 'not-configured'
        ? `GitHub authentication is not configured for '${host}'${
            account === undefined ? '' : ` account '${account}'`
          }.\n\n` +
          `Authenticate gh for this host with: gh auth login --hostname ${host}\n` +
          `Or run 'aide login github' to save a ${
            account === undefined ? 'host-scoped' : 'matching account-scoped'
          } token.\n` +
          guidance
        : (detail ?? `GitHub authentication failed for '${host}' (${code}).`);
    super(message);
    this.name = 'GitHubAuthError';
    this.code = code;
    this.host = host;
    this.account = account;
  }
}

export class GitHubClient {
  private mode: TransportMode;
  private token?: string;
  private host: string;
  private spawn: SpawnSyncFn;
  private fetchImpl: FetchFn;
  private ghEnvironment: Record<string, string | undefined>;
  private apiOrigin: string;

  private constructor(
    mode: TransportMode,
    host: string,
    token?: string,
    deps?: ValidatedGitHubClientDeps
  ) {
    this.mode = mode;
    this.host = host;
    this.token = token;
    this.spawn = deps?.spawn ?? (spawnSync as unknown as SpawnSyncFn);
    this.fetchImpl = deps?.fetch ?? globalThis.fetch.bind(globalThis);
    this.ghEnvironment = githubCliEnvironment();
    this.apiOrigin = new URL(githubApiBase(host)).origin;
  }

  /**
   * Create a GitHubClient with host-bound credential selection.
   *
   * github.com precedence: exact-host gh, GITHUB_TOKEN, GH_TOKEN, keyring.
   * Enterprise precedence: exact-host gh, a GH_HOST-bound enterprise env
   * token, then exact-host scoped keyring credentials.
   *
   * @param opts.host - GitHub web host (e.g. `github.com` or `acme.ghe.com`).
   *   Defaults to `github.com`. Used to derive the REST/GraphQL API base and,
   *   for the gh CLI transport, the `--hostname` passed to `gh api`.
   * @param opts.scope - Optional keyring scope. Explicit hosts/scopes read only
   *   their matching stored credential. Omitted host/scope preserves the legacy
   *   github.com key.
   * @param opts.spawn - Test seam overriding the gh CLI spawn function.
   * @param opts.fetch - Test seam overriding the token transport's fetch.
   * @throws {GitHubAuthError} if no auth source is available
   */
  static async create(
    opts: {
      ghAuthProbe?: GitHubAuthProbe;
      host?: string;
      scope?: AuthStoreScope;
      spawn?: SpawnSyncFn;
      fetch?: FetchFn;
    } = {}
  ): Promise<GitHubClient> {
    const request = resolveGitHubAuthRequest(opts);
    if (!request.ok) {
      throw new GitHubAuthError(request.host, request.code, request.reason);
    }
    const host = request.host;
    const deps = validatedClientDependencies(opts);
    if (deps === null) {
      throw new GitHubAuthError(
        host,
        'malformed-credential',
        'Invalid GitHub client dependencies.',
        request.account
      );
    }
    const credential = await resolveGitHubCredential(
      request,
      opts as unknown as GitHubCredentialResolverOptions
    );
    switch (credential.kind) {
      case 'gh-cli':
        return new GitHubClient('gh-cli', host, undefined, deps);
      case 'env':
        return new GitHubClient(
          'token',
          host,
          credential.credential.token,
          deps
        );
      case 'stored':
        return new GitHubClient('token', host, credential.token, deps);
      case 'failure':
        throw new GitHubAuthError(
          host,
          credential.code,
          credential.reason,
          request.account
        );
      case 'missing':
      case 'unreachable':
        throw new GitHubAuthError(
          host,
          'not-configured',
          undefined,
          request.account
        );
    }
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
        env: this.ghEnvironment,
        stdin: Buffer.from(JSON.stringify(body)),
        stderr: 'pipe',
      });
    } else {
      result = this.spawn(args, {
        env: this.ghEnvironment,
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

    const result = this.spawn(args, {
      env: this.ghEnvironment,
      stderr: 'pipe',
    });

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
    const response = await this.authenticatedFetch(
      `${githubApiBase(this.host)}${endpoint}`,
      {
        method,
        headers: {
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
   * Fetch with the bearer token only after locking the request to this
   * client's canonical HTTPS API origin. Redirects are handled manually so
   * each destination is validated before the token can be sent again.
   */
  private async authenticatedFetch(
    input: string | URL,
    init: RequestInit = {}
  ): Promise<Response> {
    if (this.token === undefined) {
      throw new Error('GitHub bearer token is unavailable');
    }

    let currentUrl = validateAuthenticatedUrl(input, this.apiOrigin);
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${this.token}`);
    let requestInit: RequestInit = {
      ...init,
      headers,
      redirect: 'manual',
    };
    let redirects = 0;

    while (true) {
      const response = await this.fetchImpl(currentUrl.href, requestInit);
      if (!AUTHENTICATED_REDIRECT_STATUSES.has(response.status)) {
        return response;
      }

      const location = response.headers.get('Location');
      if (location === null) return response;

      const redirectUrl = validateAuthenticatedUrl(
        new URL(location, currentUrl),
        this.apiOrigin
      );
      if (redirects >= MAX_AUTHENTICATED_REDIRECTS) {
        throw new Error(
          `GitHub API request exceeded ${MAX_AUTHENTICATED_REDIRECTS} redirects (too many redirects)`
        );
      }

      requestInit = redirectedRequestInit(requestInit, response.status);
      currentUrl = redirectUrl;
      redirects += 1;
    }
  }

  /**
   * Make a paginated GET request via fetch, following Link headers
   */
  private async fetchApiCallPaginated<T>(endpoint: string): Promise<T[]> {
    const results: T[] = [];
    const apiBase = githubApiBase(this.host);
    let nextUrl: string | null = `${apiBase}${endpoint}`;

    while (nextUrl) {
      const currentUrl: string = nextUrl;
      nextUrl = null;

      const resp: Response = await this.authenticatedFetch(currentUrl, {
        method: 'GET',
        headers: {
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

      // Resolve the next link now; authenticatedFetch validates the resulting
      // absolute URL against the locked API origin before sending the token.
      const linkHeader: string | null = resp.headers.get('Link');
      if (linkHeader) {
        const nextMatch: RegExpMatchArray | null = linkHeader.match(
          /<([^>]+)>;\s*rel="next"/
        );
        const candidate = nextMatch?.[1];
        if (candidate) {
          nextUrl = new URL(candidate, currentUrl).href;
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
      const result = this.spawn(args, {
        env: this.ghEnvironment,
        stderr: 'pipe',
        stdout: 'pipe',
      });
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
      const response = await this.authenticatedFetch(
        githubGraphqlEndpoint(this.host),
        {
          method: 'POST',
          headers: {
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
