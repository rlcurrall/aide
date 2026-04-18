/**
 * Platform Detection and Context Resolution
 *
 * Detects whether the current repository is hosted on Azure DevOps or GitHub
 * based on the git remote URL, and provides a unified context object for
 * PR commands to use.
 */

import { AzureDevOpsClient } from './azure-devops-client.js';
import { GitHubClient, GitHubAuthError } from './github-client.js';
import {
  parseGitRemote,
  parsePRUrl as parseAdoPRUrl,
  resolveRepoContext as resolveAdoRepoContext,
  findPRByCurrentBranch as findAdoPRByCurrentBranch,
  validatePRId,
  MissingRepoContextError,
  type FindPRResult,
} from './ado-utils.js';
import {
  parseGitHubRemote,
  parseGitHubPRUrl,
  findGitHubPRByCurrentBranch,
} from './github-utils.js';
import { loadAzureDevOpsConfig } from './config.js';
import { getGitRemoteUrl } from './git-utils.js';
import { logProgress, type OutputFormat } from './cli-utils.js';

// ============================================================================
// Platform Types
// ============================================================================

export { GitHubAuthError };

export type Platform = 'azure-devops' | 'github';

export type PlatformContext =
  | {
      platform: 'azure-devops';
      org: string;
      project: string;
      repo: string;
      client: AzureDevOpsClient;
      autoDiscovered: boolean;
    }
  | {
      platform: 'github';
      owner: string;
      repo: string;
      client: GitHubClient;
      autoDiscovered: boolean;
    };

export interface ParsedPRUrl {
  platform: Platform;
  prId: number;
  // ADO-specific
  org?: string;
  project?: string;
  repo?: string;
  // GitHub-specific
  owner?: string;
  ghRepo?: string;
}

// ============================================================================
// Detection Functions
// ============================================================================

/**
 * Detect the hosting platform from a git remote URL.
 * Returns null if the URL doesn't match any supported platform.
 */
export function detectPlatformFromRemote(remoteUrl: string): Platform | null {
  if (parseGitRemote(remoteUrl)) return 'azure-devops';
  if (parseGitHubRemote(remoteUrl)) return 'github';
  return null;
}

/**
 * Resolve platform context from provided values or auto-discovery.
 *
 * For Azure DevOps: uses project/repo flags or auto-discovers from git remote.
 * For GitHub: auto-discovers owner/repo from git remote (project/repo flags ignored).
 *
 * @throws MissingRepoContextError if context cannot be resolved
 */
export async function resolvePlatformContext(
  project?: string,
  repo?: string
): Promise<PlatformContext> {
  const remoteUrl = getGitRemoteUrl();

  // Try GitHub first (since it's the new path)
  if (remoteUrl) {
    const ghInfo = parseGitHubRemote(remoteUrl);
    if (ghInfo) {
      // GitHubClient constructor throws GitHubAuthError if no auth available.
      // Let it propagate - callers handle it like MissingRepoContextError.
      const client = new GitHubClient();
      return {
        platform: 'github',
        owner: ghInfo.owner,
        repo: ghInfo.repo,
        client,
        autoDiscovered: true,
      };
    }
  }

  // Fall back to Azure DevOps
  try {
    const adoContext = resolveAdoRepoContext(project, repo);
    const { config } = await loadAzureDevOpsConfig();
    const client = new AzureDevOpsClient(config);
    return {
      platform: 'azure-devops',
      org: adoContext.org ?? '',
      project: adoContext.project,
      repo: adoContext.repo,
      client,
      autoDiscovered: adoContext.autoDiscovered,
    };
  } catch (error) {
    if (error instanceof MissingRepoContextError) {
      throw new MissingRepoContextError(
        'Could not determine project and repository.\n\n' +
          'Either:\n' +
          '  1. Run this command from within a git repository with a supported remote (Azure DevOps or GitHub)\n' +
          '  2. Specify --project and --repo flags explicitly (Azure DevOps only)'
      );
    }
    throw error;
  }
}

