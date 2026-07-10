import type { Argv } from 'yargs';

import { Effect } from 'effect';

import {
  getAuthProviderStatus,
  listAuthProviderAccounts,
  loginWithAuthProvider,
  logoutWithAuthProvider,
} from '@cli/host/auth-provider-operations.js';
import type {
  AideAuthAccount,
  AideAuthAccountDiscoveryRequest,
  AideAuthLoginRequest,
  AideAuthLoginResult,
  AideAuthLogoutRequest,
  AideAuthLogoutResult,
  AideAuthPrompt,
  AideAuthProviderCapability,
  AideAuthStatusRequest,
  AideDiscoveredCapability,
  AideAuthScope,
  AidePluginAuthStatus,
} from '@cli/host/plugin-descriptor.js';
import {
  TerminalPrompter,
  password,
  text,
  type Prompter,
} from '@lib/prompts.js';
import { authInputFieldFlagName } from '@cli/host/auth-input-fields.js';
import { runLegacyCommandEffect } from './effect-bridge.js';

export type DiscoveredAuthProvider =
  AideDiscoveredCapability<AideAuthProviderCapability>;

export type AuthProviderOperationName = 'login' | 'logout';

const authScopeFlagKeys = [
  'scope-id',
  'scope-host',
  'scope-org',
  'scope-account',
  'scope-label',
] as const;
const authScopeFlagSet = new Set<string>(authScopeFlagKeys);

export interface AuthScopeArgv {
  readonly 'scope-id'?: unknown;
  readonly 'scope-host'?: unknown;
  readonly 'scope-org'?: unknown;
  readonly 'scope-account'?: unknown;
  readonly 'scope-label'?: unknown;
}

export async function readStdin(): Promise<string> {
  let buf = '';
  for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
    buf += chunk.toString('utf8');
  }
  return buf.replace(/\r?\n$/, '');
}

function commandNames(
  provider: DiscoveredAuthProvider,
  operation: AuthProviderOperationName
): readonly string[] {
  const capability = provider.capability;
  const metadata = operation === 'login' ? capability.login : capability.logout;
  const primary = metadata?.command?.name ?? capability.providerId;
  return Array.from(
    new Set([
      primary,
      ...(metadata?.command?.aliases ?? []),
      capability.providerId,
    ])
  );
}

export function authProviderCommandRoutes(
  provider: DiscoveredAuthProvider,
  operation: AuthProviderOperationName
): string | readonly string[] {
  const names = commandNames(provider, operation);
  return names.length === 1 ? names[0]! : names;
}

export function findAuthProviderByCommandName(
  providers: readonly DiscoveredAuthProvider[],
  name: string,
  operation: AuthProviderOperationName
): DiscoveredAuthProvider | null {
  return (
    providers.find((provider) =>
      commandNames(provider, operation).includes(name)
    ) ?? null
  );
}

export function providerHasAuthOperation(
  provider: DiscoveredAuthProvider,
  operation: AuthProviderOperationName
): boolean {
  return typeof provider.capability.operations?.[operation] === 'function';
}

export const authFieldFlagName = authInputFieldFlagName;

export function assertNoReservedAuthScopeFlags(
  provider: DiscoveredAuthProvider
): void {
  for (const field of provider.capability.login?.fields ?? []) {
    const flagName = authFieldFlagName(field);
    if (authScopeFlagSet.has(flagName)) {
      throw new Error(
        `Auth provider '${provider.capability.providerId}' login field '${field.key}' conflicts with reserved auth scope option '--${flagName}'`
      );
    }
  }
}

interface ScopeArgValue {
  readonly present: boolean;
  readonly value: string | undefined;
}

function readScopeArg(
  provider: DiscoveredAuthProvider,
  argv: Readonly<Record<string, unknown>>,
  dashed: string,
  camel: string
): ScopeArgValue {
  const keys = [dashed, camel].filter((key) =>
    Object.prototype.hasOwnProperty.call(argv, key)
  );
  if (keys.length === 0) return { present: false, value: undefined };

  const values = keys.map((key) => {
    const value = argv[key];
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(
        `Auth provider '${provider.capability.providerId}' requires '--${dashed}' to be a non-empty string.`
      );
    }
    return value.trim();
  });

  // Yargs normally emits equivalent dashed and camel aliases. Independently
  // supplied aliases must also agree after trimming or scope selection fails;
  // repeated flags become arrays and fail the string validation above.
  if (values.some((value) => value !== values[0])) {
    throw new Error(
      `Auth provider '${provider.capability.providerId}' received conflicting values for '--${dashed}' and '--${camel}'.`
    );
  }

  return { present: true, value: values[0]! };
}

