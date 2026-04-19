/**
 * `aide login <service>` - interactive credential setup.
 *
 * Subcommands: jira | ado | github. Flags take precedence over prompts; any
 * field not supplied via flag is prompted for. Tokens can also be piped via
 * stdin when the flag is omitted, though if both are provided the flag wins.
 *
 * Each handler is exported so tests can exercise the business logic directly.
 */

import type { ArgumentsCamelCase, CommandModule } from 'yargs';
import * as v from 'valibot';

import { text, password, type Prompter } from '@lib/prompts.js';
import { setSecret } from '@lib/secrets.js';
import {
  StoredJiraSchema,
  StoredAdoSchema,
  StoredGithubSchema,
  type AuthMethod,
} from '@schemas/config.js';
import { isGhCliAvailable } from '@lib/gh-utils.js';
import {
  readJiraEnvForMigration,
  readAdoEnvForMigration,
  readGithubEnvForMigration,
  type MigrationError,
} from '@lib/config.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function readStdin(): Promise<string> {
  let buf = '';
  for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
    buf += chunk.toString('utf8');
  }
  return buf.replace(/\r?\n$/, '');
}

function validateUrl(s: string): string | null {
  try {
    new URL(s);
    return null;
  } catch {
    return 'must be a valid URL';
  }
}

function validateNonEmpty(s: string): string | null {
  return s.length === 0 ? 'required' : null;
}

function formatMigrationError(service: string, err: MigrationError): string {
  if (err.kind === 'missing') {
    return `Cannot migrate ${service} from env: missing ${err.missingVars.join(', ')}.`;
  }
  return `Cannot migrate ${service} from env: ${err.reason}.`;
}

function formatUnsetHint(varsUsed: string[]): string {
  if (varsUsed.length === 0) return '';
  if (varsUsed.length === 1) {
    return `Note: ${varsUsed[0]} is still set and takes precedence over the keyring. Unset it to use the keyring.`;
  }
  const list =
    varsUsed.slice(0, -1).join(', ') + ', and ' + varsUsed[varsUsed.length - 1];
  return `Note: ${list} are still set and take precedence over the keyring. Unset them to use the keyring.`;
}

// ---------------------------------------------------------------------------
// Jira
// ---------------------------------------------------------------------------

export interface JiraLoginFlags {
  url?: string;
  email?: string;
  token?: string;
  fromEnv?: boolean;
}

export async function loginJira(
  flags: JiraLoginFlags,
  opts: { prompter?: Prompter } = {}
): Promise<void> {
  if (flags.fromEnv) {
    const result = readJiraEnvForMigration();
    if (result.kind !== 'ok')
      throw new Error(formatMigrationError('Jira', result));
    await setSecret('jira', JSON.stringify(result.value));
    console.log('Migrated Jira credentials from env to keyring.');
    console.log(formatUnsetHint(result.varsUsed));
    return;
  }

  let pipedToken: string | null = null;
  if (!flags.token && !opts.prompter && !process.stdin.isTTY) {
    pipedToken = (await readStdin()).trim();
  }

  const url =
    flags.url ??
    (await text({
      label: 'Jira URL',
      validate: validateUrl,
      prompter: opts.prompter,
    }));

  const email =
    flags.email ??
    (await text({
      label: 'Email',
      validate: validateNonEmpty,
      prompter: opts.prompter,
    }));

  const token =
    flags.token ??
    pipedToken ??
    (await password({ label: 'API token', prompter: opts.prompter }));

  const validated = v.parse(StoredJiraSchema, {
    url,
    email,
    apiToken: token,
  });
  await setSecret('jira', JSON.stringify(validated));
  console.log('Saved credentials for jira.');
}

// ---------------------------------------------------------------------------
// Azure DevOps
// ---------------------------------------------------------------------------

export interface AdoLoginFlags {
  orgUrl?: string;
  pat?: string;
  authMethod?: AuthMethod;
  fromEnv?: boolean;
}

