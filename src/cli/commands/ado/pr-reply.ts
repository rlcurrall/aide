/**
 * ADO pr reply command - Reply to a comment thread on a pull request
 * @see https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-thread-comments/create?view=azure-devops-rest-7.1
 */

import type { CommandModule, ArgumentsCamelCase } from 'yargs';
import { loadAzureDevOpsConfig } from '@lib/config.js';
import { AzureDevOpsClient } from '@lib/azure-devops-client.js';
import {
  discoverRepoInfo,
  parsePRUrl,
  validatePRId,
  findPRByCurrentBranch,
} from '@lib/ado-utils.js';
import type { AzureDevOpsCreateCommentResponse } from '@lib/types.js';

type OutputFormat = 'text' | 'json' | 'markdown';

export interface PrReplyArgv {
  prIdOrUrl?: string;
  replyText: string;
  thread: number;
  parent?: number;
  project?: string;
  repo?: string;
  format: OutputFormat;
}

/**
 * Format the reply output based on format type
 */
function formatOutput(
  comment: AzureDevOpsCreateCommentResponse,
  format: OutputFormat,
  prId: number,
  threadId: number
): string {
  if (format === 'json') {
    return JSON.stringify(
      {
        success: true,
        prId,
        threadId,
        commentId: comment.id,
        parentCommentId: comment.parentCommentId,
        content: comment.content,
        author: comment.author.displayName,
        publishedDate: comment.publishedDate,
      },
      null,
      2
    );
  }

  if (format === 'markdown') {
    let output = `# Reply Posted Successfully\n\n`;
    output += `- **PR:** #${prId}\n`;
    output += `- **Thread ID:** ${threadId}\n`;
    output += `- **Comment ID:** ${comment.id}\n`;
    if (comment.parentCommentId > 0) {
      output += `- **Parent Comment ID:** ${comment.parentCommentId}\n`;
    }
    output += `- **Author:** ${comment.author.displayName}\n`;
    output += `- **Posted:** ${new Date(comment.publishedDate).toLocaleString()}\n\n`;
    output += `## Content\n\n${comment.content}`;
    return output;
  }

  // Text format
  let output = `Reply posted successfully!\n`;
  output += `PR #${prId} | Thread ${threadId} | Comment ID: ${comment.id}\n`;
  if (comment.parentCommentId > 0) {
    output += `In reply to comment #${comment.parentCommentId}\n`;
  }
  output += `Posted by: ${comment.author.displayName}\n`;
  output += `Posted at: ${new Date(comment.publishedDate).toLocaleString()}`;
  return output;
}

async function handler(argv: ArgumentsCamelCase<PrReplyArgv>): Promise<void> {
  let prId: number | undefined;
  let { project, repo } = argv;
  const { format, thread, parent, replyText } = argv;

  // Auto-discover project/repo from git remote
  if (!project || !repo) {
    const discovered = discoverRepoInfo();
    if (discovered) {
      project = project || discovered.project;
      repo = repo || discovered.repo;
      if (format !== 'json') {
        console.log(
          `Auto-discovered: ${discovered.org}/${discovered.project}/${discovered.repo}`
        );
        console.log('');
      }
    }
  }

  // Parse PR ID or URL, or auto-detect from current branch
  if (argv.prIdOrUrl) {
    if (argv.prIdOrUrl.startsWith('http')) {
      const parsed = parsePRUrl(argv.prIdOrUrl);
      if (!parsed) {
        console.error(`Error: Invalid Azure DevOps PR URL: ${argv.prIdOrUrl}`);
        console.error(
          'Expected format: https://dev.azure.com/{org}/{project}/_git/{repo}/pullrequest/{id}'
        );
        process.exit(1);
      }
      prId = parsed.prId;
      // URL overrides discovered project/repo
      project = parsed.project;
      repo = parsed.repo;
    } else {
      const validation = validatePRId(argv.prIdOrUrl);
      if (validation.valid) {
        prId = validation.value;
      } else {
        console.error('Error: Invalid PR ID. Must be a positive integer.');
        process.exit(1);
      }
    }
  } else {
    // No PR ID provided - auto-detect from current branch
    // We need project/repo for this
    if (!project || !repo) {
      console.error('Error: Could not determine project and repository.');
      console.error('');
      console.error('Either:');
      console.error(
        '  1. Run this command from within a git repository with Azure DevOps remote'
      );
      console.error('  2. Specify --project and --repo flags explicitly');
      console.error('  3. Provide a PR ID or full PR URL');
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

  // Validate we have project/repo (should be set by now, but double-check)
  if (!project || !repo) {
    console.error('Error: Could not determine project and repository.');
    console.error('');
    console.error('Either:');
    console.error(
      '  1. Run this command from within a git repository with Azure DevOps remote'
    );
    console.error('  2. Specify --project and --repo flags explicitly');
    console.error('  3. Provide a full PR URL');
    process.exit(1);
  }

  // Validate prId is set (should be set by now via URL parsing or branch detection)
  if (prId === undefined) {
    console.error('Error: Could not determine PR ID.');
    console.error(
      'Please provide a PR ID, full PR URL, or run from a branch with an associated PR.'
    );
    process.exit(1);
  }

  // Validate thread ID
  if (!thread || thread <= 0) {
    console.error(
      'Error: --thread is required and must be a positive integer.'
    );
    process.exit(1);
  }

  // Validate parent comment ID if provided
  if (parent !== undefined && parent < 0) {
    console.error('Error: --parent must be a non-negative integer.');
    process.exit(1);
  }

  // Validate reply text
  if (!replyText || replyText.trim().length === 0) {
    console.error('Error: Reply text is required and cannot be empty.');
    process.exit(1);
  }

  try {
    const config = loadAzureDevOpsConfig();
    const client = new AzureDevOpsClient(config);

    if (format !== 'json') {
      console.log(`Posting reply to PR #${prId}, thread ${thread}...`);
      if (parent !== undefined && parent > 0) {
        console.log(`Replying to comment #${parent}`);
      }
      console.log('');
    }

    // Create the comment reply
    const response = await client.createThreadComment(
      project,
      repo,
      prId,
      thread,
      replyText.trim(),
      parent
    );

    // Format and output
    const output = formatOutput(response, format, prId, thread);
    console.log(output);
  } catch (error) {
    if (error instanceof Error) {
      console.error(`Error: ${error.message}`);
    } else {
      console.error('Error: Unknown error occurred');
    }
    process.exit(1);
  }
}

export const prReplyCommand: CommandModule<object, PrReplyArgv> = {
  command: 'reply [prIdOrUrl] <replyText>',
  describe: 'Reply to a comment thread on an Azure DevOps pull request',
  builder: {
    prIdOrUrl: {
      type: 'string',
      describe:
        'PR ID or full PR URL (auto-detected from current branch if omitted)',
    },
    replyText: {
      type: 'string',
      describe: 'The reply text content',
      demandOption: true,
    },
    thread: {
      type: 'number',
      describe: 'Thread ID to reply to (required)',
      demandOption: true,
    },
    parent: {
      type: 'number',
      describe:
        'Parent comment ID to reply to a specific comment (optional, 0 or omit for root-level reply)',
    },
    project: {
      type: 'string',
      describe: 'Azure DevOps project name (auto-discovered from git remote)',
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
};
