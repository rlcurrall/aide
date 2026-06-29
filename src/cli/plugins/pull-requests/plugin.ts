import { Effect } from 'effect';

import {
  prCommandGroup,
  prCommentCommand,
  prCommentsCommand,
  prCreateCommand,
  prDiffCommand,
  prListCommand,
  prReplyCommand,
  prUpdateCommand,
  prViewCommand,
} from '@cli/commands/pr/index.js';
import {
  defineAidePlugin,
  pluginCommandModule,
} from '@cli/host/plugin-descriptor.js';

const PR_COMMANDS = `## Pull Request Commands

Note: \`--pr\` flag is optional - auto-discovers from current branch if omitted.

\`\`\`bash
# List active PRs
aide pr list --status active

# View PR details
aide pr view --pr 123
aide pr view  # auto-detect from branch

# View PR diff
aide pr diff --pr 123
aide pr diff --stat  # summary with line counts
aide pr diff --files  # list changed files only
aide pr diff --file src/app.ts  # diff for specific file only
aide pr diff --no-fetch  # skip auto-fetching branches

# Get PR comments (with explicit PR ID)
aide pr comments --pr 24094 --latest 10
aide pr comments --latest 10  # auto-detect from branch

# Create PR
aide pr create --title "feat: add new feature" --base main

# Update PR
aide pr update --pr 123 --title "Updated title"
aide pr update --publish  # auto-detect, publish draft

# Post comment
aide pr comment "LGTM, approved" --pr 123
aide pr comment "Needs work"  # auto-detect from branch

# Reply to thread
aide pr reply 456 "Fixed the issue" --pr 123
\`\`\``;

export const pullRequestsPlugin = defineAidePlugin({
  id: 'pull-requests',
  summary: 'Pull request workflows for GitHub and Azure DevOps',
  commands: [
    pluginCommandModule('pr', prCommandGroup, {
      acceptsChildren: true,
      extension: { kind: 'same-plugin' },
    }),
    pluginCommandModule('pr:list', prListCommand, { parentId: 'pr' }),
    pluginCommandModule('pr:view', prViewCommand, { parentId: 'pr' }),
    pluginCommandModule('pr:diff', prDiffCommand, { parentId: 'pr' }),
    pluginCommandModule('pr:create', prCreateCommand, { parentId: 'pr' }),
    pluginCommandModule('pr:update', prUpdateCommand, { parentId: 'pr' }),
    pluginCommandModule('pr:comments', prCommentsCommand, { parentId: 'pr' }),
    pluginCommandModule('pr:comment', prCommentCommand, { parentId: 'pr' }),
    pluginCommandModule('pr:reply', prReplyCommand, { parentId: 'pr' }),
  ],
  capabilities: {
    primeContribution: {
      sections: () =>
        Effect.succeed([
          {
            id: 'pull-requests-commands',
            order: 200,
            body: PR_COMMANDS,
          },
        ]),
    },
  },
});
