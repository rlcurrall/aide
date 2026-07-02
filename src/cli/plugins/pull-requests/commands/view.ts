/**
 * PR view command - Get details for a pull request
 * Supports Azure DevOps and GitHub
 */

import { Effect } from 'effect';
import type { ArgumentsCamelCase, CommandModule } from 'yargs';

import type { AidePullRequestViewResult } from '@cli/host/plugin-descriptor.js';
import { getAideHostContext } from '@cli/host/runtime-context.js';
import { validatePRId } from '@lib/ado-utils.js';
import { logProgress } from '@lib/cli-utils.js';
import { handleCommandError } from '@lib/errors.js';
import { getCurrentBranch, getGitRemoteUrl } from '@lib/git-utils.js';
import { validateArgs } from '@lib/validation.js';
import {
  ViewArgsSchema,
  type OutputFormat,
  type ViewArgs,
} from '@schemas/pr/view.js';
import { resolveExplicitPullRequestRepositoryRef } from './repository-ref.js';

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
    const resolved = await resolvePullRequestView(argv, args, format);

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

async function resolvePullRequestView(
  argv: ArgumentsCamelCase<ViewArgs>,
  args: ViewArgs,
  format: OutputFormat
): Promise<{
  readonly result: AidePullRequestViewResult;
  readonly autoDiscovered: boolean;
}> {
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
    const { result, autoDiscovered } = hasExplicitRepoContext
      ? await (async () => {
          const { repository, autoDiscovered } =
            await resolveExplicitPullRequestRepositoryRef(
              args.project,
              args.repo
            );
          const result = await Effect.runPromise(
            hostContext.services.findPullRequestForBranchForRepository(
              repository,
              {
                branch,
              }
            )
          );
          return { result, autoDiscovered };
        })()
      : await (async () => {
          const remoteUrl = getGitRemoteUrl();
          if (!remoteUrl) {
            throw new Error(
              'Could not determine repository context. Provide a PR ID, full PR URL, or run from a git repository with a supported remote.'
            );
          }
          const result = await Effect.runPromise(
            hostContext.services.findPullRequestForBranchForRemote(remoteUrl, {
              branch,
            })
          );
          return { result, autoDiscovered: true };
        })();

    logProgress(
      `Found PR #${result.pullRequest.id}: ${result.pullRequest.title}`,
      format
    );
    logProgress('', format);
    return { result, autoDiscovered };
  }

  if (args.pr.startsWith('http')) {
    const result = await Effect.runPromise(
      hostContext.services.getPullRequestForUrl(args.pr)
    );
    return { result, autoDiscovered: false };
  }

  const validation = validatePRId(args.pr);
  if (!validation.valid || validation.value === undefined) {
    throw new Error(
      `Could not parse '${args.pr}' as a PR ID. Expected a positive number or full PR URL.`
    );
  }

  if (hasExplicitRepoContext) {
    const { repository, autoDiscovered } =
      await resolveExplicitPullRequestRepositoryRef(args.project, args.repo);
    const result = await Effect.runPromise(
      hostContext.services.getPullRequestForRepository(repository, {
        pullRequest: { number: validation.value },
      })
    );
    return { result, autoDiscovered };
  }

  const remoteUrl = getGitRemoteUrl();
  if (!remoteUrl) {
    throw new Error(
      'Could not determine repository context. Provide a full PR URL or run from a git repository with a supported remote.'
    );
  }

  const result = await Effect.runPromise(
    hostContext.services.getPullRequestForRemote(remoteUrl, {
      pullRequest: { number: validation.value },
    })
  );
  return { result, autoDiscovered: true };
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
