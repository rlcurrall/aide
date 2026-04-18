/**
 * Tests for config.ts loaders.
 *
 * Each test scopes env-var mutation and Bun.secrets mocking to the test,
 * restoring both afterward. Source reporting is part of the contract because
 * `aide whoami` depends on it.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';

import { loadConfig, loadAzureDevOpsConfig } from './config.js';
import { installMockSecrets, type Store } from './test-helpers.js';

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

function saveEnv(keys: string[]): Map<string, string | undefined> {
  const snap = new Map<string, string | undefined>();
  for (const k of keys) {
    snap.set(k, Bun.env[k]);
    delete Bun.env[k];
  }
  return snap;
}

function restoreEnv(snap: Map<string, string | undefined>) {
  for (const [k, v] of snap) {
    if (v === undefined) delete Bun.env[k];
    else Bun.env[k] = v;
  }
}

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
      JSON.stringify({ url: 'https://k.atlassian.net', email: 'k@k.k', apiToken: 'k' })
    );
    const { source } = await loadConfig();
    expect(source).toBe('keyring');
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
    const { config, source } = await loadAzureDevOpsConfig();
    expect(source).toBe('env');
    expect(config.orgUrl).toBe('https://dev.azure.com/x');
    expect(config.authMethod).toBe('pat');
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
      await expect(loadAzureDevOpsConfig()).rejects.toThrow(/keyring is unreachable/i);
    } finally {
      localRestore();
    }
  });
});
