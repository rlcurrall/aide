/**
 * PR diff command - View pull request diff and changed files
 * Supports Azure DevOps and GitHub with hybrid approach:
 * git CLI when available, API fallback otherwise
 */

import { MissingRepoContextError } from '@lib/ado-utils.js';
import { logProgress } from '@lib/cli-utils.js';
import {
  extractBranchName,
  fetchMissingBranches,
  getGitDiff,
  isGitRepository,
  parseGitStat,
  remoteRefExists,
} from '@lib/git-utils.js';
import { handleCommandError } from '@lib/errors.js';
import type {
  AzureDevOpsChangeType,
  AzureDevOpsPRChange,
  AzureDevOpsPullRequest,
} from '@lib/types.js';
import type { GitHubPRFile, GitHubPullRequest } from '@lib/github-types.js';
import {
  resolvePlatformContext,
  resolvePRId,
  GitHubAuthError,
  type PlatformContext,
} from '@lib/platform.js';
import { validateArgs } from '@lib/validation.js';
import {
  DiffArgsSchema,
  type DiffArgs,
  type OutputFormat,
} from '@schemas/pr/diff.js';
import type { ArgumentsCamelCase, CommandModule } from 'yargs';

// ============================================================================
// Shared Types
// ============================================================================

type DiffMode = 'full' | 'stat' | 'files' | 'file';

/**
 * Result of getting diff data via git CLI
 */
interface GitCliDiffResult {
  source: 'git-cli';
  output: string;
  localBranchStatus: { available: true };
}

/**
 * Result of getting diff data via ADO API fallback
 */
interface AdoApiDiffResult {
  source: 'api-fallback';
  warning: string;
  localBranchStatus: {
    available: false;
    reason: 'not-git-repo' | 'branch-not-found' | 'git-error';
  };
  files: Array<{
    path: string;
    changeType: AzureDevOpsChangeType;
    originalPath?: string;
  }>;
}

/**
 * Result of getting diff data via GitHub API fallback
 */
interface GitHubApiDiffResult {
  source: 'api-fallback';
  warning: string;
  localBranchStatus: {
    available: false;
    reason: 'not-git-repo' | 'branch-not-found' | 'git-error';
  };
  files: GitHubPRFile[];
}

type DiffResult = GitCliDiffResult | AdoApiDiffResult | GitHubApiDiffResult;

// ============================================================================
// ADO Change Type Helpers
// ============================================================================

/**
 * Map Azure DevOps change type to display character
 */
function getAdoChangeTypeChar(changeType: AzureDevOpsChangeType): string {
  switch (changeType) {
    case 'add':
      return 'A';
    case 'edit':
      return 'M';
    case 'delete':
      return 'D';
    case 'rename':
    case 'sourceRename':
    case 'targetRename':
      return 'R';
    default:
      return '?';
  }
}

/**
 * Map Azure DevOps change type to display label
 */
function getAdoChangeTypeLabel(changeType: AzureDevOpsChangeType): string {
  switch (changeType) {
    case 'add':
      return 'added';
    case 'edit':
      return 'modified';
    case 'delete':
      return 'deleted';
    case 'rename':
    case 'sourceRename':
    case 'targetRename':
      return 'renamed';
    default:
      return changeType;
  }
}

// ============================================================================
// GitHub Change Type Helpers
// ============================================================================

/**
 * Map GitHub file status to display character
 */
function getGitHubStatusChar(status: GitHubPRFile['status']): string {
  switch (status) {
    case 'added':
      return 'A';
    case 'modified':
    case 'changed':
      return 'M';
    case 'removed':
      return 'D';
    case 'renamed':
    case 'copied':
      return 'R';
    case 'unchanged':
      return ' ';
    default:
      return '?';
  }
}

/**
 * Map GitHub file status to display label
 */
function getGitHubStatusLabel(status: GitHubPRFile['status']): string {
  switch (status) {
    case 'added':
      return 'added';
    case 'modified':
    case 'changed':
      return 'modified';
    case 'removed':
      return 'deleted';
    case 'renamed':
      return 'renamed';
    case 'copied':
      return 'copied';
    case 'unchanged':
      return 'unchanged';
    default:
      return status;
  }
}

