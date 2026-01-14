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

import type { CommandModule } from 'yargs';

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
aide jira view PROJ-123

# Create ticket
aide jira create -p PROJ -t Task -s "Summary" --assignee me

# Update ticket fields
aide jira update PROJ-123 --assignee me --priority High
aide jira update PROJ-123 --description "New description"

# Change workflow status
aide jira transition PROJ-123 "In Progress"
aide jira transition PROJ-123 --list  # show available transitions

# Add comment
aide jira comment PROJ-123 "Work completed, ready for review"

# Get recent comments
aide jira comments PROJ-123 --latest 5

# Manage attachments
aide jira attach PROJ-123 --list
aide jira attach PROJ-123 --upload ./file.pdf
\`\`\``;

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

export default {
  command: 'prime',
  describe: 'Output aide context for session start hook',
  handler() {
    console.log(buildPrimeOutput());
  },
} satisfies CommandModule;
