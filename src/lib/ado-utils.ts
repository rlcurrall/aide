/**
 * Azure DevOps Utilities
 *
 * This module provides Azure DevOps-specific helper functions for working with
 * ADO repositories, pull requests, and URLs.
 *
 * For generic git utilities, see git-utils.ts
 */

import type { GitRemoteInfo, AzureDevOpsPullRequest } from './types.js';
import type { GitHubPullRequest } from './github-types.js';
import { AzureDevOpsClient } from './azure-devops-client.js';
import { loadAzureDevOpsConfig } from './config.js';
import { regex } from 'arkregex';
import { getCurrentBranch, getGitRemoteUrl } from './git-utils.js';

// ============================================================================
// Azure DevOps URL Helpers
// ============================================================================

/**
 * Build the PR URL for Azure DevOps
 */
export function buildPrUrl(
  repoInfo: GitRemoteInfo,
  prId: number,
  orgUrl?: string
): string {
  const baseUrl = orgUrl
    ? orgUrl.replace(/\/$/, '')
    : `https://dev.azure.com/${repoInfo.org}`;
  return `${baseUrl}/${encodeURIComponent(repoInfo.project)}/_git/${encodeURIComponent(repoInfo.repo)}/pullrequest/${prId}`;
}

/**
 * Parse Azure DevOps git remote URL to extract org, project, and repo
 * Supports both SSH and HTTPS formats:
 * - SSH: git@ssh.dev.azure.com:v3/{org}/{project}/{repo}
 * - HTTPS: https://dev.azure.com/{org}/{project}/_git/{repo}
 */
export function parseGitRemote(remoteUrl: string): GitRemoteInfo | null {
  // SSH format: git@ssh.dev.azure.com:v3/acme/MyProject/MyRepo
  const sshMatch = regex(
    '^git@ssh\\.dev\\.azure\\.com:v3/(?<org>[^/]+)/(?<project>[^/]+)/(?<repo>.+)$'
  ).exec(remoteUrl)?.groups;
  if (sshMatch) {
    return {
      org: sshMatch.org,
      project: sshMatch.project,
      repo: sshMatch.repo.replace(/\.git$/, ''),
    };
  }

  // HTTPS format: https://company@dev.azure.com/acme/MyProject/_git/MyRepo
  const httpsMatch = regex(
    '^https://\\w+@dev\\.azure\\.com/(?<org>[^/]+)/(?<project>[^/]+)/_git/(?<repo>.+)$'
  ).exec(remoteUrl)?.groups;
  if (httpsMatch) {
    return {
      org: httpsMatch.org,
      project: httpsMatch.project,
      repo: httpsMatch.repo.replace(/\.git$/, ''),
    };
  }

  return null;
}

/**
 * Auto-discover Azure DevOps repo info from git remote
 * Returns null if not in a git repository or remote is not Azure DevOps
 */
export function discoverRepoInfo(): GitRemoteInfo | null {
  const remoteUrl = getGitRemoteUrl();
  if (!remoteUrl) {
    return null;
  }

  return parseGitRemote(remoteUrl);
}

/**
 * Parse Azure DevOps PR URL to extract org, project, repo, and PR ID
 * Format: https://dev.azure.com/{org}/{project}/_git/{repo}/pullrequest/{prId}
 */
