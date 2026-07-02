import { Effect } from 'effect';

import {
  loginWithAuthProvider,
  logoutWithAuthProvider,
} from '@cli/host/auth-provider-operations.js';
import type {
  AideAuthLoginRequest,
  AideAuthLoginResult,
  AideAuthLogoutResult,
  AideAuthPrompt,
  AideAuthProviderCapability,
  AideDiscoveredCapability,
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
  provider: DiscoveredAuthProvider
): Promise<AideAuthLogoutResult> {
  const result = await runLegacyCommandEffect(logoutWithAuthProvider(provider));
  printMessages(result.messages);
  return result;
}
