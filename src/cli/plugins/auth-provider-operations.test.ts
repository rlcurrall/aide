import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Effect } from 'effect';

import type {
  AideAuthPrompt,
  AideAuthPromptTextRequest,
  AideAuthProviderCapability,
} from '@cli/host/plugin-descriptor.js';
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
});
