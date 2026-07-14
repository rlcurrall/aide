import { afterEach, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

import {
  resolveGitHubAuthRequest,
  type CanonicalGitHubAuthRequest,
} from './github-auth.js';
import {
  resolveGitHubCredential,
  validateGitHubAuthProbeResult,
} from './github-credential-resolver.js';
import type { GitHubAuthProbe } from './gh-utils.js';
import { installMockSecrets } from './test-helpers.js';

const probeFixturePath = fileURLToPath(
  new URL('./github-credential-resolver-probe.fixture.ts', import.meta.url)
);
type ProbeFixtureMode = 'reachability-control' | 'production';
const probeFixtureChildren = new Set<ReturnType<typeof Bun.spawn>>();
const parentValueDescriptor = Object.getOwnPropertyDescriptor(
  Object.prototype,
  'value'
);

afterEach(async () => {
  for (const child of probeFixtureChildren) child.kill('SIGKILL');
  await Promise.allSettled(
    [...probeFixtureChildren].map((child) => child.exited)
  );
  probeFixtureChildren.clear();
});

async function runProbeFixture(mode: ProbeFixtureMode) {
  const environment = { ...Bun.env };
  delete environment.FORCE_COLOR;
  delete environment.NO_COLOR;
  const child = Bun.spawn({
    cmd: [process.execPath, 'run', probeFixturePath, mode],
    cwd: import.meta.dir,
    env: environment,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  probeFixtureChildren.add(child);

  const outcome = await Promise.race([
    Promise.all([
      child.exited,
      new Response(child.stdout as ReadableStream<Uint8Array>).text(),
      new Response(child.stderr as ReadableStream<Uint8Array>).text(),
    ]).then(([exitCode, stdout, stderr]) => ({
      status: 'exited' as const,
      exitCode,
      stdout,
      stderr,
    })),
    Bun.sleep(2_000).then(() => ({ status: 'deadline' as const })),
  ]);
  if (outcome.status === 'deadline') {
    child.kill('SIGKILL');
    await child.exited;
    probeFixtureChildren.delete(child);
    throw new Error(`Probe fixture '${mode}' exceeded its hard deadline`);
  }
  probeFixtureChildren.delete(child);
  return {
    ...outcome,
    value: JSON.parse(outcome.stdout.trim()) as Record<string, unknown>,
  };
}

function accountRequest() {
  const request = resolveGitHubAuthRequest({
    scope: {
      providerId: 'github',
      host: 'github.com',
      account: 'OctoCat',
    },
  });
  if (!request.ok) throw new Error(request.reason);
  return request;
}

function customHostRequest() {
  const request = resolveGitHubAuthRequest({ host: 'acme.ghe.com' });
  if (!request.ok) throw new Error(request.reason);
  return request;
}

function publicHostRequest() {
  const request = resolveGitHubAuthRequest({ host: 'github.com' });
  if (!request.ok) throw new Error(request.reason);
  return request;
}

describe('validateGitHubAuthProbeResult', () => {
  test('returns a newly constructed canonical authenticated result', () => {
    const request = accountRequest();
    const result = {
      kind: 'authenticated' as const,
      host: 'GITHUB.COM',
      account: 'OCTOCAT',
    };

    const validated = validateGitHubAuthProbeResult(request, result);
    expect(validated).toEqual({
      kind: 'authenticated',
      host: 'github.com',
      account: 'octocat',
    });
    expect(validated).not.toBe(result);
  });

  test('fails closed for arrays, booleans, malformed, host-only, and foreign results', () => {
    const request = accountRequest();
    for (const result of [
      true,
      false,
      null,
      [],
      { kind: 'unexpected', host: 'github.com' },
      { kind: 'authenticated' },
      { kind: 'authenticated', host: 'foreign.example', account: 'octocat' },
      { kind: 'authenticated', host: 'github.com' },
      { kind: 'authenticated', host: 'github.com', account: 42 },
    ]) {
      expect(validateGitHubAuthProbeResult(request, result)).toMatchObject({
        kind: 'unavailable',
        host: 'github.com',
      });
    }
  });

  test('fails closed when revoked proxies throw during result classification', () => {
    const request = accountRequest();
    const revokedResults = [Proxy.revocable({}, {}), Proxy.revocable([], {})];

    for (const revoked of revokedResults) {
      revoked.revoke();
      expect(() =>
        validateGitHubAuthProbeResult(request, revoked.proxy)
      ).not.toThrow();
      expect(
        validateGitHubAuthProbeResult(request, revoked.proxy)
      ).toMatchObject({
        kind: 'unavailable',
        host: 'github.com',
      });
    }
  });

  test('rejects live descriptor proxies without invoking reflection traps', () => {
    const request = accountRequest();
    let descriptorCalls = 0;
    const values: Record<PropertyKey, unknown> = {
      kind: 'authenticated',
      host: 'github.com',
      account: 'octocat',
    };
    const result = new Proxy(
      {},
      {
        getOwnPropertyDescriptor(_target, property) {
          descriptorCalls += 1;
          return {
            configurable: true,
            enumerable: true,
            value: values[property],
            writable: true,
          };
        },
      }
    );

    expect(validateGitHubAuthProbeResult(request, result)).toMatchObject({
      kind: 'unavailable',
      host: 'github.com',
    });
    expect(descriptorCalls).toBe(0);
  });

  test('rejects inherited discriminator, required fields, and optional account', () => {
    const request = accountRequest();
    const results = [
      Object.assign(Object.create({ kind: 'authenticated' }), {
        host: 'github.com',
        account: 'octocat',
      }),
      Object.assign(Object.create({ host: 'github.com' }), {
        kind: 'authenticated',
        account: 'octocat',
      }),
      Object.assign(Object.create({ account: 'octocat' }), {
        kind: 'authenticated',
        host: 'github.com',
      }),
      Object.assign(Object.create({ reason: 'not available' }), {
        kind: 'unavailable',
        host: 'github.com',
      }),
      Object.assign(Object.create({ activeAccount: 'hubot' }), {
        kind: 'account-mismatch',
        code: 'account-mismatch',
        host: 'github.com',
        requestedAccount: 'octocat',
        reason: 'active account differs',
      }),
    ];

    for (const result of results) {
      expect(validateGitHubAuthProbeResult(request, result)).toMatchObject({
        kind: 'unavailable',
        host: 'github.com',
      });
    }
  });

  test('never invokes throwing or side-effect accessors', () => {
    const request = accountRequest();
    let getterCalls = 0;
    const withAccessor = (
      fields: Record<string, unknown>,
      key: string,
      throws: boolean
    ) => {
      const result = { ...fields };
      Object.defineProperty(result, key, {
        enumerable: true,
        get() {
          getterCalls += 1;
          if (throws) throw new Error(`accessed ${key}`);
          return fields[key];
        },
      });
      return result;
    };
    const authenticated = {
      kind: 'authenticated',
      host: 'github.com',
      account: 'octocat',
    };
    const mismatch = {
      kind: 'account-mismatch',
      code: 'account-mismatch',
      host: 'github.com',
      requestedAccount: 'octocat',
      activeAccount: 'hubot',
      reason: 'active account differs',
    };
    const unavailable = {
      kind: 'unavailable',
      host: 'github.com',
      reason: 'not available',
    };
    const results = [
      withAccessor(authenticated, 'kind', true),
      withAccessor(authenticated, 'host', true),
      withAccessor(authenticated, 'account', false),
      withAccessor(mismatch, 'code', true),
      withAccessor(mismatch, 'requestedAccount', false),
      withAccessor(mismatch, 'activeAccount', true),
      withAccessor(mismatch, 'reason', false),
      withAccessor(unavailable, 'reason', true),
    ];

    for (const result of results) {
      expect(() =>
        validateGitHubAuthProbeResult(request, result)
      ).not.toThrow();
      expect(validateGitHubAuthProbeResult(request, result)).toMatchObject({
        kind: 'unavailable',
        host: 'github.com',
      });
    }
    expect(getterCalls).toBe(0);
  });

  test('proves the old prototype-consulting probe path reaches Object.prototype.value', async () => {
    const result = await runProbeFixture('reachability-control');

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).not.toContain('ATTACKER');
    expect(result.value).toEqual({
      schemaVersion: 1,
      mode: 'reachability-control',
      controlReached: true,
      result: null,
      kindGetterGets: 0,
      prototypeValueGets: 1,
      restored: true,
    });
    expect(Object.getOwnPropertyDescriptor(Object.prototype, 'value')).toEqual(
      parentValueDescriptor
    );
  }, 4_000);

  test('does not execute Object.prototype.value when validating accessor-backed probes', async () => {
    const result = await runProbeFixture('production');

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).not.toContain('ATTACKER');
    expect(result.value).toEqual({
      schemaVersion: 1,
      mode: 'production',
      controlReached: false,
      result: {
        kind: 'unavailable',
        host: 'github.com',
        reason:
          'GitHub CLI auth probe returned an invalid result: kind must be an own data property.',
      },
      kindGetterGets: 0,
      prototypeValueGets: 0,
      restored: true,
    });
    expect(Object.getOwnPropertyDescriptor(Object.prototype, 'value')).toEqual(
      parentValueDescriptor
    );
  }, 4_000);

  test('turns an authenticated wrong account into a typed mismatch', () => {
    const result = validateGitHubAuthProbeResult(accountRequest(), {
      kind: 'authenticated',
      host: 'github.com',
      account: 'Hubot',
    });

    expect(result).toMatchObject({
      kind: 'account-mismatch',
      code: 'account-mismatch',
      host: 'github.com',
      requestedAccount: 'octocat',
      activeAccount: 'hubot',
    });
  });

  test('returns a canonical typed mismatch and rejects dishonest variants', () => {
    const request = accountRequest();
    const mismatch = {
      kind: 'account-mismatch' as const,
      code: 'account-mismatch' as const,
      host: 'GITHUB.COM',
      requestedAccount: 'OCTOCAT',
      activeAccount: 'Hubot',
      reason: 'active account differs',
    };

    const validated = validateGitHubAuthProbeResult(request, mismatch);
    expect(validated).toEqual({
      kind: 'account-mismatch',
      code: 'account-mismatch',
      host: 'github.com',
      requestedAccount: 'octocat',
      activeAccount: 'hubot',
      reason: 'active account differs',
    });
    expect(validated).not.toBe(mismatch);

    for (const dishonest of [
      { ...mismatch, requestedAccount: 'hubot' },
      { ...mismatch, activeAccount: 'octocat' },
      { ...mismatch, reason: 42 },
      { ...mismatch, host: 'foreign.example' },
    ]) {
      expect(validateGitHubAuthProbeResult(request, dishonest)).toMatchObject({
        kind: 'unavailable',
        host: 'github.com',
      });
    }
  });

  test('returns a newly constructed unavailable result with a validated optional reason', () => {
    const input = {
      kind: 'unavailable' as const,
      host: 'GITHUB.COM',
      reason: 'gh is unavailable',
    };
    const validated = validateGitHubAuthProbeResult(accountRequest(), input);

    expect(validated).toEqual({
      kind: 'unavailable',
      host: 'github.com',
      reason: 'gh is unavailable',
    });
    expect(validated).not.toBe(input);
    expect(
      validateGitHubAuthProbeResult(accountRequest(), {
        ...input,
        reason: 42,
      })
    ).toMatchObject({ kind: 'unavailable', host: 'github.com' });
  });
});

describe('resolveGitHubCredential hostile probe results', () => {
  test('does not swallow an exception thrown directly by the probe', async () => {
    const error = new Error('probe failed intentionally');

    await expect(
      resolveGitHubCredential(publicHostRequest(), {
        env: {},
        ghAuthProbe: () => {
          throw error;
        },
      })
    ).rejects.toBe(error);
  });

  test('does not traverse canonical request prototypes while capturing fields', async () => {
    let hasCalls = 0;
    const prototype = new Proxy(
      { account: 'attacker' },
      {
        has() {
          hasCalls += 1;
          throw new Error('prototype has trap must not run');
        },
      }
    );
    const request = Object.assign(Object.create(prototype), {
      ok: true as const,
      host: 'github.com',
    }) as CanonicalGitHubAuthRequest;
    const restoreSecrets = installMockSecrets(new Map());

    try {
      const resolved = await resolveGitHubCredential(request, {
        env: { GITHUB_TOKEN: 'own-token' },
        ghAuthProbe: (candidate) => ({
          kind: 'unavailable',
          host: candidate.host,
        }),
      });

      expect(resolved).toEqual({
        kind: 'env',
        credential: {
          host: 'github.com',
          token: 'own-token',
          variable: 'GITHUB_TOKEN',
        },
      });
      expect(hasCalls).toBe(0);
    } finally {
      restoreSecrets();
    }
  });

  test('passes a detached frozen null-prototype request snapshot to the probe', async () => {
    const request = accountRequest();
    const restoreSecrets = installMockSecrets(new Map());
    let probedRequest: CanonicalGitHubAuthRequest | undefined;

    try {
      await resolveGitHubCredential(request, {
        env: {},
        ghAuthProbe: (candidate) => {
          probedRequest = candidate;
          return { kind: 'unavailable', host: candidate.host };
        },
      });

      expect(probedRequest).not.toBe(request);
      expect(probedRequest?.keyringScope).not.toBe(request.keyringScope);
      expect(Object.getPrototypeOf(probedRequest!)).toBeNull();
      expect(Object.getPrototypeOf(probedRequest?.keyringScope)).toBeNull();
      expect(Object.isFrozen(probedRequest)).toBe(true);
      expect(Object.isFrozen(probedRequest?.keyringScope)).toBe(true);
    } finally {
      restoreSecrets();
    }
  });

  test('cannot select gh-cli from inherited or accessor-backed fields', async () => {
    const request = accountRequest();
    let getterCalls = 0;
    const accessorBacked = {
      kind: 'authenticated',
      host: 'github.com',
    };
    Object.defineProperty(accessorBacked, 'account', {
      get() {
        getterCalls += 1;
        return 'octocat';
      },
    });
    const throwingAccessor = {
      host: 'github.com',
      account: 'octocat',
    };
    Object.defineProperty(throwingAccessor, 'kind', {
      get() {
        getterCalls += 1;
        throw new Error('kind getter must not run');
      },
    });
    const inherited = Object.assign(Object.create({ kind: 'authenticated' }), {
      host: 'github.com',
      account: 'octocat',
    });
    const restoreSecrets = installMockSecrets(new Map());

    try {
      for (const hostile of [inherited, accessorBacked, throwingAccessor]) {
        const resolved = await resolveGitHubCredential(request, {
          env: {},
          ghAuthProbe: (() => hostile) as unknown as GitHubAuthProbe,
        });
        expect(resolved.kind).not.toBe('gh-cli');
        expect(resolved.kind).toBe('missing');
      }
    } finally {
      restoreSecrets();
    }
    expect(getterCalls).toBe(0);
  });

  test('snapshots own environment credentials before probe reflection', async () => {
    const env = { GITHUB_TOKEN: 'original-token' };
    const restoreSecrets = installMockSecrets(new Map());

    try {
      const resolved = await resolveGitHubCredential(publicHostRequest(), {
        env,
        ghAuthProbe: (candidate) => {
          env.GITHUB_TOKEN = 'mutated-token';
          return { kind: 'unavailable', host: candidate.host };
        },
      });

      expect(resolved).toEqual({
        kind: 'env',
        credential: {
          host: 'github.com',
          token: 'original-token',
          variable: 'GITHUB_TOKEN',
        },
      });
    } finally {
      restoreSecrets();
    }
  });

  test('does not select inherited environment bindings', async () => {
    const restoreSecrets = installMockSecrets(new Map());

    try {
      for (const [request, injected] of [
        [publicHostRequest(), { GITHUB_TOKEN: 'inherited-public-token' }],
        [
          customHostRequest(),
          {
            GH_HOST: 'acme.ghe.com',
            GH_ENTERPRISE_TOKEN: 'inherited-enterprise-token',
          },
        ],
      ] as const) {
        const env = Object.create(injected) as Record<string, string>;
        const resolved = await resolveGitHubCredential(request, {
          env,
          ghAuthProbe: () => ({
            kind: 'unavailable' as const,
            host: request.host,
          }),
        });

        expect(resolved).toEqual({ kind: 'missing' });
      }
    } finally {
      restoreSecrets();
    }
  });

  test('keeps an inherited request account out of key selection and stored validation', async () => {
    const request = Object.assign(
      Object.create({ account: 'attacker' }),
      publicHostRequest()
    ) as CanonicalGitHubAuthRequest;
    const requestedKeys: string[] = [];
    const store = new (class extends Map<string, string> {
      override get(key: string): string | undefined {
        requestedKeys.push(key);
        return super.get(key);
      }
    })([
      [
        'aide:auth:github:host:github.com',
        JSON.stringify({
          token: 'host-only-token',
          identity: { host: 'github.com' },
        }),
      ],
      [
        'aide:auth:github:host:github.com:account:attacker',
        JSON.stringify({
          token: 'attacker-token',
          identity: { host: 'github.com', account: 'attacker' },
        }),
      ],
    ]);
    const restoreSecrets = installMockSecrets(store);

    try {
      expect(
        Reflect.getOwnPropertyDescriptor(request, 'account')
      ).toBeUndefined();
      expect(
        Reflect.getOwnPropertyDescriptor(
          Object.getPrototypeOf(request) as object,
          'account'
        )
      ).toMatchObject({ value: 'attacker' });

      const resolved = await resolveGitHubCredential(request, {
        env: {},
        ghAuthProbe: (candidate) => ({
          kind: 'unavailable',
          host: candidate.host,
        }),
      });

      // Inherited request data is outside the canonical identity. The resolver
      // snapshots only own fields, so this remains a host-only request and its
      // matching host-scoped credential is valid. The distinct global
      // Object.prototype mutation case (which also affects parsed keyring JSON)
      // remains covered by the isolated auth-provider boundary fixture.
      expect(requestedKeys).toEqual(['aide:auth:github:host:github.com']);
      expect(resolved).toEqual({
        kind: 'stored',
        host: 'github.com',
        account: undefined,
        token: 'host-only-token',
      });
    } finally {
      restoreSecrets();
    }
  });

  test('fails closed before probing or credential fallback for hostile canonical fields', async () => {
    let getterCalls = 0;
    let probeCalls = 0;
    const accessorRequest = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessorRequest, 'ok', { value: true });
    Object.defineProperty(accessorRequest, 'host', {
      get() {
        getterCalls += 1;
        return 'github.com';
      },
    });
    const inheritedHostRequest = Object.assign(
      Object.create({ host: 'github.com' }) as Record<string, unknown>,
      { ok: true }
    );
    const revokedScope = Proxy.revocable({}, {});
    revokedScope.revoke();
    const proxyScopeRequest = {
      ok: true,
      host: 'github.com',
      keyringScope: revokedScope.proxy,
    };
    const restoreSecrets = installMockSecrets(
      new Map([['aide:github', JSON.stringify({ token: 'stored-token' })]])
    );

    try {
      for (const request of [
        accessorRequest,
        inheritedHostRequest,
        proxyScopeRequest,
      ]) {
        const resolved = await resolveGitHubCredential(
          request as unknown as CanonicalGitHubAuthRequest,
          {
            env: { GITHUB_TOKEN: 'environment-token' },
            ghAuthProbe: () => {
              probeCalls += 1;
              return { kind: 'authenticated', host: 'github.com' };
            },
          }
        );
        expect(resolved.kind).toBe('failure');
      }
    } finally {
      restoreSecrets();
    }

    expect(getterCalls).toBe(0);
    expect(probeCalls).toBe(0);
  });

  test('keeps host-only env eligibility isolated from inherited account data', async () => {
    const request = Object.assign(
      Object.create({ account: 'attacker' }),
      publicHostRequest()
    ) as CanonicalGitHubAuthRequest;
    let descriptorCalls = 0;
    let probedRequest: Parameters<GitHubAuthProbe>[0] | undefined;
    const restoreSecrets = installMockSecrets(new Map());

    try {
      const resolved = await resolveGitHubCredential(request, {
        env: { GITHUB_TOKEN: 'host-only-env-token' },
        ghAuthProbe: (candidate) => {
          probedRequest = candidate;
          return new Proxy(
            { kind: 'unavailable' as const, host: 'github.com' },
            {
              getOwnPropertyDescriptor(target, property) {
                if (property === 'kind') descriptorCalls += 1;
                return Reflect.getOwnPropertyDescriptor(target, property);
              },
            }
          );
        },
      });

      expect(resolved).toEqual({
        kind: 'env',
        credential: {
          host: 'github.com',
          token: 'host-only-env-token',
          variable: 'GITHUB_TOKEN',
        },
      });
      expect(descriptorCalls).toBe(0);
      expect(probedRequest).toBeDefined();
      expect(Object.getPrototypeOf(probedRequest)).toBeNull();
      expect(Object.hasOwn(probedRequest!, 'account')).toBe(true);
      expect(probedRequest?.account).toBeUndefined();
      expect(Object.isFrozen(probedRequest)).toBe(true);
      expect(Object.getPrototypeOf(probedRequest?.keyringScope)).toBeNull();
      expect(Object.isFrozen(probedRequest?.keyringScope)).toBe(true);
      for (const field of ['id', 'providerId', 'host', 'org', 'account']) {
        const descriptor = Object.getOwnPropertyDescriptor(
          probedRequest!.keyringScope!,
          field
        );
        expect(descriptor).toMatchObject({
          configurable: false,
          enumerable: true,
          writable: false,
        });
      }
      expect(probedRequest?.keyringScope?.account).toBeUndefined();
    } finally {
      restoreSecrets();
    }
  });

  test('rejects a cross-account keyring payload with an inherited request account', async () => {
    const request = Object.assign(
      Object.create({ account: 'attacker' }),
      publicHostRequest()
    ) as CanonicalGitHubAuthRequest;
    const store = new Map([
      [
        'aide:auth:github:host:github.com',
        JSON.stringify({
          token: 'wrong-host-key-token',
          identity: { host: 'github.com', account: 'payload-attacker' },
        }),
      ],
      [
        'aide:auth:github:host:github.com:account:attacker',
        JSON.stringify({
          token: 'attacker-token',
          identity: { host: 'github.com', account: 'attacker' },
        }),
      ],
    ]);
    const restoreSecrets = installMockSecrets(store);

    try {
      const resolved = await resolveGitHubCredential(request, {
        env: {},
        ghAuthProbe: () => ({ kind: 'unavailable', host: 'github.com' }),
      });

      expect(resolved).toEqual({
        kind: 'failure',
        code: 'account-mismatch',
        reason:
          "Stored GitHub credential account 'payload-attacker' does not match requested account '(host-only)'.",
      });
    } finally {
      restoreSecrets();
    }
  });

  test('does not read an inherited account getter while validating a stored host-only payload', async () => {
    let inheritedReads = 0;
    const requestPrototype = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(requestPrototype, 'account', {
      get() {
        inheritedReads += 1;
        return 'attacker';
      },
    });
    const request = Object.assign(
      Object.create(requestPrototype),
      publicHostRequest()
    ) as CanonicalGitHubAuthRequest;
    const store = new Map([
      [
        'aide:auth:github:host:github.com',
        JSON.stringify({
          token: 'host-only-token',
          identity: { host: 'github.com' },
        }),
      ],
    ]);
    const restoreSecrets = installMockSecrets(store);

    try {
      const resolved = await resolveGitHubCredential(request, {
        env: {},
        ghAuthProbe: () => ({ kind: 'unavailable', host: 'github.com' }),
      });

      expect(resolved).toEqual({
        kind: 'stored',
        host: 'github.com',
        token: 'host-only-token',
      });
      expect(inheritedReads).toBe(0);
    } finally {
      restoreSecrets();
    }
  });

  test('keeps an account-qualified request ineligible for unqualified env after probe mutation', async () => {
    const request = accountRequest();
    let probedRequest: Parameters<GitHubAuthProbe>[0] | undefined;
    const restoreSecrets = installMockSecrets(new Map());

    try {
      const resolved = await resolveGitHubCredential(request, {
        env: { GITHUB_TOKEN: 'unqualified-token' },
        ghAuthProbe: (candidate) => {
          probedRequest = candidate;
          return new Proxy(
            { kind: 'unavailable' as const, host: 'github.com' },
            {
              getOwnPropertyDescriptor(target, property) {
                if (property === 'kind') {
                  Reflect.deleteProperty(candidate, 'account');
                }
                return Reflect.getOwnPropertyDescriptor(target, property);
              },
            }
          );
        },
      });

      expect(resolved).toEqual({ kind: 'missing' });
      expect(request.account).toBe('octocat');
      expect(probedRequest).not.toBe(request);
      expect(Object.isFrozen(probedRequest)).toBe(true);
    } finally {
      restoreSecrets();
    }
  });

  test('keeps a public env token bound away from a custom host after probe mutation', async () => {
    const request = customHostRequest();
    let probedRequest: Parameters<GitHubAuthProbe>[0] | undefined;
    const restoreSecrets = installMockSecrets(new Map());

    try {
      const resolved = await resolveGitHubCredential(request, {
        env: { GITHUB_TOKEN: 'public-token' },
        ghAuthProbe: (candidate) => {
          probedRequest = candidate;
          return new Proxy(
            { kind: 'unavailable' as const, host: 'github.com' },
            {
              getOwnPropertyDescriptor(target, property) {
                if (property === 'host') {
                  Reflect.set(candidate, 'host', 'github.com');
                }
                return Reflect.getOwnPropertyDescriptor(target, property);
              },
            }
          );
        },
      });

      expect(resolved).toEqual({ kind: 'missing' });
      expect(request.host).toBe('acme.ghe.com');
      expect(probedRequest).not.toBe(request);
      expect(Object.isFrozen(probedRequest)).toBe(true);
    } finally {
      restoreSecrets();
    }
  });

  test('uses the private nested keyring scope after probe mutation', async () => {
    const request = accountRequest();
    const store = new Map([
      [
        'aide:auth:github:host:github.com:account:octocat',
        JSON.stringify({
          token: 'account-token',
          identity: { host: 'github.com', account: 'octocat' },
        }),
      ],
    ]);
    let probedRequest: Parameters<GitHubAuthProbe>[0] | undefined;
    const restoreSecrets = installMockSecrets(store);

    try {
      const resolved = await resolveGitHubCredential(request, {
        env: {},
        ghAuthProbe: (candidate) => {
          probedRequest = candidate;
          if (candidate.keyringScope !== undefined) {
            Reflect.deleteProperty(candidate.keyringScope, 'account');
          }
          return { kind: 'unavailable', host: candidate.host };
        },
      });

      expect(resolved).toEqual({
        kind: 'stored',
        host: 'github.com',
        account: 'octocat',
        token: 'account-token',
      });
      expect(request.keyringScope?.account).toBe('octocat');
      expect(probedRequest).not.toBe(request);
      expect(probedRequest?.keyringScope).not.toBe(request.keyringScope);
      expect(Object.isFrozen(probedRequest)).toBe(true);
      expect(Object.isFrozen(probedRequest?.keyringScope)).toBe(true);
    } finally {
      restoreSecrets();
    }
  });
});
