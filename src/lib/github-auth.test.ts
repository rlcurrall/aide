import { describe, expect, test } from 'bun:test';

import {
  canonicalizeGitHubAuthAccount,
  canonicalizeGitHubAuthHost,
  githubCliEnvironment,
  githubEnvironmentCredential,
  resolveGitHubAuthRequest,
  validateGitHubStoredCredential,
} from './github-auth.js';

function withParsedJson<T>(value: unknown, run: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(JSON, 'parse');
  Object.defineProperty(JSON, 'parse', {
    configurable: true,
    value: () => value,
    writable: true,
  });
  try {
    return run();
  } finally {
    if (descriptor === undefined) {
      Reflect.deleteProperty(JSON, 'parse');
    } else {
      Object.defineProperty(JSON, 'parse', descriptor);
    }
  }
}

describe('GitHub auth host binding', () => {
  test('canonicalizes public and data-residency SSH aliases', () => {
    expect(canonicalizeGitHubAuthHost(' SSH.GITHUB.COM ')).toBe('github.com');
    expect(canonicalizeGitHubAuthHost('ssh.Acme.GHE.com')).toBe('acme.ghe.com');
    expect(canonicalizeGitHubAuthHost('ssh.corp.example')).toBe(
      'ssh.corp.example'
    );
  });

  test('keeps omitted-host callers legacy-compatible but scopes explicit hosts', () => {
    expect(resolveGitHubAuthRequest({})).toEqual({
      ok: true,
      host: 'github.com',
    });
    expect(resolveGitHubAuthRequest({ host: 'SSH.GITHUB.COM' })).toEqual({
      ok: true,
      host: 'github.com',
      keyringScope: { providerId: 'github', host: 'github.com' },
    });
  });

  test('returns one canonical lowercase account and exact canonical scope', () => {
    const scope = {
      providerId: 'GitHub',
      host: 'ssh.acme.ghe.com',
      account: ' OctoCat ',
    };
    const result = resolveGitHubAuthRequest({
      host: 'ACME.GHE.COM',
      scope,
    });

    expect(result).toEqual({
      ok: true,
      host: 'acme.ghe.com',
      account: 'octocat',
      keyringScope: {
        providerId: 'github',
        host: 'acme.ghe.com',
        account: 'octocat',
      },
    });
    expect(canonicalizeGitHubAuthAccount(' OctoCat ')).toBe('octocat');
  });

  test('rejects an explicitly blank account with a typed failure', () => {
    expect(
      resolveGitHubAuthRequest({
        scope: {
          providerId: 'github',
          host: 'github.com',
          account: '   ',
        },
      })
    ).toMatchObject({
      ok: false,
      code: 'invalid-account',
      host: 'github.com',
    });
  });

  test('preserves an omitted account as a host-only request', () => {
    expect(
      resolveGitHubAuthRequest({
        scope: { providerId: 'github', host: 'GitHub.com' },
      })
    ).toEqual({
      ok: true,
      host: 'github.com',
      keyringScope: { providerId: 'github', host: 'github.com' },
    });
  });

  test('uses only own data properties when constructing a canonical request', () => {
    let getterCalls = 0;
    let proxyDescriptorCalls = 0;
    const inheritedInput = Object.create({ host: 'attacker.example' }) as {
      host?: string;
    };
    const inheritedAccountScope = Object.assign(
      Object.create({ account: 'attacker' }) as Record<string, string>,
      { providerId: 'github', host: 'github.com' }
    );
    const accessorInput: { host?: string } = {};
    Object.defineProperty(accessorInput, 'host', {
      configurable: true,
      get() {
        getterCalls += 1;
        return 'attacker.example';
      },
    });
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const descriptorProxy = new Proxy(
      {},
      {
        getOwnPropertyDescriptor(_target, property) {
          proxyDescriptorCalls += 1;
          return property === 'host'
            ? {
                configurable: true,
                enumerable: true,
                value: 'attacker.example',
                writable: true,
              }
            : undefined;
        },
      }
    );

    const inheritedResult = resolveGitHubAuthRequest(inheritedInput);
    expect(inheritedResult).toEqual({ ok: true, host: 'github.com' });
    expect(Object.getPrototypeOf(inheritedResult)).toBeNull();
    expect(Object.isFrozen(inheritedResult)).toBe(true);

    const accountResult = resolveGitHubAuthRequest({
      scope: inheritedAccountScope,
    });
    expect(accountResult).toEqual({
      ok: true,
      host: 'github.com',
      keyringScope: { providerId: 'github', host: 'github.com' },
    });
    if (!accountResult.ok) throw new Error(accountResult.reason);
    expect(Object.getPrototypeOf(accountResult.keyringScope)).toBeNull();
    expect(Object.isFrozen(accountResult.keyringScope)).toBe(true);

    expect(resolveGitHubAuthRequest(accessorInput)).toMatchObject({
      ok: false,
      code: 'invalid-host',
    });
    expect(() =>
      resolveGitHubAuthRequest(revoked.proxy as { readonly host?: string })
    ).not.toThrow();
    expect(
      resolveGitHubAuthRequest(revoked.proxy as { readonly host?: string })
    ).toMatchObject({ ok: false, code: 'invalid-host' });
    expect(resolveGitHubAuthRequest(descriptorProxy)).toMatchObject({
      ok: false,
      code: 'invalid-host',
    });
    expect(getterCalls).toBe(0);
    expect(proxyDescriptorCalls).toBe(0);
  });

  test('rejects a scope bound to a different host', () => {
    const result = resolveGitHubAuthRequest({
      host: 'other.ghe.com',
      scope: { providerId: 'github', host: 'acme.ghe.com' },
    });

    expect(result).toMatchObject({
      ok: false,
      code: 'scope-host-mismatch',
      host: 'other.ghe.com',
    });
  });

  test('public tokens are eligible for github.com only with deterministic precedence', () => {
    const env = {
      GITHUB_TOKEN: 'github-token',
      GH_TOKEN: 'gh-token',
    };

    expect(githubEnvironmentCredential('github.com', env)).toEqual({
      host: 'github.com',
      token: 'github-token',
      variable: 'GITHUB_TOKEN',
    });
    expect(githubEnvironmentCredential('acme.ghe.com', env)).toBeNull();
    expect(
      githubEnvironmentCredential('github.com', env, 'octocat')
    ).toBeNull();
  });

  test('enterprise token requires a canonically matching GH_HOST', () => {
    expect(
      githubEnvironmentCredential('acme.ghe.com', {
        GH_HOST: 'ssh.ACME.ghe.com',
        GH_ENTERPRISE_TOKEN: 'enterprise-token',
      })
    ).toEqual({
      host: 'acme.ghe.com',
      token: 'enterprise-token',
      variable: 'GH_ENTERPRISE_TOKEN',
    });
    expect(
      githubEnvironmentCredential('acme.ghe.com', {
        GH_HOST: 'other.ghe.com',
        GH_ENTERPRISE_TOKEN: 'enterprise-token',
        GITHUB_TOKEN: 'public-token',
      })
    ).toBeNull();
    expect(
      githubEnvironmentCredential('acme.ghe.com', {
        GH_HOST: 'https://acme.ghe.com',
        GH_ENTERPRISE_TOKEN: 'enterprise-token',
        GH_TOKEN: 'public-token',
      })
    ).toBeNull();
  });

  test('accepts environment credentials only from own data properties', () => {
    let getterCalls = 0;
    let proxyDescriptorCalls = 0;
    const inheritedPublic = Object.create({
      GITHUB_TOKEN: 'inherited-public-token',
    });
    const inheritedEnterpriseHost = Object.assign(
      Object.create({ GH_HOST: 'acme.ghe.com' }),
      { GH_ENTERPRISE_TOKEN: 'own-enterprise-token' }
    );
    const inheritedEnterpriseToken = Object.assign(
      Object.create({ GH_ENTERPRISE_TOKEN: 'inherited-enterprise-token' }),
      { GH_HOST: 'acme.ghe.com' }
    );
    const accessorEnvironment = Object.create(null) as Record<string, string>;
    Object.defineProperty(accessorEnvironment, 'GITHUB_TOKEN', {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'accessor-token';
      },
    });
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const descriptorEnvironment = new Proxy(
      {},
      {
        getOwnPropertyDescriptor(_target, property) {
          proxyDescriptorCalls += 1;
          return property === 'GITHUB_TOKEN'
            ? {
                configurable: true,
                enumerable: true,
                value: 'proxy-token',
                writable: true,
              }
            : undefined;
        },
      }
    );

    expect(
      githubEnvironmentCredential('github.com', inheritedPublic)
    ).toBeNull();
    expect(
      githubEnvironmentCredential('acme.ghe.com', inheritedEnterpriseHost)
    ).toBeNull();
    expect(
      githubEnvironmentCredential('acme.ghe.com', inheritedEnterpriseToken)
    ).toBeNull();
    expect(
      githubEnvironmentCredential('github.com', accessorEnvironment)
    ).toBeNull();
    expect(() =>
      githubEnvironmentCredential('github.com', revoked.proxy)
    ).not.toThrow();
    expect(githubEnvironmentCredential('github.com', revoked.proxy)).toBeNull();
    expect(
      githubEnvironmentCredential('github.com', descriptorEnvironment)
    ).toBeNull();
    expect(getterCalls).toBe(0);
    expect(proxyDescriptorCalls).toBe(0);
  });

  test('removes all ambiguous auth variables from gh child environments', () => {
    expect(
      githubCliEnvironment({
        PATH: '/bin',
        GH_HOST: 'acme.ghe.com',
        GH_TOKEN: 'public',
        GITHUB_TOKEN: 'public-alias',
        GH_ENTERPRISE_TOKEN: 'enterprise',
        GITHUB_ENTERPRISE_TOKEN: 'enterprise-alias',
      })
    ).toEqual({ PATH: '/bin' });
  });

  test('validates scoped payload identity and rejects exact-key account mismatch', () => {
    const request = resolveGitHubAuthRequest({
      scope: {
        providerId: 'github',
        host: 'github.com',
        account: 'OctoCat',
      },
    });
    if (!request.ok) throw new Error(request.reason);

    expect(
      validateGitHubStoredCredential(
        request,
        'scoped',
        JSON.stringify({
          token: 'account-token',
          identity: { host: 'GITHUB.COM', account: 'OCTOCAT' },
        })
      )
    ).toMatchObject({ ok: true, token: 'account-token' });
    expect(
      validateGitHubStoredCredential(
        request,
        'scoped',
        JSON.stringify({
          token: 'wrong-token',
          identity: { host: 'github.com', account: 'hubot' },
        })
      )
    ).toMatchObject({ ok: false, code: 'account-mismatch' });
  });

  test('rejects inherited token and scoped identity fields before schema parsing', () => {
    const legacyRequest = resolveGitHubAuthRequest({});
    const scopedRequest = resolveGitHubAuthRequest({
      scope: {
        providerId: 'github',
        host: 'github.com',
        account: 'octocat',
      },
    });
    if (!legacyRequest.ok || !scopedRequest.ok) throw new Error('bad fixture');

    const inheritedToken = Object.assign(
      Object.create({ token: 'inherited-token' }) as Record<string, unknown>,
      {
        identity: { host: 'github.com', account: 'octocat' },
      }
    );
    const inheritedIdentity = Object.assign(
      Object.create({
        identity: { host: 'github.com', account: 'octocat' },
      }) as Record<string, unknown>,
      { token: 'own-token' }
    );
    const inheritedHost = {
      token: 'own-token',
      identity: Object.assign(
        Object.create({ host: 'github.com' }) as Record<string, unknown>,
        { account: 'octocat' }
      ),
    };
    const inheritedAccount = {
      token: 'own-token',
      identity: Object.assign(
        Object.create({ account: 'octocat' }) as Record<string, unknown>,
        { host: 'github.com' }
      ),
    };

    expect(
      withParsedJson(Object.create({ token: 'inherited-token' }), () =>
        validateGitHubStoredCredential(legacyRequest, 'legacy', '{}')
      )
    ).toMatchObject({ ok: false, code: 'malformed-credential' });
    for (const payload of [
      inheritedToken,
      inheritedIdentity,
      inheritedHost,
      inheritedAccount,
    ]) {
      expect(
        withParsedJson(payload, () =>
          validateGitHubStoredCredential(scopedRequest, 'scoped', '{}')
        )
      ).toMatchObject({ ok: false, code: 'malformed-credential' });
    }
  });

  test('rejects proxy, accessor, and malformed stored descriptors without invocation', () => {
    const request = resolveGitHubAuthRequest({});
    if (!request.ok) throw new Error(request.reason);

    let getterCalls = 0;
    let proxyCalls = 0;
    const accessorPayload = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessorPayload, 'token', {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'accessor-token';
      },
    });
    const proxyPayload = new Proxy(
      { token: 'proxy-token' },
      {
        get(target, property, receiver) {
          proxyCalls += 1;
          return Reflect.get(target, property, receiver);
        },
        getOwnPropertyDescriptor(target, property) {
          proxyCalls += 1;
          return Reflect.getOwnPropertyDescriptor(target, property);
        },
      }
    );
    const malformedDescriptorPayload = Object.create(null) as Record<
      string,
      unknown
    >;
    Object.defineProperty(malformedDescriptorPayload, 'token', {
      configurable: true,
      enumerable: false,
      value: 'hidden-token',
      writable: true,
    });

    for (const payload of [
      accessorPayload,
      proxyPayload,
      malformedDescriptorPayload,
    ]) {
      expect(
        withParsedJson(payload, () =>
          validateGitHubStoredCredential(request, 'legacy', '{}')
        )
      ).toMatchObject({ ok: false, code: 'malformed-credential' });
    }
    expect(getterCalls).toBe(0);
    expect(proxyCalls).toBe(0);
  });

  test('accepts token-only payloads only at the legacy unscoped key', () => {
    const legacyRequest = resolveGitHubAuthRequest({});
    const scopedRequest = resolveGitHubAuthRequest({ host: 'github.com' });
    if (!legacyRequest.ok || !scopedRequest.ok) throw new Error('bad fixture');

    expect(
      validateGitHubStoredCredential(
        legacyRequest,
        'legacy',
        JSON.stringify({
          token: 'legacy-token',
          historicalExtra: 'remains-compatible',
        })
      )
    ).toMatchObject({ ok: true, token: 'legacy-token' });
    expect(
      validateGitHubStoredCredential(
        legacyRequest,
        'legacy',
        JSON.stringify({
          token: 'misplaced-scoped-token',
          identity: { host: 'github.com' },
        })
      )
    ).toMatchObject({ ok: false, code: 'malformed-credential' });
    expect(
      validateGitHubStoredCredential(
        scopedRequest,
        'scoped',
        JSON.stringify({ token: 'pre-identity-token' })
      )
    ).toMatchObject({ ok: false, code: 'malformed-credential' });
  });
});