// ============================================================================
// Shared Git CLI Diff
// ============================================================================

interface BranchRefs {
  sourceBranch: string;
  targetBranch: string;
}

/**
 * Attempt to get diff via local git CLI. Returns null if not possible,
 * along with a reason for the failure.
 */
function tryGitCliDiff(
  branches: BranchRefs,
  options: { stat?: boolean; nameOnly?: boolean; file?: string }
):
  | GitCliDiffResult
  | {
      fallbackReason: 'not-git-repo' | 'branch-not-found' | 'git-error';
      branch?: string;
      error?: string;
    } {
  if (!isGitRepository()) {
    return { fallbackReason: 'not-git-repo' };
  }

  const sourceRef = `origin/${branches.sourceBranch}`;
  const targetRef = `origin/${branches.targetBranch}`;

  if (!remoteRefExists(sourceRef)) {
    return {
      fallbackReason: 'branch-not-found',
      branch: branches.sourceBranch,
    };
  }

  if (!remoteRefExists(targetRef)) {
    return {
      fallbackReason: 'branch-not-found',
      branch: branches.targetBranch,
    };
  }

  const diffResult = getGitDiff(targetRef, sourceRef, options);

  if (!diffResult.success) {
    return { fallbackReason: 'git-error', error: diffResult.error };
  }

  return {
    source: 'git-cli',
    output: diffResult.output ?? '',
    localBranchStatus: { available: true },
  };
}

/**
 * Build the warning message for API fallback
 */
function buildFallbackWarning(
  reason: 'not-git-repo' | 'branch-not-found' | 'git-error',
  branch?: string,
  error?: string
): string {
  if (reason === 'not-git-repo') {
    return 'Not in a git repository. Showing file list from API.';
  }
  if (reason === 'branch-not-found') {
    return `Branch '${branch}' not available locally. Run: git fetch origin ${branch}`;
  }
  return `Git error: ${error || 'unknown'}. Showing file list from API.`;
}

// ============================================================================
// ADO Diff Data
// ============================================================================

/**
 * Get diff data for an Azure DevOps PR
 */
async function getAdoDiffData(
  pr: AzureDevOpsPullRequest,
  project: string,
  repo: string,
  ctx: PlatformContext & { platform: 'azure-devops' },
  options: { stat?: boolean; nameOnly?: boolean; file?: string }
): Promise<DiffResult> {
  if (!pr.sourceRefName || !pr.targetRefName) {
    return await getAdoApiDiff(pr, project, repo, ctx, {
      reason: 'git-error',
      error: 'PR missing source or target branch',
    });
  }

  const sourceBranch = extractBranchName(pr.sourceRefName);
  const targetBranch = extractBranchName(pr.targetRefName);

  const result = tryGitCliDiff({ sourceBranch, targetBranch }, options);

  if ('source' in result) {
    return result;
  }

  return await getAdoApiDiff(pr, project, repo, ctx, {
    reason: result.fallbackReason,
    branch: result.branch,
    error: result.error,
  });
}

/**
 * Get diff from ADO API (fallback)
 */
async function getAdoApiDiff(
  pr: AzureDevOpsPullRequest,
  project: string,
  repo: string,
  ctx: PlatformContext & { platform: 'azure-devops' },
  fallbackInfo: {
    reason: 'not-git-repo' | 'branch-not-found' | 'git-error';
    branch?: string;
    error?: string;
  }
): Promise<AdoApiDiffResult> {
  const changes = await ctx.client.getAllPullRequestChanges(
    project,
    repo,
    pr.pullRequestId
  );

  return {
    source: 'api-fallback',
    warning: buildFallbackWarning(
      fallbackInfo.reason,
      fallbackInfo.branch,
      fallbackInfo.error
    ),
    localBranchStatus: {
      available: false,
      reason: fallbackInfo.reason,
    },
    files: changes.map((entry: AzureDevOpsPRChange) => ({
      path: entry.item?.path || entry.sourceServerItem || 'unknown',
      changeType: entry.changeType,
      originalPath: entry.originalPath || entry.sourceServerItem,
    })),
  };
}