export function parsePRUrl(url: string): {
  org: string;
  project: string;
  repo: string;
  prId: number;
} | null {
  let normalized = url;
  try {
    const parsed = new URL(url);
    normalized = `${parsed.origin}${parsed.pathname}`;
  } catch {
    normalized = url.split(/[?#]/)[0] ?? url;
  }

  const match = regex(
    '^https://dev\\.azure\\.com/(?<org>[^/]+)/(?<project>[^/]+)/_git/(?<repo>[^/]+)/pullrequest/(?<prId>\\d+)$'
  ).exec(normalized)?.groups;

  if (!match) {
    return null;
  }

  return {
    org: match.org,
    project: match.project,
    repo: match.repo,
    prId: parseInt(match.prId, 10),
  };
}

/**
 * Validate PR ID format (must be positive integer)
 */
export function validatePRId(prId: string | number): {
  valid: boolean;
  value?: number;
  error?: string;
} {
  const id = typeof prId === 'string' ? parseInt(prId, 10) : prId;

  if (isNaN(id) || id <= 0) {
    return {
      valid: false,
      error: `Invalid PR ID: ${prId}. Must be a positive integer.`,
    };
  }

  return {
    valid: true,
    value: id,
  };
}

// ============================================================================
// Repository Context Helpers
// ============================================================================

/**
 * Result of findPRByCurrentBranch
 */
export interface FindPRResult {
  success: boolean;
  pr?: AzureDevOpsPullRequest;
  githubPr?: GitHubPullRequest;
  error?: string;
  /** The branch name that was searched (available on both success and failure) */
  branch?: string;
}

/**
 * Error class for missing repository context
 */
export class MissingRepoContextError extends Error {
  constructor(message: string = 'Could not determine project and repository') {
    super(message);
    this.name = 'MissingRepoContextError';
  }
}

/**
 * Result of resolving repository context
 */
export interface ResolvedRepoContext {
  project: string;
  repo: string;
  org?: string;
  /** The full repo info if auto-discovered */
  repoInfo?: GitRemoteInfo;
  /** Whether project/repo was auto-discovered from git remote */
  autoDiscovered: boolean;
}

/**
 * Get the standard error message for missing project/repository
 * @param extraHint Optional additional hint to append (e.g., "Provide a PR ID or full PR URL")
 * @returns Formatted error message string
 */
export function getMissingRepoErrorMessage(extraHint?: string): string {
  const lines = [
    'Error: Could not determine project and repository.',
    '',
    'Either:',
    '  1. Run this command from within a git repository with a supported remote (Azure DevOps or GitHub)',
    '  2. Specify --project and --repo flags explicitly',
  ];
  if (extraHint) {
    lines.push(`  3. ${extraHint}`);
  }
  return lines.join('\n');
}

/**
 * Resolve repository context from provided values or auto-discovery
 *
 * This function:
 * 1. If project and repo are already provided, returns them (autoDiscovered: false)
 * 2. Otherwise, attempts to auto-discover from git remote
 * 3. Merges discovered values with provided values
 * 4. Throws MissingRepoContextError if project/repo still missing
 *
 * @param project - Project name (may be undefined)
 * @param repo - Repository name (may be undefined)
 * @returns Resolved context with project, repo, autoDiscovered flag, and optionally org
 * @throws MissingRepoContextError if context cannot be resolved
 */
export function resolveRepoContext(
  project: string | undefined,
  repo: string | undefined
): ResolvedRepoContext {
  let repoInfo: GitRemoteInfo | null = null;
  let autoDiscovered = false;

  // Auto-discover from git remote if not fully specified
  if (!project || !repo) {
    repoInfo = discoverRepoInfo();
    if (repoInfo) {
      project = project || repoInfo.project;
      repo = repo || repoInfo.repo;
      autoDiscovered = true;
    }
  }

  // Validate we have all required info
  if (!project || !repo) {
    throw new MissingRepoContextError();
  }

  return {
    project,
    repo,
    org: repoInfo?.org,
    repoInfo: repoInfo ?? undefined,
    autoDiscovered,
  };
}

/**
 * Find a pull request by the current git branch
 * Queries Azure DevOps for PRs matching the current branch as source
 * If multiple PRs found, filters to active first, then picks most recent
 */
export async function findPRByCurrentBranch(
  project: string,
  repo: string
): Promise<FindPRResult> {
  // Get current branch
  const branch = getCurrentBranch();
  if (!branch) {
    return {
      success: false,
      error:
        'Could not detect current git branch. Are you in a git repository? (Detached HEAD state is not supported)',
    };
  }

  // Format branch as refs/heads/branch-name for Azure DevOps API
  const sourceRefName = `refs/heads/${branch}`;

  try {
    const { config } = await loadAzureDevOpsConfig();
    const client = new AzureDevOpsClient(config);

    // Query for PRs with this source branch - search all statuses to find abandoned PRs too
    const response = await client.listPullRequests(project, repo, {
      sourceRefName,
      status: 'all',
    });

    const prs = response.value;

    if (prs.length === 0) {
      return {
        success: false,
        branch,
        error: `No pull request found for branch '${branch}'.\n\nTo create a PR, push your branch and create one in Azure DevOps, or specify a PR ID directly:\n  aide ado comments <pr-id>`,
      };
    }

    // If only one PR, use it
    if (prs.length === 1) {
      return {
        success: true,
        branch,
        pr: prs[0],
      };
    }

    // Multiple PRs found - filter to active first
    const activePRs = prs.filter((pr) => pr.status === 'active');

    if (activePRs.length === 1) {
      return {
        success: true,
        branch,
        pr: activePRs[0],
      };
    }

    // Still multiple (or zero active) - pick most recent by creationDate
    const candidates = activePRs.length > 0 ? activePRs : prs;
    const sorted = candidates.sort(
      (a, b) =>
        new Date(b.creationDate).getTime() - new Date(a.creationDate).getTime()
    );

    const mostRecent = sorted[0];
    if (!mostRecent) {
      // This should never happen since we checked prs.length > 0 above,
      // but adding explicit check for type safety
      return {
        success: false,
        branch,
        error: `No pull request found for branch '${branch}'.`,
      };
    }

    return {
      success: true,
      branch,
      pr: mostRecent,
    };
  } catch (error) {
    return {
      success: false,
      branch,
      error: `Failed to query PRs: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
