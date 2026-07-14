import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Effect, Layer } from 'effect';
import yargs from 'yargs';

import type { AidePublicPluginDescriptor } from '@aide/plugin-api';
import type { AideAuthProviderCapability } from './plugin-descriptor.js';
import { runAuthProviderLoginWithLayer } from '@cli/commands/auth-provider-command-utils.js';
import * as authEffectBridge from '@cli/commands/effect-bridge.js';
import {
  createKeyringCommandRegistry,
  type KeyringCommandRegistry,
} from './command-registry.js';
import { registerCommands } from './yargs-adapter.js';
import { legacyAuthPlugin } from '@cli/plugins/legacy-auth/plugin.js';
import { createJiraPlugin } from '@cli/plugins/jira/plugin.js';
import { createGitHubPlugin } from '@cli/plugins/github/plugin.js';
import { createAzureDevOpsPlugin } from '@cli/plugins/azure-devops/plugin.js';
import { makeTestKeyring } from '@lib/auth-keyring.test-helper.js';
import {
  KeyringService,
  type KeyringSecretName,
  type KeyringServiceShape,
} from '@lib/auth-keyring.js';
import { unavailableGitHubAuthProbe } from '@lib/test-helpers.js';
import {
  getAuthProviderStatus,
  loginWithAuthProvider,
  logoutWithAuthProvider,
} from './auth-provider-operations.js';

const spies: Array<{ mockRestore: () => void }> = [];

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

function jiraProvider() {
  const plugin = createJiraPlugin();
  const capability = plugin.capabilities?.authProvider;
  if (capability === undefined) throw new Error('missing Jira auth provider');
  return Object.freeze({
    provenance: 'trusted' as const,
    pluginId: plugin.id,
    capability,
  });
}

interface ProviderPlugin {
  readonly id: string;
  readonly capabilities?: {
    readonly authProvider?: AideAuthProviderCapability<
      KeyringService,
      KeyringService,
      KeyringService,
      KeyringService
    >;
  };
}

function authProvider(plugin: ProviderPlugin) {
  const capability = plugin.capabilities?.authProvider;
  if (capability === undefined) throw new Error('missing auth provider');
  return Object.freeze({
    provenance: 'trusted' as const,
    pluginId: plugin.id,
    capability,
  });
}

function authOnlyBuiltinRegistry(): KeyringCommandRegistry {
  return createKeyringCommandRegistry()
    .registerPlugin(createJiraPlugin())
    .registerPlugin(
      createGitHubPlugin({ ghAuthProbe: unavailableGitHubAuthProbe })
    )
    .registerPlugin(createAzureDevOpsPlugin())
    .registerPlugin(legacyAuthPlugin);
}

async function exerciseInjectedProvider(options: {
  readonly plugin: ProviderPlugin;
  readonly initialName: string;
  readonly initialValue: string;
  readonly loginValues: Readonly<Record<string, string>>;
}): Promise<void> {
  const keyring = makeTestKeyring(
    new Map([[`aide:${options.initialName}`, options.initialValue]])
  );
  const provider = authProvider(options.plugin);

  expect(
    await Effect.runPromise(
      getAuthProviderStatus(provider).pipe(Effect.provide(keyring.layer))
    )
  ).toMatchObject({ state: 'configured' });
  expect(
    await Effect.runPromise(
      loginWithAuthProvider(provider, {
        values: options.loginValues,
      }).pipe(Effect.provide(keyring.layer))
    )
  ).toMatchObject({ status: 'stored' });
  expect(
    await Effect.runPromise(
      logoutWithAuthProvider(provider).pipe(Effect.provide(keyring.layer))
    )
  ).toMatchObject({ status: 'removed' });
  expect(keyring.store.has(`aide:${options.initialName}`)).toBe(false);
}

