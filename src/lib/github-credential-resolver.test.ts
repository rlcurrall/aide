import { describe, expect, test } from 'bun:test';

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

function restoreObjectPrototypeProperty(
  name: string,
  descriptor: PropertyDescriptor | undefined
): void {
  Reflect.deleteProperty(Object.prototype, name);
  if (descriptor !== undefined) {
    Object.defineProperty(Object.prototype, name, descriptor);
  }
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

  test('passes a second frozen null-prototype request snapshot to the probe', async () => {
    const request = accountRequest();
    const frozenCanonicalRequests: CanonicalGitHubAuthRequest[] = [];
    const freezeDescriptor = Object.getOwnPropertyDescriptor(Object, 'freeze');
    const originalFreeze = Object.freeze;
    const restoreSecrets = installMockSecrets(new Map());
    let probedRequest: CanonicalGitHubAuthRequest | undefined;

    Object.defineProperty(Object, 'freeze', {
      configurable: true,
      value: (<T>(value: T): Readonly<T> => {
        if (
          typeof value === 'object' &&
          value !== null &&
          Object.hasOwn(value, 'ok')
        ) {
          frozenCanonicalRequests.push(
            value as unknown as CanonicalGitHubAuthRequest
          );
        }
        return originalFreeze(value);
      }) as typeof Object.freeze,
      writable: true,
    });

    try {
      await resolveGitHubCredential(request, {
        env: {},
        ghAuthProbe: (candidate) => {
          probedRequest = candidate;
          return { kind: 'unavailable', host: candidate.host };
        },
      });

      expect(frozenCanonicalRequests).toHaveLength(2);
      expect(probedRequest).toBe(frozenCanonicalRequests[1]);
      expect(probedRequest).not.toBe(frozenCanonicalRequests[0]);
      expect(probedRequest?.keyringScope).not.toBe(
        frozenCanonicalRequests[0]?.keyringScope
      );
      expect(Object.getPrototypeOf(probedRequest!)).toBeNull();
      expect(Object.getPrototypeOf(probedRequest?.keyringScope)).toBeNull();
      expect(Object.isFrozen(probedRequest)).toBe(true);
      expect(Object.isFrozen(probedRequest?.keyringScope)).toBe(true);
    } finally {
      if (freezeDescriptor === undefined) {
        Reflect.deleteProperty(Object, 'freeze');
      } else {
        Object.defineProperty(Object, 'freeze', freezeDescriptor);
      }
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

  test('does not select inherited env bindings introduced during probe reflection', async () => {
    const properties = [
      'GITHUB_TOKEN',
      'GH_ENTERPRISE_TOKEN',
      'GH_HOST',
    ] as const;
    const originals = new Map(
      properties.map((property) => [
        property,
        Object.getOwnPropertyDescriptor(Object.prototype, property),
      ])
    );
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
        const resolved = await resolveGitHubCredential(request, {
          env: {},
          ghAuthProbe: () =>
            new Proxy(
              { kind: 'unavailable' as const, host: request.host },
              {
                getOwnPropertyDescriptor(target, property) {
                  if (property === 'kind') {
                    for (const [name, value] of Object.entries(injected)) {
                      Object.defineProperty(Object.prototype, name, {
                        configurable: true,
                        value,
                        writable: true,
                      });
                    }
                  }
                  return Reflect.getOwnPropertyDescriptor(target, property);
                },
              }
            ),
        });

        expect(resolved).toEqual({ kind: 'missing' });
        for (const property of properties) {
          restoreObjectPrototypeProperty(property, originals.get(property));
        }
      }
    } finally {
      for (const property of properties) {
        restoreObjectPrototypeProperty(property, originals.get(property));
      }
      restoreSecrets();
    }
  });

  test('keeps an inherited account out of key selection and rejects it in stored validation', async () => {
    const request = publicHostRequest();
    const originalAccountDescriptor = Object.getOwnPropertyDescriptor(
      Object.prototype,
      'account'
    );
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
      Object.defineProperty(Object.prototype, 'account', {
        configurable: true,
        value: 'attacker',
        writable: true,
      });

      const resolved = await resolveGitHubCredential(request, {
        env: {},
        ghAuthProbe: (candidate) => ({
          kind: 'unavailable',
          host: candidate.host,
        }),
      });

      expect(requestedKeys).toEqual(['aide:auth:github:host:github.com']);
      expect(resolved).toEqual({
        kind: 'failure',
        code: 'malformed-credential',
        reason:
          "Stored GitHub credentials are malformed. Re-run 'aide login github' to reconfigure.",
      });
    } finally {
      restoreObjectPrototypeProperty('account', originalAccountDescriptor);
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

  test('keeps host-only env eligibility isolated from prototype mutation during result reflection', async () => {
    const request = publicHostRequest();
    const originalAccountDescriptor = Object.getOwnPropertyDescriptor(
      Object.prototype,
      'account'
    );
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
                if (property === 'kind') {
                  descriptorCalls += 1;
                  Object.defineProperty(Object.prototype, 'account', {
                    configurable: true,
                    value: 'attacker',
                    writable: true,
                  });
                }
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
      restoreObjectPrototypeProperty('account', originalAccountDescriptor);
      restoreSecrets();
    }
  });

  test('rejects a cross-account keyring payload after prototype mutation', async () => {
    const request = publicHostRequest();
    const originalAccountDescriptor = Object.getOwnPropertyDescriptor(
      Object.prototype,
      'account'
    );
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
        ghAuthProbe: () => {
          Object.defineProperty(Object.prototype, 'account', {
            configurable: true,
            value: 'attacker',
            writable: true,
          });
          return { kind: 'unavailable', host: 'github.com' };
        },
      });

      expect(resolved).toEqual({
        kind: 'failure',
        code: 'account-mismatch',
        reason:
          "Stored GitHub credential account 'payload-attacker' does not match requested account '(host-only)'.",
      });
    } finally {
      restoreObjectPrototypeProperty('account', originalAccountDescriptor);
      restoreSecrets();
    }
  });

  test('fails closed when prototype corruption prevents stored payload validation', async () => {
    const request = publicHostRequest();
    const originalAccountDescriptor = Object.getOwnPropertyDescriptor(
      Object.prototype,
      'account'
    );
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
        ghAuthProbe: () => {
          Object.defineProperty(Object.prototype, 'account', {
            configurable: true,
            get(this: object) {
              return Object.hasOwn(this, 'ok') && Object.hasOwn(this, 'token')
                ? 'attacker'
                : undefined;
            },
          });
          return { kind: 'unavailable', host: 'github.com' };
        },
      });

      expect(resolved).toEqual({
        kind: 'failure',
        code: 'malformed-credential',
        reason:
          "Stored GitHub credentials are malformed. Re-run 'aide login github' to reconfigure.",
      });
    } finally {
      restoreObjectPrototypeProperty('account', originalAccountDescriptor);
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
