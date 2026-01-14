import type { GitRemoteInfo, AzureDevOpsPullRequest } from './types.js';
import { spawnSync } from 'bun';
import { AzureDevOpsClient } from './azure-devops-client.js';
import { loadAzureDevOpsConfig } from './config.js';

// ============================================================================
// Git Ref Helpers
// ============================================================================

/**
 * Extract branch name from ref (e.g., "refs/heads/main" -> "main")
 */
export function extractBranchName(refName: string | undefined): string {
  if (!refName) return 'unknown';
  return refName.replace(/^refs\/heads\//, '');
}

/**
 * Ensure branch name has refs/heads/ prefix
 */
export function ensureRefPrefix(branch: string): string {
  if (branch.startsWith('refs/heads/')) {
    return branch;
  }
  return `refs/heads/${branch}`;
}

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
 * Error class for missing repository context
 */
export class MissingRepoContextError extends Error {
  constructor(message: string = 'Could not determine project and repository') {
    super(message);
    this.name = 'MissingRepoContextError';
  }
}

/**
 * Options for resolving repository context
 */
export interface ResolveRepoContextOptions {
  /** If true, skip printing auto-discovery message */
  silent?: boolean;
  /** Output format - if 'json', auto-discovery messages are suppressed */
  format?: 'text' | 'json' | 'markdown';
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
}

/**
 * Print the standard error message for missing project/repository
 * @param extraHint Optional additional hint to append (e.g., "Provide a PR ID or full PR URL")
 */
export function printMissingRepoError(extraHint?: string): void {
  console.error('Error: Could not determine project and repository.');
  console.error('');
  console.error('Either:');
  console.error(
    '  1. Run this command from within a git repository with a supported remote (Azure DevOps)'
  );
  console.error('  2. Specify --project and --repo flags explicitly');
  if (extraHint) {
    console.error(`  3. ${extraHint}`);
  }
}

/**
 * Resolve repository context from provided values or auto-discovery
 *
 * This function:
 * 1. If project and repo are already provided, returns them
 * 2. Otherwise, attempts to auto-discover from git remote
 * 3. Merges discovered values with provided values
 * 4. Optionally logs auto-discovery message (unless silent or format is json)
 * 5. Throws MissingRepoContextError if project/repo still missing
 *
 * @param project - Project name (may be undefined)
 * @param repo - Repository name (may be undefined)
 * @param options - Options for resolution behavior
 * @returns Resolved context with project, repo, and optionally org
 * @throws MissingRepoContextError if context cannot be resolved
 */
export function resolveRepoContext(
  project: string | undefined,
  repo: string | undefined,
  options?: ResolveRepoContextOptions
): ResolvedRepoContext {
  const silent = options?.silent || options?.format === 'json';
  let repoInfo: GitRemoteInfo | null = null;

  // Auto-discover from git remote if not fully specified
  if (!project || !repo) {
    repoInfo = discoverRepoInfo();
    if (repoInfo) {
      project = project || repoInfo.project;
      repo = repo || repoInfo.repo;
      if (!silent) {
        console.log(
          `Auto-discovered: ${repoInfo.org}/${repoInfo.project}/${repoInfo.repo}`
        );
        console.log('');
      }
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
    const config = loadAzureDevOpsConfig();
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

// ============================================================================
// Git Diff Helpers
// ============================================================================

/**
 * Check if current directory is inside a git repository
 * Returns true if inside a git work tree, false otherwise
 */
export function isGitRepository(): boolean {
  try {
    const result = spawnSync(['git', 'rev-parse', '--is-inside-work-tree']);
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Check if a remote ref exists locally
 * Returns true if the ref exists, false if not found or on error
 */
export function remoteRefExists(ref: string): boolean {
  try {
    const result = spawnSync(['git', 'rev-parse', '--verify', ref]);
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Options for git diff
 */
export interface GitDiffOptions {
  stat?: boolean;
  nameOnly?: boolean;
  file?: string;
}

/**
 * Result of a git diff operation
 */
export interface GitDiffResult {
  success: boolean;
  output?: string;
  error?: string;
}

/**
 * Get git diff output between two refs
 */
export function getGitDiff(
  baseRef: string,
  headRef: string,
  options?: GitDiffOptions
): GitDiffResult {
  try {
    const args = ['diff', `${baseRef}...${headRef}`];

    if (options?.stat) args.push('--stat');
    if (options?.nameOnly) args.push('--name-only');
    if (options?.file) args.push('--', options.file);

    const result = spawnSync(['git', ...args]);

    if (result.exitCode === 0) {
      return { success: true, output: result.stdout.toString() };
    }
    return { success: false, error: result.stderr.toString() };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Parsed file from git diff --stat
 */
export interface GitStatFile {
  path: string;
  additions: number;
  deletions: number;
}

/**
 * Summary of git diff --stat
 */
export interface GitStatSummary {
  filesChanged: number;
  additions: number;
  deletions: number;
}

/**
 * Result of parsing git diff --stat output
 */
export interface GitStatResult {
  files: GitStatFile[];
  summary: GitStatSummary;
}

/**
 * Parse git diff --stat output into structured data
 *
 * Example input:
 *  src/foo.ts | 15 ++++++++-------
 *  src/bar.ts |  3 +++
 *  2 files changed, 11 insertions(+), 7 deletions(-)
 */
export function parseGitStat(output: string): GitStatResult {
  const lines = output.trim().split('\n');
  const files: GitStatFile[] = [];
  let summary: GitStatSummary = { filesChanged: 0, additions: 0, deletions: 0 };

  for (const line of lines) {
    // Match file line: " path | count ++++----"
    const fileMatch = line.match(/^\s*(.+?)\s*\|\s*(\d+)\s*([+-]*)/);
    if (fileMatch && fileMatch[1] && fileMatch[2]) {
      const path = fileMatch[1].trim();
      const changeIndicators = fileMatch[3] || '';
      const additions = (changeIndicators.match(/\+/g) || []).length;
      const deletions = (changeIndicators.match(/-/g) || []).length;
      files.push({ path, additions, deletions });
      continue;
    }

    // Match binary file line: " path | Bin 0 -> 1234 bytes"
    const binaryMatch = line.match(/^\s*(.+?)\s*\|\s*Bin/);
    if (binaryMatch && binaryMatch[1]) {
      files.push({ path: binaryMatch[1].trim(), additions: 0, deletions: 0 });
      continue;
    }

    // Match summary line: "N files changed, X insertions(+), Y deletions(-)"
    const summaryMatch = line.match(
      /(\d+)\s+files?\s+changed(?:,\s*(\d+)\s+insertions?\(\+\))?(?:,\s*(\d+)\s+deletions?\(-\))?/
    );
    if (summaryMatch && summaryMatch[1]) {
      summary = {
        filesChanged: parseInt(summaryMatch[1], 10),
        additions: summaryMatch[2] ? parseInt(summaryMatch[2], 10) : 0,
        deletions: summaryMatch[3] ? parseInt(summaryMatch[3], 10) : 0,
      };
    }
  }

  return { files, summary };
}
