import { describe, expect, test } from 'bun:test';
import { Effect } from 'effect';

import {
  authScopeFromArgs,
  type DiscoveredAuthProvider,
} from './auth-provider-command-utils.js';

const provider: DiscoveredAuthProvider = {
  pluginId: 'external-auth-plugin',
  capability: {
    providerId: 'external-auth',
    label: 'External Auth',
    status: () => Effect.succeed({ state: 'not-configured' }),
  },
};

type ScopeOption =
  | 'scope-id'
  | 'scope-host'
  | 'scope-org'
  | 'scope-account'
  | 'scope-label';

const scopeOptions: readonly [string, ScopeOption][] = [
  ['scope-id', 'scope-id'],
  ['scope-host', 'scope-host'],
  ['scope-org', 'scope-org'],
  ['scope-account', 'scope-account'],
  ['scope-label', 'scope-label'],
];

const invalidValues: readonly [string, unknown][] = [
  ['empty', ''],
  ['whitespace-only', ' \t '],
  ['undefined own property', undefined],
  ['null', null],
  ['array', ['alice']],
  ['number', 42],
  ['object', { account: 'alice' }],
  ['boolean', true],
];

describe('authScopeFromArgs', () => {
  test('omitted scope options retain legacy unscoped behavior', () => {
    expect(authScopeFromArgs(provider, {})).toBeUndefined();
  });

  test('valid explicit values are trimmed and preserve derived-id ordering', () => {
    expect(
      authScopeFromArgs(provider, {
        'scope-host': '  example.test  ',
        scopeOrg: '  engineering  ',
        'scope-account': '  alice  ',
        scopeLabel: '  primary  ',
      })
    ).toEqual({
      id: 'example.test:engineering:alice:primary',
      providerId: 'external-auth',
      host: 'example.test',
      org: 'engineering',
      account: 'alice',
      label: 'primary',
    });
  });

  test('a valid explicit scope id is trimmed and preserved', () => {
    expect(authScopeFromArgs(provider, { scopeId: '  tenant-123  ' })).toEqual({
      id: 'tenant-123',
      providerId: 'external-auth',
    });
  });

  test.each(scopeOptions)(
    'rejects a blank explicit --%s even when another field is valid',
    (_name, option) => {
      expect(() =>
        authScopeFromArgs(provider, {
          'scope-host': 'example.test',
          'scope-account': 'alice',
          [option]: '   ',
        })
      ).toThrow(
        `Auth provider 'external-auth' requires '--${option}' to be a non-empty string.`
      );
    }
  );

  test.each(invalidValues)(
    'rejects an explicitly present %s scope value',
    (_name, value) => {
      expect(() =>
        authScopeFromArgs(provider, {
          'scope-host': value,
          'scope-account': 'alice',
        })
      ).toThrow(
        "Auth provider 'external-auth' requires '--scope-host' to be a non-empty string."
      );
    }
  );

  test('accepts equivalent dashed and camel aliases emitted by yargs', () => {
    expect(
      authScopeFromArgs(provider, {
        'scope-host': '  example.test  ',
        scopeHost: 'example.test',
      })
    ).toEqual({
      id: 'example.test',
      providerId: 'external-auth',
      host: 'example.test',
    });
  });

  test('rejects conflicting dashed and camel aliases without echoing values', () => {
    const firstValue = 'first-sensitive-host';
    const secondValue = 'second-sensitive-host';

    expect(() =>
      authScopeFromArgs(provider, {
        'scope-host': firstValue,
        scopeHost: secondValue,
      })
    ).toThrow(
      "Auth provider 'external-auth' received conflicting values for '--scope-host' and '--scopeHost'."
    );

    try {
      authScopeFromArgs(provider, {
        'scope-host': firstValue,
        scopeHost: secondValue,
      });
    } catch (error) {
      expect(String(error)).not.toContain(firstValue);
      expect(String(error)).not.toContain(secondValue);
    }
  });
});
