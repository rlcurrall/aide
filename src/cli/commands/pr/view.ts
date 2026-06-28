/**
 * PR view command - Get details for a pull request
 * Supports Azure DevOps and GitHub
 */

import { Effect } from 'effect';
import type { ArgumentsCamelCase, CommandModule } from 'yargs';

import type {
  AidePullRequestRepositoryRef,
  AidePullRequestViewItem,
  AidePullRequestViewResult,
} from '@cli/host/plugin-descriptor.js';
import { getAideHostContext } from '@cli/host/runtime-context.js';
import { MissingRepoContextError, validatePRId } from '@lib/ado-utils.js';
import { logProgress } from '@lib/cli-utils.js';
import { handleCommandError } from '@lib/errors.js';
import { extractBranchName, getGitRemoteUrl } from '@lib/git-utils.js';
import type { GitHubPullRequest } from '@lib/github-types.js';
import {
  DEFAULT_GITHUB_HOST,
  buildGitHubPrUrl,
  getGitHubPRStatus,
} from '@lib/github-utils.js';
import {
  GitHubAuthError,
  findPRByCurrentBranchAny,
  parsePRUrlAny,
  resolvePlatformContext,
  type PlatformContext,
} from '@lib/platform.js';
import type { AzureDevOpsPullRequest } from '@lib/types.js';
import { validateArgs } from '@lib/validation.js';
import {
  ViewArgsSchema,
  type OutputFormat,
  type ViewArgs,
} from '@schemas/pr/view.js';

// ============================================================================
// Provider-neutral Formatting
// ============================================================================

export function formatPullRequestViewOutput(
  result: AidePullRequestViewResult,
  format: OutputFormat
): string {
  const pr = result.pullRequest;
  if (format === 'json') {
    return JSON.stringify(pr, null, 2);
  }

  const createdDate = formatDate(pr.createdAt);
  const sourceBranch = pr.sourceBranch ?? 'unknown';
  const targetBranch = pr.targetBranch ?? 'unknown';
  const labels = pr.labels ?? [];
  const statusDisplay =
    pr.draft && pr.status !== 'draft' ? `${pr.status} (draft)` : pr.status;

  if (format === 'markdown') {
    let output = `# PR #${pr.id}: ${pr.title}\n\n`;
    output += `| Field | Value |\n`;
    output += `|-------|-------|\n`;
    output += `| **Status** | ${statusDisplay} |\n`;
    output += `| **Author** | ${pr.author.displayName} |\n`;
    output += `| **Created** | ${createdDate} |\n`;
    output += `| **Source** | ${sourceBranch} |\n`;
    output += `| **Target** | ${targetBranch} |\n`;
    if (result.repositoryLabel) {
      output += `| **Repository** | ${result.repositoryLabel} |\n`;
    }
    if (pr.url) {
      output += `| **URL** | ${pr.url} |\n`;
    }
    if (labels.length > 0) {
      output += `| **Labels** | ${labels.join(', ')} |\n`;
    }

    if (pr.description) {
      output += `\n## Description\n\n${pr.description}\n`;
    }

    return output;
  }

  let output = `PR #${pr.id}: ${pr.title}\n`;
  output += '='.repeat(50) + '\n\n';
  output += `Status:     ${statusDisplay}\n`;
  output += `Author:     ${pr.author.displayName}\n`;
  output += `Created:    ${createdDate}\n`;
  output += `Source:     ${sourceBranch}\n`;
  output += `Target:     ${targetBranch}\n`;
  if (result.repositoryLabel) {
    output += `Repository: ${result.repositoryLabel}\n`;
  }
  if (pr.url) {
    output += `URL:        ${pr.url}\n`;
  }
  if (labels.length > 0) {
    output += `Labels:     ${labels.join(', ')}\n`;
  }

  if (pr.description) {
    output += `\nDescription:\n${'-'.repeat(20)}\n${pr.description}\n`;
  }

  return output;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : value;
}

// ============================================================================
// Handler
// ============================================================================

