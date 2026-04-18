/**
 * `aide whoami [service]` - show which credentials are configured and where
 * they come from. Never prints tokens.
 *
 * For github, we report `gh-cli` if the gh CLI is authenticated, otherwise
 * fall back to the same env/keyring check as other services. No network calls.
 */

import type { ArgumentsCamelCase, CommandModule } from 'yargs';

import {
  probeJiraConfig,
  probeAdoConfig,
  probeGithubConfig,
} from '@lib/config.js';

export type ServiceName = 'jira' | 'ado' | 'github';
export type WhoamiSource =
  | 'env'
  | 'keyring'
  | 'gh-cli'
  | 'not-configured'
  | 'corrupted';

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
  return [await statusJira(), await statusAdo(), await statusGithub(opts)];
}

// ---------------------------------------------------------------------------
// Per-service status
// ---------------------------------------------------------------------------

async function statusJira(): Promise<WhoamiStatus> {
  const status = await probeJiraConfig();

  if (status.kind === 'env') {
    return {
      service: 'jira',
      source: 'env',
      identity: `${status.value.email} at ${redactUrlUserInfo(status.value.url)}`,
    };
  }
  if (status.kind === 'keyring') {
    return {
      service: 'jira',
      source: 'keyring',
      identity: `${status.value.email} at ${redactUrlUserInfo(status.value.url)}`,
    };
  }
  if (status.kind === 'malformed') {
    return {
      service: 'jira',
      source: 'corrupted',
      identity: "run 'aide login jira' to reconfigure",
    };
  }

  return { service: 'jira', source: 'not-configured', identity: null };
}

async function statusAdo(): Promise<WhoamiStatus> {
  const status = await probeAdoConfig();

  if (status.kind === 'env') {
    return {
      service: 'ado',
      source: 'env',
      identity: `${redactUrlUserInfo(status.value.orgUrl)} (${status.value.authMethod})`,
    };
  }
  if (status.kind === 'keyring') {
    return {
      service: 'ado',
      source: 'keyring',
      identity: `${redactUrlUserInfo(status.value.orgUrl)} (${status.value.authMethod})`,
    };
  }
  if (status.kind === 'malformed') {
    return {
      service: 'ado',
      source: 'corrupted',
      identity: "run 'aide login ado' to reconfigure",
    };
  }

  return { service: 'ado', source: 'not-configured', identity: null };
}

async function statusGithub(opts: {
  ghAvailable?: () => boolean;
}): Promise<WhoamiStatus> {
  const status = await probeGithubConfig(opts);

  if (status.kind === 'env') {
    const src = status.value.source;
    if (src === 'gh-cli') {
      return { service: 'github', source: 'gh-cli', identity: null };
    }
    // source === 'env' (GITHUB_TOKEN / GH_TOKEN)
    return { service: 'github', source: 'env', identity: null };
  }
  if (status.kind === 'keyring') {
    return { service: 'github', source: 'keyring', identity: null };
  }
  if (status.kind === 'malformed') {
    return {
      service: 'github',
      source: 'corrupted',
      identity: "run 'aide login github' to reconfigure",
    };
  }

  return { service: 'github', source: 'not-configured', identity: null };
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
    case 'corrupted':
      return `${pad}  corrupted   ${s.identity ?? ''}`.trimEnd();
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
