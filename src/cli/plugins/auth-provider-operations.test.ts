import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Effect } from 'effect';

import type {
  AideDiscoveredCapability,
  AideAuthPrompt,
  AideAuthPromptTextRequest,
  AideAuthProviderCapability,
} from '@cli/host/plugin-descriptor.js';
import { listAuthProviderAccounts } from '@cli/host/auth-provider-operations.js';
import { createAzureDevOpsPlugin } from './azure-devops/plugin.js';
import { createGitHubPlugin } from './github/plugin.js';
import { createJiraPlugin } from './jira/plugin.js';
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
          email: 'dev@example.com',
          token: 'jira-token',
        },
        scope: {
          id: 'example.atlassian.net:dev@example.com',
          providerId: 'jira',
          host: 'example.atlassian.net',
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
      email: 'dev@example.com',
      apiToken: 'jira-token',
    });
    expect(store.has('aide:jira')).toBe(false);
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

  test('ADO scoped login writes auth:azure-devops:host:... not ado', async () => {
    const provider = authProvider(createAzureDevOpsPlugin());
    const result = await Effect.runPromise(
      provider.operations!.login!({
        values: {
          orgUrl: 'https://dev.azure.com/example',
          pat: 'ado-token',
          authMethod: 'pat',
        },
        scope: {
          id: 'dev.azure.com',
          providerId: 'azure-devops',
          host: 'dev.azure.com',
          org: 'example',
        },
      })
    );

    expect(result).toEqual({
      status: 'stored',
      messages: ['Saved credentials for ado.'],
    });
    expect(
      JSON.parse(
        store.get('aide:auth:azure-devops:host:dev.azure.com:org:example') ??
          '{}'
      )
    ).toEqual({
      orgUrl: 'https://dev.azure.com/example',
      pat: 'ado-token',
      authMethod: 'pat',
    });
    expect(store.has('aide:ado')).toBe(false);
  });

  test('GitHub scoped login with gh unavailable writes auth:github:host:... not github', async () => {
    const provider = authProvider(
      createGitHubPlugin({ ghAvailable: () => false })
    );
    const result = await Effect.runPromise(
      provider.operations!.login!({
        values: { token: 'gh-token' },
        scope: {
          id: 'ghe.example.com',
          providerId: 'github',
          host: 'ghe.example.com',
        },
      })
    );

    expect(result).toEqual({
      status: 'stored',
      messages: ['Saved credentials for github.'],
    });
    expect(
      JSON.parse(store.get('aide:auth:github:host:ghe.example.com') ?? '{}')
    ).toEqual({
      token: 'gh-token',
    });
    expect(store.has('aide:github')).toBe(false);
  });

  test('GitHub gh available external writes nothing', async () => {
    const provider = authProvider(
      createGitHubPlugin({ ghAvailable: () => true })
    );

    await Effect.runPromise(
      provider.operations!.login!({
        values: { token: 'ignored' },
        scope: {
          id: 'ghe.example.com',
          providerId: 'github',
          host: 'ghe.example.com',
        },
      })
    );

    expect(store.has('aide:auth:github:host:ghe.example.com')).toBe(false);
    expect(store.has('aide:github')).toBe(false);
  });

  test('incomplete scope falls back to legacy key', async () => {
    const provider = authProvider(createJiraPlugin());
    const result = await Effect.runPromise(
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
    expect(store.has('aide:auth:jira:host:example.atlassian.net')).toBe(false);
  });
});
