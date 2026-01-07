import type { GitRemoteInfo, AzureDevOpsPullRequest } from './types.js';
import { spawnSync } from 'bun';
import { AzureDevOpsClient } from './azure-devops-client.js';
import { loadAzureDevOpsConfig } from './config.js';

/**
 * Parse Azure DevOps git remote URL to extract org, project, and repo
 * Supports both SSH and HTTPS formats:
 * - SSH: git@ssh.dev.azure.com:v3/{org}/{project}/{repo}
 * - HTTPS: https://dev.azure.com/{org}/{project}/_git/{repo}
 */
export function parseGitRemote(remoteUrl: string): GitRemoteInfo | null {
  // SSH format: git@ssh.dev.azure.com:v3/acme/MyProject/MyRepo
  const sshMatch = remoteUrl.match(
    /git@ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/(.+)/
  );
  if (sshMatch) {
    return {
      org: sshMatch[1]!,
      project: sshMatch[2]!,
      repo: sshMatch[3]!.replace(/\.git$/, ''),
    };
  }

  // HTTPS format: https://dev.azure.com/acme/MyProject/_git/MyRepo
  const httpsMatch = remoteUrl.match(
    /https:\/\/dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/(.+)/
  );
  if (httpsMatch) {
    return {
      org: httpsMatch[1]!,
      project: httpsMatch[2]!,
      repo: httpsMatch[3]!.replace(/\.git$/, ''),
    };
  }

  return null;
}

/**
 * Get git remote URL from current directory
 * Returns null if not in a git repository or no remote configured
 */
export function getGitRemoteUrl(): string | null {
  try {
    const result = spawnSync(['git', 'config', '--get', 'remote.origin.url']);

    if (result.exitCode === 0) {
      return result.stdout.toString().trim();
    }

    return null;
  } catch {
    return null;
  }
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
  const match = url.match(
    /https:\/\/dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+)\/pullrequest\/(\d+)/
  );

  if (!match) {
    return null;
  }

  return {
    org: match[1]!,
    project: match[2]!,
    repo: match[3]!,
    prId: parseInt(match[4]!, 10),
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

/**
 * Get the current git branch name
 * Returns null if not in a git repository, in detached HEAD state, or on error
 */
export function getCurrentBranch(): string | null {
  try {
    const result = spawnSync(['git', 'rev-parse', '--abbrev-ref', 'HEAD']);
    if (result.exitCode === 0) {
      const branch = result.stdout.toString().trim();
      return branch === 'HEAD' ? null : branch;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Result of findPRByCurrentBranch
 */
export interface FindPRResult {
  success: boolean;
  pr?: AzureDevOpsPullRequest;
  error?: string;
  /** The branch name that was searched (available on both success and failure) */
  branch?: string;
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
    const config = loadAzureDevOpsConfig();
    const client = new AzureDevOpsClient(config);

    // Query for PRs with this source branch
    const response = await client.listPullRequests(project, repo, {
      sourceRefName,
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
