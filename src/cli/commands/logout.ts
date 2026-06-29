/**
 * `aide logout <service>` - remove stored credentials for a provider.
 *
 * Env vars are never touched; this operation only affects the provider-owned
 * credential store.
 */

import type { ArgumentsCamelCase } from 'yargs';

import type { AideHostServices } from '@cli/host/runtime-context.js';
import { getAideHostContext } from '@cli/host/runtime-context.js';
import type { AideHostAwareCommandModule } from '@cli/host/yargs-adapter.js';
import {
  authProviderCommandRoutes,
  findAuthProviderByCommandName,
  providerHasAuthOperation,
  runAuthProviderLogout,
  type DiscoveredAuthProvider,
} from './auth-provider-command-utils.js';

export type LogoutResult = 'removed' | 'not-found';

interface Args {
  service: string;
}

function logoutProviders(
  services: AideHostServices
): readonly DiscoveredAuthProvider[] {
  return services
    .authProviders()
    .filter((provider) => providerHasAuthOperation(provider, 'logout'));
}

function logoutProviderCommandNames(
  provider: DiscoveredAuthProvider
): readonly string[] {
  const route = authProviderCommandRoutes(provider, 'logout');
  return typeof route === 'string' ? [route] : route;
}

function allLogoutProviderCommandNames(
  providers: readonly DiscoveredAuthProvider[]
): readonly string[] {
  return Array.from(new Set(providers.flatMap(logoutProviderCommandNames)));
}

async function logoutProvider(
  providers: readonly DiscoveredAuthProvider[],
  service: string
): Promise<LogoutResult> {
  const provider = findAuthProviderByCommandName(providers, service, 'logout');
  if (provider === null) {
    throw new Error(`Unknown auth provider '${service}'`);
  }

  const result = await runAuthProviderLogout(provider);
  return result.status;
}

const command: AideHostAwareCommandModule<object, Args> = {
  command: 'logout <service>',
  describe: 'Remove stored credentials from the OS keyring',
  aideBuilder: (yargs, services) => {
    const providers = logoutProviders(services);
    return yargs.positional('service', {
      type: 'string',
      choices: allLogoutProviderCommandNames(providers),
      demandOption: true,
      describe: 'Service to log out of',
    });
  },
  handler: async (argv: ArgumentsCamelCase<Args>) => {
    const services = getAideHostContext(argv)?.services;
    if (services === undefined) {
      throw new Error('Host services are unavailable for logout');
    }
    const contextProviders = logoutProviders(services);
    await logoutProvider(contextProviders, argv.service);
  },
};

export default command;
