import * as v from 'valibot';
import {
  JiraConfigSchema,
  AzureDevOpsConfigSchema,
  StoredJiraSchema,
  StoredAdoSchema,
  type JiraConfig,
  type AzureDevOpsConfig,
} from '../schemas/config.js';
import { getSecret, KeyringUnavailableError } from './secrets.js';

export type ConfigSource = 'env' | 'keyring';

export interface LoadedConfig<T> {
  config: T;
  source: ConfigSource;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

// ---------------------------------------------------------------------------
// Jira
// ---------------------------------------------------------------------------

function readJiraFromEnv(): JiraConfig | null {
  const url = Bun.env.JIRA_URL;
  const email = Bun.env.JIRA_EMAIL || Bun.env.JIRA_USERNAME;
  const apiToken = Bun.env.JIRA_API_TOKEN || Bun.env.JIRA_TOKEN;
  if (!url || !email || !apiToken) return null;
  const parsed = v.safeParse(JiraConfigSchema, {
    url,
    email,
    apiToken,
    defaultProject: Bun.env.JIRA_DEFAULT_PROJECT,
  });
  if (!parsed.success) {
    throw new ConfigError(
      `Invalid Jira environment variables: ${formatIssues(parsed.issues)}`
    );
  }
  return parsed.output;
}

async function readJiraFromKeyring(): Promise<JiraConfig | null> {
  let raw: string | null;
  try {
    raw = await getSecret('jira');
  } catch (err) {
    if (err instanceof KeyringUnavailableError) return null;
    throw err;
  }
  if (raw === null) return null;

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ConfigError(
      'Stored Jira credentials are malformed. Re-run via aide login jira.'
    );
  }
  const parsed = v.safeParse(StoredJiraSchema, json);
  if (!parsed.success) {
    throw new ConfigError(
      'Stored Jira credentials failed validation: ' +
        formatIssues(parsed.issues) +
        '. Re-run via aide login jira.'
    );
  }
  return { ...parsed.output };
}

export async function loadConfig(): Promise<LoadedConfig<JiraConfig>> {
  const fromEnv = readJiraFromEnv();
  if (fromEnv) return { config: fromEnv, source: 'env' };

  const fromKeyring = await readJiraFromKeyring();
  if (fromKeyring) return { config: fromKeyring, source: 'keyring' };

  throw new ConfigError(
    "Jira is not configured. Run 'aide login jira', or set JIRA_URL, " +
      'JIRA_EMAIL (or JIRA_USERNAME), and JIRA_API_TOKEN (or JIRA_TOKEN).'
  );
}

// ---------------------------------------------------------------------------
// Azure DevOps
// ---------------------------------------------------------------------------

function readAdoFromEnv(): AzureDevOpsConfig | null {
  const orgUrl = Bun.env.AZURE_DEVOPS_ORG_URL;
  const pat = Bun.env.AZURE_DEVOPS_PAT;
  if (!orgUrl || !pat) return null;
  const parsed = v.safeParse(AzureDevOpsConfigSchema, {
    orgUrl,
    pat,
    authMethod: Bun.env.AZURE_DEVOPS_AUTH_METHOD || 'pat',
    defaultProject: Bun.env.AZURE_DEVOPS_DEFAULT_PROJECT,
  });
  if (!parsed.success) {
    throw new ConfigError(
      `Invalid Azure DevOps environment variables: ${formatIssues(
        parsed.issues
      )}`
    );
  }
  return parsed.output;
}

async function readAdoFromKeyring(): Promise<AzureDevOpsConfig | null> {
  let raw: string | null;
  try {
    raw = await getSecret('ado');
  } catch (err) {
    if (err instanceof KeyringUnavailableError) return null;
    throw err;
  }
  if (raw === null) return null;

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ConfigError(
      "Stored Azure DevOps credentials are malformed. Re-run 'aide login ado'."
    );
  }
  const parsed = v.safeParse(StoredAdoSchema, json);
  if (!parsed.success) {
    throw new ConfigError(
      "Stored Azure DevOps credentials failed validation: " +
        formatIssues(parsed.issues) +
        ". Re-run 'aide login ado'."
    );
  }
  return { ...parsed.output };
}

export async function loadAzureDevOpsConfig(): Promise<
  LoadedConfig<AzureDevOpsConfig>
> {
  const fromEnv = readAdoFromEnv();
  if (fromEnv) return { config: fromEnv, source: 'env' };

  const fromKeyring = await readAdoFromKeyring();
  if (fromKeyring) return { config: fromKeyring, source: 'keyring' };

  throw new ConfigError(
    "Azure DevOps is not configured. Run 'aide login ado', or set " +
      'AZURE_DEVOPS_ORG_URL and AZURE_DEVOPS_PAT.'
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatIssues(issues: readonly v.BaseIssue<unknown>[]): string {
  return issues
    .map((i) => {
      const path = i.path?.map((p) => p.key).join('.') ?? '';
      return path ? `${path}: ${i.message}` : i.message;
    })
    .join('; ');
}
