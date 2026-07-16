import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { Effect } from 'effect';
import yargs from 'yargs/yargs';

import type { AideAuthProviderCapability } from '@cli/host/plugin-descriptor.js';
import { createJiraPlugin } from '@cli/plugins/jira/plugin.js';
import type { KeyringService } from '@lib/auth-keyring.js';
import { makeTestKeyring } from '@lib/auth-keyring.test-helper.js';
import {
  installMockSecrets,
  restoreEnv,
  saveEnv,
  type Store,
} from '@lib/test-helpers.js';
import { jiraAuthScopeFromArgs } from './auth-scope.js';
import { jiraCommands } from './index.js';

const JIRA_ENV_VARS = [
  'JIRA_URL',
  'JIRA_EMAIL',
  'JIRA_USERNAME',
  'JIRA_API_TOKEN',
  'JIRA_TOKEN',
];

function jiraAuthProvider(): AideAuthProviderCapability<
  KeyringService,
  KeyringService,
  KeyringService,
  KeyringService
> {
  const provider = createJiraPlugin().capabilities?.authProvider;
  if (provider === undefined) throw new Error('missing Jira auth provider');
  return provider;
}

let env: Map<string, string | undefined>;
let restoreSecrets: () => void;
let originalFetch: typeof globalThis.fetch;
let originalLog: typeof console.log;
let store: Store;

beforeEach(() => {
  env = saveEnv(JIRA_ENV_VARS);
  Bun.env.AIDE_SECRET_SERVICE_OVERRIDE = 'aide';
  store = new Map();
  restoreSecrets = installMockSecrets(store);
  originalFetch = globalThis.fetch;
  originalLog = console.log;
  console.log = () => {};
});

afterEach(() => {
  console.log = originalLog;
  globalThis.fetch = originalFetch;
  restoreSecrets();
  restoreEnv(env);
});

const invalidScopedSelection =
  'Scoped Jira credential selection requires non-empty string values for explicitly provided --scope-host and --scope-account options.';

test('omitted scope options preserve legacy credential selection', () => {
  expect(jiraAuthScopeFromArgs({})).toBeUndefined();
});

test('camelCase scope options produce a normalized scoped target', () => {
  expect(
    jiraAuthScopeFromArgs({
      scopeHost: '  EXAMPLE.ATLASSIAN.NET  ',
      scopeAccount: '  DEV@Example.com  ',
    })
  ).toEqual({
    providerId: 'jira',
    host: 'example.atlassian.net',
    account: 'dev@example.com',
  });
});

test('dashed scope options produce a normalized scoped target', () => {
  expect(
    jiraAuthScopeFromArgs({
      'scope-host': '  EXAMPLE.ATLASSIAN.NET  ',
      'scope-account': '  DEV@Example.com  ',
    })
  ).toEqual({
    providerId: 'jira',
    host: 'example.atlassian.net',
    account: 'dev@example.com',
  });
});

test('both blank scope options fail closed', () => {
  expect(() =>
    jiraAuthScopeFromArgs({
      'scope-host': '   ',
      'scope-account': '\t',
    })
  ).toThrow(invalidScopedSelection);
});

test('blank host with a valid account fails closed', () => {
  expect(() =>
    jiraAuthScopeFromArgs({
      'scope-host': '   ',
      'scope-account': 'dev@example.com',
    })
  ).toThrow(invalidScopedSelection);
});

test('valid host with a blank account fails closed', () => {
  expect(() =>
    jiraAuthScopeFromArgs({
      'scope-host': 'example.atlassian.net',
      'scope-account': '   ',
    })
  ).toThrow(invalidScopedSelection);
});

test('present missing and non-string scope options fail closed', () => {
  expect(() =>
    jiraAuthScopeFromArgs({
      scopeHost: undefined,
      scopeAccount: 'dev@example.com',
    })
  ).toThrow(invalidScopedSelection);
  expect(() =>
    jiraAuthScopeFromArgs({
      'scope-host': 'example.atlassian.net',
      'scope-account': ['dev@example.com'],
    })
  ).toThrow(invalidScopedSelection);
});

test('exactly one valid scope option retains the paired-option error', () => {
  expect(() =>
    jiraAuthScopeFromArgs({ 'scope-host': 'example.atlassian.net' })
  ).toThrow(
    'Scoped Jira credential selection requires both --scope-host and --scope-account.'
  );
});

test('blank explicit yargs scope flags cannot use legacy credentials or network', async () => {
  Bun.env.JIRA_URL = 'https://legacy.atlassian.net';
  Bun.env.JIRA_EMAIL = 'legacy@example.com';
  Bun.env.JIRA_API_TOKEN = 'legacy-token';

  let fetchCalls = 0;
  globalThis.fetch = (async (_input, _init) => {
    fetchCalls += 1;
    return new Response(JSON.stringify({ key: 'PROJ-1', fields: {} }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof globalThis.fetch;

  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.join(' '));
  };
  const exit = spyOn(process, 'exit').mockImplementation(((code) => {
    throw new Error(`process.exit(${String(code)})`);
  }) as typeof process.exit);

  try {
    await expect(
      yargs([
        'jira',
        'view',
        'PROJ-1',
        '--scope-host',
        '   ',
        '--scope-account',
        '\t',
        '--format',
        'json',
      ])
        .command(jiraCommands)
        .exitProcess(false)
        .parseAsync()
    ).rejects.toThrow('process.exit(1)');
  } finally {
    exit.mockRestore();
    console.error = originalError;
  }

  expect(errors[0]).toBe(`Error: ${invalidScopedSelection}`);
  expect(fetchCalls).toBe(0);
});

test('scoped provider login is consumed by a real Jira command selection', async () => {
  await Effect.runPromise(
    jiraAuthProvider().operations!.login!({
      values: {
        url: 'https://example.atlassian.net',
        email: 'Dev@Example.com',
        token: 'scoped-token',
      },
      scope: {
        id: 'example.atlassian.net:dev@example.com',
        providerId: 'jira',
        host: 'example.atlassian.net',
        account: 'dev@example.com',
      },
    }).pipe(Effect.provide(makeTestKeyring(store).layer))
  );

  let requestedUrl: string | undefined;
  let authorization: string | null | undefined;
  globalThis.fetch = (async (input, init) => {
    requestedUrl = String(input);
    authorization = new Headers(init?.headers).get('Authorization');
    return new Response(JSON.stringify({ key: 'PROJ-1', fields: {} }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof globalThis.fetch;

  await yargs([
    'jira',
    'view',
    'PROJ-1',
    '--scope-host',
    'EXAMPLE.ATLASSIAN.NET',
    '--scope-account',
    'DEV@example.com',
    '--format',
    'json',
  ])
    .command(jiraCommands)
    .exitProcess(false)
    .parseAsync();

  expect(requestedUrl).toBe(
    'https://example.atlassian.net/rest/api/3/issue/PROJ-1'
  );
  expect(authorization).toBe(`Basic ${btoa('Dev@Example.com:scoped-token')}`);
});