async function handler(argv: ArgumentsCamelCase<ViewArgs>): Promise<void> {
  const args = validateArgs(ViewArgsSchema, argv, 'view arguments');
  const format = args.format ?? 'text';

  try {
    const resolved =
      (await resolveProviderPullRequestView(argv, args)) ??
      (await resolveLegacyPullRequestView(args, format));

    if (resolved.autoDiscovered) {
      logProgress(
        `Auto-discovered: ${resolved.result.repositoryLabel}`,
        format
      );
      logProgress('', format);
    }

    console.log(formatPullRequestViewOutput(resolved.result, format));
  } catch (error) {
    handleCommandError(error);
  }
}

async function resolveProviderPullRequestView(
  argv: ArgumentsCamelCase<ViewArgs>,
  args: ViewArgs
): Promise<{
  readonly result: AidePullRequestViewResult;
  readonly autoDiscovered: boolean;
} | null> {
  const hostContext = getAideHostContext(argv);
  if (hostContext === null || args.pr === undefined) {
    return null;
  }

  if (args.pr.startsWith('http')) {
    const result = await Effect.runPromise(
      hostContext.services.getPullRequestForUrl(args.pr)
    );
    return { result, autoDiscovered: false };
  }

  const hasExplicitRepoContext =
    args.project !== undefined || args.repo !== undefined;
  if (hasExplicitRepoContext) {
    return null;
  }

  const validation = validatePRId(args.pr);
  if (!validation.valid || validation.value === undefined) {
    return null;
  }

  const remoteUrl = getGitRemoteUrl();
  if (!remoteUrl) {
    return null;
  }

  const result = await Effect.runPromise(
    hostContext.services.getPullRequestForRemote(remoteUrl, {
      pullRequest: { number: validation.value },
    })
  );
  return { result, autoDiscovered: true };
}

