/**
 * Generic Git Utilities
 *
 * This module provides platform-agnostic git helper functions that work with
 * any git repository regardless of hosting provider (GitHub, Azure DevOps, GitLab, etc.)
 *
 * For provider-specific utilities, see:
 * - ado-utils.ts for Azure DevOps-specific functions
 */

import { spawnSync } from 'bun';
import { regex } from 'arkregex';

// ============================================================================
// Git Repository Helpers
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

// ============================================================================
// Git Branch/Ref Helpers
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

// ============================================================================
// Git Fetch Helpers
// ============================================================================

/**
 * Result of a git fetch operation
 */
export interface GitFetchResult {
  success: boolean;
  error?: string;
}

/**
 * Fetch a branch from the remote
 * @param branch - Branch name (without refs/heads/ prefix)
 * @param remote - Remote name (default: origin)
 */
export function fetchBranch(branch: string, remote = 'origin'): GitFetchResult {
  try {
    const result = spawnSync(['git', 'fetch', remote, branch]);
    if (result.exitCode === 0) {
      return { success: true };
    }
    return { success: false, error: result.stderr.toString().trim() };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Result of fetching missing branches
 */
export interface FetchMissingBranchesResult {
  /** Whether both branches are now available locally */
  available: boolean;
  /** Branches that were fetched */
  fetched: string[];
  /** Branch that is missing (if available is false) */
  missingBranch?: string;
  /** Error message if fetch failed */
  error?: string;
}

/**
 * Fetch missing source and target branches from remote if not available locally
 * @param sourceBranch - Source branch name (without refs/heads/ prefix)
 * @param targetBranch - Target branch name (without refs/heads/ prefix)
 * @param options - Whether to actually fetch missing branches (if false, just checks availability)
 */
export function fetchMissingBranches(
  sourceBranch: string,
  targetBranch: string,
  options: { fetch: boolean } = { fetch: true }
): FetchMissingBranchesResult {
  const sourceRef = `origin/${sourceBranch}`;
  const targetRef = `origin/${targetBranch}`;
  const fetched: string[] = [];

  // Check/fetch source branch
  if (!remoteRefExists(sourceRef)) {
    if (options.fetch) {
      const result = fetchBranch(sourceBranch);
      if (result.success) {
        fetched.push(sourceBranch);
      } else {
        return {
          available: false,
          fetched,
          missingBranch: sourceBranch,
          error: result.error,
        };
      }
    } else {
      return {
        available: false,
        fetched,
        missingBranch: sourceBranch,
      };
    }
  }

  // Check/fetch target branch
  if (!remoteRefExists(targetRef)) {
    if (options.fetch) {
      const result = fetchBranch(targetBranch);
      if (result.success) {
        fetched.push(targetBranch);
      } else {
        return {
          available: false,
          fetched,
          missingBranch: targetBranch,
          error: result.error,
        };
      }
    } else {
      return {
        available: false,
        fetched,
        missingBranch: targetBranch,
      };
    }
  }

  return { available: true, fetched };
}

// ============================================================================
// Git Diff Helpers
// ============================================================================

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
    const fileMatch = regex(
      '^\\s*(?<path>.+?)\\s*\\|\\s*(?<count>\\d+)\\s*(?<indicators>[+-]*)'
    ).exec(line)?.groups;
    if (fileMatch && fileMatch.path && fileMatch.count) {
      const path = fileMatch.path.trim();
      const changeIndicators = fileMatch.indicators || '';
      const additions = (changeIndicators.match(/\+/g) || []).length;
      const deletions = (changeIndicators.match(/-/g) || []).length;
      files.push({ path, additions, deletions });
      continue;
    }

    // Match binary file line: " path | Bin 0 -> 1234 bytes"
    const binaryMatch = regex('^\\s*(?<path>.+?)\\s*\\|\\s*Bin').exec(
      line
    )?.groups;
    if (binaryMatch && binaryMatch.path) {
      files.push({ path: binaryMatch.path.trim(), additions: 0, deletions: 0 });
      continue;
    }

    // Match summary line: "N files changed, X insertions(+), Y deletions(-)"
    const summaryMatch = regex(
      '(?<filesChanged>\\d+)\\s+files?\\s+changed(?:,\\s*(?<additions>\\d+)\\s+insertions?\\(\\+\\))?(?:,\\s*(?<deletions>\\d+)\\s+deletions?\\(-\\))?'
    ).exec(line)?.groups;
    if (summaryMatch && summaryMatch.filesChanged) {
      summary = {
        filesChanged: parseInt(summaryMatch.filesChanged, 10),
        additions: summaryMatch.additions
          ? parseInt(summaryMatch.additions, 10)
          : 0,
        deletions: summaryMatch.deletions
          ? parseInt(summaryMatch.deletions, 10)
          : 0,
      };
    }
  }

  return { files, summary };
}
