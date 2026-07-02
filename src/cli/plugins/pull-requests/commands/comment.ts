/**
 * PR comment command - Post a comment on a pull request.
 */

import { Effect } from 'effect';
import type { ArgumentsCamelCase, Argv, CommandModule } from 'yargs';

import type { AidePullRequestCommentMutationResult } from '@cli/host/plugin-descriptor.js';
import { logProgress } from '@lib/cli-utils.js';
import { handleCommandError } from '@lib/errors.js';
import { validateArgs } from '@lib/validation.js';
import {
  PrCommentArgsSchema,
  type OutputFormat,
  type PrCommentArgs,
} from '@schemas/pr/pr-comment.js';
import { resolvePullRequestOperationContext } from './context.js';

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
