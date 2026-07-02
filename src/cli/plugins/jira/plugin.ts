import { Effect } from 'effect';
import * as v from 'valibot';

import { jiraCommands } from '@cli/commands/jira/index.js';
import {
  defineAidePlugin,
  type AideAuthInputField,
  type AideAuthLoginRequest,
  type AidePluginAuthStatus,
  pluginCommandModule,
} from '@cli/host/plugin-descriptor.js';
import {
  probeJiraConfig,
  readJiraEnvForMigration,
  type ConfigStatus,
} from '@lib/config.js';
import { deleteSecret, setSecret } from '@lib/secrets.js';
import { StoredJiraSchema, type JiraConfig } from '@schemas/config.js';
import {
  formatMigrationError,
  formatUnsetHint,
  messages,
  promptAuthField,
  validateNonEmpty,
  validateUrl,
} from '../auth-operation-utils.js';

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

const jiraUrlField = {
  kind: 'text',
  key: 'url',
  label: 'Jira URL',
  description: 'Jira URL',
  required: true,
  validate: validateUrl,
} as const satisfies AideAuthInputField;

const jiraEmailField = {
  kind: 'text',
  key: 'email',
  label: 'Email',
  description: 'Jira email',
  required: true,
  validate: validateNonEmpty,
} as const satisfies AideAuthInputField;

const jiraTokenField = {
  kind: 'secret',
  key: 'token',
  label: 'API token',
  description: 'Jira API token',
  required: true,
  stdin: true,
} as const satisfies AideAuthInputField;

const jiraLoginFields = Object.freeze([
  jiraUrlField,
  jiraEmailField,
  jiraTokenField,
] as const);

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

function loginJiraAuth(request: AideAuthLoginRequest) {
  return Effect.gen(function* () {
    if (request.fromEnv) {
      const result = readJiraEnvForMigration();
      if (result.kind !== 'ok') {
        return yield* Effect.fail(
          new Error(formatMigrationError('Jira', result))
        );
      }

      yield* Effect.tryPromise({
        try: () => setSecret('jira', JSON.stringify(result.value)),
        catch: (error) => error,
      });
      return {
        status: 'stored' as const,
        messages: messages(
          'Migrated Jira credentials from env to keyring.',
          formatUnsetHint(result.varsUsed)
        ),
      };
    }

    const url = yield* promptAuthField(request, jiraUrlField);
    const email = yield* promptAuthField(request, jiraEmailField);
    const token = yield* promptAuthField(request, jiraTokenField);

    const validated = yield* Effect.try({
      try: () =>
        v.parse(StoredJiraSchema, {
          url,
          email,
          apiToken: token,
        }),
      catch: (error) => error,
    });
    yield* Effect.tryPromise({
      try: () => setSecret('jira', JSON.stringify(validated)),
      catch: (error) => error,
    });

    return {
      status: 'stored' as const,
      messages: ['Saved credentials for jira.'],
    };
  });
}

function logoutJiraAuth() {
  return Effect.tryPromise({
    try: () => deleteSecret('jira'),
    catch: (error) => error,
  }).pipe(
    Effect.map((removed) => ({
      status: removed ? ('removed' as const) : ('not-found' as const),
      messages: [
        removed
          ? 'Removed stored credentials for jira.'
          : 'No stored credentials for jira.',
      ],
    }))
  );
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
        login: {
          summary: 'Save Jira credentials',
          fields: jiraLoginFields,
          envMigration: {
            description:
              'Migrate JIRA_URL / JIRA_EMAIL / JIRA_API_TOKEN into the keyring',
            variables: [
              'JIRA_URL',
              'JIRA_EMAIL',
              'JIRA_USERNAME',
              'JIRA_API_TOKEN',
              'JIRA_TOKEN',
            ],
          },
        },
        logout: {
          summary: 'Remove Jira credentials',
        },
        status: authStatus,
        operations: {
          login: loginJiraAuth,
          logout: logoutJiraAuth,
        },
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
