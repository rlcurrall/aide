/**
 * GitHub API Client
 *
 * Uses `gh` CLI as primary transport (leveraging existing auth), with
 * direct HTTP + host-bound environment credentials as fallback for
 * CI/headless environments. Falls back to a keyring-stored token as a third
 * credential source.
 */

import { isProxy, isUint8Array } from 'node:util/types';

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
 * Supported producer shape for the subset of `bun`'s `spawnSync` result this
 * client relies on. Bun returns buffers for piped output; injected spawns may
 * also return a string or raw byte array for stdout.
 */
export interface SpawnResult {
  exitCode: number | null;
  stdout: string | Uint8Array;
  stderr: Buffer;
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

export interface GitHubClientCreateOptions extends GitHubClientDeps {
  ghAuthProbe?: GitHubAuthProbe;
  host?: string;
  scope?: AuthStoreScope;
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
const githubAuthErrorDiagnostics = new WeakMap<object, string>();

export function githubAuthErrorDiagnostic(error: unknown): string | undefined {
  return (typeof error === 'object' && error !== null) ||
    typeof error === 'function'
    ? githubAuthErrorDiagnostics.get(error)
    : undefined;
}

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
    githubAuthErrorDiagnostics.set(this, message);
  }
}

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

/** Decode only supported spawn stdout values as strict UTF-8. */
function decodeSpawnStdout(stdout: unknown): string {
  if (typeof stdout === 'string') return stdout;
  if (
    typeof stdout !== 'object' ||
    stdout === null ||
    isProxy(stdout) ||
    !isUint8Array(stdout)
  ) {
    throw new TypeError('Unsupported spawn stdout');
  }
  return utf8Decoder.decode(stdout);
}

/**
 * Parse the single credential line printed by `gh auth token`.
 *
 * RFC 6750 section 2.1 defines bearer credentials as `b64token`: one or more
 * ASCII letters, digits, or `-._~+/`, followed by optional `=` padding. The
 * CLI may surround that value with horizontal line whitespace and terminate
 * it with one LF or CRLF, but any additional line or byte is malformed.
 */
function parseGhTokenOutput(output: string): string | null {
  const match =
    /^[ \t]*([-A-Za-z0-9._~+/]+={0,})[ \t]*(?:\r?\n)?(?![\s\S])/.exec(output);
  return match?.[1] ?? null;
}

