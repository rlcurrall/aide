/**
 * GitHub Utilities
 *
 * This module provides GitHub-specific helper functions for working with
 * GitHub repositories, pull requests, and URLs.
 *
 * For generic git utilities, see git-utils.ts
 * For Azure DevOps-specific utilities, see ado-utils.ts
 */

import type { GitHubRemoteInfo, GitHubPullRequest } from './github-types.js';
import type { FindPRResult } from './ado-utils.js';
import { GitHubClient } from './github-client.js';
import { regex } from 'arkregex';
import { getCurrentBranch, getGitRemoteUrl } from './git-utils.js';

// ============================================================================
// GitHub URL Helpers
// ============================================================================

/**
 * Default GitHub host when none is detected.
 */
export const DEFAULT_GITHUB_HOST = 'github.com';

/**
 * Normalize a raw host from a git remote or PR URL to a canonical GitHub web
 * host, or return null if it isn't a supported GitHub host.
 *
 * Supported hosts:
 * - `github.com` (public GitHub, also via `ssh.github.com`)
 * - `*.ghe.com` (GitHub Enterprise Cloud with data residency)
 *
 * Self-hosted GitHub Enterprise Server (`/api/v3` style hosts) is not handled
 * here since its API URL scheme differs.
 */
export function normalizeGitHubHost(rawHost: string): string | null {
  // `ssh.github.com` (port 443 SSH) and `ssh.{sub}.ghe.com` map to their
  // web/API host without the ssh. prefix.
  const host = rawHost.toLowerCase().replace(/^ssh\./, '');
  if (host === 'github.com') return host;
  if (regex('^[a-z0-9][a-z0-9-]*\\.ghe\\.com$').exec(host)) return host;
  return null;
}

/**
 * Derive the REST API base URL for a GitHub host.
 * - github.com -> https://api.github.com
 * - acme.ghe.com -> https://api.acme.ghe.com
 */
export function githubApiBase(host: string): string {
  return `https://api.${host}`;
}

/**
 * Build the PR URL for GitHub
 */
export function buildGitHubPrUrl(
  owner: string,
  repo: string,
  number: number,
  host: string = DEFAULT_GITHUB_HOST
): string {
  return `https://${host}/${owner}/${repo}/pull/${number}`;
}

/**
 * Parse GitHub git remote URL to extract owner, repo, and host.
 * Supports both SSH and HTTPS formats on github.com and *.ghe.com hosts:
 * - SSH: {user}@{host}:{owner}/{repo}.git
 * - HTTPS: https://{host}/{owner}/{repo}.git
 *
 * The SSH user is not assumed to be `git` — GHE Cloud orgs commonly use a
 * custom SSH user (e.g. `acme@acme.ghe.com:...`), so any user is accepted.
 */
export function parseGitHubRemote(remoteUrl: string): GitHubRemoteInfo | null {
  // SSH format: {user}@{host}:owner/repo.git  (user defaults to git but may vary)
  const sshMatch = regex(
    '^(?:[^@]+@)?(?<host>[^:/]+):(?<owner>[^/@:]+)/(?<repo>.+)$'
  ).exec(remoteUrl)?.groups;
  if (sshMatch) {
    const host = normalizeGitHubHost(sshMatch.host);
    if (host) {
      return {
        owner: sshMatch.owner,
        repo: sshMatch.repo.replace(/\.git$/, ''),
        host,
      };
    }
  }

  // HTTPS format: https://{host}/owner/repo.git
  const httpsMatch = regex(
    '^https://(?<host>[^/]+)/(?<owner>[^/]+)/(?<repo>[^/]+?)(?:\\.git)?$'
  ).exec(remoteUrl)?.groups;
  if (httpsMatch) {
    const host = normalizeGitHubHost(httpsMatch.host);
    if (host) {
      return {
        owner: httpsMatch.owner,
        repo: httpsMatch.repo,
        host,
      };
    }
  }

  return null;
}

