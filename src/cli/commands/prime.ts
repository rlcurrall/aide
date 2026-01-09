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
 * - Shows configuration status warnings when env vars are missing
 */

import { createCommandModule } from '@cli/utils';

/**
 * Check if Jira environment variables are configured
 */
function isJiraConfigured(): boolean {
  const hasUrl = !!process.env.JIRA_URL;
  const hasEmail = !!(process.env.JIRA_EMAIL || process.env.JIRA_USERNAME);
  const hasToken = !!(process.env.JIRA_API_TOKEN || process.env.JIRA_TOKEN);
  return hasUrl && hasEmail && hasToken;
}

/**
 * Check if Azure DevOps environment variables are configured
 */
function isAzureDevOpsConfigured(): boolean {
  const hasOrgUrl = !!process.env.AZURE_DEVOPS_ORG_URL;
  const hasPat = !!process.env.AZURE_DEVOPS_PAT;
  return hasOrgUrl && hasPat;
}

/**
 * Build configuration status section if any service is not configured
 */
function buildConfigStatusSection(): string {
  const jiraConfigured = isJiraConfigured();
  const adoConfigured = isAzureDevOpsConfigured();

  // If everything is configured, return empty string (no status section needed)
  if (jiraConfigured && adoConfigured) {
    return '';
  }

  const lines: string[] = ['## Configuration Status', ''];

  if (jiraConfigured) {
    lines.push('- Jira: Configured');
  } else {
    lines.push(
      '- Jira: Not configured (set JIRA_URL, JIRA_EMAIL/JIRA_USERNAME, JIRA_API_TOKEN/JIRA_TOKEN)'
    );
  }

  if (adoConfigured) {
    lines.push('- Pull Requests: Configured');
  } else {
    lines.push(
      '- Pull Requests: Not configured (set AZURE_DEVOPS_ORG_URL, AZURE_DEVOPS_PAT)'
    );
  }

  lines.push('');
  return lines.join('\n');
}

const JIRA_COMMANDS = `## Jira Commands

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
\`\`\``;

const PR_COMMANDS = `## Pull Request Commands

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
\`\`\``;

function buildPrimeOutput(): string {
  const configStatus = buildConfigStatusSection();

  const parts = ['# aide - Jira & Git Hosting Integration', ''];

  if (configStatus) {
    parts.push(configStatus);
  }

  parts.push(
    'Use aide instead of az/gh/jira CLI tools. Auto-discovers org/project/repo from git remote.',
    '',
    JIRA_COMMANDS,
    '',
    PR_COMMANDS
  );

  return parts.join('\n').trim();
}

export default createCommandModule({
  command: 'prime',
  describe: 'Output aide context for session start hook',
  builder: {},
  handler() {
    console.log(buildPrimeOutput());
  },
});
