/**
 * Jira search command
 * Search for Jira tickets using JQL (Jira Query Language)
 */

import type { ArgumentsCamelCase, CommandModule } from 'yargs';
import { loadConfig } from '@lib/config.js';
import { JiraClient } from '@lib/jira-client.js';
import { formatSearchResults } from '@lib/cli-utils.js';
import { validateArgs } from '@lib/validation.js';
import { SearchArgsSchema, type SearchArgs } from '@schemas/jira/search.js';
import { handleCommandError } from '@lib/errors.js';
import { logProgress } from '@lib/jira-utils.js';

async function handler(argv: ArgumentsCamelCase<SearchArgs>): Promise<void> {
  // Validate arguments with Valibot schema
  const validated = validateArgs(SearchArgsSchema, argv, 'search arguments');
  const maxResults = validated.maxResults ?? validated.limit ?? 50;
  const format = validated.format;

  try {
    const config = loadConfig();
    const client = new JiraClient(config);

    let query = validated.query;

    // Resolve active sprint from board ID and prepend to JQL
    if (validated.sprintBoard) {
      logProgress(
        `Resolving active sprint for board ${validated.sprintBoard}...`,
        format
      );

      const sprintResponse = await client.getSprintsForBoard(
        validated.sprintBoard,
        'active'
      );

      if (sprintResponse.values.length === 0) {
        throw new Error(
          `No active sprint found for board ${validated.sprintBoard}`
        );
      }

      if (sprintResponse.values.length > 1) {
        const listing = sprintResponse.values
          .map((s) => `  [${s.id}] ${s.name}`)
          .join('\n');
        throw new Error(
          `Multiple active sprints found for board ${validated.sprintBoard}. ` +
            `Use a JQL query with a specific sprint ID instead:\n\n${listing}`
        );
      }

      const sprint = sprintResponse.values[0]!;
      query = `sprint = ${sprint.id} AND (${query})`;

      logProgress(`Active sprint: ${sprint.name} (ID: ${sprint.id})`, format);
      logProgress('', format);
    }

    logProgress(`Searching Jira for: ${query}`, format);
    logProgress(`Max results: ${maxResults}`, format);
    logProgress('', format);

    const response = await client.searchIssues(query, maxResults);

    if (format === 'json') {
      console.log(JSON.stringify(response, null, 2));
    } else {
      const output = formatSearchResults(response);
      console.log(output);
    }
  } catch (error) {
    handleCommandError(error);
  }
}

export default {
  command: 'search <query> [maxResults]',
  describe: 'Search Jira tickets using JQL',
  builder: {
    query: {
      type: 'string',
      describe: 'JQL query string',
      demandOption: true,
    },
    maxResults: {
      type: 'number',
      describe: 'Maximum results to return (default: 50)',
    },
    limit: {
      type: 'number',
      describe: 'Alias for maxResults',
    },
    'sprint-board': {
      type: 'number',
      describe:
        'Board ID to resolve active sprint from (prepends sprint filter to JQL)',
    },
    format: {
      type: 'string',
      choices: ['text', 'json', 'markdown'] as const,
      default: 'text' as const,
      describe: 'Output format',
    },
  },
  handler,
} satisfies CommandModule<object, SearchArgs>;
