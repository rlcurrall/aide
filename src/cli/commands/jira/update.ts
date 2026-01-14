/**
 * Jira update command
 * Update fields on an existing Jira ticket
 */

import type { ArgumentsCamelCase, CommandModule } from 'yargs';
import { loadConfig } from '@lib/config.js';
import { JiraClient } from '@lib/jira-client.js';
import { validateArgs } from '@lib/validation.js';
import { convert as markdownToAdf } from '@lib/md-to-adf.js';
import { UpdateArgsSchema, type UpdateArgs } from '@schemas/jira/update.js';
import { handleCommandError } from '@lib/errors.js';
import {
  validateTicketKeyWithWarning,
  readContentFromFileOrArg,
  parseCommaSeparated,
  parseCustomFields,
  formatSuccessMessage,
  logProgress,
} from '@lib/jira-utils.js';
import type { JiraUpdateIssueOptions } from '@lib/types.js';

async function handler(argv: ArgumentsCamelCase<UpdateArgs>): Promise<void> {
  const args = validateArgs(UpdateArgsSchema, argv, 'update arguments');
  const { ticketKey, format } = args;

  // Validate ticket key format (soft validation with warning)
  validateTicketKeyWithWarning(ticketKey);

  // Check that at least one update field is provided
  const hasUpdate =
    args.summary ||
    args.description ||
    args.file ||
    args.assignee ||
    args.priority ||
    args.labels ||
    args.addLabels ||
    args.removeLabels ||
    (args.component && args.component.length > 0) ||
    (args.field && args.field.length > 0);

  if (!hasUpdate) {
    console.error('Error: At least one field to update must be specified.');
    console.error(
      'Available options: --summary, --description, --file, --assignee,'
    );
    console.error(
      '  --priority, --labels, --add-labels, --remove-labels, --component, --field'
    );
    process.exit(1);
  }

  try {
    const config = loadConfig();
    const client = new JiraClient(config);

    logProgress(`Updating ticket: ${ticketKey}`, format);

    const updateOptions: JiraUpdateIssueOptions = {};

    // Handle summary
    if (args.summary) {
      updateOptions.summary = args.summary;
    }

    // Handle description from file or argument
    if (args.file || args.description) {
      const descriptionContent = await readContentFromFileOrArg(
        args.description,
        args.file,
        'description'
      );
      logProgress('Converting description to Jira format...', format);
      updateOptions.description = markdownToAdf(descriptionContent);
    }

    // Handle assignee
    if (args.assignee) {
      const assignee = args.assignee.toLowerCase();
      if (assignee === 'none' || assignee === 'unassigned') {
        updateOptions.assignee = null; // Unassign
      } else if (assignee === 'me') {
        logProgress('Looking up current user...', format);
        const myself = await client.getMyself();
        updateOptions.assignee = { accountId: myself.accountId };
      } else if (args.assignee.includes('@')) {
        // Looks like an email, search for user
        logProgress(`Looking up user: ${args.assignee}...`, format);
        const users = await client.searchUsers(args.assignee, 1);
        const foundUser = users[0];
        if (!foundUser) {
          console.error(`Error: No user found matching '${args.assignee}'`);
          process.exit(1);
        }
        updateOptions.assignee = { accountId: foundUser.accountId };
      } else {
        // Assume it's an account ID
        updateOptions.assignee = { accountId: args.assignee };
      }
    }

    // Handle priority
    if (args.priority) {
      updateOptions.priority = { name: args.priority };
    }

    // Handle labels (set, add, remove)
    if (args.labels || args.addLabels || args.removeLabels) {
      // Get current issue to know current labels for add/remove operations
      let currentLabels: string[] = [];
      if (args.addLabels || args.removeLabels) {
        logProgress('Fetching current labels...', format);
        const issue = await client.getIssue(ticketKey);
        currentLabels = issue.fields.labels || [];
      }

      let newLabels: string[];

      if (args.labels) {
        // Replace all labels
        newLabels = parseCommaSeparated(args.labels);
      } else {
        newLabels = [...currentLabels];

        if (args.addLabels) {
          const toAdd = parseCommaSeparated(args.addLabels);
          for (const label of toAdd) {
            if (!newLabels.includes(label)) {
              newLabels.push(label);
            }
          }
        }

        if (args.removeLabels) {
          const toRemove = parseCommaSeparated(args.removeLabels);
          newLabels = newLabels.filter((l) => !toRemove.includes(l));
        }
      }

      updateOptions.labels = newLabels;
    }

    // Handle components
    if (args.component && args.component.length > 0) {
      updateOptions.components = args.component;
    }

    // Handle custom fields
    if (args.field && args.field.length > 0) {
      updateOptions.customFields = parseCustomFields(args.field);
    }

    logProgress('Updating ticket in Jira...', format);
    logProgress('', format);

    await client.updateIssue(ticketKey, updateOptions);

    if (format === 'json') {
      console.log(
        JSON.stringify(
          {
            success: true,
            ticketKey,
            url: `${config.url}/browse/${ticketKey}`,
          },
          null,
          2
        )
      );
    } else {
      console.log(formatSuccessMessage('updated', ticketKey, config.url));
    }
  } catch (error) {
    handleCommandError(error);
  }
}

export default {
  command: 'update <ticketKey>',
  describe: 'Update ticket fields',
  builder: {
    ticketKey: {
      type: 'string',
      describe: 'Jira ticket key (e.g., PROJ-123)',
      demandOption: true,
    },
    summary: {
      type: 'string',
      alias: 's',
      describe: 'Update summary/title',
    },
    description: {
      type: 'string',
      alias: 'd',
      describe: 'Update description (markdown format)',
    },
    file: {
      type: 'string',
      alias: 'f',
      describe: 'Read description from markdown file',
    },
    assignee: {
      type: 'string',
      alias: 'a',
      describe:
        'Update assignee (email, account ID, "me", or "none" to unassign)',
    },
    priority: {
      type: 'string',
      describe: 'Update priority (e.g., High, Medium, Low)',
    },
    labels: {
      type: 'string',
      describe: 'Set labels (comma-separated, replaces existing)',
    },
    'add-labels': {
      type: 'string',
      describe: 'Add labels (comma-separated, keeps existing)',
    },
    'remove-labels': {
      type: 'string',
      describe: 'Remove labels (comma-separated)',
    },
    component: {
      type: 'string',
      array: true,
      describe: 'Set components (can be repeated, replaces existing)',
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
} satisfies CommandModule<object, UpdateArgs>;
