/**
 * PR create command - Create a pull request.
 */

import { Effect } from 'effect';
import type { ArgumentsCamelCase, CommandModule } from 'yargs';

import type {
  AidePullRequestCreateRequest,
  AidePullRequestCreateResult,
} from '@cli/host/plugin-descriptor.js';
import { getAideHostContext } from '@cli/host/runtime-context.js';
import { logProgress } from '@lib/cli-utils.js';
import { handleCommandError } from '@lib/errors.js';
import { getCurrentBranch, getGitRemoteUrl } from '@lib/git-utils.js';
import { parseGitHubRemote } from '@lib/github-utils.js';
import { validateArgs } from '@lib/validation.js';
import {
  PrCreateArgsSchema,
  type OutputFormat,
  type PrCreateArgs,
} from '@schemas/pr/pr-create.js';
import { resolvePullRequestBodyInput } from './body-input.js';
import { resolveExplicitPullRequestRepositoryRef } from './repository-ref.js';

type PullRequestCreateOperationRequest = Omit<
  AidePullRequestCreateRequest,
  'match'
>;

export interface ResolvedPullRequestCreateBranches {
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly autoDetectedSource: boolean;
  readonly defaultedTarget: boolean;
}

export type PullRequestCreateTarget =
  | { readonly kind: 'remote'; readonly remoteUrl: string }
  | { readonly kind: 'repository' }
  | { readonly kind: 'missing' };

function branchValue(value: string | undefined): string | undefined {
  return value === undefined || value.length === 0 ? undefined : value;
}

export function selectPullRequestCreateTarget(
  args: Pick<PrCreateArgs, 'project' | 'repo'>,
  remoteUrl: string | null
): PullRequestCreateTarget {
  if (remoteUrl !== null && parseGitHubRemote(remoteUrl) !== null) {
    return { kind: 'remote', remoteUrl };
  }
  if (args.project !== undefined || args.repo !== undefined) {
    return { kind: 'repository' };
  }
  if (remoteUrl !== null) {
    return { kind: 'remote', remoteUrl };
  }
  return { kind: 'missing' };
}

export function resolvePullRequestCreateBranches(
  args: Pick<
    PrCreateArgs,
    'head' | 'base' | 'source' | 'target' | 'source-branch' | 'target-branch'
  >,
  currentBranch: string | null = getCurrentBranch()
): ResolvedPullRequestCreateBranches {
  const sourceBranch =
    branchValue(args.head) ??
    branchValue(args.source) ??
    branchValue(args['source-branch']);
  const targetBranch =
    branchValue(args.base) ??
    branchValue(args.target) ??
    branchValue(args['target-branch']);

  if (sourceBranch === undefined) {
    if (!currentBranch) {
      throw new Error(
        'Could not detect current branch. Please specify --head branch explicitly.'
      );
    }
    return {
      sourceBranch: currentBranch,
      targetBranch: targetBranch ?? 'main',
      autoDetectedSource: true,
      defaultedTarget: targetBranch === undefined,
    };
  }

  return {
    sourceBranch,
    targetBranch: targetBranch ?? 'main',
    autoDetectedSource: false,
    defaultedTarget: targetBranch === undefined,
  };
}

export function buildPullRequestCreateOperationRequest(
  args: PrCreateArgs,
  description: string | undefined,
  branches: Pick<
    ResolvedPullRequestCreateBranches,
    'sourceBranch' | 'targetBranch'
  >
): PullRequestCreateOperationRequest {
  return {
    title: args.title,
    description: description ?? '',
    sourceBranch: branches.sourceBranch,
    targetBranch: branches.targetBranch,
    draft: args.draft ?? false,
    ...(args.tag === undefined || args.tag.length === 0
      ? {}
      : { labels: args.tag }),
  };
}

export function formatPullRequestCreateOutput(
  result: AidePullRequestCreateResult,
  format: OutputFormat
): string {
  const pr = result.pullRequest;
  if (format === 'json') {
    return JSON.stringify(
      {
        success: true,
        repository: result.repository,
        repositoryLabel: result.repositoryLabel,
        pullRequest: pr,
        ...(result.warnings === undefined ? {} : { warnings: result.warnings }),
      },
      null,
      2
    );
  }

  const sourceBranch = pr.sourceBranch ?? 'unknown';
  const targetBranch = pr.targetBranch ?? 'unknown';
  const labels = pr.labels ?? [];
  const statusDisplay =
    pr.draft && pr.status !== 'draft' ? `${pr.status} (draft)` : pr.status;

  if (format === 'markdown') {
    let output = `# Pull Request Created\n\n`;
    output += `**PR #${pr.id}**: ${pr.title}\n\n`;
    if (pr.url !== undefined) {
      output += `- **URL:** ${pr.url}\n`;
    }
    output += `- **Status:** ${statusDisplay}\n`;
    output += `- **Source:** ${sourceBranch}\n`;
    output += `- **Target:** ${targetBranch}\n`;
    output += `- **Created By:** ${pr.author.displayName}\n`;
    if (result.repositoryLabel !== undefined) {
      output += `- **Repository:** ${result.repositoryLabel}\n`;
    }
    if (labels.length > 0) {
      output += `- **Labels:** ${labels.join(', ')}\n`;
    }
    if (pr.description) {
      output += `\n## Description\n\n${pr.description}\n`;
    }
    return output;
  }

  let output = `Pull Request Created Successfully!\n`;
  output += '='.repeat(50) + '\n\n';
  output += `PR #${pr.id}: ${pr.title}\n\n`;
  if (pr.url !== undefined) {
    output += `URL: ${pr.url}\n`;
  }
  output += `Status: ${statusDisplay}\n`;
  output += `Source: ${sourceBranch}\n`;
  output += `Target: ${targetBranch}\n`;
  output += `Created By: ${pr.author.displayName}\n`;
  if (result.repositoryLabel !== undefined) {
    output += `Repository: ${result.repositoryLabel}\n`;
  }
  if (labels.length > 0) {
    output += `Labels: ${labels.join(', ')}\n`;
  }

  return output;
}

