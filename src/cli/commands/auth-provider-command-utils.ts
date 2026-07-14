import type { Argv } from 'yargs';
import { isProxy } from 'node:util/types';

import { Effect, type Layer } from 'effect';

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
import type { KeyringService } from '@lib/auth-keyring.js';
import type {
  AideAuthProviderRegistration,
  AideInternalHostServices,
} from '@cli/host/runtime-context.js';
import {
  runAuthProviderCommandEffect,
  runLiveAuthProviderCommandEffect,
  runServiceFreeAuthProviderCommandEffect,
} from './effect-bridge.js';
import {
  defineHostArrayIndex,
  ownArrayDataValue,
  ownArrayLength,
} from '@cli/host/host-owned-array.js';

export type DiscoveredAuthProvider = AideDiscoveredCapability<
  AideAuthProviderCapability<
    KeyringService,
    KeyringService,
    KeyringService,
    KeyringService
  >
>;

export type DynamicAuthProvider = AideAuthProviderRegistration;

export type AuthProviderOperationName = 'login' | 'logout';

const objectFreeze = Object.freeze;
const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const objectHasOwn = Object.hasOwn;

const authScopeFlagKeys = [
  'scope-id',
  'scope-host',
  'scope-org',
  'scope-account',
  'scope-label',
] as const;
const authScopeFlagSet = new Set<string>();
for (let index = 0; index < authScopeFlagKeys.length; index += 1) {
  const entry = ownArrayDataValue<string>(authScopeFlagKeys, index);
  if (entry.found) authScopeFlagSet.add(entry.value);
}

function trustedAuthProviderRegistration(
  provider: DiscoveredAuthProvider
): DiscoveredAuthProvider & { readonly provenance: 'trusted' } {
  return objectFreeze({
    provenance: 'trusted' as const,
    pluginId: provider.pluginId,
    capability: provider.capability,
  });
}

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
  provider: DiscoveredAuthProvider | DynamicAuthProvider,
  operation: AuthProviderOperationName
): readonly string[] {
  const capability = provider.capability;
  const metadata = operation === 'login' ? capability.login : capability.logout;
  const primary = metadata?.command?.name ?? capability.providerId;
  const names: string[] = [];
  const seen = new Set<string>();
  const add = (name: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    const index = ownArrayLength(names);
    if (index !== undefined) defineHostArrayIndex(names, index, name);
  };
  add(primary);
  const aliases = metadata?.command?.aliases;
  const aliasCount = aliases === undefined ? 0 : ownArrayLength(aliases);
  if (aliasCount !== undefined) {
    for (let index = 0; index < aliasCount; index += 1) {
      const alias = ownArrayDataValue<string>(aliases!, index);
      if (alias.found) add(alias.value);
    }
  }
  add(capability.providerId);
  return names;
}

export function authProviderCommandRoutes(
  provider: DiscoveredAuthProvider | DynamicAuthProvider,
  operation: AuthProviderOperationName
): string | readonly string[] {
  const names = commandNames(provider, operation);
  const length = ownArrayLength(names);
  const first = ownArrayDataValue<string>(names, 0);
  return length === 1 && first.found ? first.value : names;
}

export function findAuthProviderByCommandName<
  TProvider extends DiscoveredAuthProvider | DynamicAuthProvider,
>(
  providers: readonly TProvider[],
  name: string,
  operation: AuthProviderOperationName
): TProvider | null {
  const providerCount = ownArrayLength(providers);
  if (providerCount === undefined) return null;
  for (let index = 0; index < providerCount; index += 1) {
    const provider = ownArrayDataValue<TProvider>(providers, index);
    if (!provider.found) continue;
    const names = commandNames(provider.value, operation);
    const nameCount = ownArrayLength(names);
    if (nameCount === undefined) continue;
    for (let nameIndex = 0; nameIndex < nameCount; nameIndex += 1) {
      const candidate = ownArrayDataValue<string>(names, nameIndex);
      if (candidate.found && candidate.value === name) return provider.value;
    }
  }
  return null;
}

