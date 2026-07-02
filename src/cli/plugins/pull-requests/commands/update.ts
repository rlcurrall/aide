/**
 * PR update command - Update a pull request.
 */

import { Effect } from 'effect';
import type { ArgumentsCamelCase, CommandModule } from 'yargs';

import type {
  AidePullRequestUpdateRequest,
  AidePullRequestUpdateResult,
} from '@cli/host/plugin-descriptor.js';
import { logProgress } from '@lib/cli-utils.js';
import { handleCommandError } from '@lib/errors.js';
import { validateArgs } from '@lib/validation.js';
import {
  PrUpdateArgsSchema,
  type OutputFormat,
  type PrUpdateArgs,
} from '@schemas/pr/pr-update.js';
import { resolvePullRequestBodyInput } from './body-input.js';
import { resolvePullRequestOperationContext } from './context.js';

type PullRequestUpdateOperationRequest = Omit<
  AidePullRequestUpdateRequest,
  'match' | 'pullRequest'
>;

export function buildPullRequestUpdateOperationRequest(
  args: PrUpdateArgs,
  description: string | undefined
): PullRequestUpdateOperationRequest {
  validatePullRequestUpdateFlags(args);

  const labelsToAdd = args.tag ?? [];
  const labelsToRemove =
    args.removeTag !== undefined && args.removeTag.length > 0
      ? args.removeTag
      : (args['remove-tag'] ?? []);
  const request: PullRequestUpdateOperationRequest = {
    ...(args.title === undefined ? {} : { title: args.title }),
    ...(description === undefined ? {} : { description }),
    ...(args.target === undefined ? {} : { targetBranch: args.target }),
    ...(args.draft ? { draft: true } : {}),
    ...(args.publish ? { draft: false } : {}),
    ...(args.abandon ? { status: 'abandoned' as const } : {}),
    ...(args.activate ? { status: 'active' as const } : {}),
    ...(labelsToAdd.length === 0 ? {} : { labelsToAdd }),
    ...(labelsToRemove.length === 0 ? {} : { labelsToRemove }),
  };

  if (!hasPullRequestUpdates(request)) {
    throw new Error(
      'No updates specified. Use one or more of: --title, --description, --target, --draft, --publish, --abandon, --activate, --tag, --remove-tag'
    );
  }

  return request;
}

export function validatePullRequestUpdateFlags(
  args: Pick<PrUpdateArgs, 'draft' | 'publish' | 'abandon' | 'activate'>
): void {
  if (args.draft && args.publish) {
    throw new Error('Cannot use both --draft and --publish flags.');
  }
  if (args.abandon && args.activate) {
    throw new Error('Cannot use both --abandon and --activate flags.');
  }
}

function hasPullRequestUpdates(
  request: PullRequestUpdateOperationRequest
): boolean {
  return (
    request.title !== undefined ||
    request.description !== undefined ||
    request.targetBranch !== undefined ||
    request.draft !== undefined ||
    request.status !== undefined ||
    (request.labelsToAdd !== undefined && request.labelsToAdd.length > 0) ||
    (request.labelsToRemove !== undefined && request.labelsToRemove.length > 0)
  );
}

export function formatPullRequestUpdateOutput(
  result: AidePullRequestUpdateResult,
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

  const createdDate = formatDate(pr.createdAt);
  const sourceBranch = pr.sourceBranch ?? 'unknown';
  const targetBranch = pr.targetBranch ?? 'unknown';
  const labels = pr.labels ?? [];
  const draftStatus = pr.draft || pr.status === 'draft' ? ' [DRAFT]' : '';
  const statusDisplay =
    pr.draft && pr.status !== 'draft' ? `${pr.status} (draft)` : pr.status;

  if (format === 'markdown') {
    let output = `# PR #${pr.id} Updated${draftStatus}\n\n`;
    output += `**Title:** ${pr.title}\n`;
    output += `**Status:** ${statusDisplay}\n`;
    output += `**Created:** ${createdDate} by ${pr.author.displayName}\n`;
    output += `**Source:** ${sourceBranch}\n`;
    output += `**Target:** ${targetBranch}\n`;
    if (result.repositoryLabel !== undefined) {
      output += `**Repository:** ${result.repositoryLabel}\n`;
    }
    if (pr.url !== undefined) {
      output += `**URL:** ${pr.url}\n`;
    }
    if (labels.length > 0) {
      output += `**Labels:** ${labels.join(', ')}\n`;
    }
    if (pr.description) {
      output += `\n## Description\n\n${pr.description}\n`;
    }
    return output;
  }

  let output = `PR #${pr.id} Updated${draftStatus}\n`;
  output += '='.repeat(50) + '\n\n';
  output += `Title: ${pr.title}\n`;
  output += `Status: ${statusDisplay}\n`;
  output += `Created: ${createdDate} by ${pr.author.displayName}\n`;
  output += `Source: ${sourceBranch}\n`;
  output += `Target: ${targetBranch}\n`;
  if (result.repositoryLabel !== undefined) {
    output += `Repository: ${result.repositoryLabel}\n`;
  }
  if (pr.url !== undefined) {
    output += `URL: ${pr.url}\n`;
  }
  if (labels.length > 0) {
    output += `Labels: ${labels.join(', ')}\n`;
  }
  if (pr.description) {
    const shortDescription =
      pr.description.length > 200
        ? `${pr.description.substring(0, 197)}...`
        : pr.description;
    output += `\nDescription:\n${shortDescription}\n`;
  }
  return output;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toISOString().split('T')[0]!
    : value;
}