// ============================================================================
// GitHub Diff Data
// ============================================================================

/**
 * Get diff data for a GitHub PR
 */
async function getGitHubDiffData(
  pr: GitHubPullRequest,
  ctx: PlatformContext & { platform: 'github' },
  options: { stat?: boolean; nameOnly?: boolean; file?: string }
): Promise<DiffResult> {
  const sourceBranch = pr.head.ref;
  const targetBranch = pr.base.ref;

  const result = tryGitCliDiff({ sourceBranch, targetBranch }, options);

  if ('source' in result) {
    return result;
  }

  return await getGitHubApiDiff(pr, ctx, {
    reason: result.fallbackReason,
    branch: result.branch,
    error: result.error,
  });
}

/**
 * Get diff from GitHub API (fallback)
 */
async function getGitHubApiDiff(
  pr: GitHubPullRequest,
  ctx: PlatformContext & { platform: 'github' },
  fallbackInfo: {
    reason: 'not-git-repo' | 'branch-not-found' | 'git-error';
    branch?: string;
    error?: string;
  }
): Promise<GitHubApiDiffResult> {
  const files = await ctx.client.getPullRequestFiles(
    ctx.owner,
    ctx.repo,
    pr.number
  );

  return {
    source: 'api-fallback',
    warning: buildFallbackWarning(
      fallbackInfo.reason,
      fallbackInfo.branch,
      fallbackInfo.error
    ),
    localBranchStatus: {
      available: false,
      reason: fallbackInfo.reason,
    },
    files,
  };
}

// ============================================================================
// ADO Formatting
// ============================================================================

function formatAdoApiFilesText(
  files: AdoApiDiffResult['files'],
  isStatMode: boolean
): string {
  if (!files || files.length === 0) {
    return 'No changes found.';
  }

  let output = '';

  for (const file of files) {
    const char = getAdoChangeTypeChar(file.changeType);
    if (file.originalPath && file.changeType === 'rename') {
      output += `  ${char}  ${file.path}  (renamed from ${file.originalPath})\n`;
    } else {
      output += `  ${char}  ${file.path}\n`;
    }
  }

  if (isStatMode) {
    output += `\n${files.length} files changed (line counts unavailable)`;
  }

  return output;
}

function formatAdoTextOutput(
  pr: AzureDevOpsPullRequest,
  diffResult: DiffResult,
  mode: DiffMode
): string {
  const sourceBranch = extractBranchName(pr.sourceRefName);
  const targetBranch = extractBranchName(pr.targetRefName);

  if (mode === 'files') {
    if (diffResult.source === 'git-cli' && diffResult.output) {
      return diffResult.output.trim();
    }
    if ('files' in diffResult && diffResult.files) {
      const files = diffResult.files as AdoApiDiffResult['files'];
      return files.map((f) => f.path).join('\n');
    }
    return '';
  }

  let output = `PR #${pr.pullRequestId}: ${pr.title}\n`;
  output += `Source: ${sourceBranch} -> Target: ${targetBranch}\n`;

  if (diffResult.source === 'api-fallback' && diffResult.warning) {
    output += `\nWARNING: ${diffResult.warning}\n`;
  }

  output += '\n';

  if (diffResult.source === 'git-cli' && diffResult.output) {
    output += diffResult.output;
  } else if ('files' in diffResult && diffResult.files) {
    if (mode === 'full') {
      output += 'Changed files:\n';
    }
    output += formatAdoApiFilesText(
      diffResult.files as AdoApiDiffResult['files'],
      mode === 'stat'
    );
  }

  return output;
}

