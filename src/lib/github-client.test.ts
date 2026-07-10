/**
 * Tests for GitHubClient.create() factory.
 *
 * Real-keyring is used for the "keyring branch" test via
 * AIDE_SECRET_SERVICE_OVERRIDE so we verify the actual integration
 * (signature, schema, round-trip) rather than a local mock. The gh-cli and
 * env branches are tested with an injected ghAuthProbe stub plus env
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
  authenticatedGitHubAuthProbe,
  installMockSecrets,
  isKeyringAvailable,
  uniqueTestService,
  cleanupTestService,
  restoreEnv,
  saveEnv,
  unavailableGitHubAuthProbe,
  type Store,
} from './test-helpers.js';

const GITHUB_AUTH_VARS = [
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'GH_HOST',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
];

function clearGhEnv(): Map<string, string | undefined> {
  return saveEnv(GITHUB_AUTH_VARS);
}

function restoreGhEnv(snap: Map<string, string | undefined>): void {
  restoreEnv(snap);
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

  test('uses exact-host gh auth when eligible, ignoring other sources', async () => {
    Bun.env.GITHUB_TOKEN = 'env-token';
    store.set(
      `${MOCK_SERVICE}:auth:github:host:acme.ghe.com`,
      '{malformed scoped credentials'
    );
    store.set(
      `${MOCK_SERVICE}:github`,
      JSON.stringify({ token: 'stored-token' })
    );
    const checkedHosts: string[] = [];
    const client = await GitHubClient.create({
      ghAuthProbe: (request) => {
        checkedHosts.push(request.host);
        return { kind: 'authenticated', host: request.host };
      },
      host: 'acme.ghe.com',
      scope: { providerId: 'github', host: 'acme.ghe.com' },
    });
    expect(client).toBeInstanceOf(GitHubClient);
    expect(checkedHosts).toEqual(['acme.ghe.com']);
    // The malformed scoped blob confirms the keyring was not read.
  });

  test('rejects inherited and accessor client dependencies without invocation', async () => {
    let inheritedProbeCalls = 0;
    let inheritedSpawnCalls = 0;
    let fetchGetterCalls = 0;
    let proxyCalls = 0;
    const inheritedProbe = Object.create({
      ghAuthProbe: () => {
        inheritedProbeCalls += 1;
        return { kind: 'authenticated', host: 'github.com' };
      },
    }) as Parameters<typeof GitHubClient.create>[0];
    const accessorFetch = {
      ghAuthProbe: unavailableGitHubAuthProbe,
    } as Parameters<typeof GitHubClient.create>[0];
    Object.defineProperty(accessorFetch, 'fetch', {
      configurable: true,
      enumerable: true,
      get() {
        fetchGetterCalls += 1;
        return globalThis.fetch;
      },
    });
    const inheritedSpawn = Object.assign(
      Object.create({
        spawn: () => {
          inheritedSpawnCalls += 1;
          throw new Error('inherited spawn must not run');
        },
      }),
      { ghAuthProbe: unavailableGitHubAuthProbe }
    ) as Parameters<typeof GitHubClient.create>[0];
    const proxyPrototype = new Proxy(
      { fetch: globalThis.fetch },
      {
        getOwnPropertyDescriptor(target, property) {
          proxyCalls += 1;
          return Reflect.getOwnPropertyDescriptor(target, property);
        },
      }
    );
    const proxyBacked = Object.assign(Object.create(proxyPrototype), {
      ghAuthProbe: unavailableGitHubAuthProbe,
    }) as Parameters<typeof GitHubClient.create>[0];

    await expect(GitHubClient.create(inheritedProbe)).rejects.toMatchObject({
      name: 'GitHubAuthError',
      code: 'malformed-credential',
    });
    await expect(GitHubClient.create(accessorFetch)).rejects.toMatchObject({
      name: 'GitHubAuthError',
      code: 'malformed-credential',
    });
    await expect(GitHubClient.create(inheritedSpawn)).rejects.toMatchObject({
      name: 'GitHubAuthError',
      code: 'malformed-credential',
    });
    await expect(GitHubClient.create(proxyBacked)).rejects.toMatchObject({
      name: 'GitHubAuthError',
      code: 'malformed-credential',
    });
    expect(inheritedProbeCalls).toBe(0);
    expect(inheritedSpawnCalls).toBe(0);
    expect(fetchGetterCalls).toBe(0);
    expect(proxyCalls).toBe(0);
  });

  test('does not accept github.com gh auth for a custom host', async () => {
    const checkedHosts: string[] = [];
    await expect(
      GitHubClient.create({
        ghAuthProbe: (request) => {
          checkedHosts.push(request.host);
          return { kind: 'authenticated', host: 'github.com' };
        },
        host: 'github.example.com',
      })
    ).rejects.toMatchObject({
      name: 'GitHubAuthError',
      code: 'not-configured',
      host: 'github.example.com',
    });
    expect(checkedHosts).toEqual(['github.example.com']);
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

  test('does not use GITHUB_TOKEN for an enterprise host', async () => {
    Bun.env.GITHUB_TOKEN = 'env-token';
    await expect(
      GitHubClient.create({
        ghAuthProbe: unavailableGitHubAuthProbe,
        host: 'acme.ghe.com',
        scope: { providerId: 'github', host: 'acme.ghe.com' },
      })
    ).rejects.toBeInstanceOf(GitHubAuthError);
  });

  test('uses a matching GH_HOST-bound enterprise token', async () => {
    Bun.env.GH_HOST = 'ssh.ACME.ghe.com';
    Bun.env.GH_ENTERPRISE_TOKEN = 'enterprise-token';
    const fetchStub = makeFetchStub({ number: 5 });
    const client = await GitHubClient.create({
      ghAuthProbe: unavailableGitHubAuthProbe,
      host: 'acme.ghe.com',
      scope: { providerId: 'github', host: 'acme.ghe.com' },
      fetch: fetchStub.fn,
    });

    await client.getPullRequest('acme', 'widgets', 5);
    expect(fetchStub.authorizations).toEqual(['Bearer enterprise-token']);
  });

  test('ignores enterprise tokens with mismatched or malformed GH_HOST', async () => {
    Bun.env.GH_ENTERPRISE_TOKEN = 'enterprise-token';
    Bun.env.GITHUB_TOKEN = 'public-token';
    for (const environmentHost of ['other.ghe.com', 'https://acme.ghe.com']) {
      Bun.env.GH_HOST = environmentHost;
      await expect(
        GitHubClient.create({
          ghAuthProbe: unavailableGitHubAuthProbe,
          host: 'acme.ghe.com',
        })
      ).rejects.toBeInstanceOf(GitHubAuthError);
    }
  });

  test('uses GH_TOKEN when GITHUB_TOKEN is absent', async () => {
    Bun.env.GH_TOKEN = 'gh-token';
    const client = await GitHubClient.create({
      ghAuthProbe: unavailableGitHubAuthProbe,
    });
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
      GitHubClient.create({ ghAuthProbe: unavailableGitHubAuthProbe })
    ).rejects.toBeInstanceOf(GitHubAuthError);
  });

  test('throws descriptive error when stored JSON is malformed', async () => {
    store.set(`${MOCK_SERVICE}:github`, '{not json');
    await expect(
      GitHubClient.create({ ghAuthProbe: unavailableGitHubAuthProbe })
    ).rejects.toThrow(/re-run 'aide login github'/i);
  });

  test('throws descriptive error when stored blob fails schema', async () => {
    store.set(`${MOCK_SERVICE}:github`, JSON.stringify({ token: '' }));
    await expect(
      GitHubClient.create({ ghAuthProbe: unavailableGitHubAuthProbe })
    ).rejects.toThrow(/re-run 'aide login github'/i);
  });

  test('uses the exact scoped keyring token when legacy is also populated', async () => {
    store.set(
      `${MOCK_SERVICE}:auth:github:host:acme.ghe.com`,
      JSON.stringify({
        token: 'scoped-token',
        identity: { host: 'acme.ghe.com' },
      })
    );
    store.set(
      `${MOCK_SERVICE}:github`,
      JSON.stringify({ token: 'legacy-token' })
    );
    const fetchStub = makeFetchStub({ number: 5 });

    const client = await GitHubClient.create({
      ghAuthProbe: unavailableGitHubAuthProbe,
      host: 'acme.ghe.com',
      scope: { providerId: 'github', host: 'acme.ghe.com' },
      fetch: fetchStub.fn,
    });
    await client.getPullRequest('acme', 'widgets', 5);

    expect(fetchStub.authorizations).toEqual(['Bearer scoped-token']);
  });

  test('does not read the legacy token when the scoped key is missing', async () => {
    store.set(
      `${MOCK_SERVICE}:github`,
      JSON.stringify({ token: 'legacy-token' })
    );
    await expect(
      GitHubClient.create({
        ghAuthProbe: unavailableGitHubAuthProbe,
        host: 'acme.ghe.com',
        scope: { providerId: 'github', host: 'acme.ghe.com' },
      })
    ).rejects.toBeInstanceOf(GitHubAuthError);
  });

  test('keeps no-scope callers on the legacy key', async () => {
    store.set(
      `${MOCK_SERVICE}:github`,
      JSON.stringify({ token: 'legacy-token' })
    );
    const fetchStub = makeFetchStub({ number: 5 });

    const client = await GitHubClient.create({
      ghAuthProbe: unavailableGitHubAuthProbe,
      fetch: fetchStub.fn,
    });
    await client.getPullRequest('acme', 'widgets', 5);

    expect(fetchStub.authorizations).toEqual(['Bearer legacy-token']);
  });

  test('does not fall back when scoped credentials are malformed', async () => {
    store.set(`${MOCK_SERVICE}:auth:github:host:acme.ghe.com`, '{not json');
    store.set(
      `${MOCK_SERVICE}:github`,
      JSON.stringify({ token: 'legacy-token' })
    );

    await expect(
      GitHubClient.create({
        ghAuthProbe: unavailableGitHubAuthProbe,
        host: 'acme.ghe.com',
        scope: { providerId: 'github', host: 'acme.ghe.com' },
      })
    ).rejects.toThrow(/re-run 'aide login github'/i);
  });

  test('rejects a mismatched host/scope before a token can be transported', async () => {
    Bun.env.GH_HOST = 'acme.ghe.com';
    Bun.env.GH_ENTERPRISE_TOKEN = 'enterprise-token';
    const fetchStub = makeFetchStub({ number: 5 });

    await expect(
      GitHubClient.create({
        ghAuthProbe: unavailableGitHubAuthProbe,
        host: 'other.ghe.com',
        scope: { providerId: 'github', host: 'acme.ghe.com' },
        fetch: fetchStub.fn,
      })
    ).rejects.toMatchObject({
      name: 'GitHubAuthError',
      code: 'scope-host-mismatch',
      host: 'other.ghe.com',
    });
    expect(fetchStub.urls).toEqual([]);
  });

  test('canonical SSH alias resolves the same exact scoped key', async () => {
    store.set(
      `${MOCK_SERVICE}:auth:github:host:acme.ghe.com`,
      JSON.stringify({
        token: 'alias-scoped-token',
        identity: { host: 'acme.ghe.com' },
      })
    );
    const fetchStub = makeFetchStub({ number: 5 });
    const client = await GitHubClient.create({
      ghAuthProbe: unavailableGitHubAuthProbe,
      host: 'ssh.acme.ghe.com',
      scope: { providerId: 'github', host: 'ACME.GHE.COM' },
      fetch: fetchStub.fn,
    });

    await client.getPullRequest('acme', 'widgets', 5);
    expect(fetchStub.authorizations).toEqual(['Bearer alias-scoped-token']);
    expect(fetchStub.urls[0]).toStartWith('https://api.acme.ghe.com/');
  });

  test('account-qualified requests never use an unqualified env token', async () => {
    Bun.env.GITHUB_TOKEN = 'unqualified-env-token';

    await expect(
      GitHubClient.create({
        ghAuthProbe: unavailableGitHubAuthProbe,
        scope: {
          providerId: 'github',
          host: 'github.com',
          account: 'OctoCat',
        },
      })
    ).rejects.toMatchObject({
      name: 'GitHubAuthError',
      code: 'not-configured',
      host: 'github.com',
      account: 'octocat',
    });
  });

  test('matching account-qualified gh auth may override the exact account key', async () => {
    store.set(
      `${MOCK_SERVICE}:auth:github:host:github.com:account:octocat`,
      '{malformed exact account payload'
    );
    const observed: Array<[string, string | undefined]> = [];

    const client = await GitHubClient.create({
      scope: {
        providerId: 'github',
        host: 'GITHUB.COM',
        account: 'OCTOCAT',
      },
      ghAuthProbe: (request) => {
        observed.push([request.host, request.account]);
        return {
          kind: 'authenticated',
          host: request.host,
          account: request.account,
        };
      },
    });

    expect(client).toBeInstanceOf(GitHubClient);
    expect(observed).toEqual([['github.com', 'octocat']]);
  });

  test('uses only an identity-matching exact account payload', async () => {
    Bun.env.GITHUB_TOKEN = 'unqualified-env-token';
    store.set(
      `${MOCK_SERVICE}:auth:github:host:github.com:account:octocat`,
      JSON.stringify({
        token: 'account-token',
        identity: { host: 'github.com', account: 'OctoCat' },
      })
    );
    store.set(
      `${MOCK_SERVICE}:auth:github:host:github.com`,
      JSON.stringify({
        token: 'host-token',
        identity: { host: 'github.com' },
      })
    );
    const fetchStub = makeFetchStub({ number: 5 });

    const client = await GitHubClient.create({
      ghAuthProbe: unavailableGitHubAuthProbe,
      scope: {
        providerId: 'github',
        host: 'github.com',
        account: 'OCTOCAT',
      },
      fetch: fetchStub.fn,
    });
    await client.getPullRequest('acme', 'widgets', 5);

    expect(fetchStub.authorizations).toEqual(['Bearer account-token']);
  });

  test('fails closed with a typed error for mismatched exact account identity', async () => {
    Bun.env.GITHUB_TOKEN = 'unqualified-env-token';
    store.set(
      `${MOCK_SERVICE}:auth:github:host:github.com:account:octocat`,
      JSON.stringify({
        token: 'wrong-account-token',
        identity: { host: 'github.com', account: 'hubot' },
      })
    );

    await expect(
      GitHubClient.create({
        ghAuthProbe: unavailableGitHubAuthProbe,
        scope: {
          providerId: 'github',
          host: 'github.com',
          account: 'octocat',
        },
      })
    ).rejects.toMatchObject({
      name: 'GitHubAuthError',
      code: 'account-mismatch',
      account: 'octocat',
    });
  });

  test('requires migration for pre-identity host-scoped payloads', async () => {
    store.set(
      `${MOCK_SERVICE}:auth:github:host:github.com`,
      JSON.stringify({ token: 'pre-identity-token' })
    );

    await expect(
      GitHubClient.create({
        ghAuthProbe: unavailableGitHubAuthProbe,
        host: 'github.com',
      })
    ).rejects.toMatchObject({
      name: 'GitHubAuthError',
      code: 'malformed-credential',
    });
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

      const client = await GitHubClient.create({
        ghAuthProbe: unavailableGitHubAuthProbe,
      });
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
  options: Array<Parameters<SpawnSyncFn>[1]>;
} {
  const calls: string[][] = [];
  const options: Array<Parameters<SpawnSyncFn>[1]> = [];
  const fn: SpawnSyncFn = (cmd, spawnOptions) => {
    calls.push(cmd);
    options.push(spawnOptions);
    return {
      exitCode: 0,
      stdout: { toString: () => stdout },
      stderr: { toString: () => '' },
    };
  };
  return { fn, calls, options };
}

/** Records request URLs and returns a canned JSON Response for each call. */
function makeFetchStub(body: unknown): {
  fn: FetchFn;
  urls: string[];
  authorizations: Array<string | null>;
  redirects: Array<RequestInit['redirect']>;
} {
  const urls: string[] = [];
  const authorizations: Array<string | null> = [];
  const redirects: Array<RequestInit['redirect']> = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    urls.push(String(input));
    authorizations.push(new Headers(init?.headers).get('Authorization'));
    redirects.push(init?.redirect);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as FetchFn;
  return { fn, urls, authorizations, redirects };
}