function logUpdateProgress(
  prNumber: number,
  request: PullRequestUpdateOperationRequest,
  format: OutputFormat
): void {
  logProgress(`Updating PR #${prNumber}...`, format);
  if (request.title !== undefined) {
    logProgress(`  Title: ${request.title}`, format);
  }
  if (request.description !== undefined) {
    logProgress(
      `  Description: ${request.description.substring(0, 50)}${request.description.length > 50 ? '...' : ''}`,
      format
    );
  }
  if (request.targetBranch !== undefined) {
    logProgress(`  Target branch: ${request.targetBranch}`, format);
  }
  if (request.draft === true) {
    logProgress('  Setting as draft', format);
  } else if (request.draft === false) {
    logProgress('  Publishing draft', format);
  }
  if (request.status === 'abandoned') {
    logProgress('  Abandoning PR', format);
  } else if (request.status === 'active') {
    logProgress('  Reactivating PR', format);
  }
  if (request.labelsToAdd !== undefined && request.labelsToAdd.length > 0) {
    logProgress(`  Adding tags: ${request.labelsToAdd.join(', ')}`, format);
  }
  if (
    request.labelsToRemove !== undefined &&
    request.labelsToRemove.length > 0
  ) {
    logProgress(
      `  Removing tags: ${request.labelsToRemove.join(', ')}`,
      format
    );
  }
  logProgress('', format);
}

function logUpdateWarnings(
  result: AidePullRequestUpdateResult,
  format: OutputFormat
): void {
  if (format === 'json') return;
  for (const warning of result.warnings ?? []) {
    console.error(`Warning: ${warning}`);
  }
}

async function handler(argv: ArgumentsCamelCase<PrUpdateArgs>): Promise<void> {
  try {
    const args = validateArgs(PrUpdateArgsSchema, argv, 'pr-update arguments');
    validatePullRequestUpdateFlags(args);

    const format = args.format ?? 'text';
    const description = await resolvePullRequestBodyInput(args);
    const updateRequest = buildPullRequestUpdateOperationRequest(
      args,
      description
    );
    const resolved = await resolvePullRequestOperationContext(
      argv,
      args,
      format
    );
    if (
      resolved.autoDiscovered &&
      resolved.context.result.repositoryLabel !== undefined
    ) {
      logProgress(
        `Auto-discovered: ${resolved.context.result.repositoryLabel}`,
        format
      );
      logProgress('', format);
    }

    const prNumber = resolved.context.result.pullRequest.id;
    logUpdateProgress(prNumber, updateRequest, format);
    const result = await Effect.runPromise(
      resolved.context.updatePullRequest({
        pullRequest: { number: prNumber },
        ...updateRequest,
      })
    );

    logUpdateWarnings(result, format);
    console.log(formatPullRequestUpdateOutput(result, format));
  } catch (error) {
    handleCommandError(error);
  }
}

export default {
  command: 'update',
  describe: 'Update a pull request',
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
    title: {
      type: 'string',
      describe: 'New title for the PR',
    },
    description: {
      type: 'string',
      describe: 'New description for the PR',
      alias: 'body',
      nargs: 1,
      requiresArg: true,
    },
    'description-file': {
      type: 'string',
      describe: 'Read new description from a file, or - for stdin',
      alias: 'body-file',
      nargs: 1,
      requiresArg: true,
    },
    target: {
      type: 'string',
      describe: 'New target branch name (e.g., main, develop)',
    },
    draft: {
      type: 'boolean',
      describe: 'Mark the PR as a draft',
    },
    publish: {
      type: 'boolean',
      describe: 'Publish a draft PR (sets draft=false)',
    },
    abandon: {
      type: 'boolean',
      describe: 'Abandon the PR',
    },
    activate: {
      type: 'boolean',
      describe: 'Reactivate an abandoned PR',
    },
    tag: {
      type: 'array',
      string: true,
      describe: 'Add tag(s) to the PR',
    },
    'remove-tag': {
      type: 'array',
      string: true,
      describe: 'Remove tag(s) from the PR',
    },
  },
  handler,
} satisfies CommandModule<object, PrUpdateArgs>;