function scopeFromArgValues(
  provider: DiscoveredAuthProvider,
  args: {
    readonly id?: string;
    readonly host?: string;
    readonly org?: string;
    readonly account?: string;
    readonly label?: string;
  }
): AideAuthScope {
  const derivedId =
    args.id ??
    [args.host, args.org, args.account, args.label]
      .filter((part) => part !== undefined)
      .join(':');

  if (derivedId === undefined || derivedId === '') {
    throw new Error(
      `Cannot infer a valid auth scope for '${provider.capability.providerId}'. ` +
        'Provide --scope-id or at least one non-empty --scope-host, --scope-org, --scope-account, or --scope-label value.'
    );
  }

  return Object.freeze({
    id: derivedId,
    providerId: provider.capability.providerId,
    ...(args.host === undefined ? {} : { host: args.host }),
    ...(args.org === undefined ? {} : { org: args.org }),
    ...(args.account === undefined ? {} : { account: args.account }),
    ...(args.label === undefined ? {} : { label: args.label }),
  });
}

export function configureAuthScopeOptions<T>(yargs: Argv<T>): Argv<T> {
  return yargs
    .option('scope-id', {
      type: 'string',
      describe: 'Authentication scope identifier',
    })
    .option('scope-host', {
      type: 'string',
      describe: 'Authentication host for scoped credentials',
    })
    .option('scope-org', {
      type: 'string',
      describe: 'Authentication org for scoped credentials',
    })
    .option('scope-account', {
      type: 'string',
      describe: 'Authentication account for scoped credentials',
    })
    .option('scope-label', {
      type: 'string',
      describe: 'Authentication label for scoped credentials',
    });
}

export function authScopeFromArgs(
  provider: DiscoveredAuthProvider,
  argv: Readonly<Record<string, unknown>> & Partial<AuthScopeArgv>
): AideAuthScope | undefined {
  const id = readScopeArg(provider, argv, 'scope-id', 'scopeId');
  const host = readScopeArg(provider, argv, 'scope-host', 'scopeHost');
  const org = readScopeArg(provider, argv, 'scope-org', 'scopeOrg');
  const account = readScopeArg(provider, argv, 'scope-account', 'scopeAccount');
  const label = readScopeArg(provider, argv, 'scope-label', 'scopeLabel');

  if (![id, host, org, account, label].some((arg) => arg.present)) {
    return undefined;
  }

  return scopeFromArgValues(provider, {
    id: id.value,
    host: host.value,
    org: org.value,
    account: account.value,
    label: label.value,
  });
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

export function authPrompt(prompter: Prompter | undefined): AideAuthPrompt {
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

function printMessages(messages: readonly string[] | undefined): void {
  for (const message of messages ?? []) {
    console.log(message);
  }
}

export async function runAuthProviderLogin(
  provider: DiscoveredAuthProvider,
  request: AideAuthLoginRequest,
  opts: { readonly prompter?: Prompter } = {}
): Promise<AideAuthLoginResult> {
  const result = await runLegacyCommandEffect(
    loginWithAuthProvider(provider, {
      ...request,
      prompt: request.prompt ?? authPrompt(opts.prompter),
    })
  );
  printMessages(result.messages);
  return result;
}

export async function runAuthProviderLogout(
  provider: DiscoveredAuthProvider,
  request?: AideAuthLogoutRequest
): Promise<AideAuthLogoutResult> {
  const result = await runLegacyCommandEffect(
    request === undefined
      ? logoutWithAuthProvider(provider)
      : logoutWithAuthProvider(provider, request)
  );
  printMessages(result.messages);
  return result;
}

export async function runAuthProviderStatus(
  provider: DiscoveredAuthProvider,
  request: AideAuthStatusRequest = {}
): Promise<AidePluginAuthStatus> {
  return await runLegacyCommandEffect(getAuthProviderStatus(provider, request));
}

export async function runAuthProviderAccounts(
  provider: DiscoveredAuthProvider,
  request: AideAuthAccountDiscoveryRequest = {}
): Promise<readonly AideAuthAccount[]> {
  return await runLegacyCommandEffect(
    listAuthProviderAccounts(provider, request)
  );
}
