import * as v from 'valibot';
import {
  JiraConfigSchema,
  AzureDevOpsConfigSchema,
  StoredJiraSchema,
  StoredAdoSchema,
  StoredGithubSchema,
  type JiraConfig,
  type AzureDevOpsConfig,
} from '../schemas/config.js';
import { getSecret, KeyringUnavailableError } from './secrets.js';
import { isGhCliAvailable } from './gh-utils.js';

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
// ConfigStatus discriminated union (non-throwing probe API)
// ---------------------------------------------------------------------------

export type ConfigStatus<T> =
  | { kind: 'env'; value: T }
  | { kind: 'keyring'; value: T }
  | { kind: 'missing' }
  | { kind: 'unreachable' }
  | { kind: 'malformed'; reason: string };

// ---------------------------------------------------------------------------
// Jira
// ---------------------------------------------------------------------------

function readJiraFromEnv(): ConfigStatus<JiraConfig> | null {
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
    return {
      kind: 'malformed',
      reason: `Invalid Jira environment variables: ${formatIssues(parsed.issues)}`,
    };
  }
  return { kind: 'env', value: parsed.output };
}

type KeyringResult<T> =
  | { kind: 'found'; value: T }
  | { kind: 'missing' }
  | { kind: 'unreachable' }
  | { kind: 'malformed'; reason: string };

async function readJiraFromKeyring(): Promise<KeyringResult<JiraConfig>> {
  let raw: string | null;
  try {
    raw = await getSecret('jira');
  } catch (err) {
    if (err instanceof KeyringUnavailableError) return { kind: 'unreachable' };
    throw err;
  }
  if (raw === null) return { kind: 'missing' };

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return {
      kind: 'malformed',
      reason:
        "Stored Jira credentials are malformed. Re-run 'aide login jira' to reconfigure.",
    };
  }
  const parsed = v.safeParse(StoredJiraSchema, json);
  if (!parsed.success) {
    return {
      kind: 'malformed',
      reason:
        'Stored Jira credentials failed validation: ' +
        formatIssues(parsed.issues) +
        ". Re-run 'aide login jira' to reconfigure.",
    };
  }
  return { kind: 'found', value: parsed.output };
}

export async function probeJiraConfig(): Promise<ConfigStatus<JiraConfig>> {
  const fromEnv = readJiraFromEnv();
  if (fromEnv !== null) return fromEnv;

  const fromKeyring = await readJiraFromKeyring();
  if (fromKeyring.kind === 'found')
    return { kind: 'keyring', value: fromKeyring.value };
  if (fromKeyring.kind === 'unreachable') return { kind: 'unreachable' };
  if (fromKeyring.kind === 'malformed') return fromKeyring;
  return { kind: 'missing' };
}

export async function loadConfig(): Promise<LoadedConfig<JiraConfig>> {
  const status = await probeJiraConfig();
  if (status.kind === 'env') return { config: status.value, source: 'env' };
  if (status.kind === 'keyring')
    return { config: status.value, source: 'keyring' };

  if (status.kind === 'malformed') {
    throw new ConfigError(status.reason);
  }

  if (status.kind === 'unreachable') {
    throw new ConfigError(
      'Jira is not configured via environment variables, and the system ' +
        'keyring is unreachable. On Linux, this usually means gnome-keyring ' +
        "or kwallet isn't running. Set JIRA_URL, JIRA_EMAIL (or JIRA_USERNAME), " +
        'and JIRA_API_TOKEN (or JIRA_TOKEN) as a fallback.'
    );
  }

  throw new ConfigError(
    "Jira is not configured. Run 'aide login jira', or set JIRA_URL, " +
      'JIRA_EMAIL (or JIRA_USERNAME), and JIRA_API_TOKEN (or JIRA_TOKEN).'
  );
}

// ---------------------------------------------------------------------------
// Azure DevOps
// ---------------------------------------------------------------------------

function readAdoFromEnv(): ConfigStatus<AzureDevOpsConfig> | null {
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
    return {
      kind: 'malformed',
      reason: `Invalid Azure DevOps environment variables: ${formatIssues(parsed.issues)}`,
    };
  }
  return { kind: 'env', value: parsed.output };
}

async function readAdoFromKeyring(): Promise<KeyringResult<AzureDevOpsConfig>> {
  let raw: string | null;
  try {
    raw = await getSecret('ado');
  } catch (err) {
    if (err instanceof KeyringUnavailableError) return { kind: 'unreachable' };
    throw err;
  }
  if (raw === null) return { kind: 'missing' };

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return {
      kind: 'malformed',
      reason:
        "Stored Azure DevOps credentials are malformed. Re-run 'aide login ado' to reconfigure.",
    };
  }
  const parsed = v.safeParse(StoredAdoSchema, json);
  if (!parsed.success) {
    return {
      kind: 'malformed',
      reason:
        'Stored Azure DevOps credentials failed validation: ' +
        formatIssues(parsed.issues) +
        ". Re-run 'aide login ado' to reconfigure.",
    };
  }
  return { kind: 'found', value: parsed.output };
}

