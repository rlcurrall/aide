import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { getWhoamiStatus, type WhoamiStatus } from './whoami.js';
import { installMockSecrets, type Store } from '@lib/test-helpers.js';

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

describe('getWhoamiStatus', () => {
  let snap: Map<string, string | undefined>;
  let store: Store;
  let restoreSecrets: () => void;

  beforeEach(() => {
    snap = saveEnv([...JIRA_VARS, ...ADO_VARS, ...GITHUB_VARS]);
    store = new Map();
    delete Bun.env.AIDE_SECRET_SERVICE_OVERRIDE;
    restoreSecrets = installMockSecrets(store);
  });

  afterEach(() => {
    restoreEnv(snap);
    restoreSecrets();
  });

  test('reports not-configured for all when nothing is set', async () => {
    const statuses = await getWhoamiStatus({ ghAvailable: () => false });
    const jira = statuses.find((s) => s.service === 'jira') as WhoamiStatus;
    expect(jira.source).toBe('not-configured');
  });

  test('reports env source for jira when env vars are set', async () => {
    Bun.env.JIRA_URL = 'https://x.atlassian.net';
    Bun.env.JIRA_EMAIL = 'a@b.c';
    Bun.env.JIRA_API_TOKEN = 'tkn';
    const statuses = await getWhoamiStatus({ ghAvailable: () => false });
    const jira = statuses.find((s) => s.service === 'jira') as WhoamiStatus;
    expect(jira.source).toBe('env');
    expect(jira.identity).toBe('a@b.c at https://x.atlassian.net');
  });

  test('reports keyring source for ado when only keyring is set', async () => {
    store.set(
      'aide:ado',
      JSON.stringify({
        orgUrl: 'https://dev.azure.com/org',
        pat: 't',
        authMethod: 'pat',
      })
    );
    const statuses = await getWhoamiStatus({ ghAvailable: () => false });
    const ado = statuses.find((s) => s.service === 'ado') as WhoamiStatus;
    expect(ado.source).toBe('keyring');
    expect(ado.identity).toContain('https://dev.azure.com/org');
    expect(ado.identity).toContain('pat');
  });

  test('reports gh-cli when gh is available', async () => {
    const statuses = await getWhoamiStatus({ ghAvailable: () => true });
    const gh = statuses.find((s) => s.service === 'github') as WhoamiStatus;
    expect(gh.source).toBe('gh-cli');
  });

  test('reports env for github when GITHUB_TOKEN is set and gh is absent', async () => {
    Bun.env.GITHUB_TOKEN = 'ghp_xxx';
    const statuses = await getWhoamiStatus({ ghAvailable: () => false });
    const gh = statuses.find((s) => s.service === 'github') as WhoamiStatus;
    expect(gh.source).toBe('env');
  });

  test('reports keyring for github when keyring is set and gh/env are absent', async () => {
    store.set('aide:github', JSON.stringify({ token: 'ghp_x' }));
    const statuses = await getWhoamiStatus({ ghAvailable: () => false });
    const gh = statuses.find((s) => s.service === 'github') as WhoamiStatus;
    expect(gh.source).toBe('keyring');
  });

  test('redacts userinfo from stored ADO org URL', async () => {
    store.set(
      'aide:ado',
      JSON.stringify({
        orgUrl: 'https://user:pass@dev.azure.com/org',
        pat: 't',
        authMethod: 'pat',
      })
    );
    const statuses = await getWhoamiStatus({ ghAvailable: () => false });
    const ado = statuses.find((s) => s.service === 'ado') as WhoamiStatus;
    expect(ado.identity).toBeTruthy();
    expect(ado.identity).not.toContain('user:pass');
    expect(ado.identity).toContain('dev.azure.com/org');
  });

  test('never returns a token or pat in identity', async () => {
    Bun.env.JIRA_URL = 'https://x.atlassian.net';
    Bun.env.JIRA_EMAIL = 'a@b.c';
    Bun.env.JIRA_API_TOKEN = 'super-secret-token';
    const statuses = await getWhoamiStatus({ ghAvailable: () => false });
    for (const s of statuses) {
      expect(s.identity ?? '').not.toContain('super-secret-token');
    }
  });
});
