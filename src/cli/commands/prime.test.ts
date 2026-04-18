/**
 * Tests for the `prime` command's configuration detection.
 *
 * `buildPrimeOutput` is the seam: it reads env vars + keyring and returns
 * the text that would be printed. We assert on the "Configuration Status"
 * section to verify the matrix of env + keyring + gh states.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';

import { buildPrimeOutput } from './prime.js';
import { installMockSecrets, type Store } from '@lib/test-helpers.js';

const JIRA_VARS = ['JIRA_URL', 'JIRA_EMAIL', 'JIRA_USERNAME', 'JIRA_API_TOKEN', 'JIRA_TOKEN'];
const ADO_VARS = ['AZURE_DEVOPS_ORG_URL', 'AZURE_DEVOPS_PAT'];
const GH_VARS = ['GITHUB_TOKEN', 'GH_TOKEN'];

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

describe('buildPrimeOutput', () => {
  let snap: Map<string, string | undefined>;
  let store: Store;
  let restore: () => void;

  beforeEach(() => {
    snap = saveEnv([...JIRA_VARS, ...ADO_VARS, ...GH_VARS]);
    delete Bun.env.AIDE_SECRET_SERVICE_OVERRIDE;
    store = new Map();
    restore = installMockSecrets(store);
  });

  afterEach(() => {
    restoreEnv(snap);
    restore();
  });

  test('reports Jira not configured when neither env nor keyring has credentials', async () => {
    const output = await buildPrimeOutput({ ghAvailable: () => false });
    expect(output).toMatch(/Jira: Not configured/i);
  });

  test('reports Jira configured when env vars are set', async () => {
    Bun.env.JIRA_URL = 'https://x.atlassian.net';
    Bun.env.JIRA_EMAIL = 'a@b.c';
    Bun.env.JIRA_API_TOKEN = 't';
    const output = await buildPrimeOutput({ ghAvailable: () => false });
    expect(output).toMatch(/Jira: Configured/i);
  });

  test('reports Jira configured when only keyring has credentials', async () => {
    store.set(
      'aide:jira',
      JSON.stringify({ url: 'https://x.atlassian.net', email: 'a@b.c', apiToken: 't' })
    );
    const output = await buildPrimeOutput({ ghAvailable: () => false });
    expect(output).toMatch(/Jira: Configured/i);
  });

  test('omits the Configuration Status section when everything is configured', async () => {
    Bun.env.JIRA_URL = 'https://x.atlassian.net';
    Bun.env.JIRA_EMAIL = 'a@b.c';
    Bun.env.JIRA_API_TOKEN = 't';
    Bun.env.AZURE_DEVOPS_ORG_URL = 'https://dev.azure.com/x';
    Bun.env.AZURE_DEVOPS_PAT = 'p';
    const output = await buildPrimeOutput({ ghAvailable: () => false });
    expect(output).not.toContain('Configuration Status');
  });
});
