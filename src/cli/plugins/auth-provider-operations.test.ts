import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Effect } from 'effect';

import type {
  AideDiscoveredCapability,
  AideAuthPrompt,
  AideAuthPromptTextRequest,
  AideAuthProviderCapability,
} from '@cli/host/plugin-descriptor.js';
import { listAuthProviderAccounts } from '@cli/host/auth-provider-operations.js';
import { loadJiraConfigForArgs } from '@cli/commands/jira/auth-scope.js';
import { createAzureDevOpsPlugin } from './azure-devops/plugin.js';
import { createGitHubPlugin } from './github/plugin.js';
import { createJiraPlugin } from './jira/plugin.js';
import { loadAzureDevOpsConfig } from '@lib/config.js';
import {
  installMockSecrets,
  restoreEnv,
  saveEnv,
  type Store,
} from '@lib/test-helpers.js';

const AUTH_ENV_VARS = [
  'AZURE_DEVOPS_AUTH_METHOD',
  'AZURE_DEVOPS_ORG_URL',
  'AZURE_DEVOPS_PAT',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'JIRA_API_TOKEN',
  'JIRA_EMAIL',
  'JIRA_TOKEN',
  'JIRA_URL',
  'JIRA_USERNAME',
];

class ScriptedAuthPrompt implements AideAuthPrompt {
  readonly requests: AideAuthPromptTextRequest[] = [];
  private readonly inputs: string[];

  constructor(inputs: readonly string[]) {
    this.inputs = [...inputs];
  }

  text(request: AideAuthPromptTextRequest) {
    return Effect.sync(() => {
      this.requests.push(request);
      const value = this.inputs.shift();
      if (value === undefined) {
        throw new Error('ScriptedAuthPrompt exhausted');
      }
      const error = request.validate?.(value);
      if (error) throw new Error(error);
      return value;
    });
  }
}

function authProvider(plugin: {
  readonly capabilities?: {
    readonly authProvider?: AideAuthProviderCapability;
  };
}): AideAuthProviderCapability {
  const provider = plugin.capabilities?.authProvider;
  if (provider === undefined) throw new Error('missing auth provider');
  return provider;
}

function discoveredAuthProvider(plugin: {
  readonly id: string;
  readonly capabilities?: {
    readonly authProvider?: AideAuthProviderCapability;
  };
}): AideDiscoveredCapability<AideAuthProviderCapability> {
  return Object.freeze({
    pluginId: plugin.id,
    capability: authProvider(plugin),
  });
}