function formatAdoMarkdownOutput(
  pr: AzureDevOpsPullRequest,
  diffResult: DiffResult,
  mode: DiffMode
): string {
  const sourceBranch = extractBranchName(pr.sourceRefName);
  const targetBranch = extractBranchName(pr.targetRefName);

  if (mode === 'files') {
    if (diffResult.source === 'git-cli' && diffResult.output) {
      return diffResult.output
        .trim()
        .split('\n')
        .map((f) => `- ${f}`)
        .join('\n');
    }
    if ('files' in diffResult && diffResult.files) {
      const files = diffResult.files as AdoApiDiffResult['files'];
      return files.map((f) => `- ${f.path}`).join('\n');
    }
    return '';
  }

  let output = `# PR #${pr.pullRequestId}: ${pr.title}\n\n`;
  output += `**Source:** ${sourceBranch} → **Target:** ${targetBranch}\n\n`;

  if (diffResult.source === 'api-fallback' && diffResult.warning) {
    output += `> **Warning:** ${diffResult.warning}\n\n`;
  }

  if (diffResult.source === 'git-cli' && diffResult.output) {
    if (mode === 'stat') {
      output += '```\n' + diffResult.output + '\n```\n';
    } else {
      output += '```diff\n' + diffResult.output + '\n```\n';
    }
  } else if ('files' in diffResult && diffResult.files) {
    const files = diffResult.files as AdoApiDiffResult['files'];
    output += '## Changed Files\n\n';
    output += '| Status | File |\n';
    output += '|--------|------|\n';
    for (const file of files) {
      const label = getAdoChangeTypeLabel(file.changeType);
      if (file.originalPath && file.changeType === 'rename') {
        output += `| ${label} | ${file.path} ← ${file.originalPath} |\n`;
      } else {
        output += `| ${label} | ${file.path} |\n`;
      }
    }
  }

  return output;
}

function formatAdoJsonOutput(
  pr: AzureDevOpsPullRequest,
  diffResult: DiffResult,
  mode: DiffMode
): string {
  const sourceBranch = extractBranchName(pr.sourceRefName);
  const targetBranch = extractBranchName(pr.targetRefName);

  const baseOutput = {
    prId: pr.pullRequestId,
    title: pr.title,
    sourceBranch,
    targetBranch,
    source: diffResult.source,
    localBranchStatus: diffResult.localBranchStatus,
    mode,
    ...(diffResult.source === 'api-fallback' && diffResult.warning
      ? { warning: diffResult.warning }
      : {}),
  };

  if (diffResult.source === 'git-cli' && diffResult.output) {
    if (mode === 'stat') {
      const parsed = parseGitStat(diffResult.output);
      return JSON.stringify({ ...baseOutput, ...parsed }, null, 2);
    }
    if (mode === 'files') {
      const files = diffResult.output.trim().split('\n').filter(Boolean);
      return JSON.stringify({ ...baseOutput, files }, null, 2);
    }
    return JSON.stringify({ ...baseOutput, diff: diffResult.output }, null, 2);
  }

  const adoFiles = (diffResult as AdoApiDiffResult).files || [];
  const files = adoFiles.map((f) => ({
    path: f.path,
    changeType: f.changeType,
    ...(f.originalPath && { originalPath: f.originalPath }),
  }));

  return JSON.stringify({ ...baseOutput, files }, null, 2);
}

// ============================================================================
// GitHub Formatting
// ============================================================================

function formatGitHubApiFilesText(
  files: GitHubPRFile[],
  isStatMode: boolean
): string {
  if (!files || files.length === 0) {
    return 'No changes found.';
  }

  let output = '';
  let totalAdditions = 0;
  let totalDeletions = 0;

  for (const file of files) {
    const char = getGitHubStatusChar(file.status);
    if (isStatMode) {
      output += `  ${file.filename}`;
      output += ` | ${file.changes} ${'+'.repeat(Math.min(file.additions, 20))}${'-'.repeat(Math.min(file.deletions, 20))}\n`;
      totalAdditions += file.additions;
      totalDeletions += file.deletions;
    } else if (file.previous_filename && file.status === 'renamed') {
      output += `  ${char}  ${file.filename}  (renamed from ${file.previous_filename})\n`;
    } else {
      output += `  ${char}  ${file.filename}\n`;
    }
  }

  if (isStatMode) {
    output += `\n${files.length} files changed, ${totalAdditions} insertions(+), ${totalDeletions} deletions(-)`;
  }

  return output;
}

