/**
 * `aide whoami [service]` - show which credentials are configured and where
 * they come from. Never prints tokens.
 *
 * For github, we report `gh-cli` if the gh CLI is authenticated, otherwise
 * fall back to the same env/keyring check as other services. No network calls.
 */

import type { ArgumentsCamelCase, CommandModule } from 'yargs';
import * as v from 'valibot';

import { getSecret, KeyringUnavailableError } from '@lib/secrets.js';
import {
  StoredJiraSchema,
  StoredAdoSchema,
  StoredGithubSchema,
} from '@schemas/config.js';
import { isGhCliAvailable } from '@lib/gh-utils.js';

export type ServiceName = 'jira' | 'ado' | 'github';
export type WhoamiSource = 'env' | 'keyring' | 'gh-cli' | 'not-configured';

export interface WhoamiStatus {
  service: ServiceName;
  source: WhoamiSource;
  identity: string | null;
}

function redactUrlUserInfo(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.username || url.password) {
      url.username = '';
      url.password = '';
      return url.toString().replace(/\/$/, '');
    }
    return raw;
  } catch {
    return raw;
  }
}

export async function getWhoamiStatus(
  opts: { ghAvailable?: () => boolean } = {}
): Promise<WhoamiStatus[]> {
  const ghCheck = opts.ghAvailable ?? isGhCliAvailable;
  return [
    await statusJira(),
    await statusAdo(),
    await statusGithub(ghCheck),
  ];
}

// ---------------------------------------------------------------------------
// Per-service status
// ---------------------------------------------------------------------------

async function statusJira(): Promise<WhoamiStatus> {
  const envUrl = Bun.env.JIRA_URL;
  const envEmail = Bun.env.JIRA_EMAIL || Bun.env.JIRA_USERNAME;
  const envToken = Bun.env.JIRA_API_TOKEN || Bun.env.JIRA_TOKEN;
  if (envUrl && envEmail && envToken) {
    return {
      service: 'jira',
      source: 'env',
      identity: `${envEmail} at ${redactUrlUserInfo(envUrl)}`,
    };
  }

  const stored = await tryReadStored('jira', StoredJiraSchema);
  if (stored) {
    return {
      service: 'jira',
      source: 'keyring',
      identity: `${stored.email} at ${redactUrlUserInfo(stored.url)}`,
    };
  }

  return { service: 'jira', source: 'not-configured', identity: null };
}

async function statusAdo(): Promise<WhoamiStatus> {
  const envOrg = Bun.env.AZURE_DEVOPS_ORG_URL;
  const envPat = Bun.env.AZURE_DEVOPS_PAT;
  const envAuth = Bun.env.AZURE_DEVOPS_AUTH_METHOD || 'pat';
  if (envOrg && envPat) {
    return {
      service: 'ado',
      source: 'env',
      identity: `${redactUrlUserInfo(envOrg)} (${envAuth})`,
    };
  }

  const stored = await tryReadStored('ado', StoredAdoSchema);
  if (stored) {
    return {
      service: 'ado',
      source: 'keyring',
      identity: `${redactUrlUserInfo(stored.orgUrl)} (${stored.authMethod})`,
    };
  }

  return { service: 'ado', source: 'not-configured', identity: null };
}

async function statusGithub(
  ghAvailable: () => boolean
): Promise<WhoamiStatus> {
  if (ghAvailable()) {
    return { service: 'github', source: 'gh-cli', identity: null };
  }
  if (Bun.env.GITHUB_TOKEN || Bun.env.GH_TOKEN) {
    return { service: 'github', source: 'env', identity: null };
  }
  const stored = await tryReadStored('github', StoredGithubSchema);
  if (stored) {
    return { service: 'github', source: 'keyring', identity: null };
  }
  return { service: 'github', source: 'not-configured', identity: null };
}

async function tryReadStored<T>(
  name: 'jira' | 'ado' | 'github',
  schema: v.BaseSchema<unknown, T, v.BaseIssue<unknown>>
): Promise<T | null> {
  let raw: string | null;
  try {
    raw = await getSecret(name);
  } catch (err) {
    if (err instanceof KeyringUnavailableError) return null;
    throw err;
  }
  if (raw === null) return null;
  try {
    const json = JSON.parse(raw);
    return v.parse(schema, json);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatStatus(s: WhoamiStatus): string {
  const pad = s.service.padEnd(8);
  switch (s.source) {
    case 'not-configured':
      return `${pad}  not configured`;
    case 'env':
      return `${pad}  env         ${s.identity ?? ''}`.trimEnd();
    case 'keyring':
      return `${pad}  keyring     ${s.identity ?? ''}`.trimEnd();
    case 'gh-cli':
      return `${pad}  gh CLI`;
  }
}

// ---------------------------------------------------------------------------
// yargs wiring
// ---------------------------------------------------------------------------

interface Args {
  service?: ServiceName;
}

const command: CommandModule<object, Args> = {
  command: 'whoami [service]',
  describe: 'Show configured credentials and their source',
  builder: {
    service: {
      type: 'string',
      choices: ['jira', 'ado', 'github'] as const,
      describe: 'Limit output to a single service',
    },
  },
  handler: async (argv: ArgumentsCamelCase<Args>) => {
    const statuses = await getWhoamiStatus();
    const filtered = argv.service
      ? statuses.filter((s) => s.service === argv.service)
      : statuses;
    for (const s of filtered) {
      console.log(formatStatus(s));
    }
  },
};

export default command;
