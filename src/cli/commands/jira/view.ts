/**
 * Jira view command
 * Get detailed information about a specific Jira ticket
 */

import type { ArgumentsCamelCase, CommandModule } from 'yargs';
import { loadConfig } from '@lib/config.js';
import { JiraClient } from '@lib/jira-client.js';
import { formatTicketDetails } from '@lib/cli-utils.js';
import { validateArgs } from '@lib/validation.js';
import { ViewArgsSchema, type ViewArgs } from '@schemas/jira/view.js';
import { handleCommandError } from '@lib/errors.js';
import { validateTicketKeyWithWarning, logProgress } from '@lib/jira-utils.js';

async function handler(argv: ArgumentsCamelCase<ViewArgs>): Promise<void> {
  const args = validateArgs(ViewArgsSchema, argv, 'view arguments');
  const { ticketKey, format } = args;

  // Validate ticket key format (soft validation with warning)
  validateTicketKeyWithWarning(ticketKey);

  try {
    const config = loadConfig();
    const client = new JiraClient(config);

    logProgress(`Fetching details for ticket: ${ticketKey}`, format);
    logProgress('', format);

    const issue = await client.getIssue(ticketKey);

    if (format === 'json') {
      console.log(JSON.stringify(issue, null, 2));
    } else {
      const output = formatTicketDetails(issue);
      console.log(output);
    }
  } catch (error) {
    handleCommandError(error);
  }
}

export default {
  command: 'view <ticketKey>',
  describe: 'Get ticket details (summary, description, metadata)',
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
  },
  handler,
} satisfies CommandModule<object, ViewArgs>;
