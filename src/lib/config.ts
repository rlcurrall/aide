import type { JiraConfig, AzureDevOpsConfig } from './types.js';

export function loadConfig(): JiraConfig {
  // Bun automatically loads .env files, so we can use Bun.env directly
  const url = Bun.env.JIRA_URL;
  const email = Bun.env.JIRA_EMAIL || Bun.env.JIRA_USERNAME;
  const apiToken = Bun.env.JIRA_API_TOKEN || Bun.env.JIRA_TOKEN;
  const defaultProject = Bun.env.JIRA_DEFAULT_PROJECT;

  // Validate required configuration
  if (!url) {
    console.error('Error: Missing required configuration JIRA_URL');
    console.error('Please set the following environment variables:');
    console.error('  - JIRA_URL (your Jira instance URL)');
    console.error('  - JIRA_EMAIL or JIRA_USERNAME (your email/username)');
    console.error('  - JIRA_API_TOKEN or JIRA_TOKEN (your API token)');
    console.error('');
    console.error('You can also create a .env file (copy from .env.example)');
    process.exit(1);
  }

  if (!email) {
    console.error(
      'Error: Missing required configuration JIRA_EMAIL or JIRA_USERNAME'
    );
    console.error('Please set the following environment variables:');
    console.error('  - JIRA_URL (your Jira instance URL)');
    console.error('  - JIRA_EMAIL or JIRA_USERNAME (your email/username)');
    console.error('  - JIRA_API_TOKEN or JIRA_TOKEN (your API token)');
    console.error('');
    console.error('You can also create a .env file (copy from .env.example)');
    process.exit(1);
  }

  if (!apiToken) {
    console.error(
      'Error: Missing required configuration JIRA_API_TOKEN or JIRA_TOKEN'
    );
    console.error('Please set the following environment variables:');
    console.error('  - JIRA_URL (your Jira instance URL)');
    console.error('  - JIRA_EMAIL or JIRA_USERNAME (your email/username)');
    console.error('  - JIRA_API_TOKEN or JIRA_TOKEN (your API token)');
    console.error('');
    console.error(
      'Generate an API token at: https://id.atlassian.com/manage-profile/security/api-tokens'
    );
    console.error('You can also create a .env file (copy from .env.example)');
    process.exit(1);
  }

  return {
    url: url.replace(/\/$/, ''), // Remove trailing slash
    email,
    apiToken,
    defaultProject,
  };
}

export function loadAzureDevOpsConfig(): AzureDevOpsConfig {
  // Bun automatically loads .env files, so we can use Bun.env directly
  const orgUrl = Bun.env.AZURE_DEVOPS_ORG_URL;
  const pat = Bun.env.AZURE_DEVOPS_PAT;
  const authMethod = (Bun.env.AZURE_DEVOPS_AUTH_METHOD || 'pat') as
    | 'pat'
    | 'bearer';
  const defaultProject = Bun.env.AZURE_DEVOPS_DEFAULT_PROJECT;

  // Validate required configuration
  if (!orgUrl) {
    console.error('Error: Missing required configuration AZURE_DEVOPS_ORG_URL');
    console.error('Please set the following environment variables:');
    console.error(
      '  - AZURE_DEVOPS_ORG_URL (e.g., https://dev.azure.com/yourorg)'
    );
    console.error('  - AZURE_DEVOPS_PAT (your Personal Access Token)');
    console.error(
      '  - AZURE_DEVOPS_AUTH_METHOD (optional, default: pat, can be: pat or bearer)'
    );
    console.error('');
    console.error('You can also create a .env file with these variables');
    process.exit(1);
  }

  if (!pat) {
    console.error('Error: Missing required configuration AZURE_DEVOPS_PAT');
    console.error('Please set the following environment variables:');
    console.error(
      '  - AZURE_DEVOPS_ORG_URL (e.g., https://dev.azure.com/yourorg)'
    );
    console.error('  - AZURE_DEVOPS_PAT (your Personal Access Token)');
    console.error(
      '  - AZURE_DEVOPS_AUTH_METHOD (optional, default: pat, can be: pat or bearer)'
    );
    console.error('');
    console.error(
      'Generate a PAT at: https://dev.azure.com/yourorg/_usersSettings/tokens'
    );
    console.error('You can also create a .env file with these variables');
    process.exit(1);
  }

  return {
    orgUrl: orgUrl.replace(/\/$/, ''), // Remove trailing slash
    pat,
    authMethod,
    defaultProject,
  };
}