function logCreateProgress(
  request: PullRequestCreateOperationRequest,
  format: OutputFormat
): void {
  logProgress('', format);
  logProgress('Creating pull request...', format);
  logProgress(`  Title: ${request.title}`, format);
  logProgress(`  Source: ${request.sourceBranch}`, format);
  logProgress(`  Target: ${request.targetBranch}`, format);
  if (request.draft) logProgress('  Draft: yes', format);
  if (request.labels !== undefined && request.labels.length > 0) {
    logProgress(`  Tags: ${request.labels.join(', ')}`, format);
  }
  logProgress('', format);
}

function logCreateWarnings(
  result: AidePullRequestCreateResult,
  format: OutputFormat
): void {
  if (format === 'json') return;
  for (const warning of result.warnings ?? []) {
    console.error(`Warning: ${warning}`);
  }
}

async function createPullRequest(
  argv: ArgumentsCamelCase<PrCreateArgs>,
  args: PrCreateArgs,
  request: PullRequestCreateOperationRequest
): Promise<{
  readonly result: AidePullRequestCreateResult;
  readonly autoDiscovered: boolean;
}> {
  const hostContext = getAideHostContext(argv);
  if (hostContext === null) {
    throw new Error('Pull request provider services are unavailable.');
  }

  const remoteUrl = getGitRemoteUrl();
  const target = selectPullRequestCreateTarget(args, remoteUrl);

  switch (target.kind) {
    case 'repository': {
      const { repository, autoDiscovered } =
        await resolveExplicitPullRequestRepositoryRef(args.project, args.repo);
      const result = await Effect.runPromise(
        hostContext.services.createPullRequestForRepository(repository, request)
      );
      return { result, autoDiscovered };
    }
    case 'remote': {
      const result = await Effect.runPromise(
        hostContext.services.createPullRequestForRemote(
          target.remoteUrl,
          request
        )
      );
      return { result, autoDiscovered: true };
    }
    case 'missing':
      throw new Error(
        'Could not determine repository context. Run this command from a git repository with a supported remote or specify --project and --repo.'
      );
  }
}

async function handler(argv: ArgumentsCamelCase<PrCreateArgs>): Promise<void> {
  try {
    const args = validateArgs(PrCreateArgsSchema, argv, 'pr-create arguments');
    const format = args.format ?? 'text';
    const description = await resolvePullRequestBodyInput(args);
    const branches = resolvePullRequestCreateBranches(args);
    if (branches.autoDetectedSource) {
      logProgress(
        `Using current branch as head: ${branches.sourceBranch}`,
        format
      );
    }
    if (branches.defaultedTarget) {
      logProgress(
        `Using default base branch: ${branches.targetBranch}`,
        format
      );
    }

    const request = buildPullRequestCreateOperationRequest(
      args,
      description,
      branches
    );
    logCreateProgress(request, format);

    const resolved = await createPullRequest(argv, args, request);
    if (
      resolved.autoDiscovered &&
      resolved.result.repositoryLabel !== undefined
    ) {
      logProgress(
        `Auto-discovered: ${resolved.result.repositoryLabel}`,
        format
      );
      logProgress('', format);
    }

    logCreateWarnings(resolved.result, format);
    console.log(formatPullRequestCreateOutput(resolved.result, format));
  } catch (error) {
    handleCommandError(error);
  }
}

export default {
  command: 'create',
  describe: 'Create a pull request',
  builder: {
    title: {
      type: 'string',
      describe: 'Pull request title',
      demandOption: true,
      alias: 't',
    },
    body: {
      type: 'string',
      describe: 'Pull request description/body',
      alias: ['b', 'description'],
      nargs: 1,
      requiresArg: true,
    },
    'body-file': {
      type: 'string',
      describe:
        'Read pull request description/body from a file, or - for stdin',
      alias: 'description-file',
      nargs: 1,
      requiresArg: true,
    },
    head: {
      type: 'string',
      describe:
        'Source/head branch name (auto-detected from current branch if omitted)',
      alias: ['H', 'source', 's', 'source-branch'],
    },
    base: {
      type: 'string',
      describe: 'Target/base branch name (defaults to main)',
      alias: ['B', 'target', 'target-branch'],
    },
    draft: {
      type: 'boolean',
      default: false,
      describe: 'Create as draft pull request',
      alias: 'd',
    },
    tag: {
      type: 'array',
      string: true,
      describe: 'Add tag(s)/label(s) to the PR',
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
  },
  handler,
} satisfies CommandModule<object, PrCreateArgs>;
