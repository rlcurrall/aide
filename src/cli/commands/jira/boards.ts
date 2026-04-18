/**
 * Jira boards command
 * List Jira boards, optionally filtered by project
 */

import type { ArgumentsCamelCase, CommandModule } from 'yargs';
import { loadConfig } from '@lib/config.js';
import { JiraClient } from '@lib/jira-client.js';
import { validateArgs } from '@lib/validation.js';
import { BoardsArgsSchema, type BoardsArgs } from '@schemas/jira/boards.js';
import { handleCommandError } from '@lib/errors.js';
import { logProgress } from '@lib/jira-utils.js';
import type { JiraBoard } from '@lib/types.js';

function formatBoardText(board: JiraBoard): string {
  const location = board.location?.projectKey
    ? ` (${board.location.projectKey})`
    : '';
  return `  [${board.id}] ${board.name} - ${board.type}${location}`;
}

function formatBoardsMarkdown(boards: JiraBoard[], project?: string): string {
  const lines: string[] = [];
  const heading = project ? `Boards for ${project}` : 'All Boards';
  lines.push(`# ${heading}`);
  lines.push('');
  lines.push('| ID | Name | Type | Project |');
  lines.push('|----|------|------|---------|');
  for (const board of boards) {
    const proj = board.location?.projectKey || '';
    lines.push(`| ${board.id} | ${board.name} | ${board.type} | ${proj} |`);
  }
  return lines.join('\n');
}

async function handler(argv: ArgumentsCamelCase<BoardsArgs>): Promise<void> {
  const args = validateArgs(BoardsArgsSchema, argv, 'boards arguments');
  const { project, format } = args;

  try {
    const { config } = await loadConfig();
    const client = new JiraClient(config);

    const label = project ? `boards for project ${project}` : 'all boards';
    logProgress(`Fetching ${label}...`, format);
    logProgress('', format);

    const response = await client.listBoards(project);
    const boards = response.values;

    if (format === 'json') {
      console.log(JSON.stringify(response, null, 2));
      return;
    }

    if (boards.length === 0) {
      console.log('No boards found.');
      return;
    }

    if (format === 'markdown') {
      console.log(formatBoardsMarkdown(boards, project));
      if (!response.isLast) {
        logProgress('', format);
        logProgress(
          `Note: More boards exist. Showing first ${boards.length} results.`,
          format
        );
      }
      return;
    }

    console.log(`Found ${boards.length} board(s):`);
    console.log('');
    for (const board of boards) {
      console.log(formatBoardText(board));
    }

    if (!response.isLast) {
      logProgress('', format);
      logProgress(
        `Note: More boards exist. Showing first ${boards.length} results.`,
        format
      );
    }
  } catch (error) {
    handleCommandError(error);
  }
}

export default {
  command: 'boards [project]',
  describe: 'List Jira boards, optionally filtered by project',
  builder: {
    project: {
      type: 'string',
      describe: 'Project key to filter boards (e.g., PROJ)',
    },
    format: {
      type: 'string',
      choices: ['text', 'json', 'markdown'] as const,
      default: 'text' as const,
      describe: 'Output format',
    },
  },
  handler,
} satisfies CommandModule<object, BoardsArgs>;