async function resolveLegacyPullRequestView(
  args: ViewArgs,
  format: OutputFormat
): Promise<{
  readonly result: AidePullRequestViewResult;
  readonly autoDiscovered: boolean;
}> {
  let ctx: PlatformContext | undefined;
  try {
    ctx = await resolvePlatformContext(args.project, args.repo);
  } catch (error) {
    // URL fallback only for context-discovery failures. ConfigError from
    // GitHubClient.create() (malformed stored creds) always rethrows -
    // retrying with a URL would hit the same corrupted blob.
    if (
      !(
        error instanceof MissingRepoContextError ||
        error instanceof GitHubAuthError
      ) ||
      !args.pr?.startsWith('http')
    ) {
      throw error;
    }
    ctx = undefined;
  }

  let prId: number | undefined;

  if (args.pr) {
    if (args.pr.startsWith('http')) {
      const parsed = parsePRUrlAny(args.pr);
      if (!parsed) {
        throw new Error(
          `Invalid PR URL: ${args.pr}. Expected Azure DevOps or GitHub PR URL format.`
        );
      }
      prId = parsed.prId;

      if (parsed.platform === 'github' && parsed.owner && parsed.ghRepo) {
        const { GitHubClient } = await import('@lib/github-client.js');
        const host = parsed.ghHost ?? DEFAULT_GITHUB_HOST;
        ctx = {
          platform: 'github',
          owner: parsed.owner,
          repo: parsed.ghRepo,
          host,
          client: await GitHubClient.create({ host }),
          autoDiscovered: false,
        };
      } else if (
        parsed.platform === 'azure-devops' &&
        parsed.project &&
        parsed.repo
      ) {
        const { loadAzureDevOpsConfig } = await import('@lib/config.js');
        const { AzureDevOpsClient } =
          await import('@lib/azure-devops-client.js');
        const { config } = await loadAzureDevOpsConfig();
        ctx = {
          platform: 'azure-devops',
          org: parsed.org ?? '',
          project: parsed.project,
          repo: parsed.repo,
          client: new AzureDevOpsClient(config),
          autoDiscovered: false,
        };
      }
    } else {
      const validation = validatePRId(args.pr);
      if (validation.valid) {
        prId = validation.value;
      } else {
        throw new Error(
          `Could not parse '${args.pr}' as a PR ID. Expected a positive number or full PR URL.`
        );
      }
    }
  } else {
    if (!ctx) {
      throw new Error(
        'Could not determine repository context. Provide a PR ID or full PR URL.'
      );
    }

    const result = await findPRByCurrentBranchAny(ctx);

    if (result.branch) {
      logProgress(`Searching for PR from branch '${result.branch}'...`, format);
    }

    if (!result.success) {
      throw new Error(result.error);
    }

    if (ctx.platform === 'github' && result.githubPr) {
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

  if (!ctx) {
    throw new Error(
      'Could not determine repository context. Provide a full PR URL.'
    );
  }

  const result =
    ctx.platform === 'github'
      ? await viewGitHubPullRequest(ctx, prId)
      : await viewAzureDevOpsPullRequest(ctx, prId);
  return { result, autoDiscovered: ctx.autoDiscovered };
}

async function viewGitHubPullRequest(
  ctx: Extract<PlatformContext, { platform: 'github' }>,
  prId: number
): Promise<AidePullRequestViewResult> {
  const pr = await ctx.client.getPullRequest(ctx.owner, ctx.repo, prId);
  const url = buildGitHubPrUrl(ctx.owner, ctx.repo, prId, ctx.host);
  const repository = {
    kind: 'github',
    host: ctx.host,
    owner: ctx.owner,
    repo: ctx.repo,
  } as const;

  return {
    repository,
    repositoryLabel: repositoryLabel(repository),
    pullRequest: githubPullRequestToViewItem(pr, url),
  };
}

async function viewAzureDevOpsPullRequest(
  ctx: Extract<PlatformContext, { platform: 'azure-devops' }>,
  prId: number
): Promise<AidePullRequestViewResult> {
  const [pr, labelsResponse] = await Promise.all([
    ctx.client.getPullRequest(ctx.project, ctx.repo, prId),
    ctx.client.getPullRequestLabels(ctx.project, ctx.repo, prId),
  ]);
  const labels = labelsResponse.value
    .filter((label) => label.active)
    .map((label) => label.name);
  const repository = {
    kind: 'azure-devops',
    org: ctx.org,
    project: ctx.project,
    repo: ctx.repo,
  } as const;

  return {
    repository,
    repositoryLabel: repositoryLabel(repository),
    pullRequest: azureDevOpsPullRequestToViewItem(pr, labels),
  };
}

function githubPullRequestStatus(
  pr: GitHubPullRequest
): AidePullRequestViewItem['status'] {
  const status = getGitHubPRStatus(pr);
  if (
    status === 'active' ||
    status === 'completed' ||
    status === 'abandoned' ||
    status === 'draft'
  ) {
    return status;
  }
  return 'active';
}

function githubPullRequestToViewItem(
  pr: GitHubPullRequest,
  url: string
): AidePullRequestViewItem {
  return {
    id: pr.number,
    title: pr.title,
    status: githubPullRequestStatus(pr),
    createdAt: pr.created_at,
    author: {
      displayName: pr.user.login,
      username: pr.user.login,
    },
    ...(pr.body === null ? {} : { description: pr.body }),
    url,
    draft: pr.draft,
    sourceBranch: pr.head.ref,
    targetBranch: pr.base.ref,
    labels: pr.labels.map((label) => label.name),
  };
}

function azureDevOpsPullRequestToViewItem(
  pr: AzureDevOpsPullRequest,
  labels: readonly string[]
): AidePullRequestViewItem {
  return {
    id: pr.pullRequestId,
    title: pr.title,
    status: pr.isDraft ? 'draft' : pr.status,
    createdAt: pr.creationDate,
    author: {
      displayName: pr.createdBy.displayName,
      ...(pr.createdBy.uniqueName === undefined
        ? {}
        : { email: pr.createdBy.uniqueName }),
    },
    ...(pr.description === undefined ? {} : { description: pr.description }),
    draft: pr.isDraft ?? false,
    ...(pr.sourceRefName === undefined
      ? {}
      : { sourceBranch: extractBranchName(pr.sourceRefName) }),
    ...(pr.targetRefName === undefined
      ? {}
      : { targetBranch: extractBranchName(pr.targetRefName) }),
    labels,
  };
}

function repositoryLabel(repository: AidePullRequestRepositoryRef): string {
  switch (repository.kind) {
    case 'github':
      return `${repository.host}/${repository.owner}/${repository.repo}`;
    case 'azure-devops':
      return `${repository.org}/${repository.project}/${repository.repo}`;
    case 'external':
      return repository.displayName;
  }
}

export default {
  command: 'view [pr]',
  describe: 'View pull request details',
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
  },
  handler,
} satisfies CommandModule<object, ViewArgs>;