export function providerHasAuthOperation(
  provider: DiscoveredAuthProvider | DynamicAuthProvider,
  operation: AuthProviderOperationName
): boolean {
  return typeof provider.capability.operations?.[operation] === 'function';
}

export const authFieldFlagName = authInputFieldFlagName;

export function assertNoReservedAuthScopeFlags(
  provider: DiscoveredAuthProvider | DynamicAuthProvider
): void {
  const fields = provider.capability.login?.fields;
  const fieldCount = fields === undefined ? 0 : ownArrayLength(fields);
  if (fieldCount === undefined) return;
  for (let index = 0; index < fieldCount; index += 1) {
    const entry = ownArrayDataValue<
      NonNullable<AideAuthProviderCapability['login']>['fields'] extends
        | readonly (infer T)[]
        | undefined
        ? T
        : never
    >(fields!, index);
    if (!entry.found) continue;
    const field = entry.value;
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

type ScopeArgProperty =
  | { readonly kind: 'absent' }
  | { readonly kind: 'data'; readonly value: unknown }
  | { readonly kind: 'invalid' };

function scopeArgProperty(
  argv: Readonly<Record<string, unknown>>,
  key: string
): ScopeArgProperty {
  if (isProxy(argv)) return { kind: 'invalid' };
  try {
    const descriptor = objectGetOwnPropertyDescriptor(argv, key);
    if (descriptor === undefined) return { kind: 'absent' };
    return objectHasOwn(descriptor, 'value')
      ? { kind: 'data', value: descriptor.value }
      : { kind: 'invalid' };
  } catch {
    return { kind: 'invalid' };
  }
}

function readScopeArg(
  provider: DiscoveredAuthProvider | DynamicAuthProvider,
  argv: Readonly<Record<string, unknown>>,
  dashed: string,
  camel: string
): ScopeArgValue {
  const dashedProperty = scopeArgProperty(argv, dashed);
  const camelProperty = scopeArgProperty(argv, camel);
  if (dashedProperty.kind === 'absent' && camelProperty.kind === 'absent') {
    return { present: false, value: undefined };
  }

  const readValue = (property: ScopeArgProperty): string | undefined => {
    if (property.kind === 'absent') return undefined;
    const value = property.kind === 'data' ? property.value : undefined;
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(
        `Auth provider '${provider.capability.providerId}' requires '--${dashed}' to be a non-empty string.`
      );
    }
    return value.trim();
  };

  const dashedValue = readValue(dashedProperty);
  const camelValue = readValue(camelProperty);

  // Yargs normally emits equivalent dashed and camel aliases. Independently
  // supplied aliases must also agree after trimming or scope selection fails;
  // repeated flags become arrays and fail the string validation above.
  if (
    dashedValue !== undefined &&
    camelValue !== undefined &&
    dashedValue !== camelValue
  ) {
    throw new Error(
      `Auth provider '${provider.capability.providerId}' received conflicting values for '--${dashed}' and '--${camel}'.`
    );
  }

  return { present: true, value: dashedValue ?? camelValue };
}

function scopeFromArgValues(
  provider: DiscoveredAuthProvider | DynamicAuthProvider,
  args: {
    readonly id?: string;
    readonly host?: string;
    readonly org?: string;
    readonly account?: string;
    readonly label?: string;
  }
): AideAuthScope {
  let derivedId = args.id;
  if (derivedId === undefined) {
    const parts = [args.host, args.org, args.account, args.label] as const;
    let joined = '';
    for (let index = 0; index < parts.length; index += 1) {
      const part = ownArrayDataValue<string | undefined>(parts, index);
      if (!part.found || part.value === undefined) continue;
      if (joined !== '') joined += ':';
      joined += part.value;
    }
    derivedId = joined;
  }

  if (derivedId === undefined || derivedId === '') {
    throw new Error(
      `Cannot infer a valid auth scope for '${provider.capability.providerId}'. ` +
        'Provide --scope-id or at least one non-empty --scope-host, --scope-org, --scope-account, or --scope-label value.'
    );
  }

  return objectFreeze({
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
  provider: DiscoveredAuthProvider | DynamicAuthProvider,
  argv: Readonly<Record<string, unknown>> & Partial<AuthScopeArgv>
): AideAuthScope | undefined {
  const id = readScopeArg(provider, argv, 'scope-id', 'scopeId');
  const host = readScopeArg(provider, argv, 'scope-host', 'scopeHost');
  const org = readScopeArg(provider, argv, 'scope-org', 'scopeOrg');
  const account = readScopeArg(provider, argv, 'scope-account', 'scopeAccount');
  const label = readScopeArg(provider, argv, 'scope-label', 'scopeLabel');

  if (
    !id.present &&
    !host.present &&
    !org.present &&
    !account.present &&
    !label.present
  ) {
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
  if (messages === undefined) return;
  const messageCount = ownArrayLength(messages);
  if (messageCount === undefined) return;
  for (let index = 0; index < messageCount; index += 1) {
    const message = ownArrayDataValue<string>(messages, index);
    if (message.found) console.log(message.value);
  }
}

function runDynamicAuthProviderEffect<A>(
  provider: DynamicAuthProvider,
  services: AideInternalHostServices,
  makeTrusted: (
    trusted: Extract<DynamicAuthProvider, { readonly provenance: 'trusted' }>
  ) => Effect.Effect<A, unknown, KeyringService>,
  makeExternal: (
    external: Extract<DynamicAuthProvider, { readonly provenance: 'external' }>
  ) => Effect.Effect<A, unknown, never>
): Promise<A> {
  return provider.provenance === 'trusted'
    ? runServiceFreeAuthProviderCommandEffect(
        services.provideTrustedKeyring(
          Effect.suspend(() => makeTrusted(provider))
        )
      )
    : runServiceFreeAuthProviderCommandEffect(
        services.isolatePublicEffect(
          Effect.suspend(() => makeExternal(provider))
        )
      );
}

export async function runDynamicAuthProviderLogin(
  provider: DynamicAuthProvider,
  request: AideAuthLoginRequest,
  services: AideInternalHostServices,
  opts: { readonly prompter?: Prompter } = {}
): Promise<AideAuthLoginResult> {
  const operationRequest = {
    ...request,
    prompt: request.prompt ?? authPrompt(opts.prompter),
  };
  const result = await runDynamicAuthProviderEffect(
    provider,
    services,
    (trusted) => loginWithAuthProvider(trusted, operationRequest),
    (external) => loginWithAuthProvider(external, operationRequest)
  );
  printMessages(result.messages);
  return result;
}

export async function runDynamicAuthProviderLogout(
  provider: DynamicAuthProvider,
  services: AideInternalHostServices,
  request?: AideAuthLogoutRequest
): Promise<AideAuthLogoutResult> {
  const result = await runDynamicAuthProviderEffect(
    provider,
    services,
    (trusted) =>
      request === undefined
        ? logoutWithAuthProvider(trusted)
        : logoutWithAuthProvider(trusted, request),
    (external) =>
      request === undefined
        ? logoutWithAuthProvider(external)
        : logoutWithAuthProvider(external, request)
  );
  printMessages(result.messages);
  return result;
}

export function runDynamicAuthProviderStatus(
  provider: DynamicAuthProvider,
  services: AideInternalHostServices,
  request: AideAuthStatusRequest = {}
): Promise<AidePluginAuthStatus> {
  return runDynamicAuthProviderEffect(
    provider,
    services,
    (trusted) => getAuthProviderStatus(trusted, request),
    (external) => getAuthProviderStatus(external, request)
  );
}

export function runDynamicAuthProviderAccounts(
  provider: DynamicAuthProvider,
  services: AideInternalHostServices,
  request: AideAuthAccountDiscoveryRequest = {}
): Promise<readonly AideAuthAccount[]> {
  return runDynamicAuthProviderEffect(
    provider,
    services,
    (trusted) => listAuthProviderAccounts(trusted, request),
    (external) => listAuthProviderAccounts(external, request)
  );
}

export async function runAuthProviderLoginWithLayer(
  provider: DiscoveredAuthProvider,
  request: AideAuthLoginRequest,
  keyringLayer: Layer.Layer<KeyringService>,
  opts: { readonly prompter?: Prompter } = {}
): Promise<AideAuthLoginResult> {
  const trustedProvider = trustedAuthProviderRegistration(provider);
  const result = await runAuthProviderCommandEffect(
    loginWithAuthProvider(trustedProvider, {
      ...request,
      prompt: request.prompt ?? authPrompt(opts.prompter),
    }),
    keyringLayer
  );
  printMessages(result.messages);
  return result;
}

export async function runAuthProviderLogoutWithLayer(
  provider: DiscoveredAuthProvider,
  keyringLayer: Layer.Layer<KeyringService>,
  request?: AideAuthLogoutRequest
): Promise<AideAuthLogoutResult> {
  const trustedProvider = trustedAuthProviderRegistration(provider);
  const result = await runAuthProviderCommandEffect(
    request === undefined
      ? logoutWithAuthProvider(trustedProvider)
      : logoutWithAuthProvider(trustedProvider, request),
    keyringLayer
  );
  printMessages(result.messages);
  return result;
}

export async function runAuthProviderStatusWithLayer(
  provider: DiscoveredAuthProvider,
  keyringLayer: Layer.Layer<KeyringService>,
  request: AideAuthStatusRequest = {}
): Promise<AidePluginAuthStatus> {
  const trustedProvider = trustedAuthProviderRegistration(provider);
  return await runAuthProviderCommandEffect(
    getAuthProviderStatus(trustedProvider, request),
    keyringLayer
  );
}

export async function runAuthProviderAccountsWithLayer(
  provider: DiscoveredAuthProvider,
  keyringLayer: Layer.Layer<KeyringService>,
  request: AideAuthAccountDiscoveryRequest = {}
): Promise<readonly AideAuthAccount[]> {
  const trustedProvider = trustedAuthProviderRegistration(provider);
  return await runAuthProviderCommandEffect(
    listAuthProviderAccounts(trustedProvider, request),
    keyringLayer
  );
}

/** @deprecated Standalone Promise/live compatibility adapter. */
export async function runAuthProviderLogin(
  provider: DiscoveredAuthProvider,
  request: AideAuthLoginRequest,
  opts: { readonly prompter?: Prompter } = {}
): Promise<AideAuthLoginResult> {
  const trustedProvider = trustedAuthProviderRegistration(provider);
  const result = await runLiveAuthProviderCommandEffect(
    loginWithAuthProvider(trustedProvider, {
      ...request,
      prompt: request.prompt ?? authPrompt(opts.prompter),
    })
  );
  printMessages(result.messages);
  return result;
}

/** @deprecated Standalone Promise/live compatibility adapter. */
export async function runAuthProviderLogout(
  provider: DiscoveredAuthProvider,
  request?: AideAuthLogoutRequest
): Promise<AideAuthLogoutResult> {
  const trustedProvider = trustedAuthProviderRegistration(provider);
  const result = await runLiveAuthProviderCommandEffect(
    request === undefined
      ? logoutWithAuthProvider(trustedProvider)
      : logoutWithAuthProvider(trustedProvider, request)
  );
  printMessages(result.messages);
  return result;
}

/** @deprecated Standalone Promise/live compatibility adapter. */
export async function runAuthProviderStatus(
  provider: DiscoveredAuthProvider,
  request: AideAuthStatusRequest = {}
): Promise<AidePluginAuthStatus> {
  const trustedProvider = trustedAuthProviderRegistration(provider);
  return runLiveAuthProviderCommandEffect(
    getAuthProviderStatus(trustedProvider, request)
  );
}

/** @deprecated Standalone Promise/live compatibility adapter. */
export async function runAuthProviderAccounts(
  provider: DiscoveredAuthProvider,
  request: AideAuthAccountDiscoveryRequest = {}
): Promise<readonly AideAuthAccount[]> {
  const trustedProvider = trustedAuthProviderRegistration(provider);
  return runLiveAuthProviderCommandEffect(
    listAuthProviderAccounts(trustedProvider, request)
  );
}
