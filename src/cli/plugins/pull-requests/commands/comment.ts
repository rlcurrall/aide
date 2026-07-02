/**
 * PR comment command - Post a comment on a pull request.
 */

import { Effect } from 'effect';
import type { ArgumentsCamelCase, Argv, CommandModule } from 'yargs';

import type {
  AidePullRequestAddCommentRequest,
  AidePullRequestCommentMutationResult,
  AidePullRequestReplyCommentRequest,
  AidePullRequestViewResult,
} from '@cli/host/plugin-descriptor.js';
import { getAideHostContext } from '@cli/host/runtime-context.js';
import { validatePRId } from '@lib/ado-utils.js';
import { logProgress } from '@lib/cli-utils.js';
import { handleCommandError } from '@lib/errors.js';
import { getCurrentBranch, getGitRemoteUrl } from '@lib/git-utils.js';
import { validateArgs } from '@lib/validation.js';
import {
  PrCommentArgsSchema,
  type OutputFormat,
  type PrCommentArgs,
} from '@schemas/pr/pr-comment.js';
import { resolveExplicitPullRequestRepositoryRef } from './repository-ref.js';

export interface ProviderMutationContext {
  readonly provider: {
    readonly providerId: string;
  };
  readonly result: AidePullRequestViewResult;
  readonly addPullRequestComment: (
    request: Omit<AidePullRequestAddCommentRequest, 'match'>
  ) => Effect.Effect<AidePullRequestCommentMutationResult, unknown, never>;
  readonly replyToPullRequestComment: (
    request: Omit<AidePullRequestReplyCommentRequest, 'match'>
  ) => Effect.Effect<AidePullRequestCommentMutationResult, unknown, never>;
}

export interface ResolvedMutationContext {
  readonly context: ProviderMutationContext;
  readonly autoDiscovered: boolean;
}

export interface PullRequestContextArgs {
  readonly pr?: string;
  readonly project?: string;
  readonly repo?: string;
}

export function formatPullRequestCommentMutationOutput(
  result: AidePullRequestCommentMutationResult,
  format: OutputFormat,
  options: {
    readonly action: 'comment' | 'reply';
    readonly targetId?: number;
  }
): string {
  if (format === 'json') {
    return JSON.stringify(
      {
        success: true,
        action: options.action,
        prId: result.pullRequest.number,
        repository: result.repository,
        repositoryLabel: result.repositoryLabel,
        ...(options.targetId === undefined
          ? {}
          : { targetId: options.targetId }),
        comment: result.comment,
        ...(result.thread === undefined ? {} : { thread: result.thread }),
      },
      null,
      2
    );
  }

  const title =
    options.action === 'reply' ? 'Reply Posted Successfully' : 'Comment Posted';
  const comment = result.comment;
  const date = new Date(comment.createdAt);
  const dateText = Number.isFinite(date.getTime())
    ? date.toLocaleString()
    : comment.createdAt;
  const fileInfo =
    comment.filePath === undefined
      ? ''
      : ` on ${comment.filePath}${comment.lineNumber === undefined ? '' : `:${comment.lineNumber}`}`;

  if (format === 'markdown') {
    let output = `# ${title}\n\n`;
    output += `- **PR:** #${result.pullRequest.number}\n`;
    if (result.repositoryLabel !== undefined) {
      output += `- **Repository:** ${result.repositoryLabel}\n`;
    }
    if (result.thread !== undefined) {
      output += `- **Thread ID:** ${result.thread.id}\n`;
    }
    if (options.targetId !== undefined) {
      output += `- **In Reply To:** ${options.targetId}\n`;
    }
    output += `- **Comment ID:** ${comment.id}\n`;
    output += `- **Type:** ${comment.kind}\n`;
    output += `- **Author:** ${comment.author.displayName}\n`;
    output += `- **Posted:** ${dateText}\n`;
    if (comment.filePath !== undefined) {
      output += `- **Location:** \`${comment.filePath}\``;
      if (comment.lineNumber !== undefined) {
        output += ` line ${comment.lineNumber}`;
      }
      output += '\n';
    }
    if (comment.url !== undefined) {
      output += `- **URL:** ${comment.url}\n`;
    }
    output += `\n## Content\n\n${comment.body}`;
    return output;
  }

  let output =
    options.action === 'reply'
      ? `Reply posted successfully${fileInfo}!\n`
      : `Comment posted successfully${fileInfo}!\n`;
  output += '='.repeat(50) + '\n\n';
  output += `PR: #${result.pullRequest.number}\n`;
  if (result.repositoryLabel !== undefined) {
    output += `Repository: ${result.repositoryLabel}\n`;
  }
  if (result.thread !== undefined) {
    output += `Thread ID: ${result.thread.id}\n`;
  }
  if (options.targetId !== undefined) {
    output += `In Reply To: ${options.targetId}\n`;
  }
  output += `Comment ID: ${comment.id}\n`;
  output += `Type: ${comment.kind}\n`;
  output += `Author: ${comment.author.displayName}\n`;
  output += `Date: ${dateText}\n`;
  if (comment.filePath !== undefined) {
    output += `File: ${comment.filePath}`;
    if (comment.lineNumber !== undefined) {
      output += `:${comment.lineNumber}`;
    }
    output += '\n';
  }
  if (comment.url !== undefined) {
    output += `URL: ${comment.url}\n`;
  }
  output += `\nComment:\n  ${comment.body}\n`;
  return output;
}