describe('trusted auth-provider keyring composition', () => {
  test('built-in yargs login/logout acquire exactly one injected keyring layer per operation', async () => {
    const bunGet = spyOn(Bun.secrets, 'get').mockImplementation(async () => {
      throw new Error('Bun.secrets.get must not run');
    });
    const bunSet = spyOn(Bun.secrets, 'set').mockImplementation(async () => {
      throw new Error('Bun.secrets.set must not run');
    });
    const bunDelete = spyOn(Bun.secrets, 'delete').mockImplementation(
      async () => {
        throw new Error('Bun.secrets.delete must not run');
      }
    );
    const deprecatedLiveAdapter = spyOn(
      authEffectBridge,
      'runLiveAuthProviderCommandEffect'
    );
    spies.push(bunGet, bunSet, bunDelete, deprecatedLiveAdapter);

    const counts = { constructions: 0, acquisitions: 0, releases: 0 };
    const calls: Array<
      | { readonly operation: 'get'; readonly name: string }
      | { readonly operation: 'set'; readonly name: string }
      | { readonly operation: 'delete'; readonly name: string }
    > = [];
    const store = new Map<string, string>();
    const service: KeyringServiceShape = {
      get: (name: KeyringSecretName) =>
        Effect.sync(() => {
          calls.push({ operation: 'get', name });
          return store.get(name) ?? null;
        }),
      set: (name: KeyringSecretName, value: string) =>
        Effect.sync(() => {
          calls.push({ operation: 'set', name });
          store.set(name, value);
        }),
      delete: (name: KeyringSecretName) =>
        Effect.sync(() => {
          calls.push({ operation: 'delete', name });
          return store.delete(name);
        }),
    };
    const keyringLayer = Layer.scoped(
      KeyringService,
      Effect.gen(function* () {
        counts.constructions += 1;
        return yield* Effect.acquireRelease(
          Effect.sync(() => {
            counts.acquisitions += 1;
            return service;
          }),
          () =>
            Effect.sync(() => {
              counts.releases += 1;
            })
        );
      })
    );
    const registry = authOnlyBuiltinRegistry();
    const operations = [
      [
        'login',
        'jira',
        '--url',
        'https://example.atlassian.net',
        '--email',
        'dev@example.com',
        '--token',
        'jira-token',
      ],
      ['logout', 'jira'],
      ['login', 'github', '--token', 'github-token'],
      ['logout', 'github'],
      [
        'login',
        'ado',
        '--org-url',
        'https://dev.azure.com/example',
        '--pat',
        'ado-token',
        '--auth-method',
        'pat',
      ],
      ['logout', 'ado'],
    ] as const;

    for (const [index, args] of operations.entries()) {
      await registerCommands(
        yargs([...args])
          .scriptName('aide')
          .exitProcess(false),
        registry,
        { keyringLayer }
      )
        .strict()
        .parseAsync();

      const expected = index + 1;
      expect(counts).toEqual({
        constructions: expected,
        acquisitions: expected,
        releases: expected,
      });
    }

    expect(calls.filter((call) => call.operation === 'get')).toHaveLength(1);
    expect(calls.filter((call) => call.operation === 'set')).toHaveLength(3);
    expect(calls.filter((call) => call.operation === 'delete')).toHaveLength(3);
    expect(store.size).toBe(0);
    expect(bunGet).not.toHaveBeenCalled();
    expect(bunSet).not.toHaveBeenCalled();
    expect(bunDelete).not.toHaveBeenCalled();
    expect(deprecatedLiveAdapter).not.toHaveBeenCalled();
  });

  test('Jira status, login, and delete use only the injected keyring', async () => {
    const bunGet = spyOn(Bun.secrets, 'get').mockImplementation(async () => {
      throw new Error('Bun.secrets.get must not run');
    });
    const bunSet = spyOn(Bun.secrets, 'set').mockImplementation(async () => {
      throw new Error('Bun.secrets.set must not run');
    });
    const bunDelete = spyOn(Bun.secrets, 'delete').mockImplementation(
      async () => {
        throw new Error('Bun.secrets.delete must not run');
      }
    );
    spies.push(bunGet, bunSet, bunDelete);

    await exerciseInjectedProvider({
      plugin: createJiraPlugin(),
      initialName: 'jira',
      initialValue: JSON.stringify({
        url: 'https://example.atlassian.net',
        email: 'dev@example.com',
        apiToken: 'old-token',
      }),
      loginValues: {
        url: 'https://example.atlassian.net',
        email: 'dev@example.com',
        token: 'new-token',
      },
    });
    expect(bunGet).not.toHaveBeenCalled();
    expect(bunSet).not.toHaveBeenCalled();
    expect(bunDelete).not.toHaveBeenCalled();
  });

  test('GitHub status, login, and delete use only the injected keyring', async () => {
    const bunGet = spyOn(Bun.secrets, 'get').mockRejectedValue(
      new Error('Bun.secrets.get must not run')
    );
    const bunSet = spyOn(Bun.secrets, 'set').mockRejectedValue(
      new Error('Bun.secrets.set must not run')
    );
    const bunDelete = spyOn(Bun.secrets, 'delete').mockRejectedValue(
      new Error('Bun.secrets.delete must not run')
    );
    spies.push(bunGet, bunSet, bunDelete);

    await exerciseInjectedProvider({
      plugin: createGitHubPlugin({
        ghAuthProbe: unavailableGitHubAuthProbe,
      }),
      initialName: 'github',
      initialValue: JSON.stringify({ token: 'old-token' }),
      loginValues: { token: 'new-token' },
    });
    expect(bunGet).not.toHaveBeenCalled();
    expect(bunSet).not.toHaveBeenCalled();
    expect(bunDelete).not.toHaveBeenCalled();
  });

  test('Azure DevOps status, login, and delete use only the injected keyring', async () => {
    const bunGet = spyOn(Bun.secrets, 'get').mockRejectedValue(
      new Error('Bun.secrets.get must not run')
    );
    const bunSet = spyOn(Bun.secrets, 'set').mockRejectedValue(
      new Error('Bun.secrets.set must not run')
    );
    const bunDelete = spyOn(Bun.secrets, 'delete').mockRejectedValue(
      new Error('Bun.secrets.delete must not run')
    );
    spies.push(bunGet, bunSet, bunDelete);

    await exerciseInjectedProvider({
      plugin: createAzureDevOpsPlugin(),
      initialName: 'ado',
      initialValue: JSON.stringify({
        orgUrl: 'https://dev.azure.com/example',
        pat: 'old-token',
        authMethod: 'pat',
      }),
      loginValues: {
        orgUrl: 'https://dev.azure.com/example',
        pat: 'new-token',
        authMethod: 'pat',
      },
    });
    expect(bunGet).not.toHaveBeenCalled();
    expect(bunSet).not.toHaveBeenCalled();
    expect(bunDelete).not.toHaveBeenCalled();
  });

  test('built-in reads and mutations use an injected keyring without Bun.secrets fallback', async () => {
    const bunGet = spyOn(Bun.secrets, 'get');
    const bunSet = spyOn(Bun.secrets, 'set');
    spies.push(bunGet, bunSet);

    const keyring = makeTestKeyring(
      new Map([
        [
          'aide:jira',
          JSON.stringify({
            url: 'https://example.atlassian.net',
            email: 'dev@example.com',
            apiToken: 'old-token',
          }),
        ],
      ])
    );
    const provider = jiraProvider();

    const status = await Effect.runPromise(
      getAuthProviderStatus(provider).pipe(Effect.provide(keyring.layer))
    );
    const login = await Effect.runPromise(
      loginWithAuthProvider(provider, {
        values: {
          url: 'https://example.atlassian.net',
          email: 'dev@example.com',
          token: 'new-token',
        },
      }).pipe(Effect.provide(keyring.layer))
    );

    expect(status.state).toBe('configured');
    expect(login.status).toBe('stored');
    expect(JSON.parse(keyring.store.get('aide:jira') ?? '{}')).toMatchObject({
      apiToken: 'new-token',
    });
    expect(bunGet).not.toHaveBeenCalled();
    expect(bunSet).not.toHaveBeenCalled();
  });

  test('core invocation retains KeyringService as a composition requirement', () => {
    const effect = loginWithAuthProvider(jiraProvider(), {
      values: {
        url: 'https://example.atlassian.net',
        email: 'dev@example.com',
        token: 'token',
      },
    });

    const environment: Effect.Effect.Context<
      typeof effect
    > extends KeyringService
      ? true
      : false = true;
    expect(environment).toBe(true);

    const acceptsRunnableEffect = (
      _effect: Effect.Effect<unknown, unknown, never>
    ): void => {};
    // @ts-expect-error The injectable core is not runnable until the host provides KeyringService.
    acceptsRunnableEffect(effect);
  });

  test('the external plugin descriptor remains service-free', () => {
    type PublicCapabilities = NonNullable<
      AidePublicPluginDescriptor['capabilities']
    >;
    type PublicAuthProvider = NonNullable<PublicCapabilities['authProvider']>;
    type PublicEnvironment = Effect.Effect.Context<
      ReturnType<PublicAuthProvider['status']>
    >;

    const serviceFree: [PublicEnvironment] extends [never] ? true : false =
      true;
    expect(serviceFree).toBe(true);
  });

  test('the standalone adapter accepts an injected keyring layer', async () => {
    const values = new Map<string, string>();
    const keyring = makeTestKeyring(values);

    const result = await runAuthProviderLoginWithLayer(
      jiraProvider(),
      {
        values: {
          url: 'https://example.atlassian.net',
          email: 'dev@example.com',
          token: 'injected-token',
        },
      },
      keyring.layer
    );

    expect(result.status).toBe('stored');
    expect(JSON.parse(values.get('aide:jira') ?? '{}')).toMatchObject({
      apiToken: 'injected-token',
    });
  });
});
