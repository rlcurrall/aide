/**
 * Prime command - Outputs context for session start hook
 *
 * This command is designed to be called by Claude Code's SessionStart hook
 * to inject awareness of aide tooling into the agent's context.
 *
 * Design considerations:
 * - Outputs minimal context (~80 tokens) to preserve context budget
 * - Uses generic "Pull Requests" language to support future GitHub integration
 * - Silent exit (code 0) on any error to not disrupt sessions
 */

import { createCommandModule } from '@cli/utils';

const PRIME_OUTPUT = `
# aide - Jira & Git Hosting Integration

Use aide instead of az/gh/jira CLI tools. Auto-discovers org/project/repo from git remote.

## Jira Commands

\`\`\`bash
# Search tickets
aide jira search "assignee = currentUser() AND status = 'In Progress'"

# Get ticket details
aide jira ticket PROJ-123

# Add comment
aide jira comment PROJ-123 "Work completed, ready for review"

# Get recent comments
aide jira comments PROJ-123 --latest 5

# Update description
aide jira desc PROJ-123 "Updated requirements..."
\`\`\`

## Pull Request Commands

Note: \`--pr\` flag is optional - auto-discovers from current branch if omitted.

\`\`\`bash
# List active PRs
aide pr list --status active

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
\`\`\`
`.trim();

export default createCommandModule({
  command: 'prime',
  describe: 'Output aide context for session start hook',
  builder: {},
  handler() {
    console.log(PRIME_OUTPUT);
  },
});