export async function probeAdoConfig(): Promise<
  ConfigStatus<AzureDevOpsConfig>
> {
  const fromEnv = readAdoFromEnv();
  if (fromEnv !== null) return fromEnv;

  const fromKeyring = await readAdoFromKeyring();
  if (fromKeyring.kind === 'found')
    return { kind: 'keyring', value: fromKeyring.value };
  if (fromKeyring.kind === 'unreachable') return { kind: 'unreachable' };
  if (fromKeyring.kind === 'malformed') return fromKeyring;
  return { kind: 'missing' };
}

export async function loadAzureDevOpsConfig(): Promise<
  LoadedConfig<AzureDevOpsConfig>
> {
  const status = await probeAdoConfig();
  if (status.kind === 'env') return { config: status.value, source: 'env' };
  if (status.kind === 'keyring')
    return { config: status.value, source: 'keyring' };

  if (status.kind === 'malformed') {
    throw new ConfigError(status.reason);
  }

  if (status.kind === 'unreachable') {
    throw new ConfigError(
      'Azure DevOps is not configured via environment variables, and the system ' +
        'keyring is unreachable. On Linux, this usually means gnome-keyring ' +
        "or kwallet isn't running. Set AZURE_DEVOPS_ORG_URL and AZURE_DEVOPS_PAT " +
        'as a fallback.'
    );
  }

  throw new ConfigError(
    "Azure DevOps is not configured. Run 'aide login ado', or set " +
      'AZURE_DEVOPS_ORG_URL and AZURE_DEVOPS_PAT.'
  );
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

export type GithubConfigValue =
  | { source: 'gh-cli' }
  | { source: 'env' }
  | { source: 'stored'; token: string };

export async function probeGithubConfig(
  opts: { ghAvailable?: () => boolean } = {}
): Promise<ConfigStatus<GithubConfigValue>> {
  const ghCheck = opts.ghAvailable ?? isGhCliAvailable;

  if (ghCheck()) {
    return { kind: 'env', value: { source: 'gh-cli' } };
  }

  const envToken = Bun.env.GITHUB_TOKEN || Bun.env.GH_TOKEN;
  if (envToken) {
    return { kind: 'env', value: { source: 'env' } };
  }

  let raw: string | null;
  try {
    raw = await getSecret('github');
  } catch (err) {
    if (err instanceof KeyringUnavailableError) return { kind: 'unreachable' };
    throw err;
  }

  if (raw === null) return { kind: 'missing' };

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return {
      kind: 'malformed',
      reason:
        "Stored GitHub credentials are malformed. Re-run 'aide login github' to reconfigure.",
    };
  }

  const parsed = v.safeParse(StoredGithubSchema, json);
  if (!parsed.success) {
    return {
      kind: 'malformed',
      reason:
        'Stored GitHub credentials failed validation. ' +
        "Re-run 'aide login github' to reconfigure.",
    };
  }

  return {
    kind: 'keyring',
    value: { source: 'stored', token: parsed.output.token },
  };
}

// ---------------------------------------------------------------------------
// Env-to-stored helpers (used by `aide login <service> --from-env`)
// ---------------------------------------------------------------------------
//
// These report explicitly which env vars are missing so the login command
// can produce actionable errors, narrow the env values to the Stored*
// schema (no user preferences like defaultProject), and include the list
// of concrete env var names actually read (used by success messages so
// the user knows what to unset).

export type MigrationError =
  | { kind: 'missing'; missingVars: string[] }
  | { kind: 'invalid'; reason: string };

export type ReadEnvResult<T> =
  | { kind: 'ok'; value: T; varsUsed: string[] }
  | MigrationError;

export function readJiraEnvForMigration(): ReadEnvResult<
  v.InferOutput<typeof StoredJiraSchema>
> {
  const url = Bun.env.JIRA_URL;
  const emailVar = Bun.env.JIRA_EMAIL ? 'JIRA_EMAIL' : 'JIRA_USERNAME';
  const email = Bun.env.JIRA_EMAIL || Bun.env.JIRA_USERNAME;
  const tokenVar = Bun.env.JIRA_API_TOKEN ? 'JIRA_API_TOKEN' : 'JIRA_TOKEN';
  const apiToken = Bun.env.JIRA_API_TOKEN || Bun.env.JIRA_TOKEN;
  const missing: string[] = [];
  if (!url) missing.push('JIRA_URL');
  if (!email) missing.push('JIRA_EMAIL (or JIRA_USERNAME)');
  if (!apiToken) missing.push('JIRA_API_TOKEN (or JIRA_TOKEN)');
  if (missing.length > 0) return { kind: 'missing', missingVars: missing };
  const parsed = v.safeParse(StoredJiraSchema, { url, email, apiToken });
  if (!parsed.success)
    return { kind: 'invalid', reason: formatIssues(parsed.issues) };
  return {
    kind: 'ok',
    value: parsed.output,
    varsUsed: ['JIRA_URL', emailVar, tokenVar],
  };
}

