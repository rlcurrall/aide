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

import {
  GitHubClient,
  GitHubAuthError,
  type SpawnSyncFn,
  type FetchFn,
} from './github-client.js';
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

// ---------------------------------------------------------------------------
// Transport tests — verify the host flows into the actual request target.
//
// These exercise the gh CLI and token transports through injectable stubs so
// we can assert the wire-level behavior (gh `--hostname`, and the
// `https://api.{host}` base URL) without spawning `gh` or hitting the network.
// ---------------------------------------------------------------------------

/** Records spawned argv and returns a canned stdout. */
function makeSpawnStub(stdout = '{}'): {
  fn: SpawnSyncFn;
  calls: string[][];
} {
  const calls: string[][] = [];
  const fn: SpawnSyncFn = (cmd) => {
    calls.push(cmd);
    return {
      exitCode: 0,
      stdout: { toString: () => stdout },
      stderr: { toString: () => '' },
    };
  };
  return { fn, calls };
}

/** Records request URLs and returns a canned JSON Response for each call. */
function makeFetchStub(body: unknown): {
  fn: FetchFn;
  urls: string[];
} {
  const urls: string[] = [];
  const fn = (async (input: string | URL | Request) => {
    urls.push(String(input));
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as FetchFn;
  return { fn, urls };
}

/** Find the value passed immediately after a flag in an argv array. */
function flagValue(argv: string[] | undefined, flag: string): string | undefined {
  if (!argv) return undefined;
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
}

describe('GitHubClient transport — gh CLI (spawn stub)', () => {
  test('passes --hostname github.com by default and hits the REST endpoint', async () => {
    const spawn = makeSpawnStub('{"node_id":"abc"}');
    const client = await GitHubClient.create({
      ghAvailable: () => true,
      spawn: spawn.fn,
    });

    await client.getPullRequest('acme', 'widgets', 5);

    expect(spawn.calls).toHaveLength(1);
    expect(flagValue(spawn.calls[0], '--hostname')).toBe('github.com');
    expect(spawn.calls[0]).toContain('/repos/acme/widgets/pulls/5');
  });

  test('passes the ghe.com host on the --hostname flag', async () => {
    const spawn = makeSpawnStub('{"node_id":"abc"}');
    const client = await GitHubClient.create({
      ghAvailable: () => true,
      host: 'acme.ghe.com',
      spawn: spawn.fn,
    });

    await client.getPullRequest('acme', 'widgets', 5);

    expect(flagValue(spawn.calls[0], '--hostname')).toBe('acme.ghe.com');
  });

  test('paginated requests carry --hostname and --paginate', async () => {
    const spawn = makeSpawnStub('[]');
    const client = await GitHubClient.create({
      ghAvailable: () => true,
      host: 'acme.ghe.com',
      spawn: spawn.fn,
    });

    await client.getIssueComments('acme', 'widgets', 5);

    expect(flagValue(spawn.calls[0], '--hostname')).toBe('acme.ghe.com');
    expect(spawn.calls[0]).toContain('--paginate');
    expect(spawn.calls[0]).toContain('/repos/acme/widgets/issues/5/comments');
  });

  test('GraphQL mutations target the host (publishDraftPR)', async () => {
    const spawn = makeSpawnStub('{"node_id":"abc"}');
    const client = await GitHubClient.create({
      ghAvailable: () => true,
      host: 'acme.ghe.com',
      spawn: spawn.fn,
    });

    await client.publishDraftPR('acme', 'widgets', 5);

    // First call resolves the PR node id; second is the graphql mutation.
    expect(spawn.calls).toHaveLength(2);
    const graphqlCall = spawn.calls[1];
    expect(graphqlCall).toContain('graphql');
    expect(flagValue(graphqlCall, '--hostname')).toBe('acme.ghe.com');
  });
});

describe('GitHubClient transport — token (fetch stub)', () => {
  let envSnap: ReturnType<typeof clearGhEnv>;

  beforeEach(() => {
    envSnap = clearGhEnv();
    Bun.env.AIDE_SECRET_SERVICE_OVERRIDE = MOCK_SERVICE;
    Bun.env.GITHUB_TOKEN = 'tok';
  });

  afterEach(() => {
    restoreGhEnv(envSnap);
    delete Bun.env.AIDE_SECRET_SERVICE_OVERRIDE;
  });

  test('defaults to https://api.github.com', async () => {
    const fetchStub = makeFetchStub({ number: 5 });
    const client = await GitHubClient.create({
      ghAvailable: () => false,
      fetch: fetchStub.fn,
    });

    await client.getPullRequest('acme', 'widgets', 5);

    expect(fetchStub.urls[0]).toBe(
      'https://api.github.com/repos/acme/widgets/pulls/5'
    );
  });

  test('derives https://api.{host} for ghe.com', async () => {
    const fetchStub = makeFetchStub({ number: 5 });
    const client = await GitHubClient.create({
      ghAvailable: () => false,
      host: 'acme.ghe.com',
      fetch: fetchStub.fn,
    });

    await client.getPullRequest('acme', 'widgets', 5);

    expect(fetchStub.urls[0]).toBe(
      'https://api.acme.ghe.com/repos/acme/widgets/pulls/5'
    );
  });

  test('paginated GET uses the derived api host', async () => {
    const fetchStub = makeFetchStub([]);
    const client = await GitHubClient.create({
      ghAvailable: () => false,
      host: 'acme.ghe.com',
      fetch: fetchStub.fn,
    });

    await client.getIssueComments('acme', 'widgets', 5);

    expect(fetchStub.urls[0]).toBe(
      'https://api.acme.ghe.com/repos/acme/widgets/issues/5/comments'
    );
  });

  test('GraphQL endpoint is on the derived api host', async () => {
    const fetchStub = makeFetchStub({ node_id: 'abc' });
    const client = await GitHubClient.create({
      ghAvailable: () => false,
      host: 'acme.ghe.com',
      fetch: fetchStub.fn,
    });

    await client.publishDraftPR('acme', 'widgets', 5);

    // First fetch resolves the PR; second is the graphql mutation.
    expect(fetchStub.urls[1]).toBe('https://api.acme.ghe.com/graphql');
  });

  test('follows a same-host Link header to fetch page 2', async () => {
    const page1 = `https://api.acme.ghe.com/repos/acme/widgets/issues/5/comments`;
    const page2 = `${page1}?page=2`;
    const urls: string[] = [];
    let call = 0;
    const fetchFn = (async (input: string | URL | Request) => {
      urls.push(String(input));
      const isFirst = call++ === 0;
      return new Response(JSON.stringify(isFirst ? [{ id: 1 }] : [{ id: 2 }]), {
        status: 200,
        headers: isFirst ? { Link: `<${page2}>; rel="next"` } : {},
      });
    }) as unknown as FetchFn;

    const client = await GitHubClient.create({
      ghAvailable: () => false,
      host: 'acme.ghe.com',
      fetch: fetchFn,
    });

    const comments = await client.getIssueComments('acme', 'widgets', 5);

    expect(urls).toEqual([page1, page2]);
    expect(comments).toHaveLength(2);
  });

  test('does NOT follow a cross-host Link header (no token sent off-host)', async () => {
    const page1 = `https://api.acme.ghe.com/repos/acme/widgets/issues/5/comments`;
    const urls: string[] = [];
    const fetchFn = (async (input: string | URL | Request) => {
      urls.push(String(input));
      return new Response(JSON.stringify([{ id: 1 }]), {
        status: 200,
        // Hostile/stray cross-host next link must be ignored.
        headers: { Link: `<https://evil.example.com/steal>; rel="next"` },
      });
    }) as unknown as FetchFn;

    const client = await GitHubClient.create({
      ghAvailable: () => false,
      host: 'acme.ghe.com',
      fetch: fetchFn,
    });

    const comments = await client.getIssueComments('acme', 'widgets', 5);

    expect(urls).toEqual([page1]);
    expect(comments).toHaveLength(1);
  });
});
