import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import type {
  AideAuthProviderCapability,
  AideDiscoveredCapability,
} from '@cli/host/plugin-descriptor.js';
import { AuthProviderOperationError } from '@cli/host/auth-provider-operations.js';
import { createAzureDevOpsPlugin } from '@cli/plugins/azure-devops/plugin.js';
import { createGitHubPlugin } from '@cli/plugins/github/plugin.js';
import { createJiraPlugin } from '@cli/plugins/jira/plugin.js';
import type { Prompter, ReadLineOptions } from '@lib/prompts.js';
import {
  installMockSecrets,
  restoreEnv,
  saveEnv,
  type Store,
} from '@lib/test-helpers.js';
import { runAuthProviderLogin } from './auth-provider-command-utils.js';

const JIRA_VARS = [
  'JIRA_URL',
  'JIRA_EMAIL',
  'JIRA_USERNAME',
  'JIRA_API_TOKEN',
  'JIRA_TOKEN',
];
const ADO_VARS = [
  'AZURE_DEVOPS_ORG_URL',
  'AZURE_DEVOPS_PAT',
  'AZURE_DEVOPS_AUTH_METHOD',
];
const GITHUB_VARS = ['GITHUB_TOKEN', 'GH_TOKEN'];

class ScriptedPrompter implements Prompter {
  private inputs: string[];
  readonly writes: string[] = [];

  constructor(inputs: string[]) {
    this.inputs = [...inputs];
  }

  async readLine(_opts: ReadLineOptions): Promise<string> {
    const next = this.inputs.shift();
    if (next === undefined) throw new Error('ScriptedPrompter exhausted');
    return next;
  }

  writeLine(s: string): void {
    this.writes.push(s);
  }
}

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

describe('provider-backed login', () => {
  let store: Store;
  let restore: () => void;

  beforeEach(() => {
    store = new Map();
    Bun.env.AIDE_SECRET_SERVICE_OVERRIDE = 'aide';
    restore = installMockSecrets(store);
  });

  afterEach(() => restore());

  test('uses supplied Jira values without prompting', async () => {
    const p = new ScriptedPrompter([]);
    await runAuthProviderLogin(
      authProvider(createJiraPlugin()),
      {
        values: {
          url: 'https://x.atlassian.net',
          email: 'a@b.c',
          token: 'tkn',
        },
      },
      { prompter: p }
    );

    const stored = JSON.parse(store.get('aide:jira') ?? '{}');
    expect(stored.url).toBe('https://x.atlassian.net');
    expect(stored.email).toBe('a@b.c');
    expect(stored.apiToken).toBe('tkn');
  });

  test('prompts for missing Jira fields only', async () => {
    const p = new ScriptedPrompter(['a@b.c', 'tkn']);
    await runAuthProviderLogin(
      authProvider(createJiraPlugin()),
      { values: { url: 'https://x.atlassian.net' } },
      { prompter: p }
    );

    const stored = JSON.parse(store.get('aide:jira') ?? '{}');
    expect(stored.email).toBe('a@b.c');
    expect(stored.apiToken).toBe('tkn');
  });

  test('prompts for all Jira fields when no values are supplied', async () => {
    const p = new ScriptedPrompter(['https://x.atlassian.net', 'a@b.c', 'tkn']);
    await runAuthProviderLogin(
      authProvider(createJiraPlugin()),
      {},
      {
        prompter: p,
      }
    );

    expect(store.has('aide:jira')).toBe(true);
  });

  test('wraps KeyringUnavailableError when setSecret fails', async () => {
    restore();
    const localRestore = installMockSecrets(store, 'set');
    try {
      const p = new ScriptedPrompter([]);
      const error = await runAuthProviderLogin(
        authProvider(createJiraPlugin()),
        {
          values: {
            url: 'https://x.atlassian.net',
            email: 'a@b.c',
            token: 't',
          },
        },
        { prompter: p }
      ).catch((error) => error);

      expect(error).toBeInstanceOf(AuthProviderOperationError);
      expect((error as AuthProviderOperationError).cause).toMatchObject({
        name: 'KeyringUnavailableError',
      });
    } finally {
      localRestore();
    }
  });

  test('stores Azure DevOps with default authMethod of pat when not supplied', async () => {
    const p = new ScriptedPrompter([]);
    await runAuthProviderLogin(
      authProvider(createAzureDevOpsPlugin()),
      { values: { orgUrl: 'https://dev.azure.com/x', pat: 't' } },
      { prompter: p }
    );

    const stored = JSON.parse(store.get('aide:ado') ?? '{}');
    expect(stored.authMethod).toBe('pat');
  });

  test('stores Azure DevOps bearer authMethod when supplied', async () => {
    const p = new ScriptedPrompter([]);
    await runAuthProviderLogin(
      authProvider(createAzureDevOpsPlugin()),
      {
        values: {
          orgUrl: 'https://dev.azure.com/x',
          pat: 't',
          authMethod: 'bearer',
        },
      },
      { prompter: p }
    );

    const stored = JSON.parse(store.get('aide:ado') ?? '{}');
    expect(stored.authMethod).toBe('bearer');
  });

  test('reports external GitHub auth when gh CLI is available', async () => {
    const p = new ScriptedPrompter([]);
    const result = await runAuthProviderLogin(
      authProvider(createGitHubPlugin({ ghAvailable: () => true })),
      { values: { token: 'should-be-ignored' } },
      { prompter: p }
    );

    expect(result.status).toBe('external');
    expect(store.has('aide:github')).toBe(false);
  });

  test('stores GitHub token when gh CLI is missing', async () => {
    const p = new ScriptedPrompter(['ghp_xxx']);
    const result = await runAuthProviderLogin(
      authProvider(createGitHubPlugin({ ghAvailable: () => false })),
      {},
      { prompter: p }
    );

    expect(result.status).toBe('stored');
    const stored = JSON.parse(store.get('aide:github') ?? '{}');
    expect(stored.token).toBe('ghp_xxx');
  });
});

