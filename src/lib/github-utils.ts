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
import { getGhKnownHosts, isKnownGitHubHost, githubWebBase } from './github-host.js';

// ============================================================================
// GitHub URL Helpers
// ============================================================================

/**
 * Build the PR URL for a GitHub host.
 */
export function buildGitHubPrUrl(
  host: string,
  owner: string,
  repo: string,
  number: number
): string {
  return `${githubWebBase(host)}/${owner}/${repo}/pull/${number}`;
}

/**
 * Parse a GitHub git remote URL to extract host, owner, and repo.
 * Accepts SSH (git@<host>:owner/repo.git) and HTTPS
 * (https://<host>/owner/repo(.git)) forms. Returns null unless the host is a
 * known GitHub host (github.com plus any gh-authenticated enterprise hosts).
 *
 * @param knownHosts Optional pre-resolved host set (defaults to gh's known
 *   hosts). Pass it to avoid repeated `gh auth status` calls.
 */
export function parseGitHubRemote(
  remoteUrl: string,
  knownHosts?: string[]
): GitHubRemoteInfo | null {
  const hosts = knownHosts ?? getGhKnownHosts();

  // SSH (scp-like): [user@]<host>:owner/repo(.git). The user is usually `git`
  // but enterprise setups use other users (e.g. `vantaca@`), so allow any.
  // The isKnownGitHubHost gate below keeps non-GitHub hosts out.
  const ssh = regex(
    '^(?:[^@]+@)?(?<host>[^:/]+):(?<owner>[^/]+)/(?<repo>.+)$'
  ).exec(remoteUrl)?.groups;
  if (ssh && isKnownGitHubHost(ssh.host, hosts)) {
    return {
      host: ssh.host.toLowerCase(),
      owner: ssh.owner,
      repo: ssh.repo.replace(/\.git$/, ''),
    };
  }

  // HTTPS: https://<host>/owner/repo(.git)
  const https = regex(
    '^https://(?<host>[^/]+)/(?<owner>[^/]+)/(?<repo>[^/]+?)(?:\\.git)?$'
  ).exec(remoteUrl)?.groups;
  if (https && isKnownGitHubHost(https.host, hosts)) {
    return {
      host: https.host.toLowerCase(),
      owner: https.owner,
      repo: https.repo,
    };
  }

  return null;
}

/**
 * Auto-discover GitHub repo info from git remote.
 * Returns null if not in a git repository or remote is not a known GitHub host.
 */
export function discoverGitHubRepoInfo(): GitHubRemoteInfo | null {
  const remoteUrl = getGitRemoteUrl();
  if (!remoteUrl) {
    return null;
  }
  return parseGitHubRemote(remoteUrl);
}

/**
 * Parse a GitHub PR URL to extract host, owner, repo, and PR number.
 * Format: https://<host>/{owner}/{repo}/pull/{number}. Returns null unless the
 * host is a known GitHub host.
 */
export function parseGitHubPRUrl(
  url: string,
  knownHosts?: string[]
): { host: string; owner: string; repo: string; number: number } | null {
  const hosts = knownHosts ?? getGhKnownHosts();

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

  if (!match || !isKnownGitHubHost(match.host, hosts)) {
    return null;
  }

  return {
    host: match.host.toLowerCase(),
    owner: match.owner,
    repo: match.repo,
    number: parseInt(match.number, 10),
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
