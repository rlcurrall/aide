/**
 * Tests for config.ts loaders and probes.
 *
 * Each test scopes env-var mutation and Bun.secrets mocking to the test,
 * restoring both afterward. Source reporting is part of the contract because
 * `aide whoami` depends on it.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';

import {
  loadConfig,
  loadAzureDevOpsConfig,
  probeJiraConfig,
  probeAdoConfig,
  probeGithubConfig,
} from './config.js';
import {
  installMockSecrets,
  saveEnv,
  restoreEnv,
  type Store,
} from './test-helpers.js';

const JIRA_VARS = [
  'JIRA_URL',
  'JIRA_EMAIL',
  'JIRA_USERNAME',
  'JIRA_API_TOKEN',
  'JIRA_TOKEN',
  'JIRA_DEFAULT_PROJECT',
];
const ADO_VARS = [
  'AZURE_DEVOPS_ORG_URL',
  'AZURE_DEVOPS_PAT',
  'AZURE_DEVOPS_AUTH_METHOD',
  'AZURE_DEVOPS_DEFAULT_PROJECT',
];
const GITHUB_VARS = ['GITHUB_TOKEN', 'GH_TOKEN'];

describe('loadConfig (Jira)', () => {
  let snap: Map<string, string | undefined>;
  let store: Store;
  let restoreSecrets: () => void;

  beforeEach(() => {
    snap = saveEnv(JIRA_VARS);
    store = new Map();
    Bun.env.AIDE_SECRET_SERVICE_OVERRIDE = 'aide';
    restoreSecrets = installMockSecrets(store);
  });

  afterEach(() => {
    restoreEnv(snap);
    restoreSecrets();
  });

  test('uses env vars when full set is present', async () => {
    Bun.env.JIRA_URL = 'https://x.atlassian.net';
    Bun.env.JIRA_EMAIL = 'a@b.c';
    Bun.env.JIRA_API_TOKEN = 'tkn';
    const { config, source } = await loadConfig();
    expect(source).toBe('env');
    expect(config.url).toBe('https://x.atlassian.net');
    expect(config.email).toBe('a@b.c');
    expect(config.apiToken).toBe('tkn');
  });

  test('falls through to keyring when env is partial', async () => {
    Bun.env.JIRA_URL = 'https://ignored';
    store.set(
      'aide:jira',
      JSON.stringify({
        url: 'https://kept.atlassian.net',
        email: 'k@k.k',
        apiToken: 'k',
      })
    );
    const { config, source } = await loadConfig();
    expect(source).toBe('keyring');
    expect(config.url).toBe('https://kept.atlassian.net');
  });

  test('uses keyring when env is empty', async () => {
    store.set(
      'aide:jira',
      JSON.stringify({
        url: 'https://k.atlassian.net',
        email: 'k@k.k',
        apiToken: 'k',
      })
    );
    const { source } = await loadConfig();
    expect(source).toBe('keyring');
  });

  test('uses matching Jira env credentials for an explicit scope', async () => {
    Bun.env.JIRA_URL = 'https://EXAMPLE.atlassian.net/path';
    Bun.env.JIRA_EMAIL = 'Dev@Example.com';
    Bun.env.JIRA_API_TOKEN = 'env-token';
    store.set(
      'aide:auth:jira:host:example.atlassian.net:account:dev%40example.com',
      '{malformed scoped credentials'
    );

    const loaded = await loadConfig({
      providerId: 'jira',
      host: 'example.atlassian.net',
      account: 'dev@example.com',
    });

    expect(loaded.source).toBe('env');
    expect(loaded.config.apiToken).toBe('env-token');
  });

  test('uses the selected scoped key and ignores mismatching Jira env identity', async () => {
    Bun.env.JIRA_URL = 'https://other.atlassian.net';
    Bun.env.JIRA_EMAIL = 'other@example.com';
    Bun.env.JIRA_API_TOKEN = 'env-token';
    store.set(
      'aide:auth:jira:host:example.atlassian.net:account:dev%40example.com',
      JSON.stringify({
        url: 'https://example.atlassian.net',
        email: 'Dev@Example.com',
        apiToken: 'scoped-token',
      })
    );
    store.set(
      'aide:jira',
      JSON.stringify({
        url: 'https://legacy.atlassian.net',
        email: 'legacy@example.com',
        apiToken: 'legacy-token',
      })
    );

    const loaded = await loadConfig({
      providerId: 'jira',
      host: 'EXAMPLE.ATLASSIAN.NET',
      account: 'dev@example.com',
    });

    expect(loaded.source).toBe('keyring');
    expect(loaded.config).toMatchObject({
      url: 'https://example.atlassian.net',
      email: 'Dev@Example.com',
      apiToken: 'scoped-token',
    });
  });

  test('ignores malformed unrelated Jira env and uses the selected scoped key', async () => {
    Bun.env.JIRA_URL = 'not-a-url';
    Bun.env.JIRA_EMAIL = 'other@example.com';
    Bun.env.JIRA_API_TOKEN = 'env-token';
    store.set(
      'aide:auth:jira:host:example.atlassian.net:account:dev%40example.com',
      JSON.stringify({
        url: 'https://example.atlassian.net',
        email: 'dev@example.com',
        apiToken: 'scoped-token',
      })
    );

    const loaded = await loadConfig({
      providerId: 'jira',
      host: 'example.atlassian.net',
      account: 'dev@example.com',
    });

    expect(loaded.source).toBe('keyring');
    expect(loaded.config.apiToken).toBe('scoped-token');
  });

  test('rejects a parsed scoped Jira payload with a mismatching identity without using legacy', async () => {
    store.set(
      'aide:auth:jira:host:example.atlassian.net:account:dev%40example.com',
      JSON.stringify({
        url: 'https://other.atlassian.net',
        email: 'other@example.com',
        apiToken: 'wrong-scoped-token',
      })
    );
    store.set(
      'aide:jira',
      JSON.stringify({
        url: 'https://example.atlassian.net',
        email: 'dev@example.com',
        apiToken: 'legacy-token',
      })
    );

    await expect(
      loadConfig({
        providerId: 'jira',
        host: 'example.atlassian.net',
        account: 'dev@example.com',
      })
    ).rejects.toThrow(/does not match.*scope/i);
  });

  test('does not read legacy Jira credentials when a selected scoped key is missing', async () => {
    store.set(
      'aide:jira',
      JSON.stringify({
        url: 'https://legacy.atlassian.net',
        email: 'legacy@example.com',
        apiToken: 'legacy-token',
      })
    );

    await expect(
      loadConfig({
        providerId: 'jira',
        host: 'example.atlassian.net',
        account: 'dev@example.com',
      })
    ).rejects.toThrow(/not configured/i);
  });

  test('throws when neither env nor keyring is configured', async () => {
    await expect(loadConfig()).rejects.toThrow(/not configured/i);
  });

  test('throws with descriptive message when keyring JSON is malformed', async () => {
    store.set('aide:jira', '{not json');
    await expect(loadConfig()).rejects.toThrow(/aide login jira/i);
  });

  test('throws with descriptive message when keyring JSON fails schema', async () => {
    store.set('aide:jira', JSON.stringify({ url: 'not a url' }));
    await expect(loadConfig()).rejects.toThrow(/aide login jira/i);
  });

  test('throws "keyring unreachable" error when secret-service is unavailable', async () => {
    restoreSecrets(); // remove the default mock first
    const localRestore = installMockSecrets(store, 'get');
    try {
      await expect(loadConfig()).rejects.toThrow(/keyring is unreachable/i);
    } finally {
      localRestore();
    }
  });
});

describe('loadAzureDevOpsConfig', () => {
  let snap: Map<string, string | undefined>;
  let store: Store;
  let restoreSecrets: () => void;

  beforeEach(() => {
    snap = saveEnv(ADO_VARS);
    store = new Map();
    Bun.env.AIDE_SECRET_SERVICE_OVERRIDE = 'aide';
    restoreSecrets = installMockSecrets(store);
  });

  afterEach(() => {
    restoreEnv(snap);
    restoreSecrets();
  });

  test('uses env vars when full set is present', async () => {
    Bun.env.AZURE_DEVOPS_ORG_URL = 'https://dev.azure.com/x';
    Bun.env.AZURE_DEVOPS_PAT = 'pat';
    store.set(
      'aide:auth:azure-devops:host:dev.azure.com:org:x',
      '{malformed scoped credentials'
    );
    const { config, source } = await loadAzureDevOpsConfig({
      providerId: 'azure-devops',
      host: 'dev.azure.com',
      org: 'x',
    });
    expect(source).toBe('env');
    expect(config.orgUrl).toBe('https://dev.azure.com/x');
    expect(config.authMethod).toBe('pat');
  });

  test('uses the selected scoped key and ignores mismatching Azure DevOps env identity', async () => {
    Bun.env.AZURE_DEVOPS_ORG_URL = 'https://dev.azure.com/other';
    Bun.env.AZURE_DEVOPS_PAT = 'env-token';
    store.set(
      'aide:auth:azure-devops:host:dev.azure.com:org:acme',
      JSON.stringify({
        orgUrl: 'https://dev.azure.com/acme',
        pat: 'scoped-token',
        authMethod: 'pat',
      })
    );
    store.set(
      'aide:ado',
      JSON.stringify({
        orgUrl: 'https://dev.azure.com/acme',
        pat: 'legacy-token',
        authMethod: 'pat',
      })
    );

    const loaded = await loadAzureDevOpsConfig({
      providerId: 'azure-devops',
      host: 'dev.azure.com',
      org: 'acme',
    });

    expect(loaded.source).toBe('keyring');
    expect(loaded.config.pat).toBe('scoped-token');
  });

  test('falls through to keyring when env is partial', async () => {
    Bun.env.AZURE_DEVOPS_ORG_URL = 'https://ignored';
    store.set(
      'aide:ado',
      JSON.stringify({
        orgUrl: 'https://dev.azure.com/kept',
        pat: 'k',
        authMethod: 'bearer',
      })
    );
    const { config, source } = await loadAzureDevOpsConfig();
    expect(source).toBe('keyring');
    expect(config.orgUrl).toBe('https://dev.azure.com/kept');
    expect(config.authMethod).toBe('bearer');
  });

  test('uses the exact scoped keyring credential when legacy is also populated', async () => {
    store.set(
      'aide:auth:azure-devops:host:dev.azure.com:org:acme',
      JSON.stringify({
        orgUrl: 'https://dev.azure.com/acme',
        pat: 'scoped-token',
        authMethod: 'pat',
      })
    );
    store.set(
      'aide:ado',
      JSON.stringify({
        orgUrl: 'https://dev.azure.com/legacy',
        pat: 'legacy-token',
        authMethod: 'bearer',
      })
    );

    const { config, source } = await loadAzureDevOpsConfig({
      providerId: 'azure-devops',
      host: 'dev.azure.com',
      org: 'acme',
    });

    expect(source).toBe('keyring');
    expect(config).toMatchObject({
      orgUrl: 'https://dev.azure.com/acme',
      pat: 'scoped-token',
      authMethod: 'pat',
    });
  });

  test('does not read the legacy key when scoped credentials are missing', async () => {
    store.set(
      'aide:ado',
      JSON.stringify({
        orgUrl: 'https://dev.azure.com/acme',
        pat: 'legacy-token',
        authMethod: 'pat',
      })
    );

    await expect(
      loadAzureDevOpsConfig({
        providerId: 'azure-devops',
        host: 'dev.azure.com',
        org: 'acme',
      })
    ).rejects.toThrow(/not configured/i);
  });

  test('does not fall back when scoped credentials are malformed', async () => {
    store.set(
      'aide:auth:azure-devops:host:dev.azure.com:org:acme',
      '{not json'
    );
    store.set(
      'aide:ado',
      JSON.stringify({
        orgUrl: 'https://dev.azure.com/acme',
        pat: 'legacy-token',
        authMethod: 'pat',
      })
    );

    await expect(
      loadAzureDevOpsConfig({
        providerId: 'azure-devops',
        host: 'dev.azure.com',
        org: 'acme',
      })
    ).rejects.toThrow(/aide login ado/i);
  });

  test('rejects a parsed scoped Azure DevOps payload with a mismatching identity without using legacy', async () => {
    store.set(
      'aide:auth:azure-devops:host:dev.azure.com:org:acme',
      JSON.stringify({
        orgUrl: 'https://dev.azure.com/other',
        pat: 'wrong-scoped-token',
        authMethod: 'pat',
      })
    );
    store.set(
      'aide:ado',
      JSON.stringify({
        orgUrl: 'https://dev.azure.com/acme',
        pat: 'legacy-token',
        authMethod: 'pat',
      })
    );

    await expect(
      loadAzureDevOpsConfig({
        providerId: 'azure-devops',
        host: 'dev.azure.com',
        org: 'acme',
      })
    ).rejects.toThrow(/does not match.*scope/i);
  });

  test('throws when neither is configured', async () => {
    await expect(loadAzureDevOpsConfig()).rejects.toThrow(/not configured/i);
  });

  test('throws with descriptive message when ADO keyring JSON is malformed', async () => {
    store.set('aide:ado', '{not json');
    await expect(loadAzureDevOpsConfig()).rejects.toThrow(/aide login ado/i);
  });

  test('throws with descriptive message when ADO keyring JSON fails schema', async () => {
    store.set('aide:ado', JSON.stringify({ orgUrl: 'not a url' }));
    await expect(loadAzureDevOpsConfig()).rejects.toThrow(/aide login ado/i);
  });

  test('throws "keyring unreachable" when ADO env is missing and keyring backend fails', async () => {
    restoreSecrets(); // tear down the default mock that was installed in beforeEach
    const localRestore = installMockSecrets(store, 'get');
    try {
      await expect(loadAzureDevOpsConfig()).rejects.toThrow(
        /keyring is unreachable/i
      );
    } finally {
      localRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Probe tests
// ---------------------------------------------------------------------------

describe('probeJiraConfig', () => {
  let snap: Map<string, string | undefined>;
  let store: Store;
  let restoreSecrets: () => void;

  beforeEach(() => {
    snap = saveEnv(JIRA_VARS);
    store = new Map();
    Bun.env.AIDE_SECRET_SERVICE_OVERRIDE = 'aide';
    restoreSecrets = installMockSecrets(store);
  });

  afterEach(() => {
    restoreEnv(snap);
    restoreSecrets();
  });

  test('returns env kind when env vars are set', async () => {
    Bun.env.JIRA_URL = 'https://x.atlassian.net';
    Bun.env.JIRA_EMAIL = 'a@b.c';
    Bun.env.JIRA_API_TOKEN = 'tkn';
    const status = await probeJiraConfig();
    expect(status.kind).toBe('env');
    if (status.kind === 'env') {
      expect(status.value.url).toBe('https://x.atlassian.net');
      expect(status.value.email).toBe('a@b.c');
    }
  });

  test('returns keyring kind when only keyring has credentials', async () => {
    store.set(
      'aide:jira',
      JSON.stringify({
        url: 'https://k.atlassian.net',
        email: 'k@k.k',
        apiToken: 'k',
      })
    );
    const status = await probeJiraConfig();
    expect(status.kind).toBe('keyring');
    if (status.kind === 'keyring') {
      expect(status.value.url).toBe('https://k.atlassian.net');
    }
  });

  test('returns missing when nothing is configured', async () => {
    const status = await probeJiraConfig();
    expect(status.kind).toBe('missing');
  });

  test('returns unreachable when keyring daemon is down', async () => {
    restoreSecrets();
    restoreSecrets = installMockSecrets(store, 'get');
    const status = await probeJiraConfig();
    expect(status.kind).toBe('unreachable');
  });

  test('returns malformed for bad keyring JSON', async () => {
    store.set('aide:jira', '{not json');
    const status = await probeJiraConfig();
    expect(status.kind).toBe('malformed');
    if (status.kind === 'malformed') {
      expect(status.reason).toMatch(/aide login jira/i);
    }
  });

  test('returns malformed when stored blob fails schema', async () => {
    store.set('aide:jira', JSON.stringify({ url: 'not-a-url' }));
    const status = await probeJiraConfig();
    expect(status.kind).toBe('malformed');
    if (status.kind === 'malformed') {
      expect(status.reason).toMatch(/aide login jira/i);
    }
  });

  test('returns malformed when env URL is invalid', async () => {
    Bun.env.JIRA_URL = 'not-a-url';
    Bun.env.JIRA_EMAIL = 'a@b.c';
    Bun.env.JIRA_API_TOKEN = 'tkn';
    const status = await probeJiraConfig();
    expect(status.kind).toBe('malformed');
    if (status.kind === 'malformed') {
      expect(status.reason).toMatch(/Invalid Jira environment variables/i);
    }
  });
});

describe('probeAdoConfig', () => {
  let snap: Map<string, string | undefined>;
  let store: Store;
  let restoreSecrets: () => void;

  beforeEach(() => {
    snap = saveEnv(ADO_VARS);
    store = new Map();
    Bun.env.AIDE_SECRET_SERVICE_OVERRIDE = 'aide';
    restoreSecrets = installMockSecrets(store);
  });

  afterEach(() => {
    restoreEnv(snap);
    restoreSecrets();
  });

  test('returns env kind when env vars are set', async () => {
    Bun.env.AZURE_DEVOPS_ORG_URL = 'https://dev.azure.com/x';
    Bun.env.AZURE_DEVOPS_PAT = 'pat';
    const status = await probeAdoConfig();
    expect(status.kind).toBe('env');
    if (status.kind === 'env') {
      expect(status.value.orgUrl).toBe('https://dev.azure.com/x');
    }
  });

  test('returns keyring kind when only keyring has credentials', async () => {
    store.set(
      'aide:ado',
      JSON.stringify({
        orgUrl: 'https://dev.azure.com/org',
        pat: 't',
        authMethod: 'pat',
      })
    );
    const status = await probeAdoConfig();
    expect(status.kind).toBe('keyring');
  });

  test('returns missing when nothing is configured', async () => {
    const status = await probeAdoConfig();
    expect(status.kind).toBe('missing');
  });

  test('returns unreachable when keyring daemon is down', async () => {
    restoreSecrets();
    restoreSecrets = installMockSecrets(store, 'get');
    const status = await probeAdoConfig();
    expect(status.kind).toBe('unreachable');
  });

  test('returns malformed when stored blob fails schema', async () => {
    store.set('aide:ado', JSON.stringify({ orgUrl: 'not-a-url' }));
    const status = await probeAdoConfig();
    expect(status.kind).toBe('malformed');
    if (status.kind === 'malformed') {
      expect(status.reason).toMatch(/aide login ado/i);
    }
  });
});

describe('probeGithubConfig', () => {
  let snap: Map<string, string | undefined>;
  let store: Store;
  let restoreSecrets: () => void;

  beforeEach(() => {
    snap = saveEnv(GITHUB_VARS);
    store = new Map();
    Bun.env.AIDE_SECRET_SERVICE_OVERRIDE = 'aide';
    restoreSecrets = installMockSecrets(store);
  });

  afterEach(() => {
    restoreEnv(snap);
    restoreSecrets();
  });

  test('returns env/gh-cli when gh CLI is available', async () => {
    const status = await probeGithubConfig({ ghAvailable: () => true });
    expect(status.kind).toBe('env');
    if (status.kind === 'env') {
      expect(status.value.source).toBe('gh-cli');
    }
  });

  test('gh-cli takes precedence over GITHUB_TOKEN', async () => {
    Bun.env.GITHUB_TOKEN = 'ghp_xxx';
    const status = await probeGithubConfig({ ghAvailable: () => true });
    expect(status.kind).toBe('env');
    if (status.kind === 'env') {
      expect(status.value.source).toBe('gh-cli');
    }
  });

  test('returns env/env when GITHUB_TOKEN is set and gh is absent', async () => {
    Bun.env.GITHUB_TOKEN = 'ghp_xxx';
    const status = await probeGithubConfig({ ghAvailable: () => false });
    expect(status.kind).toBe('env');
    if (status.kind === 'env') {
      expect(status.value.source).toBe('env');
    }
  });

  test('returns keyring when stored token is present', async () => {
    store.set('aide:github', JSON.stringify({ token: 'ghp_stored' }));
    const status = await probeGithubConfig({ ghAvailable: () => false });
    expect(status.kind).toBe('keyring');
  });

  test('returns missing when nothing is configured', async () => {
    const status = await probeGithubConfig({ ghAvailable: () => false });
    expect(status.kind).toBe('missing');
  });

  test('returns unreachable when keyring daemon is down', async () => {
    restoreSecrets();
    restoreSecrets = installMockSecrets(store, 'get');
    const status = await probeGithubConfig({ ghAvailable: () => false });
    expect(status.kind).toBe('unreachable');
  });

  test('returns malformed when stored blob fails schema', async () => {
    store.set('aide:github', JSON.stringify({ wrongField: 'x' }));
    const status = await probeGithubConfig({ ghAvailable: () => false });
    expect(status.kind).toBe('malformed');
    if (status.kind === 'malformed') {
      expect(status.reason).toMatch(/aide login github/i);
    }
  });
});
