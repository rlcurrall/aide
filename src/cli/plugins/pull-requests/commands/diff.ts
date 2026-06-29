/**
 * PR diff command - View pull request diff and changed files
 * Supports provider-backed PR metadata with local git diff when available.
 */

import { Effect } from 'effect';
import type { ArgumentsCamelCase, CommandModule } from 'yargs';

import type {
  AidePullRequestDiffFile,
  AidePullRequestDiffRequest,
  AidePullRequestDiffResult,
  AidePullRequestViewResult,
} from '@cli/host/plugin-descriptor.js';
import { getAideHostContext } from '@cli/host/runtime-context.js';
import { validatePRId } from '@lib/ado-utils.js';
import { logProgress } from '@lib/cli-utils.js';
import { handleCommandError } from '@lib/errors.js';
import {
  fetchMissingBranches,
  getCurrentBranch,
  getGitDiff,
  getGitRemoteUrl,
  isGitRepository,
  parseGitStat,
  remoteRefExists,
} from '@lib/git-utils.js';
import { validateArgs } from '@lib/validation.js';
import {
  DiffArgsSchema,
  type DiffArgs,
  type OutputFormat,
} from '@schemas/pr/diff.js';
import { resolveExplicitPullRequestRepositoryRef } from './repository-ref.js';

type DiffMode = 'full' | 'stat' | 'files' | 'file';
type LocalBranchUnavailableReason =
  | 'not-git-repo'
  | 'branch-not-found'
  | 'git-error';

interface GitCliDiffResult {
  readonly source: 'git-cli';
  readonly output: string;
  readonly localBranchStatus: { readonly available: true };
}

interface ProviderApiDiffResult {
  readonly source: 'api-fallback';
  readonly warning: string;
  readonly localBranchStatus: {
    readonly available: false;
    readonly reason: LocalBranchUnavailableReason;
  };
  readonly files: readonly AidePullRequestDiffFile[];
}

type DiffResult = GitCliDiffResult | ProviderApiDiffResult;

interface BranchRefs {
  readonly sourceBranch: string;
  readonly targetBranch: string;
}

interface ResolvedDiff {
  readonly result: AidePullRequestViewResult;
  readonly loadProviderDiff: () => Promise<AidePullRequestDiffResult>;
  readonly autoDiscovered: boolean;
}

interface ProviderDiffContext {
  readonly result: AidePullRequestViewResult;
  readonly getPullRequestDiff: (
    request: Pick<AidePullRequestDiffRequest, 'pullRequest'>
  ) => Effect.Effect<AidePullRequestDiffResult, unknown, never>;
}

function loadProviderDiffFrom(
  context: ProviderDiffContext
): () => Promise<AidePullRequestDiffResult> {
  return () =>
    Effect.runPromise(
      context.getPullRequestDiff({
        pullRequest: { number: context.result.pullRequest.id },
      })
    );
}

function statusChar(file: AidePullRequestDiffFile): string {
  switch (file.status) {
    case 'added':
      return 'A';
    case 'modified':
      return 'M';
    case 'deleted':
      return 'D';
    case 'renamed':
    case 'copied':
      return 'R';
    case 'unchanged':
      return ' ';
    case 'unknown':
      return '?';
  }
}

function statusLabel(file: AidePullRequestDiffFile): string {
  switch (file.status) {
    case 'added':
      return 'added';
    case 'modified':
      return 'modified';
    case 'deleted':
      return 'deleted';
    case 'renamed':
      return 'renamed';
    case 'copied':
      return 'copied';
    case 'unchanged':
      return 'unchanged';
    case 'unknown':
      return file.providerStatus ?? 'unknown';
  }
}

function hasLineCounts(file: AidePullRequestDiffFile): boolean {
  return (
    file.additions !== undefined ||
    file.deletions !== undefined ||
    file.changes !== undefined
  );
}