describe('provider-backed login --from-env', () => {
  let envSnap: Map<string, string | undefined>;
  let store: Store;
  let restore: () => void;
  let logSpy: { messages: string[]; restore: () => void };

  function installLogSpy() {
    const messages: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      messages.push(args.join(' '));
    };
    return {
      messages,
      restore: () => {
        console.log = original;
      },
    };
  }

  beforeEach(() => {
    envSnap = saveEnv([...JIRA_VARS, ...ADO_VARS, ...GITHUB_VARS]);
    store = new Map();
    Bun.env.AIDE_SECRET_SERVICE_OVERRIDE = 'aide';
    restore = installMockSecrets(store);
    logSpy = installLogSpy();
  });

  afterEach(() => {
    logSpy.restore();
    restoreEnv(envSnap);
    restore();
  });

  test('Jira --from-env writes env vars to keyring', async () => {
    Bun.env.JIRA_URL = 'https://x.atlassian.net';
    Bun.env.JIRA_EMAIL = 'a@b.c';
    Bun.env.JIRA_API_TOKEN = 'tkn';
    await runAuthProviderLogin(authProvider(createJiraPlugin()), {
      fromEnv: true,
    });

    const stored = JSON.parse(store.get('aide:jira') ?? '{}');
    expect(stored.url).toBe('https://x.atlassian.net');
    expect(stored.email).toBe('a@b.c');
    expect(stored.apiToken).toBe('tkn');
  });

  test('Jira --from-env success message lists env vars to unset', async () => {
    Bun.env.JIRA_URL = 'https://x.atlassian.net';
    Bun.env.JIRA_EMAIL = 'a@b.c';
    Bun.env.JIRA_API_TOKEN = 'tkn';
    await runAuthProviderLogin(authProvider(createJiraPlugin()), {
      fromEnv: true,
    });

    const output = logSpy.messages.join('\n');
    expect(output).toMatch(/JIRA_URL.*JIRA_EMAIL.*JIRA_API_TOKEN/);
    expect(output).toMatch(/Unset them/i);
  });

  test('Jira --from-env hint uses whichever alias is set', async () => {
    Bun.env.JIRA_URL = 'https://x.atlassian.net';
    Bun.env.JIRA_USERNAME = 'user@b.c';
    Bun.env.JIRA_TOKEN = 'tkn';
    await runAuthProviderLogin(authProvider(createJiraPlugin()), {
      fromEnv: true,
    });

    const output = logSpy.messages.join('\n');
    expect(output).toContain('JIRA_USERNAME');
    expect(output).toContain('JIRA_TOKEN');
    expect(output).not.toContain('JIRA_EMAIL,');
    expect(output).not.toContain('JIRA_API_TOKEN,');
  });

  test('GitHub --from-env hint names GITHUB_TOKEN when that alias is set', async () => {
    Bun.env.GITHUB_TOKEN = 'ghp_xxx';
    await runAuthProviderLogin(
      authProvider(createGitHubPlugin({ ghAvailable: () => false })),
      { fromEnv: true }
    );

    const output = logSpy.messages.join('\n');
    expect(output).toContain('GITHUB_TOKEN');
    expect(output).toMatch(/Unset it/i);
  });

  test('GitHub --from-env hint names GH_TOKEN when that alias is set', async () => {
    Bun.env.GH_TOKEN = 'ghp_yyy';
    await runAuthProviderLogin(
      authProvider(createGitHubPlugin({ ghAvailable: () => false })),
      { fromEnv: true }
    );

    const output = logSpy.messages.join('\n');
    expect(output).toContain('GH_TOKEN');
    expect(output).not.toContain('GITHUB_TOKEN');
  });

  test('Jira --from-env accepts JIRA_USERNAME / JIRA_TOKEN aliases', async () => {
    Bun.env.JIRA_URL = 'https://x.atlassian.net';
    Bun.env.JIRA_USERNAME = 'user@b.c';
    Bun.env.JIRA_TOKEN = 'tkn';
    await runAuthProviderLogin(authProvider(createJiraPlugin()), {
      fromEnv: true,
    });

    const stored = JSON.parse(store.get('aide:jira') ?? '{}');
    expect(stored.email).toBe('user@b.c');
    expect(stored.apiToken).toBe('tkn');
  });

  test('Jira --from-env lists missing vars when env is incomplete', async () => {
    Bun.env.JIRA_URL = 'https://x.atlassian.net';
    await expect(
      runAuthProviderLogin(authProvider(createJiraPlugin()), {
        fromEnv: true,
      })
    ).rejects.toThrow(/JIRA_EMAIL.*JIRA_API_TOKEN/);
    expect(store.has('aide:jira')).toBe(false);
  });

  test('Jira --from-env reports invalid env values', async () => {
    Bun.env.JIRA_URL = 'not-a-url';
    Bun.env.JIRA_EMAIL = 'a@b.c';
    Bun.env.JIRA_API_TOKEN = 'tkn';
    await expect(
      runAuthProviderLogin(authProvider(createJiraPlugin()), {
        fromEnv: true,
      })
    ).rejects.toThrow(/URL/);
  });

  test('Azure DevOps --from-env writes env vars to keyring', async () => {
    Bun.env.AZURE_DEVOPS_ORG_URL = 'https://dev.azure.com/org';
    Bun.env.AZURE_DEVOPS_PAT = 'pat';
    await runAuthProviderLogin(authProvider(createAzureDevOpsPlugin()), {
      fromEnv: true,
    });

    const stored = JSON.parse(store.get('aide:ado') ?? '{}');
    expect(stored.orgUrl).toBe('https://dev.azure.com/org');
    expect(stored.pat).toBe('pat');
    expect(stored.authMethod).toBe('pat');
  });

  test('Azure DevOps --from-env respects AZURE_DEVOPS_AUTH_METHOD', async () => {
    Bun.env.AZURE_DEVOPS_ORG_URL = 'https://dev.azure.com/org';
    Bun.env.AZURE_DEVOPS_PAT = 'pat';
    Bun.env.AZURE_DEVOPS_AUTH_METHOD = 'bearer';
    await runAuthProviderLogin(authProvider(createAzureDevOpsPlugin()), {
      fromEnv: true,
    });

    const stored = JSON.parse(store.get('aide:ado') ?? '{}');
    expect(stored.authMethod).toBe('bearer');
  });

  test('Azure DevOps --from-env lists missing vars', async () => {
    await expect(
      runAuthProviderLogin(authProvider(createAzureDevOpsPlugin()), {
        fromEnv: true,
      })
    ).rejects.toThrow(/AZURE_DEVOPS_ORG_URL.*AZURE_DEVOPS_PAT/);
  });

  test('GitHub --from-env writes GITHUB_TOKEN to keyring even when gh-cli is available', async () => {
    Bun.env.GITHUB_TOKEN = 'ghp_xxx';
    const result = await runAuthProviderLogin(
      authProvider(createGitHubPlugin({ ghAvailable: () => true })),
      { fromEnv: true }
    );

    expect(result.status).toBe('stored');
    const stored = JSON.parse(store.get('aide:github') ?? '{}');
    expect(stored.token).toBe('ghp_xxx');
  });

  test('GitHub --from-env accepts GH_TOKEN alias', async () => {
    Bun.env.GH_TOKEN = 'ghp_yyy';
    await runAuthProviderLogin(
      authProvider(createGitHubPlugin({ ghAvailable: () => false })),
      { fromEnv: true }
    );

    const stored = JSON.parse(store.get('aide:github') ?? '{}');
    expect(stored.token).toBe('ghp_yyy');
  });

  test('GitHub --from-env errors when no token is in env', async () => {
    await expect(
      runAuthProviderLogin(
        authProvider(createGitHubPlugin({ ghAvailable: () => false })),
        { fromEnv: true }
      )
    ).rejects.toThrow(/GITHUB_TOKEN/);
  });
});
