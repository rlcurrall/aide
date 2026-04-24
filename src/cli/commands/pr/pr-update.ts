/**
 * PR update command - Update a pull request
 * Supports Azure DevOps and GitHub
 */

import { MissingRepoContextError, buildPrUrl } from '@lib/ado-utils.js';
import { logProgress } from '@lib/cli-utils.js';
import { ensureRefPrefix } from '@lib/git-utils.js';
import { handleCommandError } from '@lib/errors.js';
import type {
  AzureDevOpsPullRequest,
  GitRemoteInfo,
  PullRequestUpdateOptions,
} from '@lib/types.js';
import type { GitHubPullRequest } from '@lib/github-types.js';
import {
  resolvePlatformContext,
  resolvePRId,
  GitHubAuthError,
  type PlatformContext,
} from '@lib/platform.js';
import { buildGitHubPrUrl, getGitHubPRStatus } from '@lib/github-utils.js';
import { validateArgs } from '@lib/validation.js';
import {
  PrUpdateArgsSchema,
  type OutputFormat,
  type PrUpdateArgs,
} from '@schemas/pr/pr-update.js';
import type { ArgumentsCamelCase, CommandModule } from 'yargs';

// ============================================================================
// Azure DevOps Formatting
// ============================================================================

function formatAdoOutput(
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

// ============================================================================
// GitHub Formatting
// ============================================================================

function formatGitHubOutput(
  pr: GitHubPullRequest,
  format: OutputFormat,
  url: string
): string {
  if (format === 'json') {
    return JSON.stringify({ ...pr, url }, null, 2);
  }

  const status = getGitHubPRStatus(pr);
  const draftStatus = pr.draft ? ' [DRAFT]' : '';
  const date = new Date(pr.created_at).toISOString().split('T')[0];
  const labels = pr.labels.map((l) => l.name);

  if (format === 'markdown') {
    let output = `# PR #${pr.number} Updated${draftStatus}\n\n`;
    output += `**Title:** ${pr.title}\n`;
    output += `**Status:** ${status}\n`;
    output += `**Created:** ${date} by ${pr.user.login}\n`;
    output += `**Source:** ${pr.head.ref}\n`;
    output += `**Target:** ${pr.base.ref}\n`;
    output += `**URL:** ${url}\n`;
    if (labels.length > 0) {
      output += `**Labels:** ${labels.join(', ')}\n`;
    }
    if (pr.body) {
      output += `\n## Description\n\n${pr.body}\n`;
    }
    return output;
  }

  // Text format
  let output = `PR #${pr.number} Updated${draftStatus}\n`;
  output += '='.repeat(50) + '\n\n';
  output += `Title: ${pr.title}\n`;
  output += `Status: ${status}\n`;
  output += `Created: ${date} by ${pr.user.login}\n`;
  output += `Source: ${pr.head.ref}\n`;
  output += `Target: ${pr.base.ref}\n`;
  output += `URL: ${url}\n`;
  if (labels.length > 0) {
    output += `Labels: ${labels.join(', ')}\n`;
  }
  if (pr.body) {
    const shortDesc =
      pr.body.length > 200 ? pr.body.substring(0, 197) + '...' : pr.body;
    output += `\nDescription:\n${shortDesc}\n`;
  }

  return output;
}

// ============================================================================
// Handler
// ============================================================================

async function handler(argv: ArgumentsCamelCase<PrUpdateArgs>): Promise<void> {
  const args = validateArgs(PrUpdateArgsSchema, argv, 'pr-update arguments');
  const {
    format,
    title,
    description,
    target,
    draft,
    publish,
    abandon,
    activate,
    tag: tagsToAdd,
    removeTag: tagsToRemove,
  } = args;

  // Validate conflicting flags
  if (draft && publish) {
    throw new Error('Cannot use both --draft and --publish flags.');
  }

  if (abandon && activate) {
    throw new Error('Cannot use both --abandon and --activate flags.');
  }

  try {
    let ctx: PlatformContext | undefined;
    try {
      ctx = await resolvePlatformContext(args.project, args.repo);
      if (ctx.autoDiscovered) {
        if (ctx.platform === 'github') {
          logProgress(
            `Auto-discovered: github.com/${ctx.owner}/${ctx.repo}`,
            format
          );
        } else {
          logProgress(
            `Auto-discovered: ${ctx.org}/${ctx.project}/${ctx.repo}`,
            format
          );
        }
        logProgress('', format);
      }
    } catch (error) {
      if (
        !(
          error instanceof MissingRepoContextError ||
          error instanceof GitHubAuthError
        ) ||
        !args.pr?.startsWith('http')
      ) {
        throw error;
      }
      // Will handle below via URL parsing
      ctx = undefined;
    }

    // Resolve PR ID from --pr flag or auto-detect from current branch
    if (!ctx) {
      throw new Error(
        'Could not determine repository context. Provide a PR ID or full PR URL.'
      );
    }
    const resolved = await resolvePRId(args.pr, ctx, format);
    const prId = resolved.prId;
    ctx = resolved.ctx;

    const hasTagOps =
      (tagsToAdd && tagsToAdd.length > 0) ||
      (tagsToRemove && tagsToRemove.length > 0);

    // Check if there's anything to update
    if (
      title === undefined &&
      description === undefined &&
      target === undefined &&
      !draft &&
      !publish &&
      !abandon &&
      !activate &&
      !hasTagOps
    ) {
      throw new Error(
        'No updates specified. Use one or more of: --title, --description, --target, --draft, --publish, --abandon, --activate, --tag, --remove-tag'
      );
    }

    logProgress(`Updating PR #${prId}...`, format);
    if (title) logProgress(`  Title: ${title}`, format);
    if (description)
      logProgress(
        `  Description: ${description.substring(0, 50)}${description.length > 50 ? '...' : ''}`,
        format
      );
    if (target) logProgress(`  Target branch: ${target}`, format);
    if (draft) logProgress('  Setting as draft', format);
    if (publish) logProgress('  Publishing draft', format);
    if (abandon) logProgress('  Abandoning PR', format);
    if (activate) logProgress('  Reactivating PR', format);
    if (tagsToAdd && tagsToAdd.length > 0)
      logProgress(`  Adding tags: ${tagsToAdd.join(', ')}`, format);
    if (tagsToRemove && tagsToRemove.length > 0)
      logProgress(`  Removing tags: ${tagsToRemove.join(', ')}`, format);
    logProgress('', format);

    if (ctx.platform === 'github') {
      // =======================================================================
      // GitHub path
      // =======================================================================
      const { owner, repo } = ctx;

      // Build REST API update payload
      const ghUpdates: Record<string, unknown> = {};
      if (title !== undefined) ghUpdates.title = title;
      if (description !== undefined) ghUpdates.body = description;
      if (target !== undefined) ghUpdates.base = target;
      if (abandon) ghUpdates.state = 'closed';
      else if (activate) ghUpdates.state = 'open';

      // Apply REST updates if any
      if (Object.keys(ghUpdates).length > 0) {
        await ctx.client.updatePullRequest(
          owner,
          repo,
          prId,
          ghUpdates as {
            title?: string;
            body?: string;
            state?: 'open' | 'closed';
            base?: string;
          }
        );
      }

      // Draft/publish require GraphQL mutations (separate from REST update)
      if (draft) {
        await ctx.client.convertToDraft(owner, repo, prId);
      } else if (publish) {
        await ctx.client.publishDraftPR(owner, repo, prId);
      }

      // Handle label additions
      if (tagsToAdd && tagsToAdd.length > 0) {
        try {
          await ctx.client.addLabels(owner, repo, prId, tagsToAdd);
        } catch (error) {
          console.error(
            `Warning: Failed to add labels: ${error instanceof Error ? error.message : error}`
          );
        }
      }

      // Handle label removals
      if (tagsToRemove && tagsToRemove.length > 0) {
        for (const label of tagsToRemove) {
          try {
            await ctx.client.removeLabel(owner, repo, prId, label);
          } catch (error) {
            console.error(
              `Warning: Failed to remove label '${label}': ${error instanceof Error ? error.message : error}`
            );
          }
        }
      }

      // Refetch to get current state after all updates
      const updatedPR = await ctx.client.getPullRequest(owner, repo, prId);
      const prUrl = buildGitHubPrUrl(owner, repo, prId);
      const output = formatGitHubOutput(updatedPR, format, prUrl);
      console.log(output);
    } else {
      // =======================================================================
      // Azure DevOps path
      // =======================================================================

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

      // Perform the PR field update (if there are any field changes)
      let updatedPR: AzureDevOpsPullRequest;
      if (Object.keys(updates).length > 0) {
        updatedPR = await ctx.client.updatePullRequest(
          ctx.project,
          ctx.repo,
          prId,
          updates
        );
      } else {
        // Tag-only update - fetch current PR state
        updatedPR = await ctx.client.getPullRequest(
          ctx.project,
          ctx.repo,
          prId
        );
      }

      // Handle tag removals
      if (tagsToRemove && tagsToRemove.length > 0) {
        const labelsResponse = await ctx.client.getPullRequestLabels(
          ctx.project,
          ctx.repo,
          prId
        );
        const existingLabels = labelsResponse.value;

        for (const tagName of tagsToRemove) {
          const label = existingLabels.find(
            (l) => l.name.toLowerCase() === tagName.toLowerCase()
          );
          if (label) {
            try {
              await ctx.client.removePullRequestLabel(
                ctx.project,
                ctx.repo,
                prId,
                label.id
              );
            } catch (error) {
              console.error(
                `Warning: Failed to remove tag '${tagName}': ${error instanceof Error ? error.message : error}`
              );
            }
          } else {
            console.error(`Warning: Tag '${tagName}' not found on PR #${prId}`);
          }
        }
      }

      // Handle tag additions
      if (tagsToAdd && tagsToAdd.length > 0) {
        for (const tagName of tagsToAdd) {
          try {
            await ctx.client.addPullRequestLabel(
              ctx.project,
              ctx.repo,
              prId,
              tagName
            );
          } catch (error) {
            console.error(
              `Warning: Failed to add tag '${tagName}': ${error instanceof Error ? error.message : error}`
            );
          }
        }
      }

      // Build PR URL for output
      const { loadAzureDevOpsConfig } = await import('@lib/config.js');
      const { config } = await loadAzureDevOpsConfig();
      const repoInfo: GitRemoteInfo = {
        org: ctx.org,
        project: ctx.project,
        repo: ctx.repo,
      };
      const prUrl = buildPrUrl(repoInfo, prId, config.orgUrl);

      // Format and output
      const output = formatAdoOutput(updatedPR, format, prUrl);
      console.log(output);
    }
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
