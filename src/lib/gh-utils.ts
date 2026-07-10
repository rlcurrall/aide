/**
 * Helpers for the GitHub CLI (`gh`).
 *
 * Centralizes the "is gh authenticated for this host?" probe so login,
 * whoami, and the GitHub client all use one consistent check. No caching:
 * `gh auth status`
 * is fast and caching across a process's lifetime masks `gh auth login` /
 * `gh auth logout` that a user runs mid-session.
 */

import { spawnSync } from 'bun';
import {
  canonicalizeGitHubAuthAccount,
  canonicalizeGitHubAuthHost,
  type CanonicalGitHubAuthRequest,
  DEFAULT_GITHUB_HOST,
  githubCliEnvironment,
  type GitHubAuthEnvironment,
} from './github-auth.js';

type SpawnSyncFn = typeof spawnSync;

export type GitHubCliAuthProbe =
  | {
      readonly kind: 'authenticated';
      readonly host: string;
      readonly account?: string;
    }
  | {
      readonly kind: 'account-mismatch';
      readonly code: 'account-mismatch';
      readonly host: string;
      readonly requestedAccount: string;
      readonly activeAccount: string;
      readonly reason: string;
    }
  | {
      readonly kind: 'unavailable';
      readonly host: string;
      readonly reason?: string;
    };

/** Structured seam for probing one already-canonicalized auth request. */
export type GitHubAuthProbe = (
  request: CanonicalGitHubAuthRequest
) => GitHubCliAuthProbe;

interface GhAuthStatusAccount {
  readonly active: boolean;
  readonly error?: string;
  readonly host: string;
  readonly login: string;
  readonly state: string;
}

function structuredActiveAccount(
  output: string,
  host: string
): GhAuthStatusAccount | null {
  let json: unknown;
  try {
    json = JSON.parse(output);
  } catch {
    return null;
  }
  if (typeof json !== 'object' || json === null || !('hosts' in json)) {
    return null;
  }
  const hosts = json.hosts;
  if (typeof hosts !== 'object' || hosts === null || !(host in hosts)) {
    return null;
  }
  const accounts = (hosts as Record<string, unknown>)[host];
  if (!Array.isArray(accounts)) return null;
  const activeAccounts = accounts.filter(
    (account): account is Record<string, unknown> =>
      typeof account === 'object' && account !== null && account.active === true
  );
  if (activeAccounts.length !== 1) return null;

  const account = activeAccounts[0]!;
  if (
    ('error' in account && typeof account.error !== 'string') ||
    typeof account.host !== 'string' ||
    typeof account.login !== 'string' ||
    typeof account.state !== 'string'
  ) {
    return null;
  }
  return account as unknown as GhAuthStatusAccount;
}

/**
 * Probe one resolved request. Account-qualified requests use only gh 2.96's
 * documented JSON `hosts` contract; unsupported or malformed output fails
 * closed and human-readable output is never parsed.
 */
export function probeGhCliAuth(
  request: Pick<CanonicalGitHubAuthRequest, 'host' | 'account'>,
  spawn: SpawnSyncFn = spawnSync,
  env: GitHubAuthEnvironment = Bun.env
): GitHubCliAuthProbe {
  const host = canonicalizeGitHubAuthHost(request.host);
  if (host === null) return { kind: 'unavailable', host: request.host };

  if (request.account === undefined) {
    return isGhCliAuthenticated(host, spawn, env)
      ? { kind: 'authenticated', host }
      : { kind: 'unavailable', host };
  }

  try {
    const result = spawn(
      [
        'gh',
        'auth',
        'status',
        '--active',
        '--hostname',
        host,
        '--json',
        'hosts',
      ],
      {
        stdout: 'pipe',
        stderr: 'ignore',
        env: githubCliEnvironment(env),
      }
    );
    if (result.exitCode !== 0) return { kind: 'unavailable', host };

    const active = structuredActiveAccount(result.stdout.toString(), host);
    if (
      active === null ||
      active.host !== host ||
      active.state !== 'success' ||
      (active.error !== undefined && active.error.length > 0)
    ) {
      return {
        kind: 'unavailable',
        host,
        reason:
          'gh did not return a healthy active account through its structured auth status contract.',
      };
    }

    const activeAccount = canonicalizeGitHubAuthAccount(active.login);
    if (activeAccount === null) {
      return { kind: 'unavailable', host };
    }
    if (activeAccount !== request.account) {
      return {
        kind: 'account-mismatch',
        code: 'account-mismatch',
        host,
        requestedAccount: request.account,
        activeAccount,
        reason:
          `Active gh account '${activeAccount}' does not match requested ` +
          `GitHub account '${request.account}' for '${host}'.`,
      };
    }
    return { kind: 'authenticated', host, account: activeAccount };
  } catch {
    return { kind: 'unavailable', host };
  }
}

export function isGhCliAuthenticated(
  requestedHost: string,
  spawn: SpawnSyncFn = spawnSync,
  env: GitHubAuthEnvironment = Bun.env
): boolean {
  const host = canonicalizeGitHubAuthHost(requestedHost);
  if (host === null) return false;

  try {
    const result = spawn(
      ['gh', 'auth', 'status', '--active', '--hostname', host],
      {
        stdout: 'ignore',
        stderr: 'ignore',
        // gh honors token env vars ahead of stored accounts. Strip them so
        // this probe proves that gh itself has auth for this exact host.
        env: githubCliEnvironment(env),
      }
    );
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/** Backward-compatible no-host probe, scoped to github.com. */
export function isGhCliAvailable(spawn: SpawnSyncFn = spawnSync): boolean {
  return isGhCliAuthenticated(DEFAULT_GITHUB_HOST, spawn);
}
