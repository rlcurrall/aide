/**
 * Tests for the login command.
 *
 * These exercise the per-service handlers directly (not the yargs wiring),
 * injecting a ScriptedPrompter and mocking Bun.secrets. The yargs wiring is
 * smoke-tested manually before release.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';

import { loginJira, loginAdo, loginGithub } from './login.js';
import type { Prompter, ReadLineOptions } from '@lib/prompts.js';
import {
  installMockSecrets,
  saveEnv,
  restoreEnv,
  type Store,
} from '@lib/test-helpers.js';

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

describe('loginJira', () => {
  let store: Store;
  let restore: () => void;

  beforeEach(() => {
    store = new Map();
    Bun.env.AIDE_SECRET_SERVICE_OVERRIDE = 'aide';
    restore = installMockSecrets(store);
  });

  afterEach(() => restore());

  test('uses supplied flags without prompting', async () => {
    const p = new ScriptedPrompter([]);
    await loginJira(
      {
        url: 'https://x.atlassian.net',
        email: 'a@b.c',
        token: 'tkn',
      },
      { prompter: p }
    );
    const stored = JSON.parse(store.get('aide:jira') ?? '{}');
    expect(stored.url).toBe('https://x.atlassian.net');
    expect(stored.email).toBe('a@b.c');
    expect(stored.apiToken).toBe('tkn');
  });

  test('prompts for missing fields only', async () => {
    const p = new ScriptedPrompter(['a@b.c', 'tkn']);
    await loginJira({ url: 'https://x.atlassian.net' }, { prompter: p });
    const stored = JSON.parse(store.get('aide:jira') ?? '{}');
    expect(stored.email).toBe('a@b.c');
    expect(stored.apiToken).toBe('tkn');
  });

  test('prompts for all fields when no flags supplied', async () => {
    const p = new ScriptedPrompter(['https://x.atlassian.net', 'a@b.c', 'tkn']);
    await loginJira({}, { prompter: p });
    expect(store.has('aide:jira')).toBe(true);
  });

  test('loginJira propagates KeyringUnavailableError when setSecret fails', async () => {
    restore(); // tear down the default mock
    const localRestore = installMockSecrets(store, 'set');
    try {
      const p = new ScriptedPrompter([]);
      await expect(
        loginJira(
          { url: 'https://x.atlassian.net', email: 'a@b.c', token: 't' },
          { prompter: p }
        )
      ).rejects.toMatchObject({ name: 'KeyringUnavailableError' });
    } finally {
      localRestore();
    }
  });
});

describe('loginAdo', () => {
  let store: Store;
  let restore: () => void;

  beforeEach(() => {
    store = new Map();
    Bun.env.AIDE_SECRET_SERVICE_OVERRIDE = 'aide';
    restore = installMockSecrets(store);
  });

  afterEach(() => restore());

  test('stores with default authMethod of pat when not supplied', async () => {
    const p = new ScriptedPrompter([]);
    await loginAdo(
      { orgUrl: 'https://dev.azure.com/x', pat: 't' },
      { prompter: p }
    );
    const stored = JSON.parse(store.get('aide:ado') ?? '{}');
    expect(stored.authMethod).toBe('pat');
  });

  test('stores bearer authMethod when supplied', async () => {
    const p = new ScriptedPrompter([]);
    await loginAdo(
      {
        orgUrl: 'https://dev.azure.com/x',
        pat: 't',
        authMethod: 'bearer',
      },
      { prompter: p }
    );
    const stored = JSON.parse(store.get('aide:ado') ?? '{}');
    expect(stored.authMethod).toBe('bearer');
  });
});

describe('loginGithub', () => {
  let store: Store;
  let restore: () => void;

  beforeEach(() => {
    store = new Map();
    Bun.env.AIDE_SECRET_SERVICE_OVERRIDE = 'aide';
    restore = installMockSecrets(store);
  });

  afterEach(() => restore());

  test('no-op when gh CLI is available', async () => {
    const p = new ScriptedPrompter([]);
    const result = await loginGithub(
      { token: 'should-be-ignored' },
      { prompter: p, ghAvailable: () => true }
    );
    expect(result).toBe('gh-cli');
    expect(store.has('aide:github')).toBe(false);
  });

  test('stores token when gh CLI is missing', async () => {
    const p = new ScriptedPrompter(['ghp_xxx']);
    const result = await loginGithub(
      {},
      { prompter: p, ghAvailable: () => false }
    );
    expect(result).toBe('stored');
    const stored = JSON.parse(store.get('aide:github') ?? '{}');
    expect(stored.token).toBe('ghp_xxx');
  });
});

describe('login --from-env', () => {
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

  test('loginJira --from-env writes env vars to keyring', async () => {
    Bun.env.JIRA_URL = 'https://x.atlassian.net';
    Bun.env.JIRA_EMAIL = 'a@b.c';
    Bun.env.JIRA_API_TOKEN = 'tkn';
    await loginJira({ fromEnv: true });
    const stored = JSON.parse(store.get('aide:jira') ?? '{}');
    expect(stored.url).toBe('https://x.atlassian.net');
    expect(stored.email).toBe('a@b.c');
    expect(stored.apiToken).toBe('tkn');
  });

  test('loginJira --from-env success message lists env vars to unset', async () => {
    Bun.env.JIRA_URL = 'https://x.atlassian.net';
    Bun.env.JIRA_EMAIL = 'a@b.c';
    Bun.env.JIRA_API_TOKEN = 'tkn';
    await loginJira({ fromEnv: true });
    const output = logSpy.messages.join('\n');
    expect(output).toMatch(/JIRA_URL.*JIRA_EMAIL.*JIRA_API_TOKEN/);
    expect(output).toMatch(/Unset them/i);
  });

  test('loginJira --from-env hint uses whichever alias is set', async () => {
    Bun.env.JIRA_URL = 'https://x.atlassian.net';
    Bun.env.JIRA_USERNAME = 'user@b.c';
    Bun.env.JIRA_TOKEN = 'tkn';
    await loginJira({ fromEnv: true });
    const output = logSpy.messages.join('\n');
    expect(output).toContain('JIRA_USERNAME');
    expect(output).toContain('JIRA_TOKEN');
    expect(output).not.toContain('JIRA_EMAIL,');
    expect(output).not.toContain('JIRA_API_TOKEN,');
  });

  test('loginGithub --from-env hint names GITHUB_TOKEN when that alias is set', async () => {
    Bun.env.GITHUB_TOKEN = 'ghp_xxx';
    await loginGithub({ fromEnv: true }, { ghAvailable: () => false });
    const output = logSpy.messages.join('\n');
    expect(output).toContain('GITHUB_TOKEN');
    expect(output).toMatch(/Unset it/i);
  });

  test('loginGithub --from-env hint names GH_TOKEN when that alias is set', async () => {
    Bun.env.GH_TOKEN = 'ghp_yyy';
    await loginGithub({ fromEnv: true }, { ghAvailable: () => false });
    const output = logSpy.messages.join('\n');
    expect(output).toContain('GH_TOKEN');
    expect(output).not.toContain('GITHUB_TOKEN');
  });

  test('loginJira --from-env accepts JIRA_USERNAME / JIRA_TOKEN aliases', async () => {
    Bun.env.JIRA_URL = 'https://x.atlassian.net';
    Bun.env.JIRA_USERNAME = 'user@b.c';
    Bun.env.JIRA_TOKEN = 'tkn';
    await loginJira({ fromEnv: true });
    const stored = JSON.parse(store.get('aide:jira') ?? '{}');
    expect(stored.email).toBe('user@b.c');
    expect(stored.apiToken).toBe('tkn');
  });

  test('loginJira --from-env lists missing vars when env is incomplete', async () => {
    Bun.env.JIRA_URL = 'https://x.atlassian.net';
    await expect(loginJira({ fromEnv: true })).rejects.toThrow(
      /JIRA_EMAIL.*JIRA_API_TOKEN/
    );
    expect(store.has('aide:jira')).toBe(false);
  });

  test('loginJira --from-env reports invalid env values', async () => {
    Bun.env.JIRA_URL = 'not-a-url';
    Bun.env.JIRA_EMAIL = 'a@b.c';
    Bun.env.JIRA_API_TOKEN = 'tkn';
    await expect(loginJira({ fromEnv: true })).rejects.toThrow(/URL/);
  });

  test('loginAdo --from-env writes env vars to keyring', async () => {
    Bun.env.AZURE_DEVOPS_ORG_URL = 'https://dev.azure.com/org';
    Bun.env.AZURE_DEVOPS_PAT = 'pat';
    await loginAdo({ fromEnv: true });
    const stored = JSON.parse(store.get('aide:ado') ?? '{}');
    expect(stored.orgUrl).toBe('https://dev.azure.com/org');
    expect(stored.pat).toBe('pat');
    expect(stored.authMethod).toBe('pat');
  });

  test('loginAdo --from-env respects AZURE_DEVOPS_AUTH_METHOD', async () => {
    Bun.env.AZURE_DEVOPS_ORG_URL = 'https://dev.azure.com/org';
    Bun.env.AZURE_DEVOPS_PAT = 'pat';
    Bun.env.AZURE_DEVOPS_AUTH_METHOD = 'bearer';
    await loginAdo({ fromEnv: true });
    const stored = JSON.parse(store.get('aide:ado') ?? '{}');
    expect(stored.authMethod).toBe('bearer');
  });

  test('loginAdo --from-env lists missing vars', async () => {
    await expect(loginAdo({ fromEnv: true })).rejects.toThrow(
      /AZURE_DEVOPS_ORG_URL.*AZURE_DEVOPS_PAT/
    );
  });

  test('loginGithub --from-env writes GITHUB_TOKEN to keyring even when gh-cli is available', async () => {
    Bun.env.GITHUB_TOKEN = 'ghp_xxx';
    const result = await loginGithub(
      { fromEnv: true },
      { ghAvailable: () => true }
    );
    expect(result).toBe('stored');
    const stored = JSON.parse(store.get('aide:github') ?? '{}');
    expect(stored.token).toBe('ghp_xxx');
  });

  test('loginGithub --from-env accepts GH_TOKEN alias', async () => {
    Bun.env.GH_TOKEN = 'ghp_yyy';
    await loginGithub({ fromEnv: true }, { ghAvailable: () => false });
    const stored = JSON.parse(store.get('aide:github') ?? '{}');
    expect(stored.token).toBe('ghp_yyy');
  });

  test('loginGithub --from-env errors when no token is in env', async () => {
    await expect(
      loginGithub({ fromEnv: true }, { ghAvailable: () => false })
    ).rejects.toThrow(/GITHUB_TOKEN/);
  });
});
