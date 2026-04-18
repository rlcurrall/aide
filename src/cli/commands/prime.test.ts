/**
 * Tests for the `prime` command's configuration detection.
 *
 * `buildPrimeOutput` is the seam: it reads env vars + keyring and returns
 * the text that would be printed. We assert on the "Configuration Status"
 * section to verify the matrix of env + keyring + gh states.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';

import { buildPrimeOutput } from './prime.js';
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
const ADO_VARS = ['AZURE_DEVOPS_ORG_URL', 'AZURE_DEVOPS_PAT'];
const GH_VARS = ['GITHUB_TOKEN', 'GH_TOKEN'];

describe('buildPrimeOutput', () => {
  let snap: Map<string, string | undefined>;
  let store: Store;
  let restore: () => void;

  beforeEach(() => {
    snap = saveEnv([...JIRA_VARS, ...ADO_VARS, ...GH_VARS]);
    Bun.env.AIDE_SECRET_SERVICE_OVERRIDE = 'aide';
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
      JSON.stringify({
        url: 'https://x.atlassian.net',
        email: 'a@b.c',
        apiToken: 't',
      })
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

  test('reports Jira misconfigured when stored blob fails schema', async () => {
    store.set('aide:jira', JSON.stringify({ url: 'not-a-url' }));
    const output = await buildPrimeOutput({ ghAvailable: () => false });
    expect(output).toMatch(/Jira: Misconfigured/i);
    expect(output).not.toMatch(/Jira: Configured$/m);
  });

  test('reports PR misconfigured when stored github token blob fails schema', async () => {
    store.set('aide:github', JSON.stringify({ wrongField: 'x' }));
    const output = await buildPrimeOutput({ ghAvailable: () => false });
    expect(output).toMatch(/Pull Requests: Misconfigured/i);
  });

  test('still omits status section when everything is configured via env', async () => {
    Bun.env.JIRA_URL = 'https://x.atlassian.net';
    Bun.env.JIRA_EMAIL = 'a@b.c';
    Bun.env.JIRA_API_TOKEN = 't';
    Bun.env.AZURE_DEVOPS_ORG_URL = 'https://dev.azure.com/x';
    Bun.env.AZURE_DEVOPS_PAT = 'p';
    const output = await buildPrimeOutput({ ghAvailable: () => false });
    expect(output).not.toContain('Configuration Status');
  });

  test('reports services as not configured when keyring is unreachable', async () => {
    // Replace the mock with one that throws on get
    restore();
    restore = installMockSecrets(store, 'get');
    const output = await buildPrimeOutput({ ghAvailable: () => false });
    expect(output).toMatch(/Jira: Not configured/i);
    expect(output).toMatch(/Pull Requests: Not configured/i);
  });

  test('reports Jira configured when JIRA_USERNAME is set instead of JIRA_EMAIL', async () => {
    Bun.env.JIRA_URL = 'https://x.atlassian.net';
    Bun.env.JIRA_USERNAME = 'user';
    Bun.env.JIRA_API_TOKEN = 't';
    const output = await buildPrimeOutput({ ghAvailable: () => false });
    expect(output).toMatch(/Jira: Configured/i);
  });

  test('reports Jira configured when JIRA_TOKEN is set instead of JIRA_API_TOKEN', async () => {
    Bun.env.JIRA_URL = 'https://x.atlassian.net';
    Bun.env.JIRA_EMAIL = 'a@b.c';
    Bun.env.JIRA_TOKEN = 't';
    const output = await buildPrimeOutput({ ghAvailable: () => false });
    expect(output).toMatch(/Jira: Configured/i);
  });

  test('emits partial status section when Jira is configured but PR is not', async () => {
    Bun.env.JIRA_URL = 'https://x.atlassian.net';
    Bun.env.JIRA_EMAIL = 'a@b.c';
    Bun.env.JIRA_API_TOKEN = 't';
    const output = await buildPrimeOutput({ ghAvailable: () => false });
    expect(output).toContain('Configuration Status');
    expect(output).toMatch(/Jira: Configured/i);
    expect(output).toMatch(/Pull Requests: Not configured/i);
  });

  test('emits partial status section when PR via gh is configured but Jira is not', async () => {
    const output = await buildPrimeOutput({ ghAvailable: () => true });
    expect(output).toContain('Configuration Status');
    expect(output).toMatch(/Jira: Not configured/i);
    expect(output).toMatch(/Pull Requests: Configured/i);
  });

  test('reports PR configured when GITHUB_TOKEN is set', async () => {
    Bun.env.GITHUB_TOKEN = 'ghp_xxx';
    const output = await buildPrimeOutput({ ghAvailable: () => false });
    expect(output).toMatch(/Pull Requests: Configured/i);
  });

  test('reports PR configured when GH_TOKEN is set', async () => {
    Bun.env.GH_TOKEN = 'ghp_xxx';
    const output = await buildPrimeOutput({ ghAvailable: () => false });
    expect(output).toMatch(/Pull Requests: Configured/i);
  });
});
