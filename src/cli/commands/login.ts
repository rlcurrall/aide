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
import { Effect } from 'effect';

import { loginWithAuthProvider } from '@cli/host/auth-provider-operations.js';
import type {
  AideAuthLoginRequest,
  AideAuthLoginResult,
  AideAuthPrompt,
  AideDiscoveredCapability,
  AideAuthProviderCapability,
} from '@cli/host/plugin-descriptor.js';
import { createAzureDevOpsPlugin } from '@cli/plugins/azure-devops/plugin.js';
import { createGitHubPlugin } from '@cli/plugins/github/plugin.js';
import { createJiraPlugin } from '@cli/plugins/jira/plugin.js';
import {
  TerminalPrompter,
  text,
  password,
  type Prompter,
} from '@lib/prompts.js';
import type { AuthMethod } from '@schemas/config.js';
import { runLegacyCommandEffect } from './effect-bridge.js';

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

function authProvider(plugin: {
  readonly id: string;
  readonly capabilities?: {
    readonly authProvider?: AideAuthProviderCapability;
  };
}): AideDiscoveredCapability<AideAuthProviderCapability> {
  const provider = plugin.capabilities?.authProvider;
  if (provider === undefined) throw new Error('Plugin has no auth provider');
  return Object.freeze({ pluginId: plugin.id, capability: provider });
}

async function secretText(
  request: Parameters<AideAuthPrompt['text']>[0],
  prompter: Prompter | undefined
): Promise<string> {
  if (request.validate === undefined) {
    return await password({ label: request.label, prompter });
  }

  const activePrompter = prompter ?? new TerminalPrompter();
  const label = `${request.label}: `;

  for (;;) {
    const value = await activePrompter.readLine({ label, masked: true });
    if (value.length === 0) {
      activePrompter.writeLine('  value required');
      continue;
    }

    const error = request.validate(value);
    if (error) {
      activePrompter.writeLine(`  ${error}`);
      continue;
    }
    return value;
  }
}

function authPrompt(prompter: Prompter | undefined): AideAuthPrompt {
  return {
    text: (request) =>
      Effect.tryPromise({
        try: () =>
          request.secret
            ? secretText(request, prompter)
            : text({
                label: request.label,
                validate: request.validate,
                prompter,
              }),
        catch: (error) => error,
      }),
  };
}

async function runProviderLogin(
  provider: AideDiscoveredCapability<AideAuthProviderCapability>,
  request: AideAuthLoginRequest
): Promise<AideAuthLoginResult> {
  const result = await runLegacyCommandEffect(
    loginWithAuthProvider(provider, request)
  );
  for (const message of result.messages ?? []) {
    console.log(message);
  }
  return result;
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
  let pipedToken: string | null = null;
  if (
    !flags.fromEnv &&
    !flags.token &&
    !opts.prompter &&
    !process.stdin.isTTY
  ) {
    pipedToken = (await readStdin()).trim();
  }

  await runProviderLogin(authProvider(createJiraPlugin()), {
    fromEnv: flags.fromEnv,
    values: {
      url: flags.url,
      email: flags.email,
      token: flags.token ?? pipedToken ?? undefined,
    },
    prompt: authPrompt(opts.prompter),
  });
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
  let pipedToken: string | null = null;
  if (!flags.fromEnv && !flags.pat && !opts.prompter && !process.stdin.isTTY) {
    pipedToken = (await readStdin()).trim();
  }

  await runProviderLogin(authProvider(createAzureDevOpsPlugin()), {
    fromEnv: flags.fromEnv,
    values: {
      orgUrl: flags.orgUrl,
      pat: flags.pat ?? pipedToken ?? undefined,
      authMethod: flags.authMethod,
    },
    prompt: authPrompt(opts.prompter),
  });
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
  let pipedToken: string | null = null;
  if (
    !flags.fromEnv &&
    !flags.token &&
    !opts.prompter &&
    !process.stdin.isTTY
  ) {
    pipedToken = (await readStdin()).trim();
  }

  const result = await runProviderLogin(
    authProvider(createGitHubPlugin({ ghAvailable: opts.ghAvailable })),
    {
      fromEnv: flags.fromEnv,
      values: {
        token: flags.token ?? pipedToken ?? undefined,
      },
      prompt: authPrompt(opts.prompter),
    }
  );
  return result.status === 'external' ? 'gh-cli' : 'stored';
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
