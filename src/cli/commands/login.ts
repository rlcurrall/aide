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

import {
  text,
  password,
  type Prompter,
} from '@lib/prompts.js';
import { setSecret, KeyringUnavailableError } from '@lib/secrets.js';
import {
  StoredJiraSchema,
  StoredAdoSchema,
  StoredGithubSchema,
  type AuthMethod,
} from '@schemas/config.js';
import { isGhCliAvailable } from '@lib/gh-utils.js';

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

// ---------------------------------------------------------------------------
// Jira
// ---------------------------------------------------------------------------

export interface JiraLoginFlags {
  url?: string;
  email?: string;
  token?: string;
}

export async function loginJira(
  flags: JiraLoginFlags,
  opts: { prompter?: Prompter } = {}
): Promise<void> {
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
    flags.token ?? pipedToken ?? (await password({ label: 'API token', prompter: opts.prompter }));

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
}

export async function loginAdo(
  flags: AdoLoginFlags,
  opts: { prompter?: Prompter } = {}
): Promise<void> {
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
    flags.pat ?? pipedToken ?? (await password({ label: 'PAT', prompter: opts.prompter }));

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
}

export async function loginGithub(
  flags: GithubLoginFlags,
  opts: {
    prompter?: Prompter;
    ghAvailable?: () => boolean;
  } = {}
): Promise<'gh-cli' | 'stored'> {
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
    flags.token ?? pipedToken ?? (await password({ label: 'GitHub token', prompter: opts.prompter }));

  const validated = v.parse(StoredGithubSchema, { token });
  await setSecret('github', JSON.stringify(validated));
  console.log('Saved credentials for github.');
  return 'stored';
}

// ---------------------------------------------------------------------------
// yargs wiring
// ---------------------------------------------------------------------------

async function runAndExit(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof KeyringUnavailableError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}

interface JiraArgs {
  url?: string;
  email?: string;
  token?: string;
}
interface AdoArgs {
  'org-url'?: string;
  pat?: string;
  'auth-method'?: AuthMethod;
}
interface GithubArgs {
  token?: string;
}

const command: CommandModule = {
  command: 'login <service>',
  describe: 'Save credentials for a service to the OS keyring',
  builder: (yargs) =>
    yargs
      .command({
        command: 'jira',
        describe: 'Save Jira credentials',
        builder: {
          url: { type: 'string', describe: 'Jira URL' },
          email: { type: 'string', describe: 'Jira email' },
          token: { type: 'string', describe: 'Jira API token' },
        },
        handler: (argv: ArgumentsCamelCase<JiraArgs>) =>
          runAndExit(() =>
            loginJira({
              url: argv.url,
              email: argv.email,
              token: argv.token,
            })
          ),
      })
      .command({
        command: 'ado',
        describe: 'Save Azure DevOps credentials',
        builder: {
          'org-url': { type: 'string', describe: 'ADO org URL' },
          pat: { type: 'string', describe: 'ADO PAT' },
          'auth-method': {
            type: 'string',
            choices: ['pat', 'bearer'] as const,
            describe: 'Auth method (default: pat)',
          },
        },
        handler: (argv: ArgumentsCamelCase<AdoArgs>) =>
          runAndExit(() =>
            loginAdo({
              orgUrl: argv['org-url'],
              pat: argv.pat,
              authMethod: argv['auth-method'],
            })
          ),
      })
      .command({
        command: 'github',
        describe: 'Save GitHub token (only if gh CLI is unavailable)',
        builder: {
          token: { type: 'string', describe: 'GitHub token' },
        },
        handler: (argv: ArgumentsCamelCase<GithubArgs>) =>
          runAndExit(async () => {
            await loginGithub({ token: argv.token });
          }),
      })
      .demandCommand(1, 'Specify a service: jira, ado, or github'),
  handler: () => {
    // Never reached - subcommand is required.
  },
};

export default command;