function formatGitHubTextOutput(
  pr: GitHubPullRequest,
  diffResult: DiffResult,
  mode: DiffMode
): string {
  const sourceBranch = pr.head.ref;
  const targetBranch = pr.base.ref;

  if (mode === 'files') {
    if (diffResult.source === 'git-cli' && diffResult.output) {
      return diffResult.output.trim();
    }
    if ('files' in diffResult && diffResult.files) {
      const files = diffResult.files as GitHubPRFile[];
      return files.map((f) => f.filename).join('\n');
    }
    return '';
  }

  let output = `PR #${pr.number}: ${pr.title}\n`;
  output += `Source: ${sourceBranch} -> Target: ${targetBranch}\n`;

  if (diffResult.source === 'api-fallback' && diffResult.warning) {
    output += `\nWARNING: ${diffResult.warning}\n`;
  }

  output += '\n';

  if (diffResult.source === 'git-cli' && diffResult.output) {
    output += diffResult.output;
  } else if ('files' in diffResult && diffResult.files) {
    const files = diffResult.files as GitHubPRFile[];
    if (mode === 'full') {
      output += 'Changed files:\n';
    }
    output += formatGitHubApiFilesText(files, mode === 'stat');
  }

  return output;
}

function formatGitHubMarkdownOutput(
  pr: GitHubPullRequest,
  diffResult: DiffResult,
  mode: DiffMode
): string {
  const sourceBranch = pr.head.ref;
  const targetBranch = pr.base.ref;

  if (mode === 'files') {
    if (diffResult.source === 'git-cli' && diffResult.output) {
      return diffResult.output
        .trim()
        .split('\n')
        .map((f) => `- ${f}`)
        .join('\n');
    }
    if ('files' in diffResult && diffResult.files) {
      const files = diffResult.files as GitHubPRFile[];
      return files.map((f) => `- ${f.filename}`).join('\n');
    }
    return '';
  }

  let output = `# PR #${pr.number}: ${pr.title}\n\n`;
  output += `**Source:** ${sourceBranch} → **Target:** ${targetBranch}\n\n`;

  if (diffResult.source === 'api-fallback' && diffResult.warning) {
    output += `> **Warning:** ${diffResult.warning}\n\n`;
  }

  if (diffResult.source === 'git-cli' && diffResult.output) {
    if (mode === 'stat') {
      output += '```\n' + diffResult.output + '\n```\n';
    } else {
      output += '```diff\n' + diffResult.output + '\n```\n';
    }
  } else if ('files' in diffResult && diffResult.files) {
    const files = diffResult.files as GitHubPRFile[];
    output += '## Changed Files\n\n';
    output += '| Status | File | +/- |\n';
    output += '|--------|------|-----|\n';
    for (const file of files) {
      const label = getGitHubStatusLabel(file.status);
      const stats = `+${file.additions} -${file.deletions}`;
      if (file.previous_filename && file.status === 'renamed') {
        output += `| ${label} | ${file.filename} ← ${file.previous_filename} | ${stats} |\n`;
      } else {
        output += `| ${label} | ${file.filename} | ${stats} |\n`;
      }
    }
  }

  return output;
}