/**
 * Parse a PR URL from any supported platform.
 * Returns null if the URL doesn't match any supported format.
 */
export function parsePRUrlAny(url: string): ParsedPRUrl | null {
  // Try Azure DevOps
  const adoResult = parseAdoPRUrl(url);
  if (adoResult) {
    return {
      platform: 'azure-devops',
      prId: adoResult.prId,
      org: adoResult.org,
      project: adoResult.project,
      repo: adoResult.repo,
    };
  }

  // Try GitHub
  const ghResult = parseGitHubPRUrl(url);
  if (ghResult) {
    return {
      platform: 'github',
      prId: ghResult.number,
      owner: ghResult.owner,
      ghRepo: ghResult.repo,
    };
  }

  return null;
}

/**
 * Find a PR by the current git branch, dispatching to the appropriate platform.
 */
export async function findPRByCurrentBranchAny(
  ctx: PlatformContext
): Promise<FindPRResult> {
  if (ctx.platform === 'github') {
    return findGitHubPRByCurrentBranch(ctx.client, ctx.owner, ctx.repo);
  }
  return findAdoPRByCurrentBranch(ctx.project, ctx.repo);
}

// ============================================================================
// PR ID Resolution Helper
// ============================================================================

export interface ResolvedPR {
  prId: number;
  ctx: PlatformContext;
}

/**
 * Resolve PR ID from --pr flag (URL or number) or auto-detect from current branch.
 * Also rebuilds the platform context if a URL overrides the auto-discovered repo.
 *
 * Handles all error cases and exits on failure.
 */
export async function resolvePRId(
  prArg: string | undefined,
  ctx: PlatformContext,
  format: OutputFormat
): Promise<ResolvedPR> {
  let prId: number | undefined;
  let resolvedCtx = ctx;

  if (prArg) {
    if (prArg.startsWith('http')) {
      const parsed = parsePRUrlAny(prArg);
      if (!parsed) {
        throw new Error(
          `Invalid PR URL: ${prArg}. Expected Azure DevOps or GitHub PR URL format.`
        );
      }
      prId = parsed.prId;

      // URL overrides context
      if (parsed.platform === 'github' && parsed.owner && parsed.ghRepo) {
        resolvedCtx = {
          platform: 'github',
          owner: parsed.owner,
          repo: parsed.ghRepo,
          client: new GitHubClient(),
          autoDiscovered: false,
        };
      } else if (
        parsed.platform === 'azure-devops' &&
        parsed.project &&
        parsed.repo
      ) {
        const { config } = await loadAzureDevOpsConfig();
        resolvedCtx = {
          platform: 'azure-devops',
          org: parsed.org ?? '',
          project: parsed.project,
          repo: parsed.repo,
          client: new AzureDevOpsClient(config),
          autoDiscovered: false,
        };
      }
    } else {
      const validation = validatePRId(prArg);
      if (validation.valid) {
        prId = validation.value;
      } else {
        throw new Error(
          `Could not parse '${prArg}' as a PR ID. Expected a positive number or full PR URL.`
        );
      }
    }
  } else {
    // Auto-detect from current branch
    const result = await findPRByCurrentBranchAny(resolvedCtx);

    if (result.branch) {
      logProgress(`Searching for PR from branch '${result.branch}'...`, format);
    }

    if (!result.success) {
      throw new Error(result.error);
    }

    if (resolvedCtx.platform === 'github' && result.githubPr) {
      prId = result.githubPr.number;
      logProgress(`Found PR #${prId}: ${result.githubPr.title}`, format);
      logProgress('', format);
    } else if (result.pr) {
      prId = result.pr.pullRequestId;
      logProgress(`Found PR #${prId}: ${result.pr.title}`, format);
      logProgress('', format);
    }
  }

  if (prId === undefined) {
    throw new Error(
      'Could not determine PR ID. Please provide a PR ID, full PR URL, or run from a branch with an associated PR.'
    );
  }

  return { prId, ctx: resolvedCtx };
}
