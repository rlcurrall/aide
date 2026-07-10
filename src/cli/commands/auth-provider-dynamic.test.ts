import { describe, expect, test } from 'bun:test';
import { Effect } from 'effect';
import yargs from 'yargs';
import yargsParser from 'yargs/yargs';

import {
  AIDE_PLUGIN_API_VERSION,
  defineAidePlugin as definePublicAidePlugin,
} from '@aide/plugin-api';
import { createCommandRegistry } from '@cli/host/command-registry.js';
import { registerCommands } from '@cli/host/yargs-adapter.js';
import { legacyAuthPlugin } from '@cli/plugins/legacy-auth/plugin.js';
import type {
  AideAuthLoginRequest,
  AideAuthLogoutRequest,
} from '@cli/host/plugin-descriptor.js';

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
    let observedRequest: AideAuthLogoutRequest | undefined;
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
              logout: (request) =>
                Effect.sync(() => {
                  logoutCalls += 1;
                  observedRequest = request;
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
    expect(observedRequest).toBeUndefined();
    expect(lines).toEqual(['external logout removed']);
  });

  test('login receives frozen scope from --scope-* flags', async () => {
    const registry = createCommandRegistry();
    let observedRequest: AideAuthLoginRequest | undefined;
    const originalLog = console.log;
    console.log = () => {};

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
        yargs([
          'login',
          'external',
          '--api-token',
          'secret-token',
          '--scope-host',
          'example.atlassian.net',
          '--scope-org',
          'project-x',
          '--scope-account',
          'alice',
          '--scope-label',
          'team',
        ])
          .scriptName('aide')
          .exitProcess(false),
        registry
      )
        .strict()
        .parseAsync();
    } finally {
      console.log = originalLog;
    }

    expect(observedRequest?.scope).toMatchObject({
      id: 'example.atlassian.net:project-x:alice:team',
      providerId: 'external-auth',
      host: 'example.atlassian.net',
      org: 'project-x',
      account: 'alice',
      label: 'team',
    });
    expect(Object.isFrozen(observedRequest?.scope)).toBe(true);
    expect(observedRequest?.values).toEqual({ apiToken: 'secret-token' });
  });

  test('login with --scope-id only sets id and leaves other scope fields undefined', async () => {
    const registry = createCommandRegistry();
    let observedRequest: AideAuthLoginRequest | undefined;
    const originalLog = console.log;
    console.log = () => {};

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
        yargs([
          'login',
          'external',
          '--api-token',
          'secret-token',
          '--scope-id',
          'tenant-123',
        ])
          .scriptName('aide')
          .exitProcess(false),
        registry
      )
        .strict()
        .parseAsync();
    } finally {
      console.log = originalLog;
    }

    expect(observedRequest).toMatchObject({
      scope: {
        id: 'tenant-123',
        providerId: 'external-auth',
      },
      values: { apiToken: 'secret-token' },
    });
    expect(observedRequest?.scope).toMatchObject({
      id: 'tenant-123',
      providerId: 'external-auth',
      host: undefined,
      org: undefined,
      account: undefined,
      label: undefined,
    });
    expect(Object.isFrozen(observedRequest?.scope)).toBe(true);
  });

  test('logout receives frozen scope from --scope-* flags', async () => {
    const registry = createCommandRegistry();
    let observedRequest: AideAuthLogoutRequest | undefined;
    const originalLog = console.log;
    console.log = () => {};

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
              logout: (request) =>
                Effect.sync(() => {
                  observedRequest = request;
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
        yargs([
          'logout',
          'external',
          '--scope-host',
          'example.atlassian.net',
          '--scope-org',
          'project-x',
          '--scope-account',
          'alice',
        ])
          .scriptName('aide')
          .exitProcess(false),
        registry
      )
        .strict()
        .parseAsync();
    } finally {
      console.log = originalLog;
    }

    expect(observedRequest).toMatchObject({
      scope: {
        id: 'example.atlassian.net:project-x:alice',
        providerId: 'external-auth',
        host: 'example.atlassian.net',
        org: 'project-x',
        account: 'alice',
      },
    });
    expect(Object.isFrozen(observedRequest?.scope)).toBe(true);
  });

  test('blank-only scope flags are rejected', async () => {
    const registry = createCommandRegistry();

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
              login: () =>
                Effect.sync(() => ({
                  status: 'stored' as const,
                  messages: ['external login stored'],
                })),
            },
          },
        },
      }),
      { manifest: externalManifest('external-auth-plugin') }
    );
    registry.registerPlugin(legacyAuthPlugin);

    await expect(
      registerCommands(
        yargs([
          'login',
          'external',
          '--scope-host',
          '   ',
          '--scope-org',
          '  ',
          '--api-token',
          'secret-token',
        ])
          .scriptName('aide')
          .exitProcess(false),
        registry
      )
        .strict()
        .fail((message, err) => {
          throw err ?? new Error(message ?? 'parse failed');
        })
        .parseAsync()
    ).rejects.toThrow(
      "Auth provider 'external-auth' requires '--scope-host' to be a non-empty string."
    );
  });

  test('invalid mixed yargs scope input fails before login, from-env, and logout operations', async () => {
    const registry = createCommandRegistry();
    let loginCalls = 0;
    let logoutCalls = 0;

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
              envMigration: {
                description: 'Migrate EXTERNAL_TOKEN into the keyring',
                variables: ['EXTERNAL_TOKEN'],
              },
            },
            logout: {
              command: {
                name: 'external',
              },
              summary: 'Remove External Auth credentials',
            },
            status: () => Effect.succeed({ state: 'configured' }),
            operations: {
              login: () =>
                Effect.sync(() => {
                  loginCalls += 1;
                  return {
                    status: 'stored' as const,
                    messages: ['external login stored'],
                  };
                }),
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

    const invocations = [
      ['login', 'external'],
      ['login', 'external', '--from-env'],
      ['logout', 'external'],
    ];

    for (const invocation of invocations) {
      await expect(
        registerCommands(
          yargsParser([
            ...invocation,
            '--scope-host',
            '   ',
            '--scope-account',
            'alice',
          ])
            .scriptName('aide')
            .exitProcess(false),
          registry
        )
          .strict()
          .fail((message, err) => {
            throw err ?? new Error(message ?? 'parse failed');
          })
          .parseAsync()
      ).rejects.toThrow(
        "Auth provider 'external-auth' requires '--scope-host' to be a non-empty string."
      );
    }

    expect(loginCalls).toBe(0);
    expect(logoutCalls).toBe(0);
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
    expect(observedRequest?.scope).toBeUndefined();
    expect(observedRequest?.values).toBeUndefined();
  });

  test('login --from-env with scope flags passes scope and omits values', async () => {
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
      yargs([
        'login',
        'external',
        '--from-env',
        '--scope-host',
        'example.atlassian.net',
        '--scope-account',
        'alice',
      ])
        .scriptName('aide')
        .exitProcess(false),
      registry
    )
      .strict()
      .parseAsync();

    expect(observedRequest).toMatchObject({
      fromEnv: true,
      scope: {
        id: 'example.atlassian.net:alice',
        providerId: 'external-auth',
        host: 'example.atlassian.net',
        account: 'alice',
      },
    });
    expect(observedRequest?.scope).toMatchObject({
      id: 'example.atlassian.net:alice',
      providerId: 'external-auth',
      host: 'example.atlassian.net',
      account: 'alice',
    });
    expect(observedRequest?.values).toBeUndefined();
    expect(Object.isFrozen(observedRequest?.scope)).toBe(true);
  });

  test('login rejects field flag names that collide with reserved scope flags', async () => {
    const registry = createCommandRegistry();
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
                  key: 'scope-host',
                  label: 'Scope host',
                  description: 'Reserved field',
                  required: true,
                },
              ],
            },
            status: () => Effect.succeed({ state: 'configured' }),
            operations: {
              login: () =>
                Effect.sync(() => ({
                  status: 'stored' as const,
                  messages: ['external login stored'],
                })),
            },
          },
        },
      }),
      { manifest: externalManifest('external-auth-plugin') }
    );
    registry.registerPlugin(legacyAuthPlugin);

    let observedError: unknown;
    try {
      await registerCommands(
        yargs(['login', 'external']).scriptName('aide').exitProcess(false),
        registry
      )
        .strict()
        .parseAsync();
    } catch (error) {
      observedError = error;
    }

    expect(observedError).toBeDefined();
    expect(String(observedError)).toContain(
      "Auth provider 'external-auth' login field 'scope-host' conflicts with reserved auth scope option '--scope-host'"
    );
  });
});