function formatGitHubJsonOutput(
  pr: GitHubPullRequest,
  diffResult: DiffResult,
  mode: DiffMode
): string {
  const sourceBranch = pr.head.ref;
  const targetBranch = pr.base.ref;

  const baseOutput = {
    prId: pr.number,
    title: pr.title,
    sourceBranch,
    targetBranch,
    source: diffResult.source,
    localBranchStatus: diffResult.localBranchStatus,
    mode,
    ...(diffResult.source === 'api-fallback' && diffResult.warning
      ? { warning: diffResult.warning }
      : {}),
  };

  if (diffResult.source === 'git-cli' && diffResult.output) {
    if (mode === 'stat') {
      const parsed = parseGitStat(diffResult.output);
      return JSON.stringify({ ...baseOutput, ...parsed }, null, 2);
    }
    if (mode === 'files') {
      const files = diffResult.output.trim().split('\n').filter(Boolean);
      return JSON.stringify({ ...baseOutput, files }, null, 2);
    }
    return JSON.stringify({ ...baseOutput, diff: diffResult.output }, null, 2);
  }

  const ghFiles = (diffResult as GitHubApiDiffResult).files || [];
  const files = ghFiles.map((f) => ({
    filename: f.filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    changes: f.changes,
    ...(f.previous_filename && { previous_filename: f.previous_filename }),
    ...(f.patch && { patch: f.patch }),
  }));

  return JSON.stringify({ ...baseOutput, files }, null, 2);
}

// ============================================================================
// Handler
// ============================================================================

async function handler(argv: ArgumentsCamelCase<DiffArgs>): Promise<void> {
  try {
    const args = validateArgs(DiffArgsSchema, argv, 'diff arguments');
    const { format } = args;

    // Validate mutually exclusive flags
    const modeFlags = [args.stat, args.files, !!args.file].filter(
      Boolean
    ).length;
    if (modeFlags > 1) {
      throw new Error(
        '--stat, --files, and --file are mutually exclusive. Use only one.'
      );
    }

    // Determine mode
    let mode: DiffMode = 'full';
    if (args.stat) mode = 'stat';
    else if (args.files) mode = 'files';
    else if (args.file) mode = 'file';

    // Resolve platform context
    let ctx: PlatformContext | undefined;
    try {
      ctx = resolvePlatformContext(args.project, args.repo);
      if (ctx.autoDiscovered) {
        if (ctx.platform === 'github') {
          logProgress(
            `Auto-discovered: github.com/${ctx.owner}/${ctx.repo}`,
            format
          );
        } else {
          logProgress(
            `Auto-discovered: ${ctx.org}/${ctx.project}/${ctx.repo}`,
            format
          );
        }
        logProgress('', format);
      }
    } catch (error) {
      if (
        !(
          error instanceof MissingRepoContextError ||
          error instanceof GitHubAuthError
        ) ||
        !args.pr?.startsWith('http')
      ) {
        throw error;
      }
      // Will handle below via URL parsing
      ctx = undefined;
    }

    // Resolve PR ID (handles URL parsing, numeric ID, and auto-detect from branch)
    if (!ctx) {
      throw new Error(
        'Could not determine repository context. Provide a PR ID or full PR URL.'
      );
    }
    const resolved = await resolvePRId(args.pr, ctx, format);
    ctx = resolved.ctx;
    const prId = resolved.prId;

    logProgress(`Fetching diff for PR #${prId}...`, format);
    logProgress('', format);

    if (ctx.platform === 'github') {
      await handleGitHubDiff(ctx, prId, args, mode, format);
    } else {
      await handleAdoDiff(ctx, prId, args, mode, format);
    }
  } catch (error) {
    handleCommandError(error);
  }
}

// ============================================================================
// Platform-specific Handler Logic
// ============================================================================

