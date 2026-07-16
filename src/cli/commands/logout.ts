/**
 * `aide logout <service>` - remove stored credentials for a provider.
 *
 * Env vars are never touched; this operation only affects the provider-owned
 * credential store.
 */

import type { ArgumentsCamelCase } from 'yargs';

import type { AideInternalHostServices } from '@cli/host/runtime-context.js';
import { getAideHostContext } from '@cli/host/runtime-context.js';
import type { AideHostAwareCommandModule } from '@cli/host/yargs-adapter.js';
import {
  authScopeFromArgs,
  configureAuthScopeOptions,
  authProviderCommandRoutes,
  findAuthProviderByCommandName,
  providerHasAuthOperation,
  runDynamicAuthProviderLogout,
  type DynamicAuthProvider,
} from './auth-provider-command-utils.js';
import type { AideAuthScope } from '@cli/host/plugin-descriptor.js';

export type LogoutResult = 'removed' | 'not-found';

interface Args {
  service: string;
  readonly 'scope-id'?: string;
  readonly 'scope-host'?: string;
  readonly 'scope-org'?: string;
  readonly 'scope-account'?: string;
  readonly 'scope-label'?: string;
}

function logoutProviders(
  services: AideInternalHostServices
): readonly DynamicAuthProvider[] {
  return services
    .authProviderRegistrations()
    .filter((provider) => providerHasAuthOperation(provider, 'logout'));
}

function logoutProviderCommandNames(
  provider: DynamicAuthProvider
): readonly string[] {
  const route = authProviderCommandRoutes(provider, 'logout');
  return typeof route === 'string' ? [route] : route;
}

function allLogoutProviderCommandNames(
  providers: readonly DynamicAuthProvider[]
): readonly string[] {
  return Array.from(new Set(providers.flatMap(logoutProviderCommandNames)));
}

async function logoutProvider(
  providers: readonly DynamicAuthProvider[],
  services: AideInternalHostServices,
  service: string,
  scopeArgv: Readonly<Record<string, unknown>> & {
    readonly 'scope-id'?: unknown;
    readonly 'scope-host'?: unknown;
    readonly 'scope-org'?: unknown;
    readonly 'scope-account'?: unknown;
    readonly 'scope-label'?: unknown;
  }
): Promise<LogoutResult> {
  const provider = findAuthProviderByCommandName(providers, service, 'logout');
  if (provider === null) {
    throw new Error(`Unknown auth provider '${service}'`);
  }

  const scope: AideAuthScope | undefined = authScopeFromArgs(
    provider,
    scopeArgv
  );
  const result = await runDynamicAuthProviderLogout(
    provider,
    services,
    scope === undefined ? undefined : { scope }
  );
  return result.status;
}

const command: AideHostAwareCommandModule<object, Args> = {
  command: 'logout <service>',
  describe: 'Remove stored credentials from the OS keyring',
  aideBuilder: (yargs, services) => {
    const providers = logoutProviders(services);
    return configureAuthScopeOptions(
      yargs.positional('service', {
        type: 'string',
        choices: allLogoutProviderCommandNames(providers),
        demandOption: true,
        describe: 'Service to log out of',
      })
    );
  },
  handler: async (argv: ArgumentsCamelCase<Args>) => {
    const context = getAideHostContext(argv);
    if (context === null) {
      throw new Error('Host services are unavailable for logout');
    }
    const contextProviders = logoutProviders(context.services);
    await logoutProvider(
      contextProviders,
      context.services,
      argv.service,
      argv
    );
  },
};

export default command;