export async function resolvePullRequestMutationContext(
  argv: ArgumentsCamelCase<PullRequestContextArgs>,
  args: PullRequestContextArgs,
  format: OutputFormat
): Promise<ResolvedMutationContext> {
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
              { branch }
            )
          );
          return { context, autoDiscovered: true };
        })();

    logProgress(
      `Found PR #${found.context.result.pullRequest.id}: ${found.context.result.pullRequest.title}`,
      format
    );
    logProgress('', format);
    return {
      context: found.context,
      autoDiscovered: found.autoDiscovered,
    };
  }

  if (args.pr.startsWith('http')) {
    const context = await Effect.runPromise(
      hostContext.services.getPullRequestContextForUrl(args.pr)
    );
    return { context, autoDiscovered: false };
  }

  const validation = validatePRId(args.pr);
  if (!validation.valid || validation.value === undefined) {
    throw new Error(
      `Could not parse '${args.pr}' as a PR ID. Expected a positive number or full PR URL.`
    );
  }
  const prNumber = validation.value;

  if (hasExplicitRepoContext) {
    const { repository, autoDiscovered } =
      await resolveExplicitPullRequestRepositoryRef(args.project, args.repo);
    const context = await Effect.runPromise(
      hostContext.services.getPullRequestContextForRepository(repository, {
        pullRequest: { number: prNumber },
      })
    );
    return { context, autoDiscovered };
  }

  const remoteUrl = gitRemoteOrThrow(
    'Could not determine repository context. Provide a full PR URL or run from a git repository with a supported remote.'
  );
  const context = await Effect.runPromise(
    hostContext.services.getPullRequestContextForRemote(remoteUrl, {
      pullRequest: { number: prNumber },
    })
  );
  return { context, autoDiscovered: true };
}

function gitRemoteOrThrow(message: string): string {
  const remoteUrl = getGitRemoteUrl();
  if (!remoteUrl) {
    throw new Error(message);
  }
  return remoteUrl;
}

export function validatePullRequestCommentLocation(
  args: Pick<PrCommentArgs, 'file' | 'line' | 'endLine'>
): void {
  if (args.file !== undefined && args.file.trim() === '') {
    throw new Error('--file cannot be empty.');
  }
  if (args.file !== undefined && args.line === undefined) {
    throw new Error(
      '--line is required when --file is specified. To comment on a specific file location, provide both --file and --line.'
    );
  }
  if (args.line !== undefined && args.file === undefined) {
    throw new Error(
      '--file is required when --line is specified. To comment on a specific file location, provide both --file and --line.'
    );
  }
  if (args.endLine !== undefined && args.line === undefined) {
    throw new Error('--line is required when --end-line is specified.');
  }
  if (
    args.endLine !== undefined &&
    args.line !== undefined &&
    args.endLine < args.line
  ) {
    throw new Error('--end-line must be greater than or equal to --line.');
  }
}

async function handler(argv: ArgumentsCamelCase<PrCommentArgs>): Promise<void> {
  try {
    const args = validateArgs(
      PrCommentArgsSchema,
      argv,
      'pr-comment arguments'
    );
    validatePullRequestCommentLocation(args);

    const { format, comment, file, line, endLine } = args;
    const resolved = await resolvePullRequestMutationContext(
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
    logProgress(`Posting comment to PR #${prNumber}...`, format);
    if (file !== undefined) {
      logProgress(`File: ${file}`, format);
      logProgress(`Line: ${line}${endLine ? `-${endLine}` : ''}`, format);
    }
    logProgress('', format);

    const result = await Effect.runPromise(
      resolved.context.addPullRequestComment({
        pullRequest: { number: prNumber },
        body: comment,
        ...(file === undefined || line === undefined
          ? {}
          : {
              position: {
                filePath: file,
                lineNumber: line,
                ...(endLine === undefined ? {} : { endLineNumber: endLine }),
              },
            }),
      })
    );

    console.log(
      formatPullRequestCommentMutationOutput(result, format, {
        action: 'comment',
      })
    );
  } catch (error) {
    handleCommandError(error);
  }
}

export default {
  command: 'comment <comment>',
  describe: 'Post a comment on a pull request',
  builder: (yargs: Argv) =>
    yargs
      .positional('comment', {
        type: 'string',
        demandOption: true,
        describe: 'Comment text to post',
        coerce: (val: unknown) => (val !== undefined ? String(val) : undefined),
      })
      .option('pr', {
        type: 'string',
        describe:
          'PR ID or full PR URL (auto-detected from current branch if omitted)',
        coerce: (val: unknown) => (val !== undefined ? String(val) : undefined),
      })
      .option('project', {
        type: 'string',
        describe: 'Project name (auto-discovered from git remote)',
      })
      .option('repo', {
        type: 'string',
        describe: 'Repository name (auto-discovered from git remote)',
      })
      .option('format', {
        type: 'string',
        choices: ['text', 'json', 'markdown'] as const,
        default: 'text' as const,
        describe: 'Output format',
      })
      .option('file', {
        type: 'string',
        describe: 'File path for file-specific comment (requires --line)',
      })
      .option('line', {
        type: 'number',
        describe: 'Line number for file-specific comment (requires --file)',
      })
      .option('end-line', {
        type: 'number',
        describe: 'End line number for multi-line comment range',
      }) as Argv<PrCommentArgs>,
  handler,
} satisfies CommandModule<object, PrCommentArgs>;
