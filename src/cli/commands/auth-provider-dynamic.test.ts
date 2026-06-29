import { describe, expect, test } from 'bun:test';
import { Effect } from 'effect';
import yargs from 'yargs';

import {
  AIDE_PLUGIN_API_VERSION,
  defineAidePlugin as definePublicAidePlugin,
} from '@aide/plugin-api';
import { createCommandRegistry } from '@cli/host/command-registry.js';
import { registerCommands } from '@cli/host/yargs-adapter.js';
import { legacyAuthPlugin } from '@cli/plugins/legacy-auth/plugin.js';
import type { AideAuthLoginRequest } from '@cli/host/plugin-descriptor.js';

function externalManifest(id: string) {
  return {
    id,
    version: '1.0.0',
    aidePluginApiVersion: AIDE_PLUGIN_API_VERSION,
    capabilities: ['auth-provider'],
  } as const;
}

describe('dynamic auth provider commands', () => {
  test('login is generated from external auth provider metadata', async () => {
    const registry = createCommandRegistry();
    const lines: string[] = [];
    let observedRequest: AideAuthLoginRequest | undefined;
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.join(' '));
    };

    registry.registerExternalPlugin(
      definePublicAidePlugin({
        id: 'external-auth-plugin',
        summary: 'External auth provider',
        commands: [],
        capabilities: {
          authProvider: {
            providerId: 'external-auth',
            label: 'External Auth',
            login: {
              command: {
                name: 'external',
              },
              summary: 'Save External Auth credentials',
              fields: [
                {
                  kind: 'secret',
                  key: 'apiToken',
                  label: 'External token',
                  description: 'External token',
                  required: true,
                },
              ],
            },
            status: () => Effect.succeed({ state: 'configured' }),
            operations: {
              login: (request) =>
                Effect.sync(() => {
                  observedRequest = request;
                  return {
                    status: 'stored' as const,
                    messages: ['external login stored'],
                  };
                }),
            },
          },
        },
      }),
      { manifest: externalManifest('external-auth-plugin') }
    );
    registry.registerPlugin(legacyAuthPlugin);

    try {
      await registerCommands(
        yargs(['login', 'external', '--api-token', 'secret-token'])
          .scriptName('aide')
          .exitProcess(false),
        registry
      )
        .strict()
        .parseAsync();
    } finally {
      console.log = originalLog;
    }

    expect(observedRequest?.values).toMatchObject({
      apiToken: 'secret-token',
    });
    expect(Object.isFrozen(observedRequest?.values)).toBe(true);
    expect(lines).toEqual(['external login stored']);
  });

  test('logout resolves providers from external auth provider metadata', async () => {
    const registry = createCommandRegistry();
    const lines: string[] = [];
    let logoutCalls = 0;
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.join(' '));
    };

    registry.registerExternalPlugin(
      definePublicAidePlugin({
        id: 'external-auth-plugin',
        summary: 'External auth provider',
        commands: [],
        capabilities: {
          authProvider: {
            providerId: 'external-auth',
            label: 'External Auth',
            logout: {
              command: {
                name: 'external',
              },
              summary: 'Remove External Auth credentials',
            },
            status: () => Effect.succeed({ state: 'configured' }),
            operations: {
              logout: () =>
                Effect.sync(() => {
                  logoutCalls += 1;
                  return {
                    status: 'removed' as const,
                    messages: ['external logout removed'],
                  };
                }),
            },
          },
        },
      }),
      { manifest: externalManifest('external-auth-plugin') }
    );
    registry.registerPlugin(legacyAuthPlugin);

    try {
      await registerCommands(
        yargs(['logout', 'external']).scriptName('aide').exitProcess(false),
        registry
      )
        .strict()
        .parseAsync();
    } finally {
      console.log = originalLog;
    }

    expect(logoutCalls).toBe(1);
    expect(lines).toEqual(['external logout removed']);
  });

  test('login --from-env does not synthesize field defaults', async () => {
    const registry = createCommandRegistry();
    let observedRequest: AideAuthLoginRequest | undefined;

    registry.registerExternalPlugin(
      definePublicAidePlugin({
        id: 'external-auth-plugin',
        summary: 'External auth provider',
        commands: [],
        capabilities: {
          authProvider: {
            providerId: 'external-auth',
            label: 'External Auth',
            login: {
              command: {
                name: 'external',
              },
              summary: 'Save External Auth credentials',
              fields: [
                {
                  kind: 'select',
                  key: 'mode',
                  label: 'Mode',
                  choices: [{ value: 'default' }],
                  default: 'default',
                },
              ],
              envMigration: {
                description: 'Migrate EXTERNAL_TOKEN into the keyring',
                variables: ['EXTERNAL_TOKEN'],
              },
            },
            status: () => Effect.succeed({ state: 'configured' }),
            operations: {
              login: (request) =>
                Effect.sync(() => {
                  observedRequest = request;
                  return {
                    status: 'stored' as const,
                  };
                }),
            },
          },
        },
      }),
      { manifest: externalManifest('external-auth-plugin') }
    );
    registry.registerPlugin(legacyAuthPlugin);

    await registerCommands(
      yargs(['login', 'external', '--from-env'])
        .scriptName('aide')
        .exitProcess(false),
      registry
    )
      .strict()
      .parseAsync();

    expect(observedRequest).toMatchObject({ fromEnv: true });
    expect(observedRequest?.values).toBeUndefined();
  });
});
