import type { GitRemoteInfo } from './types.js';
import { spawnSync } from 'bun';

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
  } catch (error) {
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
