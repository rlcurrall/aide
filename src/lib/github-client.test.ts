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
import { runInNewContext } from 'node:vm';

import {
  GitHubClient,
  GitHubAuthError,
  type SpawnResult,
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

type IsAssignable<From, To> = From extends To ? true : false;
type AssertFalse<Value extends false> = Value;

// Compile-time-only contract: conversion hooks are not supported spawn output.
export type SpawnOutputExcludesConversionObjects = {
  stdout: AssertFalse<
    IsAssignable<{ toString(): string }, SpawnResult['stdout']>
  >;
  stderr: AssertFalse<
    IsAssignable<{ toString(): string }, SpawnResult['stderr']>
  >;
};

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
    const spawn = makeSpawnStub('account-token');

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
      spawn: spawn.fn,
    });

    expect(client).toBeInstanceOf(GitHubClient);
    expect(observed).toEqual([['github.com', 'octocat']]);
    expect(spawn.calls).toEqual([
      ['gh', 'auth', 'token', '--hostname', 'github.com', '--user', 'octocat'],
    ]);
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
function makeSpawnStub(stdout = '{}') {
  return makeSpawnRecorder(() => successfulSpawnResult(Buffer.from(stdout)));
}

/** Records request URLs and returns canned or URL-dependent JSON. */
function makeFetchStub(body: unknown | ((url: string) => unknown)): {
  fn: FetchFn;
  urls: string[];
  authorizations: Array<string | null>;
  redirects: Array<RequestInit['redirect']>;
} {
  const urls: string[] = [];
  const authorizations: Array<string | null> = [];
  const redirects: Array<RequestInit['redirect']> = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    authorizations.push(new Headers(init?.headers).get('Authorization'));
    redirects.push(init?.redirect);
    const responseBody = typeof body === 'function' ? body(url) : body;
    return new Response(JSON.stringify(responseBody), {
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

const PINNED_SCOPE = {
  providerId: 'github',
  host: 'github.com',
  account: 'octocat',
} as const;
const PINNED_FALLBACK_TOKEN = 'fallback-account-token';
const SANITIZED_GH_ENV = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'GH_HOST',
] as const;

function pinnedTokenCommand(host = 'github.com', account = 'octocat') {
  return ['gh', 'auth', 'token', '--hostname', host, '--user', account];
}

function makeSpawnRecorder(
  implementation: (
    cmd: string[],
    options: Parameters<SpawnSyncFn>[1]
  ) => unknown
): {
  fn: SpawnSyncFn;
  calls: string[][];
  options: Array<Parameters<SpawnSyncFn>[1]>;
} {
  const calls: string[][] = [];
  const options: Array<Parameters<SpawnSyncFn>[1]> = [];
  const fn = ((cmd: string[], spawnOptions: Parameters<SpawnSyncFn>[1]) => {
    calls.push(cmd);
    options.push(spawnOptions);
    return implementation(cmd, spawnOptions);
  }) as SpawnSyncFn;
  return { fn, calls, options };
}

function successfulSpawnResult(
  stdout: SpawnResult['stdout'],
  stderr = ''
): SpawnResult {
  return { exitCode: 0, stdout, stderr: Buffer.from(stderr) };
}

function expectPinnedTokenSpawn(
  spawn: ReturnType<typeof makeSpawnRecorder>,
  host = 'github.com',
  account = 'octocat'
): void {
  expect(spawn.calls).toEqual([pinnedTokenCommand(host, account)]);
  expect(spawn.options).toHaveLength(1);
  expect(spawn.options[0]).toMatchObject({ stdout: 'pipe', stderr: 'pipe' });
  expect(
    Object.fromEntries(
      SANITIZED_GH_ENV.map((name) => [name, spawn.options[0]?.env?.[name]])
    )
  ).toEqual(
    Object.fromEntries(SANITIZED_GH_ENV.map((name) => [name, undefined]))
  );
}

function createPinnedClient(spawn: SpawnSyncFn, fetch: FetchFn) {
  return GitHubClient.create({
    scope: PINNED_SCOPE,
    ghAuthProbe: authenticatedGitHubAuthProbe,
    spawn,
    fetch,
  });
}

describe('GitHubClient transport — account-pinned gh CLI', () => {
  let envSnap: ReturnType<typeof clearGhEnv>;
  let store: Store;
  let restoreSecrets: () => void;

  beforeEach(() => {
    envSnap = clearGhEnv();
    Bun.env.AIDE_SECRET_SERVICE_OVERRIDE = MOCK_SERVICE;
    Object.assign(Bun.env, {
      GH_TOKEN: 'ambient-gh-token',
      GITHUB_TOKEN: 'ambient-github-token',
      GH_ENTERPRISE_TOKEN: 'ambient-enterprise-token',
      GITHUB_ENTERPRISE_TOKEN: 'ambient-enterprise-alias',
      GH_HOST: 'ambient.example.com',
    });
    store = new Map();
    restoreSecrets = installMockSecrets(store);
  });

  afterEach(() => {
    restoreGhEnv(envSnap);
    restoreSecrets();
  });

  async function expectPinnedSpawnFailure(
    result: () => unknown,
    secrets: string[] = []
  ): Promise<void> {
    store.set(
      `${MOCK_SERVICE}:auth:github:host:github.com:account:octocat`,
      JSON.stringify({
        token: PINNED_FALLBACK_TOKEN,
        identity: { host: 'github.com', account: 'octocat' },
      })
    );
    const spawn = makeSpawnRecorder(result);
    const fetch = makeFetchStub({ number: 5 });
    const error = await createPinnedClient(spawn.fn, fetch.fn).then(
      () => undefined,
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(GitHubAuthError);
    expect(error).toMatchObject({
      name: 'GitHubAuthError',
      code: 'malformed-credential',
      host: 'github.com',
      account: 'octocat',
    });
    for (const secret of [PINNED_FALLBACK_TOKEN, ...secrets]) {
      expect(String(error)).not.toContain(secret);
    }
    expectPinnedTokenSpawn(spawn);
    expect(fetch.urls).toEqual([]);
  }

  async function expectPinnedStdoutAccepted(
    stdout: SpawnResult['stdout'],
    token: string
  ): Promise<void> {
    const spawn = makeSpawnRecorder(() => successfulSpawnResult(stdout));
    const fetch = makeFetchStub({ number: 5 });
    const client = await createPinnedClient(spawn.fn, fetch.fn);
    await client.getPullRequest('acme', 'widgets', 5);

    expectPinnedTokenSpawn(spawn);
    expect(fetch.urls).toEqual([
      'https://api.github.com/repos/acme/widgets/pulls/5',
    ]);
    expect(fetch.authorizations).toEqual([`Bearer ${token}`]);
  }

  function withHostilePrototype(
    stdout: Uint8Array,
    secret: string
  ): { stdout: Uint8Array; hookCalls: () => number } {
    let calls = 0;
    Object.setPrototypeOf(
      stdout,
      new Proxy(Object.getPrototypeOf(stdout), {
        get() {
          calls += 1;
          throw new Error(`prototype get exposed ${secret}`);
        },
        getPrototypeOf() {
          calls += 1;
          throw new Error(`prototype traversal exposed ${secret}`);
        },
      })
    );
    return { stdout, hookCalls: () => calls };
  }

  test.each([
    {
      name: 'github.com',
      requestedHost: 'GITHUB.COM',
      canonicalHost: 'github.com',
      restBase: 'https://api.github.com',
      graphqlUrl: 'https://api.github.com/graphql',
    },
    {
      name: 'a custom enterprise host',
      requestedHost: 'GITHUB.EXAMPLE.COM',
      canonicalHost: 'github.example.com',
      restBase: 'https://github.example.com/api/v3',
      graphqlUrl: 'https://github.example.com/api/graphql',
    },
  ])(
    'pins one canonical account token across REST, pagination, and GraphQL on $name',
    async ({ requestedHost, canonicalHost, restBase, graphqlUrl }) => {
      const token = `Ab0-._~+/${canonicalHost.replaceAll('.', '-')}==`;
      let activeAccount = 'octocat';
      let probeCalls = 0;
      const spawn = makeSpawnRecorder(() =>
        successfulSpawnResult(Buffer.from(` \t${token}\t\r\n`))
      );
      const fetch = makeFetchStub((url: string) =>
        url === graphqlUrl
          ? { data: {} }
          : url.includes('/issues/5/comments')
            ? []
            : { number: 5, node_id: 'pr-node-id' }
      );
      const client = await GitHubClient.create({
        scope: {
          providerId: 'github',
          host: requestedHost,
          account: 'OctoCat',
        },
        ghAuthProbe: (request) => {
          probeCalls += 1;
          return activeAccount === request.account
            ? {
                kind: 'authenticated',
                host: request.host,
                account: activeAccount,
              }
            : {
                kind: 'account-mismatch',
                code: 'account-mismatch',
                host: request.host,
                requestedAccount: request.account!,
                activeAccount,
                reason: 'active account changed',
              };
        },
        spawn: spawn.fn,
        fetch: fetch.fn,
      });

      activeAccount = 'hubot';
      await client.getPullRequest('acme', 'widgets', 5);
      await client.getIssueComments('acme', 'widgets', 5);
      await client.publishDraftPR('acme', 'widgets', 5);

      expect(probeCalls).toBe(1);
      expectPinnedTokenSpawn(spawn, canonicalHost);
      expect(fetch.urls).toEqual([
        `${restBase}/repos/acme/widgets/pulls/5`,
        `${restBase}/repos/acme/widgets/issues/5/comments`,
        `${restBase}/repos/acme/widgets/pulls/5`,
        graphqlUrl,
      ]);
      expect(fetch.authorizations).toEqual(Array(4).fill(`Bearer ${token}`));
    }
  );

  test('rejects inherited spawn result fields', async () => {
    const secret = 'inherited-result-secret';
    await expectPinnedSpawnFailure(
      () => Object.create({ exitCode: 0, stdout: Buffer.from(secret) }),
      [secret]
    );
  });

  test.each(['exitCode', 'stdout'] as const)(
    'rejects accessor-backed result %s without invoking the getter',
    async (field) => {
      let getterCalls = 0;
      const secret = 'accessor-result-secret';
      const result = { exitCode: 0, stdout: Buffer.from(secret) };
      Object.defineProperty(result, field, {
        enumerable: true,
        get() {
          getterCalls += 1;
          return field === 'exitCode' ? 0 : Buffer.from(secret);
        },
      });
      await expectPinnedSpawnFailure(() => result, [secret]);
      expect(getterCalls).toBe(0);
    }
  );

  test.each([
    ['null result', () => null, []],
    ['undefined result', () => undefined, []],
    ['numeric result', () => 0, []],
    [
      'string result',
      () => 'primitive-result-secret',
      ['primitive-result-secret'],
    ],
    ['boolean result', () => false, []],
    ['array result', () => [], []],
    ['missing fields', () => ({}), []],
    [
      'missing exitCode',
      () => ({ stdout: Buffer.from('missing-exit-secret') }),
      ['missing-exit-secret'],
    ],
    ['missing stdout', () => ({ exitCode: 0 }), []],
    [
      'string exitCode',
      () => ({ exitCode: '0', stdout: Buffer.from('wrong-exit-secret') }),
      ['wrong-exit-secret'],
    ],
    ['object stdout', () => ({ exitCode: 0, stdout: {} }), []],
    ['null stdout', () => ({ exitCode: 0, stdout: null }), []],
    ['numeric stdout', () => ({ exitCode: 0, stdout: 42 }), []],
    [
      'Uint16Array stdout',
      () => ({ exitCode: 0, stdout: new Uint16Array(1) }),
      [],
    ],
    [
      'DataView stdout',
      () => ({ exitCode: 0, stdout: new DataView(new ArrayBuffer(1)) }),
      [],
    ],
    [
      'detached Uint8Array stdout',
      () => {
        const stdout = new TextEncoder().encode('detached-secret');
        const buffer = stdout.buffer as ArrayBuffer;
        structuredClone(buffer, { transfer: [buffer] });
        return successfulSpawnResult(stdout);
      },
      ['detached-secret'],
    ],
    ['empty token output', () => successfulSpawnResult('  \n'), []],
    [
      'nonzero exit',
      () => ({
        exitCode: 1,
        stdout: Buffer.from('pinned-secret'),
        stderr: Buffer.from('failure mentioning pinned-secret'),
      }),
      ['pinned-secret'],
    ],
    [
      'thrown spawn',
      () => {
        throw new Error('spawn failure mentioning pinned-secret');
      },
      ['pinned-secret'],
    ],
  ] as Array<[string, () => unknown, string[]]>)(
    'fails typed and closed for %s',
    async (_name, result, secrets) => {
      await expectPinnedSpawnFailure(result, secrets);
    }
  );

  test.each([
    ['proxy spawn result', 'result', 'proxy-result-secret'],
    ['proxy stdout', 'stdout', 'proxy-stdout-secret'],
    [
      'spoofed stdout with proxy prototype',
      'prototype',
      'spoofed-prototype-secret',
    ],
  ] as Array<[string, 'result' | 'stdout' | 'prototype', string]>)(
    'rejects %s without invoking hooks',
    async (_name, placement, secret) => {
      let calls = 0;
      const fail = () => {
        calls += 1;
        throw new Error(`proxy trap exposed ${secret}`);
      };
      const target =
        placement === 'result'
          ? { exitCode: 0, stdout: Buffer.from(secret) }
          : placement === 'stdout'
            ? Buffer.from(secret)
            : Object.create(null);
      const proxy = new Proxy(target, {
        get: fail,
        getOwnPropertyDescriptor: fail,
        getPrototypeOf: fail,
      });
      const stdout = placement === 'prototype' ? Object.create(proxy) : proxy;
      if (placement === 'prototype') {
        Object.defineProperty(stdout, 'secret', { value: secret });
      }
      const result = placement === 'result' ? proxy : { exitCode: 0, stdout };

      await expectPinnedSpawnFailure(() => result, [secret]);
      expect(calls).toBe(0);
    }
  );

  test('rejects revoked proxy spawn results', async () => {
    const secret = 'revoked-proxy-secret';
    const revocable = Proxy.revocable(
      { exitCode: 0, stdout: Buffer.from(secret) },
      {}
    );
    revocable.revoke();
    await expectPinnedSpawnFailure(() => revocable.proxy, [secret]);
  });

  test.each([
    {
      name: 'primitive string',
      make: (output: string) => ({ stdout: output }),
    },
    {
      name: 'Buffer',
      make: (output: string) => ({ stdout: Buffer.from(output) }),
    },
    {
      name: 'raw Uint8Array',
      make: (output: string) => ({ stdout: new TextEncoder().encode(output) }),
    },
    {
      name: 'offset Uint8Array view',
      make(output: string) {
        const bytes = new TextEncoder().encode(`xx${output}xx`);
        return { stdout: bytes.subarray(2, -2) };
      },
    },
    {
      name: 'cross-realm Uint8Array',
      make(output: string) {
        const bytes = [...new TextEncoder().encode(output)];
        return {
          stdout: runInNewContext('Uint8Array.from(bytes)', {
            bytes,
          }) as Uint8Array,
        };
      },
    },
    {
      name: 'SharedArrayBuffer-backed Uint8Array',
      make(output: string) {
        const bytes = new TextEncoder().encode(output);
        const stdout = new Uint8Array(new SharedArrayBuffer(bytes.length));
        stdout.set(bytes);
        return { stdout };
      },
    },
    {
      name: 'Buffer with proxy prototype',
      make: (output: string) =>
        withHostilePrototype(Buffer.from(output), output),
    },
    {
      name: 'Uint8Array with proxy prototype',
      make: (output: string) =>
        withHostilePrototype(new TextEncoder().encode(output), output),
    },
  ] as Array<{
    name: string;
    make(output: string): {
      stdout: SpawnResult['stdout'];
      hookCalls?: () => number;
    };
  }>)('accepts and brand-decodes $name', async ({ make }) => {
    const token = 'Ab0-._~+/==';
    const testCase = make(` \t${token}\t\r\n`);
    await expectPinnedStdoutAccepted(testCase.stdout, token);
    expect(testCase.hookCalls?.() ?? 0).toBe(0);
  });

  test('does not consult Uint8Array Symbol.hasInstance', async () => {
    const token = 'hostile-has-instance-token';
    const stdout = new TextEncoder().encode(`${token}\n`);
    const previous = Object.getOwnPropertyDescriptor(
      Uint8Array,
      Symbol.hasInstance
    );
    let hookCalls = 0;
    let observedError: unknown;
    try {
      Object.defineProperty(Uint8Array, Symbol.hasInstance, {
        configurable: true,
        value() {
          hookCalls += 1;
          throw new Error(`hasInstance exposed ${token}`);
        },
      });
      try {
        await expectPinnedStdoutAccepted(stdout, token);
      } catch (error) {
        observedError = error;
      }
    } finally {
      if (previous === undefined) {
        Reflect.deleteProperty(Uint8Array, Symbol.hasInstance);
      } else {
        Object.defineProperty(Uint8Array, Symbol.hasInstance, previous);
      }
    }
    expect(hookCalls).toBe(0);
    if (observedError !== undefined) throw observedError;
  });

  test.each(['accessor', 'throwing method'] as const)(
    'rejects nonnative stdout with a %s toString without invoking it',
    async (shape) => {
      const secret = `hostile-${shape.replace(' ', '-')}-secret`;
      let calls = 0;
      const stdout = {};
      Object.defineProperty(stdout, 'toString', {
        enumerable: true,
        [shape === 'accessor' ? 'get' : 'value']() {
          calls += 1;
          throw new Error(`toString exposed ${secret}`);
        },
      });
      await expectPinnedSpawnFailure(() => ({ exitCode: 0, stdout }), [secret]);
      expect(calls).toBe(0);
    }
  );

  test('decodes Buffer stdout without consulting its toString accessor', async () => {
    const token = 'bun-buffer-token';
    let getterCalls = 0;
    const stdout = Buffer.from(`${token}\n`);
    Object.defineProperty(stdout, 'toString', {
      get() {
        getterCalls += 1;
        throw new Error(`toString exposed ${token}`);
      },
    });
    await expectPinnedStdoutAccepted(stdout, token);
    expect(getterCalls).toBe(0);
  });

  test.each([
    ['nonzero exit with own stdout data', 7, false],
    ['null exit with accessor output', null, true],
  ] as Array<[string, number | null, boolean]>)(
    'checks %s before reading output',
    async (_name, exitCode, accessorStdout) => {
      const secrets = [
        `${String(exitCode)}-exit-stdout-secret`,
        `${String(exitCode)}-exit-stderr-secret`,
      ];
      let stdoutCalls = 0;
      let stderrCalls = 0;
      const result = { exitCode } as unknown as SpawnResult;
      const stdout = Buffer.from(secrets[0]!);
      if (accessorStdout) {
        Object.defineProperty(result, 'stdout', {
          get() {
            stdoutCalls += 1;
            return stdout;
          },
        });
      } else {
        Object.defineProperty(stdout, 'toString', {
          get() {
            stdoutCalls += 1;
            throw new Error(`stdout exposed ${secrets[0]}`);
          },
        });
        Object.defineProperty(result, 'stdout', { value: stdout });
      }
      Object.defineProperty(result, 'stderr', {
        get() {
          stderrCalls += 1;
          throw new Error(`stderr exposed ${secrets[1]}`);
        },
      });

      await expectPinnedSpawnFailure(() => result, secrets);
      expect([stdoutCalls, stderrCalls]).toEqual([0, 0]);
    }
  );

  test.each([
    ['LF-separated values', 'pinned-secret\nsecond-secret'],
    ['CRLF-separated values', 'pinned-secret\r\nsecond-secret'],
    ['a NUL byte', 'pinned-secret\0suffix'],
    ['an internal space', 'pinned secret'],
    ['an internal tab', 'pinned\tsecret'],
    ['an internal ASCII control', 'pinned\x1fsecret'],
    ['non-ASCII characters', 'pinned-s\u00e9cret'],
    ['invalid bearer punctuation', 'pinned:secret'],
    ['misplaced bearer padding', 'pinned=secret'],
    ['padding without a value', '==='],
    ['multiple trailing line endings', 'pinned-secret\n\n'],
  ])('rejects RFC 6750 token output containing %s', async (_name, output) => {
    const stderr = 'stderr-process-secret';
    await expectPinnedSpawnFailure(
      () => successfulSpawnResult(Buffer.from(output), stderr),
      [output, stderr]
    );
  });
});

describe('GitHubClient transport — gh CLI (spawn stub)', () => {
  const stdoutFlows = [
    {
      name: 'REST',
      outputs: ['{"number":5,"node_id":"abc"}'],
      expected: { number: 5, node_id: 'abc' },
      invoke: (client: GitHubClient) =>
        client.getPullRequest('acme', 'widgets', 5),
    },
    {
      name: 'paginated REST',
      outputs: ['[]'],
      expected: [],
      invoke: (client: GitHubClient) =>
        client.getIssueComments('acme', 'widgets', 5),
    },
    {
      name: 'GraphQL',
      outputs: ['{"node_id":"abc"}', '{"data":{}}'],
      expected: undefined,
      invoke: (client: GitHubClient) =>
        client.publishDraftPR('acme', 'widgets', 5),
    },
  ];
  const stdoutFailureFlows = stdoutFlows.flatMap((flow) =>
    [
      { ...flow, failure: 'malformed UTF-8', exitCode: 0 as const },
      { ...flow, failure: 'null exit', exitCode: null },
      { ...flow, failure: 'nonzero exit', exitCode: 7 as const },
    ].map((testCase) => ({
      ...testCase,
      caseName: `${testCase.failure} for ${flow.name}`,
    }))
  );

  async function clientForSpawnResults(results: SpawnResult[]) {
    let calls = 0;
    const client = await GitHubClient.create({
      ghAuthProbe: authenticatedGitHubAuthProbe,
      spawn: (() => results[calls++]!) as SpawnSyncFn,
    });
    return { client, callCount: () => calls };
  }

  test('host-only auth skips gh auth token and continues through gh api', async () => {
    const spawn = makeSpawnStub('{"node_id":"abc"}');
    const client = await GitHubClient.create({
      ghAuthProbe: authenticatedGitHubAuthProbe,
      spawn: spawn.fn,
    });

    await client.getPullRequest('acme', 'widgets', 5);

    expect(spawn.calls).toHaveLength(1);
    expect(spawn.calls[0]?.slice(0, 3)).toEqual(['gh', 'api', '-X']);
    expect(spawn.calls[0]).not.toContain('token');
    expect(flagValue(spawn.calls[0], '--hostname')).toBe('github.com');
    expect(spawn.calls[0]).toContain('/repos/acme/widgets/pulls/5');
  });

  test.each(stdoutFlows)(
    'decodes raw Uint8Array stdout for $name',
    async ({ outputs, expected, invoke }) => {
      const results = outputs.map((output) =>
        successfulSpawnResult(new TextEncoder().encode(output))
      );
      const { client, callCount } = await clientForSpawnResults(results);
      await expect(invoke(client) as Promise<unknown>).resolves.toEqual(
        expected
      );
      expect(callCount()).toBe(outputs.length);
    }
  );

  test.each(stdoutFailureFlows)(
    'rejects/checks $caseName',
    async ({ name, outputs, exitCode, invoke }) => {
      const message = `${String(exitCode)} exit from ${name}`;
      const results = outputs
        .slice(0, -1)
        .map((output) =>
          successfulSpawnResult(new TextEncoder().encode(output))
        );
      results.push({
        exitCode,
        stdout: Uint8Array.of(0xc3, 0x28),
        stderr: Buffer.from(message),
      });
      const { client, callCount } = await clientForSpawnResults(results);
      const rejection = expect(invoke(client)).rejects;
      if (exitCode === 0) {
        await rejection.toThrow();
      } else {
        await rejection.toThrow(message);
      }
      expect(callCount()).toBe(outputs.length);
    }
  );

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

describe('GitHubClient AbortSignal transport contract', () => {
  let envSnap: ReturnType<typeof clearGhEnv>;

  beforeEach(() => {
    envSnap = clearGhEnv();
    Bun.env.AIDE_SECRET_SERVICE_OVERRIDE = MOCK_SERVICE;
    Bun.env.GITHUB_TOKEN = 'signal-test-token';
  });

  afterEach(() => {
    restoreGhEnv(envSnap);
    delete Bun.env.AIDE_SECRET_SERVICE_OVERRIDE;
  });

  test('forwards one signal through PR reads and create/update/comment/reply fetches', async () => {
    const seenSignals: Array<AbortSignal | null | undefined> = [];
    const fetchFn = (async (
      _input: string | URL | Request,
      init?: RequestInit
    ) => {
      seenSignals.push(init?.signal);
      return Response.json({ number: 7, id: 11 });
    }) as unknown as FetchFn;
    const client = await GitHubClient.create({
      ghAuthProbe: unavailableGitHubAuthProbe,
      fetch: fetchFn,
    });
    const controller = new AbortController();

    await client.getPullRequest('acme', 'widgets', 7, controller.signal);
    await client.createPullRequest(
      'acme',
      'widgets',
      'feature',
      'main',
      'Title',
      'Body',
      {},
      controller.signal
    );
    await client.updatePullRequest(
      'acme',
      'widgets',
      7,
      { title: 'Updated' },
      controller.signal
    );
    await client.createIssueComment(
      'acme',
      'widgets',
      7,
      'Comment',
      controller.signal
    );
    await client.replyToReviewComment(
      'acme',
      'widgets',
      7,
      11,
      'Reply',
      controller.signal
    );

    expect(seenSignals).toEqual(Array(5).fill(controller.signal));
  });

  test('aborting a read cancels fetch and prevents post-exit completion', async () => {
    let aborted = 0;
    let completed = 0;
    const fetchFn = (async (
      _input: string | URL | Request,
      init?: RequestInit
    ) =>
      new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => {
          completed += 1;
          resolve(Response.json({ number: 7 }));
        }, 40);
        init?.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            aborted += 1;
            reject(init.signal?.reason);
          },
          { once: true }
        );
      })) as unknown as FetchFn;
    const client = await GitHubClient.create({
      ghAuthProbe: unavailableGitHubAuthProbe,
      fetch: fetchFn,
    });
    const controller = new AbortController();
    const pending = client.getPullRequest(
      'acme',
      'widgets',
      7,
      controller.signal
    );
    controller.abort();

    expect(
      await pending.then(
        () => 'resolved',
        () => 'rejected'
      )
    ).toBe('rejected');
    expect({ aborted, completed }).toEqual({ aborted: 1, completed: 0 });
    await Bun.sleep(60);
    expect({ aborted, completed }).toEqual({ aborted: 1, completed: 0 });
  });

  test('pagination carries one signal to the next page and aborts without post-exit work', async () => {
    const page1 = 'https://api.github.com/repos/acme/widgets/issues/7/comments';
    const page2 = `${page1}?page=2`;
    const seen: Array<{
      readonly url: string;
      readonly signal: AbortSignal | null | undefined;
    }> = [];
    let secondPageStarted = 0;
    let secondPageAborted = 0;
    let secondPageCompleted = 0;
    const fetchFn = (async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const url = String(input);
      seen.push({ url, signal: init?.signal });
      if (url === page1) {
        return Response.json([], {
          headers: { Link: `<${page2}>; rel="next"` },
        });
      }
      secondPageStarted += 1;
      return new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => {
          secondPageCompleted += 1;
          resolve(Response.json([]));
        }, 40);
        init?.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            secondPageAborted += 1;
            reject(init.signal?.reason);
          },
          { once: true }
        );
      });
    }) as unknown as FetchFn;
    const client = await GitHubClient.create({
      ghAuthProbe: unavailableGitHubAuthProbe,
      fetch: fetchFn,
    });
    const controller = new AbortController();
    const pending = client.getIssueComments(
      'acme',
      'widgets',
      7,
      controller.signal
    );
    while (secondPageStarted === 0) await Bun.sleep(1);
    controller.abort();

    await expect(pending).rejects.toBeDefined();
    expect(seen).toEqual([
      { url: page1, signal: controller.signal },
      { url: page2, signal: controller.signal },
    ]);
    expect({ secondPageAborted, secondPageCompleted }).toEqual({
      secondPageAborted: 1,
      secondPageCompleted: 0,
    });
    await Bun.sleep(60);
    expect({ secondPageAborted, secondPageCompleted }).toEqual({
      secondPageAborted: 1,
      secondPageCompleted: 0,
    });
  });

  test('same-origin redirects preserve signal and label mutation request semantics', async () => {
    const requests: Array<{
      readonly url: string;
      readonly method: string | undefined;
      readonly body: RequestInit['body'];
      readonly signal: AbortSignal | null | undefined;
    }> = [];
    const addUrl = 'https://api.github.com/repos/acme/widgets/issues/7/labels';
    const redirectedAddUrl = `${addUrl}?redirected=1`;
    const removeUrl = `${addUrl}/needs%20review`;
    const fetchFn = (async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const url = String(input);
      requests.push({
        url,
        method: init?.method,
        body: init?.body,
        signal: init?.signal,
      });
      if (url === addUrl) {
        return new Response(null, {
          status: 307,
          headers: { Location: redirectedAddUrl },
        });
      }
      return url === removeUrl
        ? new Response(null, { status: 204 })
        : Response.json([]);
    }) as unknown as FetchFn;
    const client = await GitHubClient.create({
      ghAuthProbe: unavailableGitHubAuthProbe,
      fetch: fetchFn,
    });
    const controller = new AbortController();

    await client.addLabels('acme', 'widgets', 7, ['ready'], controller.signal);
    await client.removeLabel(
      'acme',
      'widgets',
      7,
      'needs review',
      controller.signal
    );

    expect(requests.map(({ url }) => url)).toEqual([
      addUrl,
      redirectedAddUrl,
      removeUrl,
    ]);
    expect(requests.map(({ method }) => method)).toEqual([
      'POST',
      'POST',
      'DELETE',
    ]);
    expect(requests[1]?.body).toBe(requests[0]?.body);
    expect(requests.every(({ signal }) => signal === controller.signal)).toBe(
      true
    );
  });

  test('draft GraphQL transitions carry one signal through REST lookup and mutation', async () => {
    const requests: Array<{
      readonly url: string;
      readonly method: string | undefined;
      readonly signal: AbortSignal | null | undefined;
    }> = [];
    const fetchFn = (async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const url = String(input);
      requests.push({ url, method: init?.method, signal: init?.signal });
      return url === 'https://api.github.com/graphql'
        ? Response.json({})
        : Response.json({ number: 7, node_id: 'PR_7' });
    }) as unknown as FetchFn;
    const client = await GitHubClient.create({
      ghAuthProbe: unavailableGitHubAuthProbe,
      fetch: fetchFn,
    });
    const controller = new AbortController();

    await client.convertToDraft('acme', 'widgets', 7, controller.signal);
    await client.publishDraftPR('acme', 'widgets', 7, controller.signal);

    expect(requests.map(({ url }) => url)).toEqual([
      'https://api.github.com/repos/acme/widgets/pulls/7',
      'https://api.github.com/graphql',
      'https://api.github.com/repos/acme/widgets/pulls/7',
      'https://api.github.com/graphql',
    ]);
    expect(requests.map(({ method }) => method)).toEqual([
      'GET',
      'POST',
      'GET',
      'POST',
    ]);
    expect(requests.every(({ signal }) => signal === controller.signal)).toBe(
      true
    );
  });
});
