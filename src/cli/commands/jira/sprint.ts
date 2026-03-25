/**
 * Jira sprint command
 * Get sprint information for a board
 */

import type { ArgumentsCamelCase, CommandModule } from 'yargs';
import { loadConfig } from '@lib/config.js';
import { JiraClient } from '@lib/jira-client.js';
import { validateArgs } from '@lib/validation.js';
import { SprintArgsSchema, type SprintArgs } from '@schemas/jira/sprint.js';
import { handleCommandError } from '@lib/errors.js';
import { logProgress } from '@lib/jira-utils.js';
import type { JiraSprint } from '@lib/types.js';

function formatSprintText(sprint: JiraSprint): string {
  const lines: string[] = [];
  lines.push(`  [${sprint.id}] ${sprint.name}`);
  lines.push(`    State: ${sprint.state}`);
  if (sprint.startDate) {
    lines.push(`    Start: ${sprint.startDate.substring(0, 10)}`);
  }
  if (sprint.endDate) {
    lines.push(`    End: ${sprint.endDate.substring(0, 10)}`);
  }
  if (sprint.completeDate) {
    lines.push(`    Completed: ${sprint.completeDate.substring(0, 10)}`);
  }
  if (sprint.goal) {
    lines.push(`    Goal: ${sprint.goal}`);
  }
  return lines.join('\n');
}

function formatSprintsMarkdown(sprints: JiraSprint[], state: string): string {
  const lines: string[] = [];
  lines.push(`# Sprints (${state})`);
  lines.push('');
  lines.push('| ID | Name | State | Start | End | Goal |');
  lines.push('|----|------|-------|-------|-----|------|');
  for (const sprint of sprints) {
    const start = sprint.startDate?.substring(0, 10) || '';
    const end = sprint.endDate?.substring(0, 10) || '';
    const goal = sprint.goal || '';
    lines.push(
      `| ${sprint.id} | ${sprint.name} | ${sprint.state} | ${start} | ${end} | ${goal} |`
    );
  }
  return lines.join('\n');
}

async function handler(argv: ArgumentsCamelCase<SprintArgs>): Promise<void> {
  const args = validateArgs(SprintArgsSchema, argv, 'sprint arguments');
  const { boardId, state, format } = args;

  try {
    const config = loadConfig();
    const client = new JiraClient(config);

    logProgress(`Fetching ${state} sprint(s) for board ${boardId}...`, format);
    logProgress('', format);

    const response = await client.getSprintsForBoard(boardId, state);
    const sprints = response.values;

    if (format === 'json') {
      console.log(JSON.stringify(response, null, 2));
      return;
    }

    if (sprints.length === 0) {
      console.log(`No ${state} sprints found for board ${boardId}.`);
      return;
    }

    if (format === 'markdown') {
      console.log(formatSprintsMarkdown(sprints, state));
      if (!response.isLast) {
        logProgress('', format);
        logProgress(
          `Note: More sprints exist. Showing first ${sprints.length} results.`,
          format
        );
      }
      return;
    }

    console.log(`Found ${sprints.length} ${state} sprint(s):`);
    console.log('');
    for (const sprint of sprints) {
      console.log(formatSprintText(sprint));
      console.log('');
    }

    if (!response.isLast) {
      logProgress(
        `Note: More sprints exist. Showing first ${sprints.length} results.`,
        format
      );
    }
  } catch (error) {
    handleCommandError(error);
  }
}

export default {
  command: 'sprint <boardId>',
  describe: 'Get sprint information for a board',
  builder: {
    boardId: {
      type: 'number',
      describe: 'Board ID',
      demandOption: true,
    },
    state: {
      type: 'string',
      choices: ['future', 'active', 'closed'] as const,
      default: 'active' as const,
      describe: 'Sprint state filter (default: active)',
    },
    format: {
      type: 'string',
      choices: ['text', 'json', 'markdown'] as const,
      default: 'text' as const,
      describe: 'Output format',
    },
  },
  handler,
} satisfies CommandModule<object, SprintArgs>;