export function readAdoEnvForMigration(): ReadEnvResult<
  v.InferOutput<typeof StoredAdoSchema>
> {
  const orgUrl = Bun.env.AZURE_DEVOPS_ORG_URL;
  const pat = Bun.env.AZURE_DEVOPS_PAT;
  const missing: string[] = [];
  if (!orgUrl) missing.push('AZURE_DEVOPS_ORG_URL');
  if (!pat) missing.push('AZURE_DEVOPS_PAT');
  if (missing.length > 0) return { kind: 'missing', missingVars: missing };
  const parsed = v.safeParse(StoredAdoSchema, {
    orgUrl,
    pat,
    authMethod: Bun.env.AZURE_DEVOPS_AUTH_METHOD || 'pat',
  });
  if (!parsed.success)
    return { kind: 'invalid', reason: formatIssues(parsed.issues) };
  const varsUsed = ['AZURE_DEVOPS_ORG_URL', 'AZURE_DEVOPS_PAT'];
  if (Bun.env.AZURE_DEVOPS_AUTH_METHOD)
    varsUsed.push('AZURE_DEVOPS_AUTH_METHOD');
  return { kind: 'ok', value: parsed.output, varsUsed };
}

export function readGithubEnvForMigration(): ReadEnvResult<
  v.InferOutput<typeof StoredGithubSchema>
> {
  const tokenVar = Bun.env.GITHUB_TOKEN ? 'GITHUB_TOKEN' : 'GH_TOKEN';
  const token = Bun.env.GITHUB_TOKEN || Bun.env.GH_TOKEN;
  if (!token)
    return { kind: 'missing', missingVars: ['GITHUB_TOKEN (or GH_TOKEN)'] };
  const parsed = v.safeParse(StoredGithubSchema, { token });
  if (!parsed.success)
    return { kind: 'invalid', reason: formatIssues(parsed.issues) };
  return { kind: 'ok', value: parsed.output, varsUsed: [tokenVar] };
}

// ---------------------------------------------------------------------------
// Post-migration awareness helpers (used by whoami)
// ---------------------------------------------------------------------------

/**
 * Names of env vars currently set for each service. Used by whoami to tell
 * users which vars override their keyring entry.
 */
export function activeJiraEnvVars(): string[] {
  const vars: string[] = [];
  if (Bun.env.JIRA_URL) vars.push('JIRA_URL');
  if (Bun.env.JIRA_EMAIL) vars.push('JIRA_EMAIL');
  if (Bun.env.JIRA_USERNAME) vars.push('JIRA_USERNAME');
  if (Bun.env.JIRA_API_TOKEN) vars.push('JIRA_API_TOKEN');
  if (Bun.env.JIRA_TOKEN) vars.push('JIRA_TOKEN');
  return vars;
}

export function activeAdoEnvVars(): string[] {
  const vars: string[] = [];
  if (Bun.env.AZURE_DEVOPS_ORG_URL) vars.push('AZURE_DEVOPS_ORG_URL');
  if (Bun.env.AZURE_DEVOPS_PAT) vars.push('AZURE_DEVOPS_PAT');
  if (Bun.env.AZURE_DEVOPS_AUTH_METHOD) vars.push('AZURE_DEVOPS_AUTH_METHOD');
  return vars;
}

export function activeGithubEnvVars(): string[] {
  const vars: string[] = [];
  if (Bun.env.GITHUB_TOKEN) vars.push('GITHUB_TOKEN');
  if (Bun.env.GH_TOKEN) vars.push('GH_TOKEN');
  return vars;
}

/**
 * Returns true if the OS keyring has a valid credential blob stored for
 * `name`. Returns false if the entry is missing, the backend is unreachable,
 * or the stored blob fails schema validation. Does not throw.
 */
export async function isKeyringCredentialValid(
  name: 'jira' | 'ado' | 'github'
): Promise<boolean> {
  let raw: string | null;
  try {
    raw = await getSecret(name);
  } catch {
    return false;
  }
  if (!raw) return false;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return false;
  }
  const schema =
    name === 'jira'
      ? StoredJiraSchema
      : name === 'ado'
        ? StoredAdoSchema
        : StoredGithubSchema;
  return v.safeParse(schema, json).success;
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
