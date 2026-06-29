/**
 * `aide logout <service>` - remove stored credentials for a service.
 *
 * Env vars are never touched; this operation only affects the OS keyring.
 */

import type { ArgumentsCamelCase, CommandModule } from 'yargs';

import { logoutWithAuthProvider } from '@cli/host/auth-provider-operations.js';
import type { AideAuthProviderCapability } from '@cli/host/plugin-descriptor.js';
import type { AideDiscoveredCapability } from '@cli/host/plugin-descriptor.js';
import { createAzureDevOpsPlugin } from '@cli/plugins/azure-devops/plugin.js';
import { createGitHubPlugin } from '@cli/plugins/github/plugin.js';
import { createJiraPlugin } from '@cli/plugins/jira/plugin.js';
import type { SecretName } from '@lib/secrets.js';
import { runLegacyCommandEffect } from './effect-bridge.js';

export type LogoutResult = 'removed' | 'not-found';

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

function authProviderForService(
  service: SecretName
): AideDiscoveredCapability<AideAuthProviderCapability> {
  switch (service) {
    case 'jira':
      return authProvider(createJiraPlugin());
    case 'ado':
      return authProvider(createAzureDevOpsPlugin());
    case 'github':
      return authProvider(createGitHubPlugin());
  }
}

async function logoutProvider(service: SecretName) {
  const provider = authProviderForService(service);
  return await runLegacyCommandEffect(logoutWithAuthProvider(provider));
}

export async function logout(service: SecretName): Promise<LogoutResult> {
  const result = await logoutProvider(service);
  return result.status;
}

interface Args {
  service: SecretName;
}

const command: CommandModule<object, Args> = {
  command: 'logout <service>',
  describe: 'Remove stored credentials from the OS keyring',
  builder: {
    service: {
      type: 'string',
      choices: ['jira', 'ado', 'github'] as const,
      demandOption: true,
      describe: 'Service to log out of',
    },
  },
  handler: async (argv: ArgumentsCamelCase<Args>) => {
    const result = await logoutProvider(argv.service);
    for (const message of result.messages ?? []) {
      console.log(message);
    }
  },
};

export default command;
