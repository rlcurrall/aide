/**
 * Jira create command
 * Create a new Jira ticket
 */

import type { ArgumentsCamelCase, CommandModule } from 'yargs';
import { loadConfig } from '@lib/config.js';
import { JiraClient } from '@lib/jira-client.js';
import { validateArgs } from '@lib/validation.js';
import { convert as markdownToAdf } from '@lib/md-to-adf.js';
import { CreateArgsSchema, type CreateArgs } from '@schemas/jira/create.js';
import { handleCommandError } from '@lib/errors.js';
import {
  readContentFromFileOrArg,
  parseCommaSeparated,
  parseCustomFields,
  formatSuccessMessage,
  logProgress,
} from '@lib/jira-utils.js';
import type { JiraCreateIssueOptions } from '@lib/types.js';

async function handler(argv: ArgumentsCamelCase<CreateArgs>): Promise<void> {
  const args = validateArgs(CreateArgsSchema, argv, 'create arguments');
  const { project, type, summary, format } = args;

  try {
    const config = loadConfig();
    const client = new JiraClient(config);

    logProgress(`Creating ${type} in project ${project}...`, format);

    // Build create options
    const createOptions: JiraCreateIssueOptions = {
      projectKey: project,
      issueType: type,
      summary,
    };

    // Handle description from file or argument
    if (args.file || args.description) {
      const descriptionContent = await readContentFromFileOrArg(
        args.description,
        args.file,
        'description'
      );
      logProgress('Converting description to Jira format...', format);
      createOptions.description = markdownToAdf(descriptionContent);
    }

    // Handle assignee
    if (args.assignee) {
      if (args.assignee.toLowerCase() === 'me') {
        logProgress('Looking up current user...', format);
        const myself = await client.getMyself();
        createOptions.assignee = myself.accountId;
      } else if (args.assignee.includes('@')) {
        // Looks like an email, search for user
        logProgress(`Looking up user: ${args.assignee}...`, format);
        const users = await client.searchUsers(args.assignee, 1);
        const foundUser = users[0];
        if (!foundUser) {
          console.error(`Error: No user found matching '${args.assignee}'`);
          process.exit(1);
        }
        createOptions.assignee = foundUser.accountId;
      } else {
        // Assume it's an account ID
        createOptions.assignee = args.assignee;
      }
    }

    // Handle priority
    if (args.priority) {
      createOptions.priority = args.priority;
    }

    // Handle labels
    if (args.labels) {
      createOptions.labels = parseCommaSeparated(args.labels);
    }

    // Handle components
    if (args.component && args.component.length > 0) {
      createOptions.components = args.component;
    }

    // Handle parent (for subtasks)
    if (args.parent) {
      createOptions.parent = args.parent;
    }

    // Handle custom fields
    if (args.field && args.field.length > 0) {
      createOptions.customFields = parseCustomFields(args.field);
    }

    logProgress('Creating ticket in Jira...', format);
    logProgress('', format);

    const result = await client.createIssue(createOptions);

    if (format === 'json') {
      console.log(
        JSON.stringify(
          {
            ...result,
            url: `${config.url}/browse/${result.key}`,
          },
          null,
          2
        )
      );
    } else {
      console.log(formatSuccessMessage('created', result.key, config.url));
    }
  } catch (error) {
    handleCommandError(error);
  }
}

export default {
  command: 'create',
  describe: 'Create a new Jira ticket',
  builder: {
    project: {
      type: 'string',
      alias: 'p',
      describe: 'Project key (e.g., PROJ)',
      demandOption: true,
    },
    type: {
      type: 'string',
      alias: 't',
      describe: 'Issue type (e.g., Task, Bug, Story)',
      demandOption: true,
    },
    summary: {
      type: 'string',
      alias: 's',
      describe: 'Issue summary/title',
      demandOption: true,
    },
    description: {
      type: 'string',
      alias: 'd',
      describe: 'Description text in markdown format',
    },
    file: {
      type: 'string',
      alias: 'f',
      describe: 'Read description from markdown file',
    },
    assignee: {
      type: 'string',
      alias: 'a',
      describe: 'Assignee (email, account ID, or "me" for self)',
    },
    priority: {
      type: 'string',
      describe: 'Priority name (e.g., High, Medium, Low)',
    },
    labels: {
      type: 'string',
      alias: 'l',
      describe: 'Labels (comma-separated)',
    },
    component: {
      type: 'string',
      array: true,
      describe: 'Component name (can be repeated)',
    },
    parent: {
      type: 'string',
      describe: 'Parent issue key (for subtasks)',
    },
    field: {
      type: 'string',
      array: true,
      describe: 'Custom field (format: fieldName=value, can repeat)',
    },
    format: {
      type: 'string',
      choices: ['text', 'json', 'markdown'] as const,
      default: 'text' as const,
      describe: 'Output format',
    },
  },
  handler,
} satisfies CommandModule<object, CreateArgs>;
