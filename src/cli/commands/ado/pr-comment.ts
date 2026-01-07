/**
 * ADO pr comment command - Post a comment on a pull request
 * @see https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-threads/create?view=azure-devops-rest-7.1
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
import type { CreateThreadResponse } from '@lib/types.js';

type OutputFormat = 'text' | 'json' | 'markdown';

export interface PrCommentArgv {
  prIdOrUrl?: string;
  comment: string;
  project?: string;
  repo?: string;
  format: OutputFormat;
  file?: string;
  line?: number;
  endLine?: number;
}

/**
 * Format the output based on format type
 */
function formatOutput(
  thread: CreateThreadResponse,
  format: OutputFormat,
  prId: number,
  filePath?: string,
  line?: number
): string {
  if (format === 'json') {
    return JSON.stringify(thread, null, 2);
  }

  const comment = thread.comments[0];
  const date = new Date(thread.publishedDate).toISOString().split('T')[0];
  const locationInfo = filePath
    ? ` on ${filePath}${line ? `:${line}` : ''}`
    : '';

  if (format === 'markdown') {
    let output = `# Comment Posted on PR #${prId}\n\n`;
    output += `**Thread ID:** ${thread.id}\n`;
    output += `**Status:** ${thread.status}\n`;
    output += `**Date:** ${date}\n`;
    if (filePath) {
      output += `**Location:** \`${filePath}\``;
      if (line) {
        output += ` (line ${line}${thread.threadContext?.rightFileEnd?.line && thread.threadContext.rightFileEnd.line !== line ? `-${thread.threadContext.rightFileEnd.line}` : ''})`;
      }
      output += '\n';
    }
    output += `\n---\n\n`;
    output += `${comment?.content || ''}\n`;

    return output;
  }

  // Text format
  let output = `Comment posted successfully${locationInfo}!\n`;
  output += '='.repeat(50) + '\n\n';
  output += `Thread ID: ${thread.id}\n`;
  output += `PR: #${prId}\n`;
  output += `Status: ${thread.status}\n`;
  output += `Date: ${date}\n`;
  if (filePath) {
    output += `File: ${filePath}`;
    if (line) {
      output += `:${line}`;
      if (
        thread.threadContext?.rightFileEnd?.line &&
        thread.threadContext.rightFileEnd.line !== line
      ) {
        output += `-${thread.threadContext.rightFileEnd.line}`;
      }
    }
    output += '\n';
  }
  output += `\nComment:\n  ${comment?.content || ''}\n`;

  return output;
}

async function handler(argv: ArgumentsCamelCase<PrCommentArgv>): Promise<void> {
  let prId: number | undefined;
  let { project, repo } = argv;
  const { format, comment, file, line, endLine } = argv;

  // Validate file/line requirements
  if (file && !line) {
    console.error('Error: --line is required when --file is specified.');
    console.error(
      'To comment on a specific file location, provide both --file and --line.'
    );
    process.exit(1);
  }

  if (line && !file) {
    console.error('Error: --file is required when --line is specified.');
    console.error(
      'To comment on a specific file location, provide both --file and --line.'
    );
    process.exit(1);
  }

  if (endLine && !line) {
    console.error('Error: --line is required when --end-line is specified.');
    process.exit(1);
  }

  // Auto-discover project/repo from git remote first (needed for PR auto-detection)
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
        console.error('Error: Invalid PR ID.');
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

  try {
    const config = loadAzureDevOpsConfig();
    const client = new AzureDevOpsClient(config);

    if (format !== 'json') {
      console.log(`Posting comment to PR #${prId}...`);
      if (file) {
        console.log(`File: ${file}`);
        console.log(`Line: ${line}${endLine ? `-${endLine}` : ''}`);
      }
      console.log('');
    }

    // Create the thread with the comment
    const thread = await client.createPullRequestThread(
      project,
      repo,
      prId,
      comment,
      file && line
        ? {
            filePath: file,
            line,
            endLine,
          }
        : undefined
    );

    // Format and output
    const output = formatOutput(thread, format, prId, file, line);
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

export const prCommentCommand: CommandModule<object, PrCommentArgv> = {
  command: 'comment [prIdOrUrl] <comment>',
  describe: 'Post a comment on an Azure DevOps pull request',
  builder: {
    prIdOrUrl: {
      type: 'string',
      describe:
        'PR ID or full PR URL (auto-detected from current branch if omitted)',
    },
    comment: {
      type: 'string',
      demandOption: true,
      describe: 'Comment text to post',
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
    file: {
      type: 'string',
      describe: 'File path for file-specific comment (requires --line)',
    },
    line: {
      type: 'number',
      describe: 'Line number for file-specific comment (requires --file)',
    },
    'end-line': {
      type: 'number',
      describe: 'End line number for multi-line comment range',
    },
  },
  handler,
};
