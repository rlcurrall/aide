/**
 * Jira comments command
 * Retrieve comments from a specific Jira ticket with filtering options
 */

import type { ArgumentsCamelCase, CommandModule } from 'yargs';
import { loadConfig } from '@lib/config.js';
import { JiraClient } from '@lib/jira-client.js';
import { validateArgs } from '@lib/validation.js';
import {
  filterComments,
  formatCommentsOutput,
  type CommentFilter,
} from '@lib/comment-utils.js';
import type { JiraComment } from '@lib/types.js';
import {
  CommentsArgsSchema,
  type CommentsArgs,
} from '@schemas/jira/comments.js';
import { handleCommandError } from '@lib/errors.js';
import { validateTicketKeyWithWarning, logProgress } from '@lib/jira-utils.js';

/**
 * Fetch all comments with pagination support
 */
async function getAllComments(
  client: JiraClient,
  issueKey: string,
  maxTotal: number = 1000
): Promise<JiraComment[]> {
  const allComments: JiraComment[] = [];
  let startAt = 0;
  const maxResults = 100; // Jira's limit per call

  while (allComments.length < maxTotal) {
    const response = await client.getComments(issueKey, startAt, maxResults);

    if (!response.comments || response.comments.length === 0) {
      break;
    }

    allComments.push(...response.comments);

    // Check if we've got all comments
    if (
      allComments.length >= response.total ||
      response.comments.length < maxResults
    ) {
      break;
    }

    startAt += maxResults;
  }

  return allComments;
}

async function handler(argv: ArgumentsCamelCase<CommentsArgs>): Promise<void> {
  const args = validateArgs(CommentsArgsSchema, argv, 'comments arguments');
  const { ticketKey, format, author, since, latest, maxResults, all } = args;

  // Validate ticket key format (soft validation with warning)
  validateTicketKeyWithWarning(ticketKey);

  try {
    const config = loadConfig();
    const client = new JiraClient(config);

    logProgress(`Fetching comments for ticket: ${ticketKey}`, format);
    if (author) logProgress(`Filtering by author: ${author}`, format);
    if (since) logProgress(`Since date: ${since}`, format);
    if (latest) logProgress(`Latest: ${latest} comments`, format);
    logProgress('', format);

    // Fetch comments
    let comments: JiraComment[];
    if (all) {
      comments = await getAllComments(client, ticketKey);
    } else {
      const response = await client.getComments(ticketKey, 0, maxResults);
      comments = response.comments || [];
    }

    // Apply filters
    const filter: CommentFilter = {
      author,
      sinceDate: since,
      latest,
    };
    const filteredComments = filterComments(comments, filter);

    // Format and output
    const output = formatCommentsOutput(filteredComments, format, ticketKey);
    console.log(output);
  } catch (error) {
    handleCommandError(error);
  }
}

export default {
  command: 'comments <ticketKey>',
  describe: 'Get comments from a ticket',
  builder: {
    ticketKey: {
      type: 'string',
      describe: 'Jira ticket key (e.g., PROJ-123)',
      demandOption: true,
    },
    format: {
      type: 'string',
      choices: ['text', 'json', 'markdown'] as const,
      default: 'text' as const,
      describe: 'Output format',
    },
    author: {
      type: 'string',
      describe: 'Filter comments by author name/email',
    },
    since: {
      type: 'string',
      describe: 'Show comments since date (YYYY-MM-DD)',
    },
    latest: {
      type: 'number',
      describe: 'Show only N most recent comments',
    },
    'max-results': {
      type: 'number',
      default: 100,
      describe: 'Maximum comments to fetch per API call',
    },
    all: {
      type: 'boolean',
      default: false,
      describe: 'Fetch all comments (may require multiple API calls)',
    },
  },
  handler,
} satisfies CommandModule<object, CommentsArgs>;