export async function loginAdo(
  flags: AdoLoginFlags,
  opts: { prompter?: Prompter } = {}
): Promise<void> {
  if (flags.fromEnv) {
    const result = readAdoEnvForMigration();
    if (result.kind !== 'ok')
      throw new Error(formatMigrationError('Azure DevOps', result));
    await setSecret('ado', JSON.stringify(result.value));
    console.log('Migrated Azure DevOps credentials from env to keyring.');
    console.log(formatUnsetHint(result.varsUsed));
    return;
  }

  let pipedToken: string | null = null;
  if (!flags.pat && !opts.prompter && !process.stdin.isTTY) {
    pipedToken = (await readStdin()).trim();
  }

  const orgUrl =
    flags.orgUrl ??
    (await text({
      label: 'Azure DevOps org URL',
      validate: validateUrl,
      prompter: opts.prompter,
    }));

  const pat =
    flags.pat ??
    pipedToken ??
    (await password({ label: 'PAT', prompter: opts.prompter }));

  const authMethod: AuthMethod = flags.authMethod ?? 'pat';

  const validated = v.parse(StoredAdoSchema, {
    orgUrl,
    pat,
    authMethod,
  });
  await setSecret('ado', JSON.stringify(validated));
  console.log('Saved credentials for ado.');
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

export interface GithubLoginFlags {
  token?: string;
  fromEnv?: boolean;
}

export async function loginGithub(
  flags: GithubLoginFlags,
  opts: {
    prompter?: Prompter;
    ghAvailable?: () => boolean;
  } = {}
): Promise<'gh-cli' | 'stored'> {
  // --from-env migrates an explicit token from env regardless of gh-cli state,
  // since the user's intent is to promote that token into the keyring.
  if (flags.fromEnv) {
    const result = readGithubEnvForMigration();
    if (result.kind !== 'ok')
      throw new Error(formatMigrationError('GitHub', result));
    await setSecret('github', JSON.stringify(result.value));
    console.log('Migrated GitHub credentials from env to keyring.');
    console.log(formatUnsetHint(result.varsUsed));
    return 'stored';
  }

  const ghCheck = opts.ghAvailable ?? isGhCliAvailable;
  if (ghCheck()) {
    console.log('Using gh CLI auth. Nothing to do.');
    return 'gh-cli';
  }

  let pipedToken: string | null = null;
  if (!flags.token && !opts.prompter && !process.stdin.isTTY) {
    pipedToken = (await readStdin()).trim();
  }

  const token =
    flags.token ??
    pipedToken ??
    (await password({ label: 'GitHub token', prompter: opts.prompter }));

  const validated = v.parse(StoredGithubSchema, { token });
  await setSecret('github', JSON.stringify(validated));
  console.log('Saved credentials for github.');
  return 'stored';
}

// ---------------------------------------------------------------------------
// yargs wiring
// ---------------------------------------------------------------------------

interface JiraArgs {
  url?: string;
  email?: string;
  token?: string;
  'from-env'?: boolean;
}
interface AdoArgs {
  'org-url'?: string;
  pat?: string;
  'auth-method'?: AuthMethod;
  'from-env'?: boolean;
}
interface GithubArgs {
  token?: string;
  'from-env'?: boolean;
}

const command: CommandModule = {
  command: 'login <service>',
  describe: 'Save credentials for a service to the OS keyring',
  builder: (yargs) =>
    yargs
      .command({
        command: 'jira',
        describe: 'Save Jira credentials',
        builder: (y) =>
          y
            .option('url', { type: 'string', describe: 'Jira URL' })
            .option('email', { type: 'string', describe: 'Jira email' })
            .option('token', { type: 'string', describe: 'Jira API token' })
            .option('from-env', {
              type: 'boolean',
              describe:
                'Migrate JIRA_URL / JIRA_EMAIL / JIRA_API_TOKEN into the keyring',
              default: false,
            })
            .conflicts('from-env', ['url', 'email', 'token']),
        handler: async (argv: ArgumentsCamelCase<JiraArgs>) =>
          await loginJira({
            url: argv.url,
            email: argv.email,
            token: argv.token,
            fromEnv: argv['from-env'],
          }),
      })
      .command({
        command: 'ado',
        describe: 'Save Azure DevOps credentials',
        builder: (y) =>
          y
            .option('org-url', { type: 'string', describe: 'ADO org URL' })
            .option('pat', { type: 'string', describe: 'ADO PAT' })
            .option('auth-method', {
              type: 'string',
              choices: ['pat', 'bearer'] as const,
              describe: 'Auth method (default: pat)',
            })
            .option('from-env', {
              type: 'boolean',
              describe:
                'Migrate AZURE_DEVOPS_ORG_URL / AZURE_DEVOPS_PAT into the keyring',
              default: false,
            })
            .conflicts('from-env', ['org-url', 'pat', 'auth-method']),
        handler: async (argv: ArgumentsCamelCase<AdoArgs>) =>
          await loginAdo({
            orgUrl: argv['org-url'],
            pat: argv.pat,
            authMethod: argv['auth-method'],
            fromEnv: argv['from-env'],
          }),
      })
      .command({
        command: 'github',
        describe: 'Save GitHub token (only if gh CLI is unavailable)',
        builder: (y) =>
          y
            .option('token', { type: 'string', describe: 'GitHub token' })
            .option('from-env', {
              type: 'boolean',
              describe: 'Migrate GITHUB_TOKEN / GH_TOKEN into the keyring',
              default: false,
            })
            .conflicts('from-env', ['token']),
        handler: async (argv: ArgumentsCamelCase<GithubArgs>) => {
          await loginGithub({ token: argv.token, fromEnv: argv['from-env'] });
        },
      })
      .demandCommand(1, 'Specify a service: jira, ado, or github'),
  handler: () => {
    // Never reached - subcommand is required.
  },
};

export default command;
