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
  isKeyringCredentialValid,
  activeJiraEnvVars,
  activeAdoEnvVars,
  activeGithubEnvVars,
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
  // Populated only when source === 'env': the list of env vars currently
  // set for this service (used by the migration tip in buildWhoamiOutput).
  envVarsSet?: string[];
  // Populated only when source === 'env': true if the keyring also holds a
  // valid credential blob for this service (i.e. env is shadowing the
  // keyring). Drives which flavor of tip whoami prints.
  keyringAlsoConfigured?: boolean;
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
    const keyringAlsoConfigured = await isKeyringCredentialValid('jira');
    return {
      service: 'jira',
      source: 'env',
      identity: `${status.value.email} at ${redactUrlUserInfo(status.value.url)}`,
      envVarsSet: activeJiraEnvVars(),
      keyringAlsoConfigured,
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
    const keyringAlsoConfigured = await isKeyringCredentialValid('ado');
    return {
      service: 'ado',
      source: 'env',
      identity: `${redactUrlUserInfo(status.value.orgUrl)} (${status.value.authMethod})`,
      envVarsSet: activeAdoEnvVars(),
      keyringAlsoConfigured,
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
    const keyringAlsoConfigured = await isKeyringCredentialValid('github');
    return {
      service: 'github',
      source: 'env',
      identity: null,
      envVarsSet: activeGithubEnvVars(),
      keyringAlsoConfigured,
    };
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

/**
 * Compose the full whoami output, including a migration hint when any
 * service is sourced from env vars. Exported for tests.
 *
 * Two tip flavors:
 *  - env-only (keyring empty): suggest running `aide login <svc> --from-env`
 *  - env+keyring (migration already done): list the env vars overriding the
 *    keyring and suggest unsetting them
 */
export async function buildWhoamiOutput(
  opts: { ghAvailable?: () => boolean; service?: ServiceName } = {}
): Promise<string> {
  const statuses = await getWhoamiStatus({ ghAvailable: opts.ghAvailable });
  const filtered = opts.service
    ? statuses.filter((s) => s.service === opts.service)
    : statuses;
  const lines = filtered.map(formatStatus);
  const envSourced = filtered.filter((s) => s.source === 'env');
  if (envSourced.length > 0) {
    lines.push('');
    for (const s of envSourced) {
      if (s.keyringAlsoConfigured && s.envVarsSet && s.envVarsSet.length > 0) {
        lines.push(
          `tip: ${s.envVarsSet.join(', ')} override your stored keyring entry. Unset to use the keyring.`
        );
      } else {
        lines.push(
          `tip: run 'aide login ${s.service} --from-env' to store in the keyring`
        );
      }
    }
  }
  return lines.join('\n');
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
    const output = await buildWhoamiOutput({ service: argv.service });
    console.log(output);
  },
};

export default command;