/** Resolve one exact gh account token without exposing process output. */
function resolveGhAccountToken(
  host: string,
  account: string,
  spawn: SpawnSyncFn
): string {
  const failure = () =>
    new GitHubAuthError(
      host,
      'malformed-credential',
      `Failed to obtain authentication for GitHub account '${account}' on '${host}' from gh.`,
      account
    );

  let result: unknown;
  try {
    result = spawn(
      ['gh', 'auth', 'token', '--hostname', host, '--user', account],
      {
        env: githubCliEnvironment(),
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );
  } catch {
    throw failure();
  }

  try {
    if (
      typeof result !== 'object' ||
      result === null ||
      isProxy(result) ||
      Array.isArray(result)
    ) {
      throw failure();
    }

    const exitCodeProperty = Object.getOwnPropertyDescriptor(
      result,
      'exitCode'
    );
    if (
      exitCodeProperty === undefined ||
      !Object.hasOwn(exitCodeProperty, 'value') ||
      typeof exitCodeProperty.value !== 'number' ||
      exitCodeProperty.value !== 0
    ) {
      throw failure();
    }

    const stdoutProperty = Object.getOwnPropertyDescriptor(result, 'stdout');
    if (
      stdoutProperty === undefined ||
      !Object.hasOwn(stdoutProperty, 'value')
    ) {
      throw failure();
    }

    const output = decodeSpawnStdout(stdoutProperty.value);
    const token = parseGhTokenOutput(output);
    if (token === null) throw failure();
    return token;
  } catch {
    throw failure();
  }
}

type ConstructGitHubClient = (
  mode: TransportMode,
  host: string,
  token?: string,
  deps?: ValidatedGitHubClientDeps
) => GitHubClient;

let constructGitHubClient: ConstructGitHubClient = () => {
  throw new Error('GitHub client constructor is not initialized');
};

/**
 * Create a GitHubClient with host-bound credential selection.
 *
 * This immutable module binding owns the production creation algorithm.
 * GitHubClient.create delegates here for compatibility.
 */
export const createGitHubClient = async (
  opts: GitHubClientCreateOptions = {}
): Promise<GitHubClient> => {
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
    opts as GitHubCredentialResolverOptions
  );
  switch (credential.kind) {
    case 'gh-cli': {
      if (credential.account !== undefined) {
        const token = resolveGhAccountToken(
          credential.host,
          credential.account,
          deps.spawn
        );
        return constructGitHubClient('token', credential.host, token, deps);
      }
      return constructGitHubClient('gh-cli', host, undefined, deps);
    }
    case 'env':
      return constructGitHubClient(
        'token',
        host,
        credential.credential.token,
        deps
      );
    case 'stored':
      return constructGitHubClient('token', host, credential.token, deps);
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
};

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

  static {
    constructGitHubClient = (mode, host, token, deps) =>
      new GitHubClient(mode, host, token, deps);
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
    opts: GitHubClientCreateOptions = {}
  ): Promise<GitHubClient> {
    return createGitHubClient(opts);
  }

  // ===========================================================================
  // Transport Layer
  // ===========================================================================

  private async apiCall<T>(
    method: string,
    endpoint: string,
    body?: unknown,
    signal?: AbortSignal
  ): Promise<T> {
    if (this.mode === 'gh-cli') {
      signal?.throwIfAborted();
      const result = this.ghApiCall<T>(method, endpoint, body);
      signal?.throwIfAborted();
      return result;
    }
    return this.fetchApiCall<T>(method, endpoint, body, signal);
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

    const stdout = decodeSpawnStdout(result.stdout).trim();
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

    const stdout = decodeSpawnStdout(result.stdout).trim();
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
    body?: unknown,
    signal?: AbortSignal
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
        signal,
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
  private async fetchApiCallPaginated<T>(
    endpoint: string,
    signal?: AbortSignal
  ): Promise<T[]> {
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
        signal,
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
    number: number,
    signal?: AbortSignal
  ): Promise<GitHubPullRequest> {
    return this.apiCall<GitHubPullRequest>(
      'GET',
      `/repos/${owner}/${repo}/pulls/${number}`,
      undefined,
      signal
    );
  }

  async listPullRequests(
    owner: string,
    repo: string,
    options?: GitHubListPROptions,
    signal?: AbortSignal
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
      return this.apiCall<GitHubPullRequest[]>(
        'GET',
        endpoint,
        undefined,
        signal
      );
    }

    if (this.mode === 'gh-cli') {
      signal?.throwIfAborted();
      return this.ghApiCallPaginated<GitHubPullRequest>(endpoint);
    }
    return this.fetchApiCallPaginated<GitHubPullRequest>(endpoint, signal);
  }

  async createPullRequest(
    owner: string,
    repo: string,
    head: string,
    base: string,
    title: string,
    body?: string,
    options?: { draft?: boolean },
    signal?: AbortSignal
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
      },
      signal
    );
  }

  async updatePullRequest(
    owner: string,
    repo: string,
    number: number,
    updates: GitHubPRUpdateOptions,
    signal?: AbortSignal
  ): Promise<GitHubPullRequest> {
    return this.apiCall<GitHubPullRequest>(
      'PATCH',
      `/repos/${owner}/${repo}/pulls/${number}`,
      updates,
      signal
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
    errorPrefix: string,
    signal?: AbortSignal
  ): Promise<void> {
    if (this.mode === 'gh-cli') {
      signal?.throwIfAborted();
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
      signal?.throwIfAborted();
      if (result.exitCode !== 0) {
        throw new Error(`${errorPrefix}: ${result.stderr.toString().trim()}`);
      }
      // Check for GraphQL-level errors in stdout
      const stdout = decodeSpawnStdout(result.stdout).trim();
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
          signal,
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
    number: number,
    signal?: AbortSignal
  ): Promise<void> {
    const pr = await this.getPullRequest(owner, repo, number, signal);
    await this.graphqlMutation(
      `mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { number } } }`,
      { id: pr.node_id },
      'Failed to publish draft PR',
      signal
    );
  }

  /**
   * Convert a PR to draft.
   * Requires GraphQL since the REST API doesn't support this.
   */
  async convertToDraft(
    owner: string,
    repo: string,
    number: number,
    signal?: AbortSignal
  ): Promise<void> {
    const pr = await this.getPullRequest(owner, repo, number, signal);
    await this.graphqlMutation(
      `mutation($id: ID!) { convertPullRequestToDraft(input: { pullRequestId: $id }) { pullRequest { number } } }`,
      { id: pr.node_id },
      'Failed to convert PR to draft',
      signal
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
    number: number,
    signal?: AbortSignal
  ): Promise<GitHubIssueComment[]> {
    const endpoint = `/repos/${owner}/${repo}/issues/${number}/comments`;
    if (this.mode === 'gh-cli') {
      signal?.throwIfAborted();
      return this.ghApiCallPaginated<GitHubIssueComment>(endpoint);
    }
    return this.fetchApiCallPaginated<GitHubIssueComment>(endpoint, signal);
  }

  /**
   * Get review comments (code-level comments on the diff)
   */
  async getReviewComments(
    owner: string,
    repo: string,
    number: number,
    signal?: AbortSignal
  ): Promise<GitHubReviewComment[]> {
    const endpoint = `/repos/${owner}/${repo}/pulls/${number}/comments`;
    if (this.mode === 'gh-cli') {
      signal?.throwIfAborted();
      return this.ghApiCallPaginated<GitHubReviewComment>(endpoint);
    }
    return this.fetchApiCallPaginated<GitHubReviewComment>(endpoint, signal);
  }

  /**
   * Create an issue comment (general PR discussion)
   */
  async createIssueComment(
    owner: string,
    repo: string,
    number: number,
    body: string,
    signal?: AbortSignal
  ): Promise<GitHubIssueComment> {
    return this.apiCall<GitHubIssueComment>(
      'POST',
      `/repos/${owner}/${repo}/issues/${number}/comments`,
      { body },
      signal
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
    options: GitHubCreateReviewCommentOptions,
    signal?: AbortSignal
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
      },
      signal
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
    body: string,
    signal?: AbortSignal
  ): Promise<GitHubReviewComment> {
    return this.apiCall<GitHubReviewComment>(
      'POST',
      `/repos/${owner}/${repo}/pulls/${number}/comments/${commentId}/replies`,
      { body },
      signal
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
    number: number,
    signal?: AbortSignal
  ): Promise<GitHubPRFile[]> {
    const endpoint = `/repos/${owner}/${repo}/pulls/${number}/files`;
    if (this.mode === 'gh-cli') {
      signal?.throwIfAborted();
      return this.ghApiCallPaginated<GitHubPRFile>(endpoint);
    }
    return this.fetchApiCallPaginated<GitHubPRFile>(endpoint, signal);
  }

  // ===========================================================================
  // Label Operations
  // ===========================================================================

  async addLabels(
    owner: string,
    repo: string,
    number: number,
    labels: string[],
    signal?: AbortSignal
  ): Promise<GitHubLabel[]> {
    return this.apiCall<GitHubLabel[]>(
      'POST',
      `/repos/${owner}/${repo}/issues/${number}/labels`,
      { labels },
      signal
    );
  }

  async removeLabel(
    owner: string,
    repo: string,
    number: number,
    label: string,
    signal?: AbortSignal
  ): Promise<void> {
    await this.apiCall<void>(
      'DELETE',
      `/repos/${owner}/${repo}/issues/${number}/labels/${encodeURIComponent(label)}`,
      undefined,
      signal
    );
  }
}