function tryGitCliDiff(
  branches: BranchRefs,
  options: {
    readonly stat?: boolean;
    readonly nameOnly?: boolean;
    readonly file?: string;
  }
):
  | GitCliDiffResult
  | {
      readonly fallbackReason: LocalBranchUnavailableReason;
      readonly branch?: string;
      readonly error?: string;
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

function buildFallbackWarning(
  reason: LocalBranchUnavailableReason,
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

async function getDiffData(
  resolved: ResolvedDiff,
  options: {
    readonly stat?: boolean;
    readonly nameOnly?: boolean;
    readonly file?: string;
  }
): Promise<DiffResult> {
  const result = resolved.result;
  const { sourceBranch, targetBranch } = result.pullRequest;
  if (!sourceBranch || !targetBranch) {
    return await getProviderApiDiff(resolved, {
      reason: 'git-error',
      error: 'PR missing source or target branch',
    });
  }

  const gitResult = tryGitCliDiff({ sourceBranch, targetBranch }, options);
  if ('source' in gitResult) {
    return gitResult;
  }

  return await getProviderApiDiff(resolved, {
    reason: gitResult.fallbackReason,
    branch: gitResult.branch,
    error: gitResult.error,
  });
}

async function getProviderApiDiff(
  resolved: ResolvedDiff,
  fallbackInfo: {
    readonly reason: LocalBranchUnavailableReason;
    readonly branch?: string;
    readonly error?: string;
  }
): Promise<ProviderApiDiffResult> {
  const result = await resolved.loadProviderDiff();
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
    files: result.files,
  };
}

function formatApiFilesText(
  files: readonly AidePullRequestDiffFile[],
  isStatMode: boolean
): string {
  if (files.length === 0) {
    return 'No changes found.';
  }

  const includeLineCounts = isStatMode && files.some(hasLineCounts);
  let output = '';
  let totalAdditions = 0;
  let totalDeletions = 0;

  for (const file of files) {
    if (includeLineCounts) {
      const additions = file.additions ?? 0;
      const deletions = file.deletions ?? 0;
      const changes = file.changes ?? additions + deletions;
      output += `  ${file.path}`;
      output += ` | ${changes} ${'+'.repeat(Math.min(additions, 20))}${'-'.repeat(Math.min(deletions, 20))}\n`;
      totalAdditions += additions;
      totalDeletions += deletions;
      continue;
    }

    const char = statusChar(file);
    if (file.previousPath && file.status === 'renamed') {
      output += `  ${char}  ${file.path}  (renamed from ${file.previousPath})\n`;
    } else {
      output += `  ${char}  ${file.path}\n`;
    }
  }

  if (isStatMode) {
    output += includeLineCounts
      ? `\n${files.length} files changed, ${totalAdditions} insertions(+), ${totalDeletions} deletions(-)`
      : `\n${files.length} files changed (line counts unavailable)`;
  }

  return output;
}

export function formatPullRequestDiffTextOutput(
  result: AidePullRequestViewResult,
  diffResult: DiffResult,
  mode: DiffMode
): string {
  const pr = result.pullRequest;
  const sourceBranch = pr.sourceBranch ?? 'unknown';
  const targetBranch = pr.targetBranch ?? 'unknown';

  if (mode === 'files') {
    if (diffResult.source === 'git-cli') {
      return diffResult.output.trim();
    }
    return diffResult.files.map((file) => file.path).join('\n');
  }

  let output = `PR #${pr.id}: ${pr.title}\n`;
  output += `Source: ${sourceBranch} -> Target: ${targetBranch}\n`;

  if (diffResult.source === 'api-fallback') {
    output += `\nWARNING: ${diffResult.warning}\n`;
  }

  output += '\n';

  if (diffResult.source === 'git-cli') {
    output += diffResult.output;
  } else {
    if (mode === 'full') {
      output += 'Changed files:\n';
    }
    output += formatApiFilesText(diffResult.files, mode === 'stat');
  }

  return output;
}

export function formatPullRequestDiffMarkdownOutput(
  result: AidePullRequestViewResult,
  diffResult: DiffResult,
  mode: DiffMode
): string {
  const pr = result.pullRequest;
  const sourceBranch = pr.sourceBranch ?? 'unknown';
  const targetBranch = pr.targetBranch ?? 'unknown';

  if (mode === 'files') {
    if (diffResult.source === 'git-cli') {
      return diffResult.output
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((file) => `- ${file}`)
        .join('\n');
    }
    return diffResult.files.map((file) => `- ${file.path}`).join('\n');
  }

  let output = `# PR #${pr.id}: ${pr.title}\n\n`;
  output += `**Source:** ${sourceBranch} -> **Target:** ${targetBranch}\n\n`;

  if (diffResult.source === 'api-fallback') {
    output += `> **Warning:** ${diffResult.warning}\n\n`;
  }

  if (diffResult.source === 'git-cli') {
    output += mode === 'stat' ? '```\n' : '```diff\n';
    output += diffResult.output + '\n```\n';
    return output;
  }

  const showStats = diffResult.files.some(hasLineCounts);
  output += '## Changed Files\n\n';
  output += showStats ? '| Status | File | +/- |\n' : '| Status | File |\n';
  output += showStats ? '|--------|------|-----|\n' : '|--------|------|\n';

  for (const file of diffResult.files) {
    const label = statusLabel(file);
    const path =
      file.previousPath && file.status === 'renamed'
        ? `${file.path} <- ${file.previousPath}`
        : file.path;
    if (showStats) {
      const additions = file.additions ?? 0;
      const deletions = file.deletions ?? 0;
      output += `| ${label} | ${path} | +${additions} -${deletions} |\n`;
    } else {
      output += `| ${label} | ${path} |\n`;
    }
  }

  return output;
}

export function formatPullRequestDiffJsonOutput(
  result: AidePullRequestViewResult,
  diffResult: DiffResult,
  mode: DiffMode
): string {
  const pr = result.pullRequest;
  const baseOutput = {
    prId: pr.id,
    title: pr.title,
    sourceBranch: pr.sourceBranch ?? 'unknown',
    targetBranch: pr.targetBranch ?? 'unknown',
    source: diffResult.source,
    localBranchStatus: diffResult.localBranchStatus,
    mode,
    ...(diffResult.source === 'api-fallback'
      ? { warning: diffResult.warning }
      : {}),
  };

  if (diffResult.source === 'git-cli') {
    if (mode === 'stat') {
      return JSON.stringify(
        { ...baseOutput, ...parseGitStat(diffResult.output) },
        null,
        2
      );
    }
    if (mode === 'files') {
      const files = diffResult.output.trim().split('\n').filter(Boolean);
      return JSON.stringify({ ...baseOutput, files }, null, 2);
    }
    return JSON.stringify({ ...baseOutput, diff: diffResult.output }, null, 2);
  }

  return JSON.stringify(
    {
      ...baseOutput,
      files: formatJsonFiles(result, diffResult.files),
    },
    null,
    2
  );
}

function formatJsonFiles(
  result: AidePullRequestViewResult,
  files: readonly AidePullRequestDiffFile[]
): readonly unknown[] {
  if (result.repository.kind === 'github') {
    return files.map((file) => ({
      filename: file.path,
      status: file.providerStatus ?? file.status,
      additions: file.additions ?? 0,
      deletions: file.deletions ?? 0,
      changes: file.changes ?? (file.additions ?? 0) + (file.deletions ?? 0),
      ...(file.previousPath === undefined
        ? {}
        : { previous_filename: file.previousPath }),
      ...(file.patch === undefined ? {} : { patch: file.patch }),
    }));
  }

  if (result.repository.kind === 'azure-devops') {
    return files.map((file) => ({
      path: file.path,
      changeType: file.providerStatus ?? file.status,
      ...(file.previousPath === undefined
        ? {}
        : { originalPath: file.previousPath }),
    }));
  }

  return files.map((file) => ({
    path: file.path,
    status: file.status,
    ...(file.providerStatus === undefined
      ? {}
      : { providerStatus: file.providerStatus }),
    ...(file.previousPath === undefined
      ? {}
      : { previousPath: file.previousPath }),
    ...(file.additions === undefined ? {} : { additions: file.additions }),
    ...(file.deletions === undefined ? {} : { deletions: file.deletions }),
    ...(file.changes === undefined ? {} : { changes: file.changes }),
    ...(file.patch === undefined ? {} : { patch: file.patch }),
  }));
}

async function handler(argv: ArgumentsCamelCase<DiffArgs>): Promise<void> {
  try {
    const args = validateArgs(DiffArgsSchema, argv, 'diff arguments');
    const format = args.format ?? 'text';
    const mode = diffMode(args);
    const resolved = await resolvePullRequestDiff(argv, args, format);

    if (resolved.autoDiscovered && resolved.result.repositoryLabel) {
      logProgress(
        `Auto-discovered: ${resolved.result.repositoryLabel}`,
        format
      );
      logProgress('', format);
    }

    await ensureLocalBranches(resolved.result, args, format);
    const diffResult = await getDiffData(resolved, {
      stat: args.stat,
      nameOnly: args.files,
      file: args.file,
    });

    if (await printFileFallbackIfNeeded(resolved.result, diffResult, args)) {
      return;
    }

    if (format === 'json') {
      console.log(
        formatPullRequestDiffJsonOutput(resolved.result, diffResult, mode)
      );
    } else if (format === 'markdown') {
      console.log(
        formatPullRequestDiffMarkdownOutput(resolved.result, diffResult, mode)
      );
    } else {
      console.log(
        formatPullRequestDiffTextOutput(resolved.result, diffResult, mode)
      );
    }
  } catch (error) {
    handleCommandError(error);
  }
}

function diffMode(args: DiffArgs): DiffMode {
  const modeFlags = [args.stat, args.files, !!args.file].filter(Boolean).length;
  if (modeFlags > 1) {
    throw new Error(
      '--stat, --files, and --file are mutually exclusive. Use only one.'
    );
  }

  if (args.stat) return 'stat';
  if (args.files) return 'files';
  if (args.file) return 'file';
  return 'full';
}

async function resolvePullRequestDiff(
  argv: ArgumentsCamelCase<DiffArgs>,
  args: DiffArgs,
  format: OutputFormat
): Promise<ResolvedDiff> {
  const hostContext = getAideHostContext(argv);
  if (hostContext === null) {
    throw new Error('Pull request provider services are unavailable.');
  }

  const hasExplicitRepoContext =
    args.project !== undefined || args.repo !== undefined;

  if (args.pr === undefined) {
    const branch = getCurrentBranch();
    if (!branch) {
      throw new Error(
        'Could not detect current git branch. Are you in a git repository? (Detached HEAD state is not supported)'
      );
    }

    logProgress(`Searching for PR from branch '${branch}'...`, format);
    const found = hasExplicitRepoContext
      ? await (async () => {
          const { repository, autoDiscovered } =
            await resolveExplicitPullRequestRepositoryRef(
              args.project,
              args.repo
            );
          const context = await Effect.runPromise(
            hostContext.services.findPullRequestForBranchContextForRepository(
              repository,
              { branch }
            )
          );
          return { context, autoDiscovered };
        })()
      : await (async () => {
          const remoteUrl = gitRemoteOrThrow(
            'Could not determine repository context. Provide a PR ID, full PR URL, or run from a git repository with a supported remote.'
          );
          const context = await Effect.runPromise(
            hostContext.services.findPullRequestForBranchContextForRemote(
              remoteUrl,
              {
                branch,
              }
            )
          );
          return { context, autoDiscovered: true };
        })();

    logProgress(
      `Found PR #${found.context.result.pullRequest.id}: ${found.context.result.pullRequest.title}`,
      format
    );
    logProgress('', format);
    logProgress(
      `Fetching diff for PR #${found.context.result.pullRequest.id}...`,
      format
    );
    logProgress('', format);

    return {
      result: found.context.result,
      loadProviderDiff: loadProviderDiffFrom(found.context),
      autoDiscovered: found.autoDiscovered,
    };
  }

  if (args.pr.startsWith('http')) {
    const prUrl = args.pr;
    logProgress('Fetching diff...', format);
    logProgress('', format);
    const context = await Effect.runPromise(
      hostContext.services.getPullRequestContextForUrl(prUrl)
    );
    return {
      result: context.result,
      loadProviderDiff: loadProviderDiffFrom(context),
      autoDiscovered: false,
    };
  }

  const validation = validatePRId(args.pr);
  if (!validation.valid || validation.value === undefined) {
    throw new Error(
      `Could not parse '${args.pr}' as a PR ID. Expected a positive number or full PR URL.`
    );
  }
  const prNumber = validation.value;

  logProgress(`Fetching diff for PR #${prNumber}...`, format);
  logProgress('', format);

  if (hasExplicitRepoContext) {
    const { repository, autoDiscovered } =
      await resolveExplicitPullRequestRepositoryRef(args.project, args.repo);
    const context = await Effect.runPromise(
      hostContext.services.getPullRequestContextForRepository(repository, {
        pullRequest: { number: prNumber },
      })
    );
    return {
      result: context.result,
      loadProviderDiff: loadProviderDiffFrom(context),
      autoDiscovered,
    };
  }

  const remoteUrl = gitRemoteOrThrow(
    'Could not determine repository context. Provide a full PR URL or run from a git repository with a supported remote.'
  );
  const context = await Effect.runPromise(
    hostContext.services.getPullRequestContextForRemote(remoteUrl, {
      pullRequest: { number: prNumber },
    })
  );
  return {
    result: context.result,
    loadProviderDiff: loadProviderDiffFrom(context),
    autoDiscovered: true,
  };
}

function gitRemoteOrThrow(message: string): string {
  const remoteUrl = getGitRemoteUrl();
  if (!remoteUrl) {
    throw new Error(message);
  }
  return remoteUrl;
}

async function ensureLocalBranches(
  result: AidePullRequestViewResult,
  args: DiffArgs,
  format: OutputFormat
): Promise<void> {
  if (
    args.file &&
    result.repository.kind === 'azure-devops' &&
    !isGitRepository()
  ) {
    throw new Error('Single file diff requires being in a git repository.');
  }

  if (!isGitRepository()) {
    return;
  }

  const { sourceBranch, targetBranch } = result.pullRequest;
  if (!sourceBranch || !targetBranch) {
    return;
  }

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

async function printFileFallbackIfNeeded(
  result: AidePullRequestViewResult,
  diffResult: DiffResult,
  args: DiffArgs
): Promise<boolean> {
  if (!args.file || diffResult.source !== 'api-fallback') {
    return false;
  }

  if (result.repository.kind === 'azure-devops') {
    const sourceBranch = result.pullRequest.sourceBranch ?? 'unknown';
    throw new Error(
      `Single file diff requires branch to be available locally. Run: git fetch origin ${sourceBranch}`
    );
  }

  const matchingFile = diffResult.files.find((file) => file.path === args.file);
  if (!matchingFile) {
    throw new Error(`File '${args.file}' not found in PR changes.`);
  }
  if (!matchingFile.patch) {
    throw new Error(
      `No diff available for '${args.file}' (binary file or too large).`
    );
  }

  console.log(matchingFile.patch);
  return true;
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
    fetch: {
      type: 'boolean',
      default: true,
      describe:
        'Auto-fetch branches if not available locally (use --no-fetch to disable)',
    },
  },
  handler,
} satisfies CommandModule<object, DiffArgs>;
