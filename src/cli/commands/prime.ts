/**
 * Prime command - Outputs context for session start hook
 *
 * This command is designed to be called by Claude Code's SessionStart hook
 * to inject awareness of aide tooling into the agent's context.
 *
 * Design considerations:
 * - Outputs minimal context (~80 tokens) to preserve context budget
 * - Uses generic "Pull Requests" language to support both Azure DevOps and GitHub
 * - Silent exit (code 0) on any error to not disrupt sessions
 * - Shows configuration status warnings when env vars are missing
 */

import type { CommandModule } from 'yargs';

import {
  probeJiraConfig,
  probeAdoConfig,
  probeGithubConfig,
} from '@lib/config.js';
import { isGhCliAvailable } from '@lib/gh-utils.js';

type ConfigState = 'configured' | 'not-configured' | 'misconfigured';

/**
 * Build configuration status section if any service is not configured
 */
async function buildConfigStatusSection(
  ghAvailable: () => boolean
): Promise<string> {
  const [jiraStatus, adoStatus, ghStatus] = await Promise.all([
    probeJiraConfig(),
    probeAdoConfig(),
    probeGithubConfig({ ghAvailable }),
  ]);

  function toState(kind: string): ConfigState {
    if (kind === 'env' || kind === 'keyring') return 'configured';
    if (kind === 'malformed') return 'misconfigured';
    return 'not-configured';
  }

  const jiraState = toState(jiraStatus.kind);

  // PR platform is configured if either ADO or GitHub is available
  let prState: ConfigState;
  const adoState = toState(adoStatus.kind);
  const ghState = toState(ghStatus.kind);
  if (adoState === 'configured' || ghState === 'configured') {
    prState = 'configured';
  } else if (adoState === 'misconfigured' || ghState === 'misconfigured') {
    prState = 'misconfigured';
  } else {
    prState = 'not-configured';
  }

  // If everything is configured, return empty string (no status section needed)
  if (jiraState === 'configured' && prState === 'configured') {
    return '';
  }

  const lines: string[] = ['## Configuration Status', ''];

  if (jiraState === 'configured') {
    lines.push('- Jira: Configured');
  } else if (jiraState === 'misconfigured') {
    lines.push('- Jira: Misconfigured (run `aide login jira` to reconfigure)');
  } else {
    lines.push(
      '- Jira: Not configured (set JIRA_URL, JIRA_EMAIL/JIRA_USERNAME, JIRA_API_TOKEN/JIRA_TOKEN)'
    );
  }

  if (prState === 'configured') {
    lines.push('- Pull Requests: Configured');
  } else if (prState === 'misconfigured') {
    lines.push(
      '- Pull Requests: Misconfigured (run `aide login github` or `aide login ado` to reconfigure)'
    );
  } else {
    lines.push(
      '- Pull Requests: Not configured (run `gh auth login` for GitHub, or set AZURE_DEVOPS_ORG_URL + AZURE_DEVOPS_PAT for Azure DevOps)'
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

export async function buildPrimeOutput(
  opts: { ghAvailable?: () => boolean } = {}
): Promise<string> {
  const ghAvailable = opts.ghAvailable ?? isGhCliAvailable;
  const configStatus = await buildConfigStatusSection(ghAvailable);

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

const command: CommandModule = {
  command: 'prime',
  describe: 'Output aide context for session start hook',
  async handler() {
    console.log(await buildPrimeOutput());
  },
};

export default command;
