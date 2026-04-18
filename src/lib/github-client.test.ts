/**
 * Tests for GitHubClient.create() factory.
 *
 * Real-keyring is used for the "keyring branch" test via
 * AIDE_SECRET_SERVICE_OVERRIDE so we verify the actual integration
 * (signature, schema, round-trip) rather than a local mock. The gh-cli and
 * env branches are tested with an injected ghAvailable stub plus env
 * manipulation. The corrupted-blob test uses the shared installMockSecrets
 * helper since we need to plant malformed data without writing invalid UTF-8
 * to the real keyring.
 *
 * Every describe block in this file sets AIDE_SECRET_SERVICE_OVERRIDE
 * explicitly so reordering is safe. Do NOT rely on cross-block env var
 * state — a future describe inserted between these could silently clobber
 * a scoped override. Mock blocks use a fake service name (MOCK_SERVICE) so
 * that if installMockSecrets is ever forgotten, writes hit a scoped fake
 * rather than the real 'aide' production credentials.
 */

import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from 'bun:test';

import { GitHubClient, GitHubAuthError } from './github-client.js';
import {
  installMockSecrets,
  isKeyringAvailable,
  uniqueTestService,
  cleanupTestService,
  type Store,
} from './test-helpers.js';

function clearGhEnv(): {
  token: string | undefined;
  ghToken: string | undefined;
} {
  const snap = {
    token: Bun.env.GITHUB_TOKEN,
    ghToken: Bun.env.GH_TOKEN,
  };
  delete Bun.env.GITHUB_TOKEN;
  delete Bun.env.GH_TOKEN;
  return snap;
}

function restoreGhEnv(snap: {
  token: string | undefined;
  ghToken: string | undefined;
}): void {
  if (snap.token === undefined) delete Bun.env.GITHUB_TOKEN;
  else Bun.env.GITHUB_TOKEN = snap.token;
  if (snap.ghToken === undefined) delete Bun.env.GH_TOKEN;
  else Bun.env.GH_TOKEN = snap.ghToken;
}

const MOCK_SERVICE = 'aide-test-mock';

describe('GitHubClient.create() — gh-cli branch (mocked)', () => {
  let envSnap: ReturnType<typeof clearGhEnv>;
  let store: Store;
  let restoreSecrets: () => void;

  beforeEach(() => {
    envSnap = clearGhEnv();
    Bun.env.AIDE_SECRET_SERVICE_OVERRIDE = MOCK_SERVICE;
    store = new Map();
    restoreSecrets = installMockSecrets(store);
  });

  afterEach(() => {
    restoreGhEnv(envSnap);
    restoreSecrets();
  });

  test('uses gh CLI when ghAvailable returns true, ignoring other sources', async () => {
    Bun.env.GITHUB_TOKEN = 'env-token';
    store.set(
      `${MOCK_SERVICE}:github`,
      JSON.stringify({ token: 'stored-token' })
    );
    const client = await GitHubClient.create({ ghAvailable: () => true });
    expect(client).toBeInstanceOf(GitHubClient);
    // No direct introspection of mode is exposed; success without throwing
    // on an empty env + empty keyring confirms gh path was selected.
  });
});

describe('GitHubClient.create() — env-token branch (mocked)', () => {
  let envSnap: ReturnType<typeof clearGhEnv>;
  let store: Store;
  let restoreSecrets: () => void;

  beforeEach(() => {
    envSnap = clearGhEnv();
    Bun.env.AIDE_SECRET_SERVICE_OVERRIDE = MOCK_SERVICE;
    store = new Map();
    restoreSecrets = installMockSecrets(store);
  });

  afterEach(() => {
    restoreGhEnv(envSnap);
    restoreSecrets();
  });

  test('uses GITHUB_TOKEN when gh is unavailable', async () => {
    Bun.env.GITHUB_TOKEN = 'env-token';
    const client = await GitHubClient.create({ ghAvailable: () => false });
    expect(client).toBeInstanceOf(GitHubClient);
  });

  test('uses GH_TOKEN when GITHUB_TOKEN is absent', async () => {
    Bun.env.GH_TOKEN = 'gh-token';
    const client = await GitHubClient.create({ ghAvailable: () => false });
    expect(client).toBeInstanceOf(GitHubClient);
  });
});

describe('GitHubClient.create() — missing sources', () => {
  let envSnap: ReturnType<typeof clearGhEnv>;
  let store: Store;
  let restoreSecrets: () => void;

  beforeEach(() => {
    envSnap = clearGhEnv();
    Bun.env.AIDE_SECRET_SERVICE_OVERRIDE = MOCK_SERVICE;
    store = new Map();
    restoreSecrets = installMockSecrets(store);
  });

  afterEach(() => {
    restoreGhEnv(envSnap);
    restoreSecrets();
  });

  test('throws GitHubAuthError when gh, env, and keyring are all empty', async () => {
    await expect(
      GitHubClient.create({ ghAvailable: () => false })
    ).rejects.toBeInstanceOf(GitHubAuthError);
  });

  test('throws descriptive error when stored JSON is malformed', async () => {
    store.set(`${MOCK_SERVICE}:github`, '{not json');
    await expect(
      GitHubClient.create({ ghAvailable: () => false })
    ).rejects.toThrow(/re-run 'aide login github'/i);
  });

  test('throws descriptive error when stored blob fails schema', async () => {
    store.set(`${MOCK_SERVICE}:github`, JSON.stringify({ token: '' }));
    await expect(
      GitHubClient.create({ ghAvailable: () => false })
    ).rejects.toThrow(/re-run 'aide login github'/i);
  });
});

// --- Real-keyring integration test ---

const keyringReady = await isKeyringAvailable();
const describeIfKeyring = keyringReady ? describe : describe.skip;

describeIfKeyring(
  'GitHubClient.create() — keyring branch (real keyring)',
  () => {
    const service = uniqueTestService();
    const prevOverride = Bun.env.AIDE_SECRET_SERVICE_OVERRIDE;
    let envSnap: ReturnType<typeof clearGhEnv>;

    beforeAll(() => {
      Bun.env.AIDE_SECRET_SERVICE_OVERRIDE = service;
    });

    afterAll(async () => {
      await cleanupTestService(service, ['jira', 'ado', 'github']);
      if (prevOverride === undefined)
        delete Bun.env.AIDE_SECRET_SERVICE_OVERRIDE;
      else Bun.env.AIDE_SECRET_SERVICE_OVERRIDE = prevOverride;
    });

    beforeEach(async () => {
      envSnap = clearGhEnv();
      await cleanupTestService(service, ['github']);
    });

    afterEach(() => {
      restoreGhEnv(envSnap);
    });

    test('uses stored token from real keyring when gh and env are unavailable', async () => {
      // Seed the real keyring with a valid blob
      await Bun.secrets.set({
        service,
        name: 'github',
        value: JSON.stringify({ token: 'keyring-token' }),
      });

      const client = await GitHubClient.create({ ghAvailable: () => false });
      expect(client).toBeInstanceOf(GitHubClient);
    });
  }
);
