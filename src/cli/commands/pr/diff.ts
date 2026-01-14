/**
 * PR diff command - View pull request diff and changed files
 * Supports Azure DevOps with hybrid approach: git CLI when available, API fallback otherwise
 * @see https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-iteration-changes/get
 */

import {
  extractBranchName,
  findPRByCurrentBranch,
  getGitDiff,
  isGitRepository,
  parseGitStat,
  parsePRUrl,
  printMissingRepoError,
  remoteRefExists,
  resolveRepoContext,
  validatePRId,
} from '@lib/ado-utils.js';
import { AzureDevOpsClient } from '@lib/azure-devops-client.js';
import { loadAzureDevOpsConfig } from '@lib/config.js';
import { handleCommandError } from '@lib/errors.js';
import type {
  AzureDevOpsChangeType,
  AzureDevOpsPRChange,
  AzureDevOpsPullRequest,
} from '@lib/types.js';
import { validateArgs } from '@lib/validation.js';
import { DiffArgsSchema, type DiffArgs } from '@schemas/pr/diff.js';
import type { ArgumentsCamelCase, CommandModule } from 'yargs';

/**
 * Map Azure DevOps change type to display character
 */
function getChangeTypeChar(changeType: AzureDevOpsChangeType): string {
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
function getChangeTypeLabel(changeType: AzureDevOpsChangeType): string {
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

/**
 * Result of getting diff data
 */
interface DiffResult {
  source: 'git-cli' | 'api-fallback';
  warning?: string;
  localBranchStatus: {
    available: boolean;
    reason?: 'not-git-repo' | 'branch-not-found' | 'git-error';
  };
  // For git-cli source
  output?: string;
  // For api-fallback source
  files?: Array<{
    path: string;
    changeType: AzureDevOpsChangeType;
    originalPath?: string;
  }>;
}

/**
 * Format API fallback files for text output
 */
function formatApiFilesText(
  files: DiffResult['files'],
  isStatMode: boolean
): string {
  if (!files || files.length === 0) {
    return 'No changes found.';
  }

  let output = '';

  for (const file of files) {
    const char = getChangeTypeChar(file.changeType);
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

/**
 * Format output for text mode
 */
function formatTextOutput(
  pr: AzureDevOpsPullRequest,
  diffResult: DiffResult,
  mode: 'full' | 'stat' | 'files' | 'file'
): string {
  const sourceBranch = extractBranchName(pr.sourceRefName);
  const targetBranch = extractBranchName(pr.targetRefName);

  // For --files mode, just output file paths
  if (mode === 'files') {
    if (diffResult.source === 'git-cli' && diffResult.output) {
      return diffResult.output.trim();
    }
    if (diffResult.files) {
      return diffResult.files.map((f) => f.path).join('\n');
    }
    return '';
  }

  let output = `PR #${pr.pullRequestId}: ${pr.title}\n`;
  output += `Source: ${sourceBranch} -> Target: ${targetBranch}\n`;

  // Add warning for API fallback
  if (diffResult.source === 'api-fallback' && diffResult.warning) {
    output += `\nWARNING: ${diffResult.warning}\n`;
  }

  output += '\n';

  // Output the diff content
  if (diffResult.source === 'git-cli' && diffResult.output) {
    output += diffResult.output;
  } else if (diffResult.files) {
    if (mode === 'full') {
      output += 'Changed files:\n';
    }
    output += formatApiFilesText(diffResult.files, mode === 'stat');
  }

  return output;
}

/**
 * Format output for markdown mode
 */
function formatMarkdownOutput(
  pr: AzureDevOpsPullRequest,
  diffResult: DiffResult,
  mode: 'full' | 'stat' | 'files' | 'file'
): string {
  const sourceBranch = extractBranchName(pr.sourceRefName);
  const targetBranch = extractBranchName(pr.targetRefName);

  // For --files mode, just output file paths as a list
  if (mode === 'files') {
    if (diffResult.source === 'git-cli' && diffResult.output) {
      return diffResult.output
        .trim()
        .split('\n')
        .map((f) => `- ${f}`)
        .join('\n');
    }
    if (diffResult.files) {
      return diffResult.files.map((f) => `- ${f.path}`).join('\n');
    }
    return '';
  }

  let output = `# PR #${pr.pullRequestId}: ${pr.title}\n\n`;
  output += `**Source:** ${sourceBranch} → **Target:** ${targetBranch}\n\n`;

  // Add warning for API fallback
  if (diffResult.source === 'api-fallback' && diffResult.warning) {
    output += `> **Warning:** ${diffResult.warning}\n\n`;
  }

  // Output the diff content
  if (diffResult.source === 'git-cli' && diffResult.output) {
    if (mode === 'stat') {
      output += '```\n' + diffResult.output + '\n```\n';
    } else {
      output += '```diff\n' + diffResult.output + '\n```\n';
    }
  } else if (diffResult.files) {
    output += '## Changed Files\n\n';
    output += '| Status | File |\n';
    output += '|--------|------|\n';
    for (const file of diffResult.files) {
      const label = getChangeTypeLabel(file.changeType);
      if (file.originalPath && file.changeType === 'rename') {
        output += `| ${label} | ${file.path} ← ${file.originalPath} |\n`;
      } else {
        output += `| ${label} | ${file.path} |\n`;
      }
    }
  }

  return output;
}

/**
 * Format output for JSON mode
 */
function formatJsonOutput(
  pr: AzureDevOpsPullRequest,
  diffResult: DiffResult,
  mode: 'full' | 'stat' | 'files' | 'file'
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
    ...(diffResult.warning && { warning: diffResult.warning }),
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

  // API fallback
  const files = (diffResult.files || []).map((f) => ({
    path: f.path,
    changeType: f.changeType,
    ...(f.originalPath && { originalPath: f.originalPath }),
  }));

  return JSON.stringify({ ...baseOutput, files }, null, 2);
}

/**
 * Get diff data using git CLI or API fallback
 */
async function getDiffData(
  pr: AzureDevOpsPullRequest,
  project: string,
  repo: string,
  client: AzureDevOpsClient,
  options: { stat?: boolean; nameOnly?: boolean; file?: string }
): Promise<DiffResult> {
  // Step 1: Check if we're in a git repo
  if (!isGitRepository()) {
    return await getApiDiff(pr, project, repo, client, {
      reason: 'not-git-repo',
    });
  }

  // Step 2: Check if refs are present
  if (!pr.sourceRefName || !pr.targetRefName) {
    return await getApiDiff(pr, project, repo, client, {
      reason: 'git-error',
      error: 'PR missing source or target branch',
    });
  }

  // Step 3: Check if the source branch exists locally
  const sourceBranch = extractBranchName(pr.sourceRefName);
  const targetBranch = extractBranchName(pr.targetRefName);
  const sourceRef = `origin/${sourceBranch}`;
  const targetRef = `origin/${targetBranch}`;

  if (!remoteRefExists(sourceRef)) {
    return await getApiDiff(pr, project, repo, client, {
      reason: 'branch-not-found',
      branch: sourceBranch,
    });
  }

  if (!remoteRefExists(targetRef)) {
    return await getApiDiff(pr, project, repo, client, {
      reason: 'branch-not-found',
      branch: targetBranch,
    });
  }

  // Step 4: Try git diff
  const diffResult = getGitDiff(targetRef, sourceRef, options);

  if (!diffResult.success) {
    return await getApiDiff(pr, project, repo, client, {
      reason: 'git-error',
      error: diffResult.error,
    });
  }

  return {
    source: 'git-cli',
    output: diffResult.output,
    localBranchStatus: { available: true },
  };
}

/**
 * Get diff from API (fallback)
 */
async function getApiDiff(
  pr: AzureDevOpsPullRequest,
  project: string,
  repo: string,
  client: AzureDevOpsClient,
  fallbackInfo: {
    reason: 'not-git-repo' | 'branch-not-found' | 'git-error';
    branch?: string;
    error?: string;
  }
): Promise<DiffResult> {
  const changes = await client.getAllPullRequestChanges(
    project,
    repo,
    pr.pullRequestId
  );

  let warning: string;
  if (fallbackInfo.reason === 'not-git-repo') {
    warning = 'Not in a git repository. Showing file list from API.';
  } else if (fallbackInfo.reason === 'branch-not-found') {
    warning = `Branch '${fallbackInfo.branch}' not available locally. Run: git fetch origin ${fallbackInfo.branch}`;
  } else {
    warning = `Git error: ${fallbackInfo.error || 'unknown'}. Showing file list from API.`;
  }

  return {
    source: 'api-fallback',
    warning,
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

async function handler(argv: ArgumentsCamelCase<DiffArgs>): Promise<void> {
  const args = validateArgs(DiffArgsSchema, argv, 'diff arguments');
  let prId: number | undefined;
  let project: string | undefined = args.project;
  let repo: string | undefined = args.repo;
  const { format } = args;

  // Validate mutually exclusive flags
  const modeFlags = [args.stat, args.files, !!args.file].filter(Boolean).length;
  if (modeFlags > 1) {
    console.error(
      'Error: --stat, --files, and --file are mutually exclusive. Use only one.'
    );
    process.exit(1);
  }

  // Determine mode
  let mode: 'full' | 'stat' | 'files' | 'file' = 'full';
  if (args.stat) mode = 'stat';
  else if (args.files) mode = 'files';
  else if (args.file) mode = 'file';

  // Try auto-discover project/repo from git remote first
  try {
    const context = resolveRepoContext(project, repo, { format });
    project = context.project;
    repo = context.repo;
  } catch {
    // May still succeed if PR URL is provided
  }

  // Parse PR ID or URL, or auto-detect from current branch
  if (args.pr) {
    if (args.pr.startsWith('http')) {
      const parsed = parsePRUrl(args.pr);
      if (!parsed) {
        console.error(
          `Error: Invalid PR URL (expected Azure DevOps format): ${args.pr}`
        );
        console.error(
          'Expected format: https://dev.azure.com/{org}/{project}/_git/{repo}/pullrequest/{id}'
        );
        process.exit(1);
      }
      prId = parsed.prId;
      project = parsed.project;
      repo = parsed.repo;
    } else {
      const validation = validatePRId(args.pr);
      if (validation.valid) {
        prId = validation.value;
      } else {
        console.error(
          `Error: Could not parse '${args.pr}' as a PR ID. Expected a positive number or full PR URL.`
        );
        process.exit(1);
      }
    }
  } else {
    // No PR ID provided - auto-detect from current branch
    if (!project || !repo) {
      printMissingRepoError('Provide a PR ID or full PR URL');
      process.exit(1);
    }

    const result = await findPRByCurrentBranch(project, repo);

    if (format !== 'json' && result.branch) {
      console.log(`Searching for PR from branch '${result.branch}'...`);
    }

    if (!result.success || !result.pr) {
      console.error(`Error: ${result.error}`);
      process.exit(1);
    }

    prId = result.pr.pullRequestId;
    if (format !== 'json') {
      console.log(`Found PR #${prId}: ${result.pr.title}`);
      console.log('');
    }
  }

  // Validate we have project/repo
  if (!project || !repo) {
    printMissingRepoError('Provide a full PR URL');
    process.exit(1);
  }

  // Validate prId is set
  if (prId === undefined) {
    console.error('Error: Could not determine PR ID.');
    console.error(
      'Please provide a PR ID, full PR URL, or run from a branch with an associated PR.'
    );
    process.exit(1);
  }

  try {
    const config = loadAzureDevOpsConfig();
    const client = new AzureDevOpsClient(config);

    if (format !== 'json') {
      console.log(`Fetching diff for PR #${prId}...`);
      console.log('');
    }

    // Get PR details first
    const pr = await client.getPullRequest(project, repo, prId);

    // Validate refs are present for --file mode with API fallback
    // (we'll check this inside getDiffData, but pre-validate for better error message)
    if (args.file && !isGitRepository()) {
      console.error(
        'Error: Single file diff requires being in a git repository.'
      );
      process.exit(1);
    }

    // Get diff data
    const diffResult = await getDiffData(pr, project, repo, client, {
      stat: args.stat,
      nameOnly: args.files,
      file: args.file,
    });

    // Check if --file mode is unsupported in fallback
    if (args.file && diffResult.source === 'api-fallback') {
      const sourceBranch = extractBranchName(pr.sourceRefName);
      console.error(
        `Error: Single file diff requires branch to be available locally.`
      );
      console.error(`Run: git fetch origin ${sourceBranch}`);
      process.exit(1);
    }

    // Format and output
    let output: string;
    if (format === 'json') {
      output = formatJsonOutput(pr, diffResult, mode);
    } else if (format === 'markdown') {
      output = formatMarkdownOutput(pr, diffResult, mode);
    } else {
      output = formatTextOutput(pr, diffResult, mode);
    }

    console.log(output);
  } catch (error) {
    handleCommandError(error);
  }
}

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
  },
  handler,
} satisfies CommandModule<object, DiffArgs>;