async function handleAdoDiff(
  ctx: PlatformContext & { platform: 'azure-devops' },
  prId: number,
  args: DiffArgs,
  mode: DiffMode,
  format: OutputFormat
): Promise<void> {
  const pr = await ctx.client.getPullRequest(ctx.project, ctx.repo, prId);

  if (args.file && !isGitRepository()) {
    throw new Error('Single file diff requires being in a git repository.');
  }

  // Ensure branches are available locally
  if (isGitRepository() && pr.sourceRefName && pr.targetRefName) {
    const sourceBranch = extractBranchName(pr.sourceRefName);
    const targetBranch = extractBranchName(pr.targetRefName);

    const branchResult = fetchMissingBranches(sourceBranch, targetBranch, {
      fetch: args.fetch,
    });

    if (branchResult.fetched.length > 0) {
      for (const branch of branchResult.fetched) {
        logProgress(`Fetched branch '${branch}'`, format);
      }
      logProgress('', format);
    }
  }

  const diffResult = await getAdoDiffData(pr, ctx.project, ctx.repo, ctx, {
    stat: args.stat,
    nameOnly: args.files,
    file: args.file,
  });

  // --file mode unsupported in ADO API fallback
  if (args.file && diffResult.source === 'api-fallback') {
    const sourceBranch = extractBranchName(pr.sourceRefName);
    throw new Error(
      `Single file diff requires branch to be available locally. Run: git fetch origin ${sourceBranch}`
    );
  }

  let output: string;
  if (format === 'json') {
    output = formatAdoJsonOutput(pr, diffResult, mode);
  } else if (format === 'markdown') {
    output = formatAdoMarkdownOutput(pr, diffResult, mode);
  } else {
    output = formatAdoTextOutput(pr, diffResult, mode);
  }

  console.log(output);
}

async function handleGitHubDiff(
  ctx: PlatformContext & { platform: 'github' },
  prId: number,
  args: DiffArgs,
  mode: DiffMode,
  format: OutputFormat
): Promise<void> {
  const pr = await ctx.client.getPullRequest(ctx.owner, ctx.repo, prId);

  // For GitHub, --file mode with API fallback IS supported (patch field available)
  // so we don't block it upfront like ADO

  // Ensure branches are available locally
  if (isGitRepository()) {
    const sourceBranch = pr.head.ref;
    const targetBranch = pr.base.ref;

    const branchResult = fetchMissingBranches(sourceBranch, targetBranch, {
      fetch: args.fetch,
    });

    if (branchResult.fetched.length > 0) {
      for (const branch of branchResult.fetched) {
        logProgress(`Fetched branch '${branch}'`, format);
      }
      logProgress('', format);
    }
  }

  const diffResult = await getGitHubDiffData(pr, ctx, {
    stat: args.stat,
    nameOnly: args.files,
    file: args.file,
  });

  // For --file mode with GitHub API fallback, show patch from matching file
  if (args.file && diffResult.source === 'api-fallback') {
    const ghFiles = (diffResult as GitHubApiDiffResult).files;
    const matchingFile = ghFiles.find((f) => f.filename === args.file);
    if (!matchingFile) {
      throw new Error(`File '${args.file}' not found in PR changes.`);
    }
    if (!matchingFile.patch) {
      throw new Error(
        `No diff available for '${args.file}' (binary file or too large).`
      );
    }
    console.log(matchingFile.patch);
    return;
  }

  let output: string;
  if (format === 'json') {
    output = formatGitHubJsonOutput(pr, diffResult, mode);
  } else if (format === 'markdown') {
    output = formatGitHubMarkdownOutput(pr, diffResult, mode);
  } else {
    output = formatGitHubTextOutput(pr, diffResult, mode);
  }

  console.log(output);
}

// ============================================================================
// Export
// ============================================================================

export default {
  command: 'diff',
  describe: 'View pull request diff and changed files',
  builder: {
    pr: {
      type: 'string',
      describe:
        'PR ID or full PR URL (auto-detected from current branch if omitted)',
    },
    project: {
      type: 'string',
      describe: 'Project name (auto-discovered from git remote)',
    },
    repo: {
      type: 'string',
      describe: 'Repository name (auto-discovered from git remote)',
    },
    format: {
      type: 'string',
      choices: ['text', 'json', 'markdown'] as const,
      default: 'text' as const,
      describe: 'Output format',
    },
    stat: {
      type: 'boolean',
      default: false,
      describe: 'Show summary: files changed with +/- line counts',
    },
    files: {
      type: 'boolean',
      default: false,
      describe: 'Show only list of changed file paths',
    },
    file: {
      type: 'string',
      describe: 'Show diff for a specific file only',
    },
    fetch: {
      type: 'boolean',
      default: true,
      describe:
        'Auto-fetch branches if not available locally (use --no-fetch to disable)',
    },
  },
  handler,
} satisfies CommandModule<object, DiffArgs>;
