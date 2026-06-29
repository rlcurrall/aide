/**
 * `aide login <service>` - provider-driven credential setup.
 *
 * The yargs surface is still the adapter, but provider-specific behavior and
 * input metadata come from registered auth providers.
 */

import type { ArgumentsCamelCase, Argv, CommandModule } from 'yargs';

import type {
  AideAuthInputField,
  AideAuthInputValue,
  AideAuthLoginRequest,
} from '@cli/host/plugin-descriptor.js';
import type { AideHostServices } from '@cli/host/runtime-context.js';
import type { AideHostAwareCommandModule } from '@cli/host/yargs-adapter.js';
import {
  authFieldFlagName,
  authProviderCommandRoutes,
  providerHasAuthOperation,
  readStdin,
  runAuthProviderLogin,
  type DiscoveredAuthProvider,
} from './auth-provider-command-utils.js';

interface DynamicLoginArgs {
  readonly 'from-env'?: boolean;
  readonly [key: string]: unknown;
}

function authInputValue(value: unknown): AideAuthInputValue {
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  return undefined;
}

function fieldDescription(field: AideAuthInputField): string {
  const description = field.description ?? field.label;
  return field.kind === 'select' && field.default !== undefined
    ? `${description} (default: ${field.default})`
    : description;
}

function fieldFlagNames(fields: readonly AideAuthInputField[]): string[] {
  return fields.map(authFieldFlagName);
}

function configureFieldOption(
  yargs: Argv<object>,
  field: AideAuthInputField
): Argv<object> {
  const flagName = authFieldFlagName(field);
  if (field.kind === 'select') {
    return yargs.option(flagName, {
      type: 'string',
      choices: field.choices.map((choice) => choice.value),
      describe: fieldDescription(field),
    });
  }

  return yargs.option(flagName, {
    type: 'string',
    describe: fieldDescription(field),
  });
}

function configureLoginOptions(
  yargs: Argv<object>,
  provider: DiscoveredAuthProvider
): Argv<object> {
  const metadata = provider.capability.login;
  const fields = metadata?.fields ?? [];
  let configured = yargs;

  for (const field of fields) {
    configured = configureFieldOption(configured, field);
  }

  if (metadata?.envMigration !== undefined) {
    configured = configured.option('from-env', {
      type: 'boolean',
      describe: metadata.envMigration.description,
      default: false,
    });
    const conflicts = fieldFlagNames(fields);
    if (conflicts.length > 0) {
      configured = configured.conflicts('from-env', conflicts);
    }
  }

  return configured;
}

async function valueFromStdin(
  current: AideAuthInputValue,
  field: AideAuthInputField,
  fromEnv: boolean
): Promise<AideAuthInputValue> {
  if (current !== undefined) return current;
  if (fromEnv || field.kind === 'select' || field.stdin !== true) {
    return current;
  }
  if (process.stdin.isTTY) return current;

  const piped = (await readStdin()).trim();
  return piped === '' ? undefined : piped;
}

async function loginRequestFromArgs(
  provider: DiscoveredAuthProvider,
  argv: ArgumentsCamelCase<DynamicLoginArgs>
): Promise<AideAuthLoginRequest> {
  const fromEnv = argv['from-env'] === true;
  if (fromEnv) {
    return { fromEnv: true };
  }

  const values: Record<string, AideAuthInputValue> = {};

  for (const field of provider.capability.login?.fields ?? []) {
    const flagName = authFieldFlagName(field);
    const rawValue = authInputValue(argv[flagName]);
    const defaulted =
      rawValue === undefined && field.kind === 'select'
        ? field.default
        : rawValue;
    const value = await valueFromStdin(defaulted, field, fromEnv);
    if (value !== undefined) {
      values[field.key] = value;
    }
  }

  return {
    fromEnv,
    values,
  };
}

function loginCommandForProvider(
  provider: DiscoveredAuthProvider
): CommandModule<object, DynamicLoginArgs> {
  return {
    command: authProviderCommandRoutes(provider, 'login'),
    describe:
      provider.capability.login?.summary ??
      `Save ${provider.capability.label} credentials`,
    builder: (yargs) => configureLoginOptions(yargs, provider),
    handler: async (argv) => {
      await runAuthProviderLogin(
        provider,
        await loginRequestFromArgs(provider, argv)
      );
    },
  };
}

function loginProviderCommandName(provider: DiscoveredAuthProvider): string {
  const route = authProviderCommandRoutes(provider, 'login');
  return typeof route === 'string' ? route : route[0]!;
}

function loginProviders(
  services: AideHostServices
): readonly DiscoveredAuthProvider[] {
  return services
    .authProviders()
    .filter((provider) => providerHasAuthOperation(provider, 'login'));
}

const command: AideHostAwareCommandModule<object, object> = {
  command: 'login <service>',
  describe: 'Save credentials for a service to the OS keyring',
  aideBuilder: (yargs, services) => {
    const providers = loginProviders(services);
    let configured = yargs;

    for (const provider of providers) {
      configured = configured.command(loginCommandForProvider(provider));
    }

    const names = providers.map(loginProviderCommandName);
    return configured.demandCommand(
      1,
      names.length === 0
        ? 'No auth providers with login operations are registered'
        : `Specify a service: ${names.join(', ')}`
    );
  },
  handler: () => {
    // Never reached - subcommand is required.
  },
};

export default command;