/**
 * Auto-discover GitHub repo info from git remote.
 * Returns null if not in a git repository or remote is not GitHub.
 */
export function discoverGitHubRepoInfo(): GitHubRemoteInfo | null {
  const remoteUrl = getGitRemoteUrl();
  if (!remoteUrl) {
    return null;
  }
  return parseGitHubRemote(remoteUrl);
}

/**
 * Parse GitHub PR URL to extract host, owner, repo, and PR number.
 * Format: https://{host}/{owner}/{repo}/pull/{number}
 * where {host} is github.com or a *.ghe.com host.
 */
export function parseGitHubPRUrl(url: string): {
  owner: string;
  repo: string;
  number: number;
  host: string;
} | null {
  let normalized = url;
  try {
    const parsed = new URL(url);
    normalized = `${parsed.origin}${parsed.pathname}`;
  } catch {
    normalized = url.split(/[?#]/)[0] ?? url;
  }

  const match = regex(
    '^https://(?<host>[^/]+)/(?<owner>[^/]+)/(?<repo>[^/]+)/pull/(?<number>\\d+)$'
  ).exec(normalized)?.groups;

  if (!match) {
    return null;
  }

  const host = normalizeGitHubHost(match.host);
  if (!host) {
    return null;
  }

  return {
    owner: match.owner,
    repo: match.repo,
    number: parseInt(match.number, 10),
    host,
  };
}

// ============================================================================
// PR Discovery Helpers
// ============================================================================

/**
 * Find a pull request by the current git branch.
 * Queries GitHub for PRs matching the current branch as head.
 * If multiple PRs found, picks the open one, then most recent.
 */
export async function findGitHubPRByCurrentBranch(
  client: GitHubClient,
  owner: string,
  repo: string
): Promise<FindPRResult> {
  const branch = getCurrentBranch();
  if (!branch) {
    return {
      success: false,
      error:
        'Could not detect current git branch. Are you in a git repository? (Detached HEAD state is not supported)',
    };
  }

  try {
    const prs = await client.listPullRequests(owner, repo, {
      head: `${owner}:${branch}`,
      state: 'all',
    });

    if (prs.length === 0) {
      return {
        success: false,
        branch,
        error: `No pull request found for branch '${branch}'.\n\nTo create a PR, push your branch and run:\n  aide pr create --title "Your PR title"`,
      };
    }

    if (prs.length === 1) {
      return {
        success: true,
        branch,
        githubPr: prs[0],
      };
    }

    // Multiple PRs - prefer open ones
    const openPRs = prs.filter((pr) => pr.state === 'open');

    if (openPRs.length === 1) {
      return {
        success: true,
        branch,
        githubPr: openPRs[0],
      };
    }

    // Still multiple (or zero open) - pick most recent
    const candidates = openPRs.length > 0 ? openPRs : prs;
    const sorted = candidates.sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );

    const mostRecent = sorted[0];
    if (!mostRecent) {
      return {
        success: false,
        branch,
        error: `No pull request found for branch '${branch}'.`,
      };
    }

    return {
      success: true,
      branch,
      githubPr: mostRecent,
    };
  } catch (error) {
    return {
      success: false,
      branch,
      error: `Failed to query PRs: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Map an ADO-style status value to a GitHub display status.
 * GitHub uses state (open/closed) + draft + merged booleans.
 */
export function getGitHubPRStatus(pr: GitHubPullRequest): string {
  if (pr.merged) return 'completed';
  if (pr.state === 'closed') return 'abandoned';
  if (pr.draft) return 'draft';
  return 'active';
}

/**
 * Map an ADO-style status filter to GitHub API state parameter.
 */
export function mapStatusToGitHubState(
  status: string | undefined
): 'open' | 'closed' | 'all' {
  switch (status) {
    case 'active':
      return 'open';
    case 'completed':
    case 'abandoned':
      return 'closed';
    case 'all':
      return 'all';
    default:
      return 'open';
  }
}
