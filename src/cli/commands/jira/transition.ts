/**
 * Jira transition command
 * Change the workflow status of a Jira ticket
 */

import type { ArgumentsCamelCase, CommandModule } from 'yargs';
import { loadConfig } from '@lib/config.js';
import { JiraClient } from '@lib/jira-client.js';
import { validateArgs } from '@lib/validation.js';
import { convert as markdownToAdf } from '@lib/md-to-adf.js';
import {
  TransitionArgsSchema,
  type TransitionArgs,
} from '@schemas/jira/transition.js';
import { handleCommandError } from '@lib/errors.js';
import { validateTicketKeyWithWarning, logProgress } from '@lib/jira-utils.js';
import type { JiraTransition, JiraTransitionOptions } from '@lib/types.js';

function formatTransitionsText(transitions: JiraTransition[]): string {
  if (transitions.length === 0) {
    return 'No transitions available for this ticket.';
  }

  const lines = ['Available transitions:', ''];
  for (const t of transitions) {
    lines.push(`  ${t.name} -> ${t.to.name}`);
  }
  return lines.join('\n');
}

function formatTransitionsMarkdown(transitions: JiraTransition[]): string {
  if (transitions.length === 0) {
    return '## Available Transitions\n\nNo transitions available for this ticket.';
  }

  const lines = ['## Available Transitions', ''];
  for (const t of transitions) {
    lines.push(`- **${t.name}** → ${t.to.name}`);
  }
  return lines.join('\n');
}

async function handler(
  argv: ArgumentsCamelCase<TransitionArgs>
): Promise<void> {
  const args = validateArgs(TransitionArgsSchema, argv, 'transition arguments');
  const { ticketKey, format } = args;

  // Validate ticket key format (soft validation with warning)
  validateTicketKeyWithWarning(ticketKey);

  try {
    const config = loadConfig();
    const client = new JiraClient(config);

    // List mode: show available transitions
    if (args.list) {
      logProgress(`Fetching available transitions for: ${ticketKey}`, format);
      logProgress('', format);

      const response = await client.getTransitions(ticketKey);

      if (format === 'json') {
        console.log(JSON.stringify(response.transitions, null, 2));
      } else if (format === 'markdown') {
        console.log(formatTransitionsMarkdown(response.transitions));
      } else {
        console.log(formatTransitionsText(response.transitions));
      }
      return;
    }

    // Transition mode: require a status
    if (!args.status) {
      console.error('Error: Status is required for transitioning.');
      console.error('Use --list to see available transitions.');
      console.error('');
      console.error('Example: aide jira transition PROJ-123 "In Progress"');
      console.error('Example: aide jira transition PROJ-123 --list');
      process.exit(1);
    }

    logProgress(`Transitioning ticket: ${ticketKey}`, format);
    logProgress(`Target status: ${args.status}`, format);

    // Get available transitions
    logProgress('Fetching available transitions...', format);
    const response = await client.getTransitions(ticketKey);

    // Find the transition matching the requested status
    const targetStatus = args.status.toLowerCase();
    const transition = response.transitions.find(
      (t) =>
        t.name.toLowerCase() === targetStatus ||
        t.to.name.toLowerCase() === targetStatus
    );

    if (!transition) {
      console.error(`Error: No transition found to status '${args.status}'`);
      console.error('');
      console.error('Available transitions:');
      for (const t of response.transitions) {
        console.error(`  ${t.name} -> ${t.to.name}`);
      }
      process.exit(1);
    }

    // Build transition options
    const transitionOptions: JiraTransitionOptions = {};

    if (args.comment) {
      transitionOptions.comment = markdownToAdf(args.comment);
    }

    if (args.resolution) {
      transitionOptions.resolution = args.resolution;
    }

    logProgress(`Applying transition: ${transition.name}...`, format);
    logProgress('', format);

    await client.transitionIssue(ticketKey, transition.id, transitionOptions);

    if (format === 'json') {
      console.log(
        JSON.stringify(
          {
            success: true,
            ticketKey,
            transition: transition.name,
            newStatus: transition.to.name,
            url: `${config.url}/browse/${ticketKey}`,
          },
          null,
          2
        )
      );
    } else {
      console.log(`Ticket transitioned successfully!`);
      console.log(`Ticket: ${ticketKey}`);
      console.log(`New status: ${transition.to.name}`);
      console.log(`View ticket: ${config.url}/browse/${ticketKey}`);
    }
  } catch (error) {
    handleCommandError(error);
  }
}

export default {
  command: 'transition <ticketKey> [status]',
  describe: 'Change ticket workflow status',
  builder: {
    ticketKey: {
      type: 'string',
      describe: 'Jira ticket key (e.g., PROJ-123)',
      demandOption: true,
    },
    status: {
      type: 'string',
      describe: 'Target status name (e.g., "In Progress", "Done")',
    },
    list: {
      type: 'boolean',
      alias: 'l',
      describe: 'List available transitions',
      default: false,
    },
    comment: {
      type: 'string',
      alias: 'c',
      describe: 'Add comment with the transition',
    },
    resolution: {
      type: 'string',
      alias: 'r',
      describe: 'Set resolution (for Done/Resolved transitions)',
    },
    format: {
      type: 'string',
      choices: ['text', 'json', 'markdown'] as const,
      default: 'text' as const,
      describe: 'Output format',
    },
  },
  handler,
} satisfies CommandModule<object, TransitionArgs>;
