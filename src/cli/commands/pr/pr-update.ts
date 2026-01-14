/**
 * PR update command - Update a pull request
 * Supports Azure DevOps (with GitHub support planned)
 * @see https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-requests/update?view=azure-devops-rest-7.1
 */

import {
  buildPrUrl,
  ensureRefPrefix,
  findPRByCurrentBranch,
  getMissingRepoErrorMessage,
  parsePRUrl,
  resolveRepoContext,
  validatePRId,
} from '@lib/ado-utils.js';
import { AzureDevOpsClient } from '@lib/azure-devops-client.js';
import { loadAzureDevOpsConfig } from '@lib/config.js';
import { handleCommandError } from '@lib/errors.js';
import type {
  AzureDevOpsPullRequest,
  GitRemoteInfo,
  PullRequestUpdateOptions,
} from '@lib/types.js';
import { validateArgs } from '@lib/validation.js';
import {
  PrUpdateArgsSchema,
  type OutputFormat,
  type PrUpdateArgs,
} from '@schemas/pr/pr-update.js';
import type { ArgumentsCamelCase, CommandModule } from 'yargs';

/**
 * Format updated PR output based on format type
 */
function formatOutput(
  pr: AzureDevOpsPullRequest,
  format: OutputFormat,
  prUrl?: string
): string {
  if (format === 'json') {
    return prUrl
      ? JSON.stringify({ ...pr, url: prUrl }, null, 2)
      : JSON.stringify(pr, null, 2);
  }

  const date = new Date(pr.creationDate).toISOString().split('T')[0];
  const draftStatus = pr.isDraft ? ' [DRAFT]' : '';

  if (format === 'markdown') {
    let output = `# PR #${pr.pullRequestId} Updated${draftStatus}\n\n`;
    output += `**Title:** ${pr.title}\n`;
    output += `**Status:** ${pr.status}\n`;
    output += `**Created:** ${date} by ${pr.createdBy.displayName}\n`;
    if (pr.sourceRefName) {
      output += `**Source:** ${pr.sourceRefName.replace('refs/heads/', '')}\n`;
    }
    if (pr.targetRefName) {
      output += `**Target:** ${pr.targetRefName.replace('refs/heads/', '')}\n`;
    }
    if (pr.description) {
      output += `\n## Description\n\n${pr.description}\n`;
    }
    return output;
  }

  // Text format
  let output = `PR #${pr.pullRequestId} Updated${draftStatus}\n`;
  output += '='.repeat(50) + '\n\n';
  output += `Title: ${pr.title}\n`;
  output += `Status: ${pr.status}\n`;
  output += `Created: ${date} by ${pr.createdBy.displayName}\n`;
  if (pr.sourceRefName) {
    output += `Source: ${pr.sourceRefName.replace('refs/heads/', '')}\n`;
  }
  if (pr.targetRefName) {
    output += `Target: ${pr.targetRefName.replace('refs/heads/', '')}\n`;
  }
  if (pr.description) {
    const shortDesc =
      pr.description.length > 200
        ? pr.description.substring(0, 197) + '...'
        : pr.description;
    output += `\nDescription:\n${shortDesc}\n`;
  }

  return output;
}

async function handler(argv: ArgumentsCamelCase<PrUpdateArgs>): Promise<void> {
  const args = validateArgs(PrUpdateArgsSchema, argv, 'pr-update arguments');
  let prId: number | undefined;
  let project: string | undefined = args.project;
  let repo: string | undefined = args.repo;
  const {
    format,
    title,
    description,
    target,
    draft,
    publish,
    abandon,
    activate,
  } = args;
  let repoInfo: GitRemoteInfo | undefined;

  // Validate conflicting flags
  if (draft && publish) {
    console.error('Error: Cannot use both --draft and --publish flags.');
    process.exit(1);
  }

  if (abandon && activate) {
    console.error('Error: Cannot use both --abandon and --activate flags.');
    process.exit(1);
  }

  // Try auto-discover project/repo from git remote first (needed for PR auto-detection)
  try {
    const context = resolveRepoContext(project, repo);
    if (context.autoDiscovered && context.repoInfo && format !== 'json') {
      console.log(
        `Auto-discovered: ${context.repoInfo.org}/${context.repoInfo.project}/${context.repoInfo.repo}`
      );
      console.log('');
    }
    project = context.project;
    repo = context.repo;
    repoInfo = context.repoInfo;
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
      // URL overrides discovered project/repo
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
    // We need project/repo for this
    if (!project || !repo) {
      console.error(
        getMissingRepoErrorMessage('Provide a PR ID or full PR URL')
      );
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
    console.error(getMissingRepoErrorMessage('Provide a full PR URL'));
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

  // Build update options
  const updates: PullRequestUpdateOptions = {};

  if (title !== undefined) {
    updates.title = title;
  }

  if (description !== undefined) {
    updates.description = description;
  }

  if (draft) {
    updates.isDraft = true;
  } else if (publish) {
    updates.isDraft = false;
  }

  if (abandon) {
    updates.status = 'abandoned';
  } else if (activate) {
    updates.status = 'active';
  }

  if (target) {
    updates.targetRefName = ensureRefPrefix(target);
  }

  // Check if there's anything to update
  if (Object.keys(updates).length === 0) {
    console.error('Error: No updates specified.');
    console.error('');
    console.error('Use one or more of these flags:');
    console.error('  --title "New title"');
    console.error('  --description "New description"');
    console.error('  --target main (change target branch)');
    console.error('  --draft       (mark as draft)');
    console.error('  --publish     (publish draft PR)');
    console.error('  --abandon     (abandon PR)');
    console.error('  --activate    (reactivate abandoned PR)');
    process.exit(1);
  }

  try {
    const config = loadAzureDevOpsConfig();
    const client = new AzureDevOpsClient(config);

    if (format !== 'json') {
      console.log(`Updating PR #${prId}...`);
      if (title) console.log(`  Title: ${title}`);
      if (description)
        console.log(
          `  Description: ${description.substring(0, 50)}${description.length > 50 ? '...' : ''}`
        );
      if (target) console.log(`  Target branch: ${target}`);
      if (draft) console.log('  Setting as draft');
      if (publish) console.log('  Publishing draft');
      if (abandon) console.log('  Abandoning PR');
      if (activate) console.log('  Reactivating PR');
      console.log('');
    }

    // Perform the update
    const updatedPR = await client.updatePullRequest(
      project,
      repo,
      prId,
      updates
    );

    // Build PR URL for output
    const prUrl = buildPrUrl(
      repoInfo || { org: '', project, repo },
      prId,
      config.orgUrl
    );

    // Format and output
    const output = formatOutput(updatedPR, format, prUrl);
    console.log(output);
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
      describe: 'Publish a draft PR (sets isDraft=false)',
    },
    abandon: {
      type: 'boolean',
      describe: 'Abandon the PR',
    },
    activate: {
      type: 'boolean',
      describe: 'Reactivate an abandoned PR',
    },
  },
  handler,
} satisfies CommandModule<object, PrUpdateArgs>;