describe('auth provider operations', () => {
  let store: Store;
  let restoreSecrets: () => void;
  let envSnap: Map<string, string | undefined>;

  beforeEach(() => {
    envSnap = saveEnv(AUTH_ENV_VARS);
    store = new Map();
    Bun.env.AIDE_SECRET_SERVICE_OVERRIDE = 'aide';
    restoreSecrets = installMockSecrets(store);
  });

  afterEach(() => {
    restoreSecrets();
    restoreEnv(envSnap);
  });

  test('Jira login stores supplied values without command-layer prompts', async () => {
    const provider = authProvider(createJiraPlugin());
    const result = await Effect.runPromise(
      provider.operations!.login!({
        values: {
          url: 'https://example.atlassian.net',
          email: 'dev@example.com',
          token: 'jira-token',
        },
      })
    );

    expect(result).toEqual({
      status: 'stored',
      messages: ['Saved credentials for jira.'],
    });
    expect(JSON.parse(store.get('aide:jira') ?? '{}')).toEqual({
      url: 'https://example.atlassian.net',
      email: 'dev@example.com',
      apiToken: 'jira-token',
    });
  });

  test('Jira login uses the provider prompt contract for missing values', async () => {
    const provider = authProvider(createJiraPlugin());
    const prompt = new ScriptedAuthPrompt(['dev@example.com', 'jira-token']);

    await Effect.runPromise(
      provider.operations!.login!({
        values: { url: 'https://example.atlassian.net' },
        prompt,
      })
    );

    expect(prompt.requests.map((request) => request.label)).toEqual([
      'Email',
      'API token',
    ]);
    expect(prompt.requests.map((request) => Boolean(request.secret))).toEqual([
      false,
      true,
    ]);
    expect(JSON.parse(store.get('aide:jira') ?? '{}')).toMatchObject({
      email: 'dev@example.com',
      apiToken: 'jira-token',
    });
  });

  test('Azure DevOps login migrates environment credentials through provider operations', async () => {
    Bun.env.AZURE_DEVOPS_ORG_URL = 'https://dev.azure.com/example';
    Bun.env.AZURE_DEVOPS_PAT = 'ado-token';

    const provider = authProvider(createAzureDevOpsPlugin());
    const result = await Effect.runPromise(
      provider.operations!.login!({ fromEnv: true })
    );

    expect(result.status).toBe('stored');
    expect(result.messages?.join('\n')).toContain(
      'Migrated Azure DevOps credentials from env to keyring.'
    );
    expect(JSON.parse(store.get('aide:ado') ?? '{}')).toEqual({
      orgUrl: 'https://dev.azure.com/example',
      pat: 'ado-token',
      authMethod: 'pat',
    });
  });

  test('GitHub login reports external auth when gh CLI is available', async () => {
    const provider = authProvider(
      createGitHubPlugin({ ghAvailable: () => true })
    );
    const result = await Effect.runPromise(
      provider.operations!.login!({ values: { token: 'ignored' } })
    );

    expect(result).toEqual({
      status: 'external',
      messages: ['Using gh CLI auth. Nothing to do.'],
    });
    expect(store.has('aide:github')).toBe(false);
  });

  test('built-in providers expose configured auth accounts', async () => {
    Bun.env.JIRA_URL = 'https://example.atlassian.net';
    Bun.env.JIRA_EMAIL = 'dev@example.com';
    Bun.env.JIRA_API_TOKEN = 'jira-token';
    store.set(
      'aide:ado',
      JSON.stringify({
        orgUrl: 'https://dev.azure.com/example',
        pat: 'ado-token',
        authMethod: 'pat',
      })
    );

    const jiraAccounts = await Effect.runPromise(
      listAuthProviderAccounts(discoveredAuthProvider(createJiraPlugin()))
    );
    const adoAccounts = await Effect.runPromise(
      listAuthProviderAccounts(
        discoveredAuthProvider(createAzureDevOpsPlugin())
      )
    );
    const githubAccounts = await Effect.runPromise(
      listAuthProviderAccounts(
        discoveredAuthProvider(createGitHubPlugin({ ghAvailable: () => true }))
      )
    );

    expect(jiraAccounts).toMatchObject([
      {
        providerId: 'jira',
        label: 'dev@example.com',
        sourceKind: 'env',
        scope: {
          providerId: 'jira',
          host: 'example.atlassian.net',
          account: 'dev@example.com',
        },
      },
    ]);
    expect(adoAccounts).toMatchObject([
      {
        providerId: 'azure-devops',
        label: 'example',
        sourceKind: 'keyring',
        metadata: { authMethod: 'pat' },
        scope: {
          providerId: 'azure-devops',
          host: 'dev.azure.com',
          org: 'example',
        },
      },
    ]);
    expect('account' in (adoAccounts[0]?.scope ?? {})).toBe(false);
    expect(githubAccounts).toMatchObject([
      {
        providerId: 'github',
        sourceKind: 'external',
        metadata: { authSource: 'gh-cli' },
        scope: {
          providerId: 'github',
          host: 'github.com',
        },
      },
    ]);
  });

  test('Azure DevOps account discovery canonicalizes visualstudio.com identity', async () => {
    const accounts = await Effect.runPromise(
      listAuthProviderAccounts(
        discoveredAuthProvider(
          createAzureDevOpsPlugin({
            probeConfig: async () => ({
              kind: 'keyring',
              value: {
                orgUrl: 'https://Acme.visualstudio.com',
                pat: 'ado-token',
                authMethod: 'pat',
              },
            }),
          })
        )
      )
    );

    expect(accounts).toMatchObject([
      {
        id: 'acme',
        providerId: 'azure-devops',
        detail: 'https://Acme.visualstudio.com (pat, keyring)',
        scope: {
          id: 'https://dev.azure.com/acme',
          providerId: 'azure-devops',
          host: 'dev.azure.com',
          org: 'acme',
          label: 'https://Acme.visualstudio.com',
        },
      },
    ]);
  });

  test('provider logout removes only the matching stored credential', async () => {
    store.set('aide:github', JSON.stringify({ token: 'stored' }));
    const provider = authProvider(
      createGitHubPlugin({ ghAvailable: () => false })
    );

    const removed = await Effect.runPromise(provider.operations!.logout!());
    const missing = await Effect.runPromise(provider.operations!.logout!());

    expect(removed).toEqual({
      status: 'removed',
      messages: ['Removed stored credentials for github.'],
    });
    expect(missing).toEqual({
      status: 'not-found',
      messages: ['No stored credentials for github.'],
    });
  });

  test('Jira scoped login writes auth:jira:host:... not legacy jira', async () => {
    const provider = authProvider(createJiraPlugin());
    const result = await Effect.runPromise(
      provider.operations!.login!({
        values: {
          url: 'https://example.atlassian.net',
          email: 'Dev@Example.COM',
          token: 'jira-token',
        },
        scope: {
          id: 'example.atlassian.net:dev@example.com',
          providerId: 'jira',
          host: 'EXAMPLE.ATLASSIAN.NET',
          account: 'dev@example.com',
        },
      })
    );

    expect(result).toEqual({
      status: 'stored',
      messages: ['Saved credentials for jira.'],
    });
    expect(
      JSON.parse(
        store.get(
          'aide:auth:jira:host:example.atlassian.net:account:dev%40example.com'
        ) ?? '{}'
      )
    ).toEqual({
      url: 'https://example.atlassian.net',
      email: 'Dev@Example.COM',
      apiToken: 'jira-token',
    });
    expect(store.has('aide:jira')).toBe(false);

    const loaded = await loadJiraConfigForArgs({
      'scope-host': 'example.atlassian.net',
      'scope-account': 'DEV@example.com',
    });
    expect(loaded).toEqual({
      source: 'keyring',
      config: {
        url: 'https://example.atlassian.net',
        email: 'Dev@Example.COM',
        apiToken: 'jira-token',
      },
    });
  });

  test('Jira no-scope login still writes legacy jira', async () => {
    const provider = authProvider(createJiraPlugin());
    await Effect.runPromise(
      provider.operations!.login!({
        values: {
          url: 'https://example.atlassian.net',
          email: 'dev@example.com',
          token: 'jira-token',
        },
      })
    );

    expect(store.has('aide:jira')).toBe(true);
    expect(
      store.has(
        'aide:auth:jira:host:example.atlassian.net:account:dev%40example.com'
      )
    ).toBe(false);
  });

  test('Jira scoped logout removes scoped key and leaves legacy jira', async () => {
    store.set(
      'aide:auth:jira:host:example.atlassian.net:account:dev%40example.com',
      JSON.stringify({ url: 'https://example.atlassian.net' })
    );
    store.set('aide:jira', JSON.stringify({ url: 'https://legacy.jira.com' }));
    const provider = authProvider(createJiraPlugin());

    const removed = await Effect.runPromise(
      provider.operations!.logout!({
        scope: {
          id: 'example.atlassian.net:dev@example.com',
          providerId: 'jira',
          host: 'example.atlassian.net',
          account: 'dev@example.com',
        },
      })
    );

    expect(removed).toEqual({
      status: 'removed',
      messages: ['Removed stored credentials for jira.'],
    });
    expect(
      store.has(
        'aide:auth:jira:host:example.atlassian.net:account:dev%40example.com'
      )
    ).toBe(false);
    expect(store.has('aide:jira')).toBe(true);
  });

  test('ADO scoped login and lookup interoperate across legacy and canonical identities', async () => {
    const provider = authProvider(createAzureDevOpsPlugin());
    const result = await Effect.runPromise(
      provider.operations!.login!({
        values: {
          orgUrl: 'https://Acme.visualstudio.com',
          pat: 'ado-token',
          authMethod: 'pat',
        },
        scope: {
          id: 'Acme.visualstudio.com',
          providerId: 'azure-devops',
          host: 'Acme.visualstudio.com',
        },
      })
    );

    expect(result).toEqual({
      status: 'stored',
      messages: ['Saved credentials for ado.'],
    });
    expect(
      JSON.parse(
        store.get('aide:auth:azure-devops:host:dev.azure.com:org:acme') ?? '{}'
      )
    ).toEqual({
      orgUrl: 'https://Acme.visualstudio.com',
      pat: 'ado-token',
      authMethod: 'pat',
    });
    expect(store.has('aide:ado')).toBe(false);

    const { config } = await loadAzureDevOpsConfig({
      providerId: 'azure-devops',
      host: 'dev.azure.com',
      org: ' ACME ',
    });
    expect(config).toMatchObject({
      orgUrl: 'https://Acme.visualstudio.com',
      pat: 'ado-token',
    });
  });

  test('GitHub scoped login with gh unavailable writes auth:github:host:... not github', async () => {
    const provider = authProvider(
      createGitHubPlugin({ ghAvailable: () => false })
    );
    const result = await Effect.runPromise(
      provider.operations!.login!({
        values: { token: 'gh-token' },
        scope: {
          id: 'github.example.com',
          providerId: 'github',
          host: 'github.example.com',
        },
      })
    );

    expect(result).toEqual({
      status: 'stored',
      messages: ['Saved credentials for github.'],
    });
    expect(
      JSON.parse(store.get('aide:auth:github:host:github.example.com') ?? '{}')
    ).toEqual({
      token: 'gh-token',
    });
    expect(store.has('aide:github')).toBe(false);
  });

  test('GitHub gh availability does not silently ignore an explicit stored scope', async () => {
    const provider = authProvider(
      createGitHubPlugin({ ghAvailable: () => true })
    );

    const result = await Effect.runPromise(
      provider.operations!.login!({
        values: { token: 'scoped-token' },
        scope: {
          id: 'github.example.com',
          providerId: 'github',
          host: 'github.example.com',
        },
      })
    );

    expect(result.status).toBe('stored');
    expect(
      JSON.parse(store.get('aide:auth:github:host:github.example.com') ?? '{}')
    ).toEqual({ token: 'scoped-token' });
    expect(store.has('aide:github')).toBe(false);
  });

  test('incomplete Jira scope rejects instead of falling back to legacy', async () => {
    store.set('aide:jira', 'legacy');
    const provider = authProvider(createJiraPlugin());
    await expect(
      Effect.runPromise(
        provider.operations!.login!({
          values: {
            url: 'https://example.atlassian.net',
            email: 'dev@example.com',
            token: 'jira-token',
          },
          scope: {
            id: 'example.atlassian.net',
            providerId: 'jira',
            host: 'example.atlassian.net',
          },
        })
      )
    ).rejects.toThrow(/scope|auth secret key/i);

    expect(store.get('aide:jira')).toBe('legacy');
    expect(store.has('aide:auth:jira:host:example.atlassian.net')).toBe(false);
  });

  test('scoped from-env login writes each exact provider key and preserves legacy', async () => {
    Bun.env.JIRA_URL = 'https://example.atlassian.net';
    Bun.env.JIRA_EMAIL = 'Dev@Example.COM';
    Bun.env.JIRA_API_TOKEN = 'jira-env-token';
    Bun.env.AZURE_DEVOPS_ORG_URL = 'https://DEV.AZURE.COM/AcMe';
    Bun.env.AZURE_DEVOPS_PAT = 'ado-env-token';
    Bun.env.GITHUB_TOKEN = 'github-env-token';

    const cases = [
      {
        provider: authProvider(createJiraPlugin()),
        scope: {
          id: 'example.atlassian.net:dev@example.com',
          providerId: 'jira',
          host: 'example.atlassian.net',
          account: 'dev@example.com',
        },
        legacyName: 'aide:jira',
        scopedName:
          'aide:auth:jira:host:example.atlassian.net:account:dev%40example.com',
        expected: {
          url: 'https://example.atlassian.net',
          email: 'Dev@Example.COM',
          apiToken: 'jira-env-token',
        },
      },
      {
        provider: authProvider(createAzureDevOpsPlugin()),
        scope: {
          id: 'dev.azure.com:acme',
          providerId: 'azure-devops',
          host: 'dev.azure.com',
          org: 'acme',
        },
        legacyName: 'aide:ado',
        scopedName: 'aide:auth:azure-devops:host:dev.azure.com:org:acme',
        expected: {
          orgUrl: 'https://DEV.AZURE.COM/AcMe',
          pat: 'ado-env-token',
          authMethod: 'pat',
        },
      },
      {
        provider: authProvider(createGitHubPlugin({ ghAvailable: () => true })),
        scope: {
          id: 'github.example.com',
          providerId: 'github',
          host: 'github.example.com',
        },
        legacyName: 'aide:github',
        scopedName: 'aide:auth:github:host:github.example.com',
        expected: { token: 'github-env-token' },
      },
    ];

    for (const testCase of cases) {
      store.set(testCase.legacyName, 'legacy');
      const result = await Effect.runPromise(
        testCase.provider.operations!.login!({
          fromEnv: true,
          scope: testCase.scope,
        })
      );

      expect(result.status).toBe('stored');
      expect(JSON.parse(store.get(testCase.scopedName) ?? '{}')).toEqual(
        testCase.expected
      );
      expect(store.get(testCase.legacyName)).toBe('legacy');
    }
  });

  test('invalid explicit provider scopes reject login, from-env, and logout without legacy mutation', async () => {
    Bun.env.JIRA_URL = 'https://example.atlassian.net';
    Bun.env.JIRA_EMAIL = 'dev@example.com';
    Bun.env.JIRA_API_TOKEN = 'jira-env-token';
    Bun.env.AZURE_DEVOPS_ORG_URL = 'https://dev.azure.com/acme';
    Bun.env.AZURE_DEVOPS_PAT = 'ado-env-token';
    Bun.env.GITHUB_TOKEN = 'github-env-token';

    const cases = [
      {
        provider: authProvider(createJiraPlugin()),
        scope: {
          id: 'example.atlassian.net',
          providerId: 'jira',
          host: 'example.atlassian.net',
        },
        values: {
          url: 'https://example.atlassian.net',
          email: 'dev@example.com',
          token: 'jira-token',
        },
        legacyName: 'aide:jira',
      },
      {
        provider: authProvider(createAzureDevOpsPlugin()),
        scope: {
          id: 'dev.azure.com',
          providerId: 'azure-devops',
          host: 'dev.azure.com',
        },
        values: {
          orgUrl: 'https://dev.azure.com/acme',
          pat: 'ado-token',
          authMethod: 'pat',
        },
        legacyName: 'aide:ado',
      },
      {
        provider: authProvider(createGitHubPlugin({ ghAvailable: () => true })),
        scope: {
          id: 'invalid-host',
          providerId: 'github',
          host: 'not a host',
        },
        values: { token: 'github-token' },
        legacyName: 'aide:github',
      },
    ];

    for (const testCase of cases) {
      store.set(testCase.legacyName, 'legacy');
      await expect(
        Effect.runPromise(
          testCase.provider.operations!.login!({
            values: testCase.values,
            scope: testCase.scope,
          })
        )
      ).rejects.toThrow(/scope|auth secret key/i);
      await expect(
        Effect.runPromise(
          testCase.provider.operations!.login!({
            fromEnv: true,
            scope: testCase.scope,
          })
        )
      ).rejects.toThrow(/scope|auth secret key/i);
      await expect(
        Effect.runPromise(
          testCase.provider.operations!.logout!({ scope: testCase.scope })
        )
      ).rejects.toThrow(/cannot build an auth secret key/i);
      expect(store.get(testCase.legacyName)).toBe('legacy');
    }
  });

  test('manual Jira and ADO login reject credential identities that mismatch valid scopes', async () => {
    const cases = [
      {
        provider: authProvider(createJiraPlugin()),
        scope: {
          id: 'example.atlassian.net:dev@example.com',
          providerId: 'jira',
          host: 'example.atlassian.net',
          account: 'dev@example.com',
        },
        values: {
          url: 'https://other.atlassian.net',
          email: 'dev@example.com',
          token: 'jira-token',
        },
        legacyName: 'aide:jira',
        scopedName:
          'aide:auth:jira:host:example.atlassian.net:account:dev%40example.com',
      },
      {
        provider: authProvider(createJiraPlugin()),
        scope: {
          id: 'example.atlassian.net:dev@example.com',
          providerId: 'jira',
          host: 'example.atlassian.net',
          account: 'dev@example.com',
        },
        values: {
          url: 'https://example.atlassian.net',
          email: 'other@example.com',
          token: 'jira-token',
        },
        legacyName: 'aide:jira',
        scopedName:
          'aide:auth:jira:host:example.atlassian.net:account:dev%40example.com',
      },
      {
        provider: authProvider(createAzureDevOpsPlugin()),
        scope: {
          id: 'dev.azure.com:acme',
          providerId: 'azure-devops',
          host: 'dev.azure.com',
          org: 'acme',
        },
        values: {
          orgUrl: 'https://dev.azure.com/other',
          pat: 'ado-token',
          authMethod: 'pat',
        },
        legacyName: 'aide:ado',
        scopedName: 'aide:auth:azure-devops:host:dev.azure.com:org:acme',
      },
    ];

    for (const testCase of cases) {
      store.set(testCase.legacyName, 'legacy-original');
      store.set(testCase.scopedName, 'scoped-original');
      await expect(
        Effect.runPromise(
          testCase.provider.operations!.login!({
            values: testCase.values,
            scope: testCase.scope,
          })
        )
      ).rejects.toThrow(/does not match/i);
      expect(store.get(testCase.legacyName)).toBe('legacy-original');
      expect(store.get(testCase.scopedName)).toBe('scoped-original');
    }
  });

  test('Jira and ADO from-env reject credential identities that mismatch valid scopes', async () => {
    const jiraProvider = authProvider(createJiraPlugin());
    const jiraScopedName =
      'aide:auth:jira:host:example.atlassian.net:account:dev%40example.com';
    store.set('aide:jira', 'legacy-jira');
    store.set(jiraScopedName, 'scoped-jira');
    Bun.env.JIRA_URL = 'https://other.atlassian.net';
    Bun.env.JIRA_EMAIL = 'dev@example.com';
    Bun.env.JIRA_API_TOKEN = 'jira-env-token';

    await expect(
      Effect.runPromise(
        jiraProvider.operations!.login!({
          fromEnv: true,
          scope: {
            id: 'example.atlassian.net:dev@example.com',
            providerId: 'jira',
            host: 'example.atlassian.net',
            account: 'dev@example.com',
          },
        })
      )
    ).rejects.toThrow(/does not match/i);
    expect(store.get('aide:jira')).toBe('legacy-jira');
    expect(store.get(jiraScopedName)).toBe('scoped-jira');

    const adoProvider = authProvider(createAzureDevOpsPlugin());
    const adoScopedName = 'aide:auth:azure-devops:host:dev.azure.com:org:acme';
    store.set('aide:ado', 'legacy-ado');
    store.set(adoScopedName, 'scoped-ado');
    Bun.env.AZURE_DEVOPS_ORG_URL = 'https://dev.azure.com/other';
    Bun.env.AZURE_DEVOPS_PAT = 'ado-env-token';

    await expect(
      Effect.runPromise(
        adoProvider.operations!.login!({
          fromEnv: true,
          scope: {
            id: 'dev.azure.com:acme',
            providerId: 'azure-devops',
            host: 'dev.azure.com',
            org: 'acme',
          },
        })
      )
    ).rejects.toThrow(/does not match/i);
    expect(store.get('aide:ado')).toBe('legacy-ado');
    expect(store.get(adoScopedName)).toBe('scoped-ado');
  });

  test('built-in operations reject a scope tagged for another provider without mutation', async () => {
    Bun.env.JIRA_URL = 'https://example.atlassian.net';
    Bun.env.JIRA_EMAIL = 'dev@example.com';
    Bun.env.JIRA_API_TOKEN = 'jira-env-token';
    const provider = authProvider(createJiraPlugin());
    const scope = {
      id: 'example.atlassian.net:dev@example.com',
      providerId: 'github',
      host: 'example.atlassian.net',
      account: 'dev@example.com',
    };
    const scopedName =
      'aide:auth:jira:host:example.atlassian.net:account:dev%40example.com';
    store.set('aide:jira', 'legacy');
    store.set(scopedName, 'scoped');

    await expect(
      Effect.runPromise(
        provider.operations!.login!({
          values: {
            url: 'https://example.atlassian.net',
            email: 'dev@example.com',
            token: 'jira-token',
          },
          scope,
        })
      )
    ).rejects.toThrow(/scope/i);
    await expect(
      Effect.runPromise(provider.operations!.login!({ fromEnv: true, scope }))
    ).rejects.toThrow(/scope/i);
    await expect(
      Effect.runPromise(provider.operations!.logout!({ scope }))
    ).rejects.toThrow(/auth secret key/i);
    expect(store.get('aide:jira')).toBe('legacy');
    expect(store.get(scopedName)).toBe('scoped');
  });

  test('unscoped provider login, from-env, and logout retain legacy behavior', async () => {
    Bun.env.JIRA_URL = 'https://example.atlassian.net';
    Bun.env.JIRA_EMAIL = 'dev@example.com';
    Bun.env.JIRA_API_TOKEN = 'jira-env-token';
    Bun.env.AZURE_DEVOPS_ORG_URL = 'https://dev.azure.com/acme';
    Bun.env.AZURE_DEVOPS_PAT = 'ado-env-token';
    Bun.env.GITHUB_TOKEN = 'github-env-token';

    const cases = [
      {
        provider: authProvider(createJiraPlugin()),
        values: {
          url: 'https://example.atlassian.net',
          email: 'dev@example.com',
          token: 'jira-token',
        },
        legacyName: 'aide:jira',
      },
      {
        provider: authProvider(createAzureDevOpsPlugin()),
        values: {
          orgUrl: 'https://dev.azure.com/acme',
          pat: 'ado-token',
          authMethod: 'pat',
        },
        legacyName: 'aide:ado',
      },
      {
        provider: authProvider(
          createGitHubPlugin({ ghAvailable: () => false })
        ),
        values: { token: 'github-token' },
        legacyName: 'aide:github',
      },
    ];

    for (const testCase of cases) {
      await Effect.runPromise(
        testCase.provider.operations!.login!({ values: testCase.values })
      );
      expect(store.has(testCase.legacyName)).toBe(true);
      await Effect.runPromise(testCase.provider.operations!.logout!());
      expect(store.has(testCase.legacyName)).toBe(false);

      await Effect.runPromise(
        testCase.provider.operations!.login!({ fromEnv: true })
      );
      expect(store.has(testCase.legacyName)).toBe(true);
      await Effect.runPromise(testCase.provider.operations!.logout!());
      expect(store.has(testCase.legacyName)).toBe(false);
    }
  });

  test('valid scoped ADO and GitHub logout cannot delete legacy credentials', async () => {
    const cases = [
      {
        provider: authProvider(createAzureDevOpsPlugin()),
        scope: {
          id: 'dev.azure.com:acme',
          providerId: 'azure-devops',
          host: 'dev.azure.com',
          org: 'acme',
        },
        scopedName: 'aide:auth:azure-devops:host:dev.azure.com:org:acme',
        legacyName: 'aide:ado',
      },
      {
        provider: authProvider(
          createGitHubPlugin({ ghAvailable: () => false })
        ),
        scope: {
          id: 'github.example.com',
          providerId: 'github',
          host: 'github.example.com',
        },
        scopedName: 'aide:auth:github:host:github.example.com',
        legacyName: 'aide:github',
      },
    ];

    for (const testCase of cases) {
      store.set(testCase.scopedName, 'scoped');
      store.set(testCase.legacyName, 'legacy');
      const result = await Effect.runPromise(
        testCase.provider.operations!.logout!({ scope: testCase.scope })
      );

      expect(result.status).toBe('removed');
      expect(store.has(testCase.scopedName)).toBe(false);
      expect(store.get(testCase.legacyName)).toBe('legacy');
    }
  });
});
