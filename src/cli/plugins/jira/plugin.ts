import { Effect } from 'effect';

import { jiraCommands } from '@cli/commands/jira/index.js';
import {
  defineAidePlugin,
  type AidePluginAuthStatus,
  pluginCommandModule,
} from '@cli/host/plugin-descriptor.js';
import { probeJiraConfig, type ConfigStatus } from '@lib/config.js';
import type { JiraConfig } from '@schemas/config.js';

type ProbeJiraConfig = () => Promise<ConfigStatus<JiraConfig>>;

interface JiraPluginOptions {
  readonly probeConfig?: ProbeJiraConfig;
}

const JIRA_COMMANDS = `## Jira Commands

\`\`\`bash
# Search tickets
aide jira search "assignee = currentUser() AND status = 'In Progress'"

# Get ticket details
aide jira view PROJ-123

# Create ticket
aide jira create -p PROJ -t Task -s "Summary" --assignee me

# Update ticket fields
aide jira update PROJ-123 --assignee me --priority High
aide jira update PROJ-123 --description "New description"

# Set custom fields (use field name or ID - auto-formats by type)
aide jira update PROJ-123 --field "Severity=Critical"
aide jira create -p PROJ -t Bug -s "Bug" --field "Severity=High"

# Discover available fields for a project/issue type
aide jira fields PROJ -t Bug --show-values

# List boards and get active sprint
aide jira boards PROJ
aide jira sprint 123                    # active sprint for board
aide jira sprint 123 --state future     # future sprints

# Search within active sprint
aide jira search "assignee = currentUser()" --sprint-board 123

# Change workflow status
aide jira transition PROJ-123 "In Progress"
aide jira transition PROJ-123 --list  # show available transitions

# Add comment
aide jira comment PROJ-123 "Work completed, ready for review"

# Get recent comments
aide jira comments PROJ-123 --latest 5

# Edit or delete a comment
aide jira edit-comment PROJ-123 <comment-id> "Updated text"
aide jira delete-comment PROJ-123 <comment-id>

# Manage attachments
aide jira attach PROJ-123 --list
aide jira attach PROJ-123 --upload ./file.pdf
\`\`\``;

function mapJiraAuthStatus(
  status: ConfigStatus<JiraConfig>
): AidePluginAuthStatus {
  switch (status.kind) {
    case 'env':
      return { state: 'configured', detail: 'configured via environment' };
    case 'keyring':
      return { state: 'configured', detail: 'configured via keyring' };
    case 'missing':
      return {
        state: 'not-configured',
        detail: "run 'aide login jira'",
      };
    case 'malformed':
      return { state: 'misconfigured', detail: status.reason };
    case 'unreachable':
      return {
        state: 'unavailable',
        detail: 'system keyring is unreachable and Jira env vars are not set',
      };
  }
}

export function createJiraPlugin(opts: JiraPluginOptions = {}) {
  const probeConfig = opts.probeConfig ?? (() => probeJiraConfig());
  const authStatus = () =>
    Effect.tryPromise({
      try: () => probeConfig(),
      catch: (error) => error,
    }).pipe(Effect.map(mapJiraAuthStatus));

  return defineAidePlugin({
    id: 'jira',
    summary: 'Jira ticket management',
    commands: [
      pluginCommandModule('jira', jiraCommands, { acceptsChildren: false }),
    ],
    capabilities: {
      authProvider: {
        providerId: 'jira',
        label: 'Jira',
        status: authStatus,
      },
      primeContribution: {
        status: [
          {
            groupId: 'jira',
            groupLabel: 'Jira',
            label: 'Jira',
            messages: {
              misconfigured: 'run `aide login jira` to reconfigure',
              notConfigured:
                'run `aide login jira`, or set JIRA_URL, JIRA_EMAIL/JIRA_USERNAME, JIRA_API_TOKEN/JIRA_TOKEN',
            },
            status: authStatus,
          },
        ],
        sections: () =>
          Effect.succeed([
            {
              id: 'jira-commands',
              order: 100,
              body: JIRA_COMMANDS,
            },
          ]),
      },
    },
  });
}

export const jiraPlugin = createJiraPlugin();