/** Find the value passed immediately after a flag in an argv array. */
function flagValue(
  argv: string[] | undefined,
  flag: string
): string | undefined {
  if (!argv) return undefined;
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
}

describe('GitHubClient transport — gh CLI (spawn stub)', () => {
  test('passes --hostname github.com by default and hits the REST endpoint', async () => {
    const spawn = makeSpawnStub('{"node_id":"abc"}');
    const client = await GitHubClient.create({
      ghAuthProbe: authenticatedGitHubAuthProbe,
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
      ghAuthProbe: authenticatedGitHubAuthProbe,
      host: 'acme.ghe.com',
      spawn: spawn.fn,
    });

    await client.getPullRequest('acme', 'widgets', 5);

    expect(flagValue(spawn.calls[0], '--hostname')).toBe('acme.ghe.com');
    expect(spawn.options[0]?.env?.GH_TOKEN).toBeUndefined();
    expect(spawn.options[0]?.env?.GH_ENTERPRISE_TOKEN).toBeUndefined();
  });

  test('paginated requests carry --hostname and --paginate', async () => {
    const spawn = makeSpawnStub('[]');
    const client = await GitHubClient.create({
      ghAuthProbe: authenticatedGitHubAuthProbe,
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
      ghAuthProbe: authenticatedGitHubAuthProbe,
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
    Bun.env.GH_HOST = 'acme.ghe.com';
    Bun.env.GH_ENTERPRISE_TOKEN = 'enterprise-tok';
  });

  afterEach(() => {
    restoreGhEnv(envSnap);
    delete Bun.env.AIDE_SECRET_SERVICE_OVERRIDE;
  });

  test('defaults to https://api.github.com', async () => {
    const fetchStub = makeFetchStub({ number: 5 });
    const client = await GitHubClient.create({
      ghAuthProbe: unavailableGitHubAuthProbe,
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
      ghAuthProbe: unavailableGitHubAuthProbe,
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
      ghAuthProbe: unavailableGitHubAuthProbe,
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
      ghAuthProbe: unavailableGitHubAuthProbe,
      host: 'acme.ghe.com',
      fetch: fetchStub.fn,
    });

    await client.publishDraftPR('acme', 'widgets', 5);

    // First fetch resolves the PR; second is the graphql mutation.
    expect(fetchStub.urls[1]).toBe('https://api.acme.ghe.com/graphql');
    expect(fetchStub.redirects).toEqual(['manual', 'manual']);
  });

  test('custom GHES token transport stays on the requested host', async () => {
    Bun.env.GH_HOST = 'github.example.com';
    const fetchStub = makeFetchStub({ node_id: 'abc' });
    const client = await GitHubClient.create({
      ghAuthProbe: unavailableGitHubAuthProbe,
      host: 'GITHUB.EXAMPLE.COM',
      fetch: fetchStub.fn,
    });

    await client.publishDraftPR('acme', 'widgets', 5);

    expect(fetchStub.urls).toEqual([
      'https://github.example.com/api/v3/repos/acme/widgets/pulls/5',
      'https://github.example.com/api/graphql',
    ]);
    expect(fetchStub.authorizations).toEqual([
      'Bearer enterprise-tok',
      'Bearer enterprise-tok',
    ]);
  });

  test('follows a same-origin HTTPS Link header with auth locked to that origin', async () => {
    const page1 = `https://api.acme.ghe.com/repos/acme/widgets/issues/5/comments`;
    const page2 = `${page1}?page=2`;
    const urls: string[] = [];
    const authorizations: Array<string | null> = [];
    const redirects: Array<RequestInit['redirect']> = [];
    let call = 0;
    const fetchFn = (async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      urls.push(String(input));
      authorizations.push(new Headers(init?.headers).get('Authorization'));
      redirects.push(init?.redirect);
      const isFirst = call++ === 0;
      return new Response(JSON.stringify(isFirst ? [{ id: 1 }] : [{ id: 2 }]), {
        status: 200,
        headers: isFirst ? { Link: `<${page2}>; rel="next"` } : {},
      });
    }) as unknown as FetchFn;

    const client = await GitHubClient.create({
      ghAuthProbe: unavailableGitHubAuthProbe,
      host: 'acme.ghe.com',
      fetch: fetchFn,
    });

    const comments = await client.getIssueComments('acme', 'widgets', 5);

    expect(urls).toEqual([page1, page2]);
    expect(authorizations).toEqual([
      'Bearer enterprise-tok',
      'Bearer enterprise-tok',
    ]);
    expect(redirects).toEqual(['manual', 'manual']);
    expect(comments).toHaveLength(2);
  });

  test('rejects a cross-host Link before sending the token off-origin', async () => {
    const page1 = `https://api.acme.ghe.com/repos/acme/widgets/issues/5/comments`;
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const fetchFn = (async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      requests.push({
        url: String(input),
        authorization: new Headers(init?.headers).get('Authorization'),
      });
      return new Response(JSON.stringify([{ id: 1 }]), {
        status: 200,
        headers: { Link: `<https://evil.example.com/steal>; rel="next"` },
      });
    }) as unknown as FetchFn;

    const client = await GitHubClient.create({
      ghAuthProbe: unavailableGitHubAuthProbe,
      host: 'acme.ghe.com',
      fetch: fetchFn,
    });

    await expect(client.getIssueComments('acme', 'widgets', 5)).rejects.toThrow(
      /origin/i
    );

    expect(requests).toEqual([
      { url: page1, authorization: 'Bearer enterprise-tok' },
    ]);
  });

  test('rejects an HTTPS-to-HTTP pagination downgrade before sending the token', async () => {
    const page1 = `https://api.acme.ghe.com/repos/acme/widgets/issues/5/comments`;
    const downgraded = `http://api.acme.ghe.com/steal`;
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const fetchFn = (async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      requests.push({
        url: String(input),
        authorization: new Headers(init?.headers).get('Authorization'),
      });
      return new Response(JSON.stringify([{ id: 1 }]), {
        status: 200,
        headers: { Link: `<${downgraded}>; rel="next"` },
      });
    }) as unknown as FetchFn;

    const client = await GitHubClient.create({
      ghAuthProbe: unavailableGitHubAuthProbe,
      host: 'acme.ghe.com',
      fetch: fetchFn,
    });

    await expect(client.getIssueComments('acme', 'widgets', 5)).rejects.toThrow(
      /https/i
    );

    expect(requests).toEqual([
      { url: page1, authorization: 'Bearer enterprise-tok' },
    ]);
  });

  test('rejects a pagination port mismatch before sending the token', async () => {
    const page1 = `https://api.acme.ghe.com/repos/acme/widgets/issues/5/comments`;
    const wrongPort = `https://api.acme.ghe.com:8443/steal`;
    const urls: string[] = [];
    const fetchFn = (async (input: string | URL | Request) => {
      urls.push(String(input));
      return new Response(JSON.stringify([{ id: 1 }]), {
        status: 200,
        headers: { Link: `<${wrongPort}>; rel="next"` },
      });
    }) as unknown as FetchFn;

    const client = await GitHubClient.create({
      ghAuthProbe: unavailableGitHubAuthProbe,
      host: 'acme.ghe.com',
      fetch: fetchFn,
    });

    await expect(client.getIssueComments('acme', 'widgets', 5)).rejects.toThrow(
      /origin/i
    );

    expect(urls).toEqual([page1]);
  });

  test('rejects pagination userinfo before sending the token', async () => {
    const page1 = `https://api.acme.ghe.com/repos/acme/widgets/issues/5/comments`;
    const withUserinfo = `https://attacker@api.acme.ghe.com/steal`;
    const urls: string[] = [];
    const fetchFn = (async (input: string | URL | Request) => {
      urls.push(String(input));
      return new Response(JSON.stringify([{ id: 1 }]), {
        status: 200,
        headers: { Link: `<${withUserinfo}>; rel="next"` },
      });
    }) as unknown as FetchFn;

    const client = await GitHubClient.create({
      ghAuthProbe: unavailableGitHubAuthProbe,
      host: 'acme.ghe.com',
      fetch: fetchFn,
    });

    await expect(client.getIssueComments('acme', 'widgets', 5)).rejects.toThrow(
      /userinfo/i
    );

    expect(urls).toEqual([page1]);
  });

  test('safely follows a same-origin HTTPS redirect', async () => {
    const page1 = `https://api.acme.ghe.com/repos/acme/widgets/issues/5/comments`;
    const redirected = `${page1}?redirected=true`;
    const requests: Array<{
      url: string;
      authorization: string | null;
      redirect: RequestInit['redirect'];
    }> = [];
    const fetchFn = (async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      requests.push({
        url: String(input),
        authorization: new Headers(init?.headers).get('Authorization'),
        redirect: init?.redirect,
      });
      if (String(input) === page1) {
        return new Response(null, {
          status: 307,
          headers: { Location: redirected },
        });
      }
      return Response.json([{ id: 1 }]);
    }) as unknown as FetchFn;

    const client = await GitHubClient.create({
      ghAuthProbe: unavailableGitHubAuthProbe,
      host: 'acme.ghe.com',
      fetch: fetchFn,
    });

    const comments = await client.getIssueComments('acme', 'widgets', 5);

    expect(requests).toEqual([
      {
        url: page1,
        authorization: 'Bearer enterprise-tok',
        redirect: 'manual',
      },
      {
        url: redirected,
        authorization: 'Bearer enterprise-tok',
        redirect: 'manual',
      },
    ]);
    expect(comments).toHaveLength(1);
  });

  test('bounds same-origin authenticated redirects', async () => {
    const page1 = `https://api.acme.ghe.com/repos/acme/widgets/issues/5/comments`;
    const urls: string[] = [];
    const fetchFn = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      urls.push(url.href);
      const redirectNumber = Number(url.searchParams.get('redirect') ?? 0) + 1;
      url.searchParams.set('redirect', String(redirectNumber));
      return new Response(null, {
        status: 307,
        headers: { Location: url.href },
      });
    }) as unknown as FetchFn;

    const client = await GitHubClient.create({
      ghAuthProbe: unavailableGitHubAuthProbe,
      host: 'acme.ghe.com',
      fetch: fetchFn,
    });

    await expect(client.getIssueComments('acme', 'widgets', 5)).rejects.toThrow(
      /too many redirects/i
    );

    expect(urls).toHaveLength(6);
    expect(urls[0]).toBe(page1);
  });

  test.each([
    ['cross-origin', 'https://evil.example.com/steal', /origin/i],
    ['scheme downgrade', 'http://api.acme.ghe.com/steal', /https/i],
  ])(
    'rejects a %s redirect before sending the token to its destination',
    async (_case, destination, expectedError) => {
      const page1 = `https://api.acme.ghe.com/repos/acme/widgets/issues/5/comments`;
      const requests: Array<{
        url: string;
        authorization: string | null;
        redirect: RequestInit['redirect'];
      }> = [];
      const fetchFn = (async (
        input: string | URL | Request,
        init?: RequestInit
      ) => {
        requests.push({
          url: String(input),
          authorization: new Headers(init?.headers).get('Authorization'),
          redirect: init?.redirect,
        });
        return new Response(null, {
          status: 302,
          headers: { Location: destination },
        });
      }) as unknown as FetchFn;

      const client = await GitHubClient.create({
        ghAuthProbe: unavailableGitHubAuthProbe,
        host: 'acme.ghe.com',
        fetch: fetchFn,
      });

      await expect(
        client.getIssueComments('acme', 'widgets', 5)
      ).rejects.toThrow(expectedError);

      expect(requests).toEqual([
        {
          url: page1,
          authorization: 'Bearer enterprise-tok',
          redirect: 'manual',
        },
      ]);
    }
  );
});
