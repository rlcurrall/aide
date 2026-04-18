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
import * as v from 'valibot';

import { getSecret, KeyringUnavailableError } from '@lib/secrets.js';
import { isGhCliAvailable } from '@lib/gh-utils.js';
import {
  StoredJiraSchema,
  StoredAdoSchema,
  StoredGithubSchema,
} from '@schemas/config.js';

type StoredCheck = 'found' | 'missing' | 'corrupted' | 'unreachable';
type ConfigState = 'configured' | 'not-configured' | 'misconfigured';

async function checkStoredSecret(
  name: 'jira' | 'ado' | 'github'
): Promise<StoredCheck> {
  let raw: string | null;
  try {
    raw = await getSecret(name);
  } catch (err) {
    if (err instanceof KeyringUnavailableError) return 'unreachable';
    throw err;
  }
  if (raw === null) return 'missing';

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return 'corrupted';
  }

  const schema =
    name === 'jira'
      ? StoredJiraSchema
      : name === 'ado'
        ? StoredAdoSchema
        : StoredGithubSchema;
  const result = v.safeParse(schema, json);
  return result.success ? 'found' : 'corrupted';
}

/**
 * Check if Jira environment variables or keyring are configured
 */
async function isJiraConfigured(): Promise<ConfigState> {
  const hasUrl = !!process.env.JIRA_URL;
  const hasEmail = !!(process.env.JIRA_EMAIL || process.env.JIRA_USERNAME);
  const hasToken = !!(process.env.JIRA_API_TOKEN || process.env.JIRA_TOKEN);
  if (hasUrl && hasEmail && hasToken) return 'configured';

  const check = await checkStoredSecret('jira');
  if (check === 'found') return 'configured';
  if (check === 'corrupted') return 'misconfigured';
  return 'not-configured';
}

/**
 * Check if any PR platform is configured (Azure DevOps or GitHub via gh CLI/token/keyring)
 */
async function isPRPlatformConfigured(
  ghAvailable: () => boolean
): Promise<ConfigState> {
  // Azure DevOps env
  const hasAdoOrgUrl = !!process.env.AZURE_DEVOPS_ORG_URL;
  const hasAdoPat = !!process.env.AZURE_DEVOPS_PAT;
  if (hasAdoOrgUrl && hasAdoPat) return 'configured';

  // Azure DevOps keyring
  const adoCheck = await checkStoredSecret('ado');
  if (adoCheck === 'found') return 'configured';
  const adoCorrupted = adoCheck === 'corrupted';

  // GitHub via token env
  if (process.env.GITHUB_TOKEN || process.env.GH_TOKEN) return 'configured';

  // GitHub via keyring
  const ghCheck = await checkStoredSecret('github');
  if (ghCheck === 'found') return 'configured';
  const ghCorrupted = ghCheck === 'corrupted';

  // GitHub via gh CLI
  if (ghAvailable()) return 'configured';

  if (adoCorrupted || ghCorrupted) return 'misconfigured';
  return 'not-configured';
}

/**
 * Build configuration status section if any service is not configured
 */
async function buildConfigStatusSection(
  ghAvailable: () => boolean
): Promise<string> {
  const jiraState = await isJiraConfigured();
  const prState = await isPRPlatformConfigured(ghAvailable);

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

export default {
  command: 'prime',
  describe: 'Output aide context for session start hook',
  async handler() {
    console.log(await buildPrimeOutput());
  },
} satisfies CommandModule;
