import { Effect } from 'effect';
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
import {
  KeyringLive,
  KeyringService,
  KeyringUnavailableError,
} from './auth-keyring.js';
import {
  authSecretScopesMatch,
  resolveAuthSecretEffect,
  resolveAuthSecretPromise,
  type AuthStoreScope,
} from './auth-store.js';
import {
  canonicalizeGitHubAuthHost,
  DEFAULT_GITHUB_HOST,
  githubEnvironmentCredential,
  resolveGitHubAuthRequest,
  validateGitHubStoredCredential,
} from './github-auth.js';
import {
  resolveGitHubCredential,
  resolveGitHubCredentialEffect,
  type GitHubCredentialResolution,
} from './github-credential-resolver.js';
import type { GitHubAuthProbe } from './gh-utils.js';

export type ConfigSource = 'env' | 'keyring';

export interface LoadedConfig<T> {
  config: T;
  source: ConfigSource;
}

const configErrorDiagnostics = new WeakMap<object, string>();

export function configErrorDiagnostic(error: unknown): string | undefined {
  return (typeof error === 'object' && error !== null) ||
    typeof error === 'function'
    ? configErrorDiagnostics.get(error)
    : undefined;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
    configErrorDiagnostics.set(this, message);
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

function jiraConfigMatchesScope(
  config: JiraConfig,
  scope: AuthStoreScope
): boolean {
  return authSecretScopesMatch('jira', scope, {
    providerId: 'jira',
    host: config.url,
    account: config.email,
  });
}

function parseJiraFromKeyring(
  raw: string | null,
  scope?: AuthStoreScope
): KeyringResult<JiraConfig> {
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
  if (scope !== undefined && !jiraConfigMatchesScope(parsed.output, scope)) {
    return {
      kind: 'malformed',
      reason:
        'Stored scoped Jira credential identity does not match the requested authentication scope. ' +
        "Re-run 'aide login jira' to reconfigure.",
    };
  }
  return { kind: 'found', value: parsed.output };
}

function readJiraFromKeyringEffect(scope?: AuthStoreScope) {
  return Effect.matchEffect(resolveAuthSecretEffect('jira', scope), {
    onFailure: (error) =>
      error instanceof KeyringUnavailableError
        ? Effect.succeed<KeyringResult<JiraConfig>>({ kind: 'unreachable' })
        : Effect.fail(error),
    onSuccess: (resolved) =>
      Effect.succeed(parseJiraFromKeyring(resolved?.value ?? null, scope)),
  });
}

async function readJiraFromKeyring(
  scope?: AuthStoreScope
): Promise<KeyringResult<JiraConfig>> {
  return Effect.runPromise(
    readJiraFromKeyringEffect(scope).pipe(Effect.provide(KeyringLive))
  );
}

export function probeJiraConfigEffect(scope?: AuthStoreScope) {
  const fromEnv = readJiraFromEnv();
  if (
    fromEnv !== null &&
    (scope === undefined ||
      (fromEnv.kind === 'env' && jiraConfigMatchesScope(fromEnv.value, scope)))
  ) {
    return Effect.succeed(fromEnv);
  }

  return Effect.map(readJiraFromKeyringEffect(scope), (fromKeyring) => {
    if (fromKeyring.kind === 'found') {
      return { kind: 'keyring' as const, value: fromKeyring.value };
    }
    if (fromKeyring.kind === 'unreachable') {
      return { kind: 'unreachable' as const };
    }
    if (fromKeyring.kind === 'malformed') return fromKeyring;
    return { kind: 'missing' as const };
  });
}

/** @deprecated Live compatibility adapter. Use probeJiraConfigEffect. */
export async function probeJiraConfig(
  scope?: AuthStoreScope
): Promise<ConfigStatus<JiraConfig>> {
  return Effect.runPromise(
    probeJiraConfigEffect(scope).pipe(Effect.provide(KeyringLive))
  );
}

export async function loadConfig(
  scope?: AuthStoreScope
): Promise<LoadedConfig<JiraConfig>> {
  const status = await probeJiraConfig(scope);
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

function adoConfigMatchesScope(
  config: AzureDevOpsConfig,
  scope: AuthStoreScope
): boolean {
  return authSecretScopesMatch('azure-devops', scope, {
    providerId: 'azure-devops',
    host: config.orgUrl,
  });
}

function parseAdoFromKeyring(
  raw: string | null,
  scope?: AuthStoreScope
): KeyringResult<AzureDevOpsConfig> {
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
  if (scope !== undefined && !adoConfigMatchesScope(parsed.output, scope)) {
    return {
      kind: 'malformed',
      reason:
        'Stored scoped Azure DevOps credential identity does not match the requested authentication scope. ' +
        "Re-run 'aide login ado' to reconfigure.",
    };
  }
  return { kind: 'found', value: parsed.output };
}

function readAdoFromKeyringEffect(scope?: AuthStoreScope) {
  return Effect.matchEffect(resolveAuthSecretEffect('azure-devops', scope), {
    onFailure: (error) =>
      error instanceof KeyringUnavailableError
        ? Effect.succeed<KeyringResult<AzureDevOpsConfig>>({
            kind: 'unreachable',
          })
        : Effect.fail(error),
    onSuccess: (resolved) =>
      Effect.succeed(parseAdoFromKeyring(resolved?.value ?? null, scope)),
  });
}

async function readAdoFromKeyring(
  scope?: AuthStoreScope
): Promise<KeyringResult<AzureDevOpsConfig>> {
  return Effect.runPromise(
    readAdoFromKeyringEffect(scope).pipe(Effect.provide(KeyringLive))
  );
}

export function probeAdoConfigEffect(scope?: AuthStoreScope) {
  const fromEnv = readAdoFromEnv();
  if (
    fromEnv !== null &&
    (scope === undefined ||
      (fromEnv.kind === 'env' && adoConfigMatchesScope(fromEnv.value, scope)))
  ) {
    return Effect.succeed(fromEnv);
  }

  return Effect.map(readAdoFromKeyringEffect(scope), (fromKeyring) => {
    if (fromKeyring.kind === 'found') {
      return { kind: 'keyring' as const, value: fromKeyring.value };
    }
    if (fromKeyring.kind === 'unreachable') {
      return { kind: 'unreachable' as const };
    }
    if (fromKeyring.kind === 'malformed') return fromKeyring;
    return { kind: 'missing' as const };
  });
}

/** @deprecated Live compatibility adapter. Use probeAdoConfigEffect. */
export async function probeAdoConfig(
  scope?: AuthStoreScope
): Promise<ConfigStatus<AzureDevOpsConfig>> {
  return Effect.runPromise(
    probeAdoConfigEffect(scope).pipe(Effect.provide(KeyringLive))
  );
}

export async function loadAzureDevOpsConfig(
  scope?: AuthStoreScope
): Promise<LoadedConfig<AzureDevOpsConfig>> {
  const status = await probeAdoConfig(scope);
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
  | { source: 'gh-cli'; account?: string }
  | { source: 'env' }
  | { source: 'stored'; token: string; account?: string };

interface GithubConfigProbeOptions {
  readonly ghAuthProbe?: GitHubAuthProbe;
  readonly host?: string;
  readonly scope?: AuthStoreScope;
}

function githubConfigStatus(
  credential: GitHubCredentialResolution
): ConfigStatus<GithubConfigValue> {
  switch (credential.kind) {
    case 'gh-cli':
      return {
        kind: 'env',
        value: {
          source: 'gh-cli',
          ...(credential.account === undefined
            ? {}
            : { account: credential.account }),
        },
      };
    case 'env':
      return { kind: 'env', value: { source: 'env' } };
    case 'stored':
      return {
        kind: 'keyring',
        value: {
          source: 'stored',
          token: credential.token,
          ...(credential.account === undefined
            ? {}
            : { account: credential.account }),
        },
      };
    case 'missing':
      return { kind: 'missing' };
    case 'unreachable':
      return { kind: 'unreachable' };
    case 'failure':
      return { kind: 'malformed', reason: credential.reason };
  }
}

export function probeGithubConfigEffect(
  opts: GithubConfigProbeOptions = {}
): Effect.Effect<ConfigStatus<GithubConfigValue>, unknown, KeyringService> {
  const request = resolveGitHubAuthRequest(opts);
  if (!request.ok) {
    return Effect.succeed({ kind: 'malformed', reason: request.reason });
  }

  return Effect.map(
    resolveGitHubCredentialEffect(request, opts),
    githubConfigStatus
  );
}

/** @deprecated Live compatibility adapter. Use probeGithubConfigEffect. */
export async function probeGithubConfig(
  opts: GithubConfigProbeOptions = {}
): Promise<ConfigStatus<GithubConfigValue>> {
  const request = resolveGitHubAuthRequest(opts);
  if (!request.ok) return { kind: 'malformed', reason: request.reason };
  return githubConfigStatus(await resolveGitHubCredential(request, opts));
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

export function readGithubEnvForMigration(
  requestedHost: string = DEFAULT_GITHUB_HOST
): ReadEnvResult<v.InferOutput<typeof StoredGithubSchema>> {
  const host = canonicalizeGitHubAuthHost(requestedHost);
  if (host === null) {
    return {
      kind: 'invalid',
      reason: `Invalid GitHub authentication host '${requestedHost}'.`,
    };
  }

  const credential = githubEnvironmentCredential(host);
  if (credential === null) {
    if (host === DEFAULT_GITHUB_HOST) {
      return { kind: 'missing', missingVars: ['GITHUB_TOKEN (or GH_TOKEN)'] };
    }
    const missingVars: string[] = [];
    if (!Bun.env.GH_HOST) missingVars.push('GH_HOST');
    if (!Bun.env.GH_ENTERPRISE_TOKEN && !Bun.env.GITHUB_ENTERPRISE_TOKEN) {
      missingVars.push('GH_ENTERPRISE_TOKEN (or GITHUB_ENTERPRISE_TOKEN)');
    }
    if (missingVars.length > 0) return { kind: 'missing', missingVars };
    return {
      kind: 'invalid',
      reason: `GH_HOST must canonically match requested GitHub host '${host}'.`,
    };
  }

  const parsed = v.safeParse(StoredGithubSchema, { token: credential.token });
  if (!parsed.success)
    return { kind: 'invalid', reason: formatIssues(parsed.issues) };
  return {
    kind: 'ok',
    value: parsed.output,
    varsUsed:
      host === DEFAULT_GITHUB_HOST
        ? [credential.variable]
        : ['GH_HOST', credential.variable],
  };
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
 * Returns true if the unscoped production keyring reader would accept the
 * credential stored for `name`, without consulting environment variables or
 * the gh CLI. Missing, unreachable, malformed, or wrong-generation entries
 * return false.
 *
 * Unexpected failures still propagate, matching the underlying production
 * readers so the whoami Effect boundary can retain them in its typed error
 * channel. GitHub validator failures are treated as malformed, as they are by
 * resolveGitHubCredential.
 */
export async function isKeyringCredentialValid(
  name: 'jira' | 'ado' | 'github'
): Promise<boolean> {
  if (name === 'jira') {
    return (await readJiraFromKeyring()).kind === 'found';
  }
  if (name === 'ado') {
    return (await readAdoFromKeyring()).kind === 'found';
  }

  const request = resolveGitHubAuthRequest({});
  if (!request.ok) return false;

  let resolved;
  try {
    resolved = await resolveAuthSecretPromise('github');
  } catch (error) {
    if (error instanceof KeyringUnavailableError) return false;
    throw error;
  }
  if (resolved === null) return false;

  try {
    return validateGitHubStoredCredential(
      request,
      resolved.kind,
      resolved.value
    ).ok;
  } catch {
    return false;
  }
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
