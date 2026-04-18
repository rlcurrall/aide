/**
 * Tests for the login command.
 *
 * These exercise the per-service handlers directly (not the yargs wiring),
 * injecting a ScriptedPrompter and mocking Bun.secrets. The yargs wiring is
 * smoke-tested manually before release.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';

import { loginJira, loginAdo, loginGithub } from './login.js';
import type { Prompter, ReadLineOptions } from '../../lib/prompts.js';

class ScriptedPrompter implements Prompter {
  private inputs: string[];
  readonly writes: string[] = [];
  constructor(inputs: string[]) {
    this.inputs = [...inputs];
  }
  async readLine(_opts: ReadLineOptions): Promise<string> {
    const next = this.inputs.shift();
    if (next === undefined) throw new Error('ScriptedPrompter exhausted');
    return next;
  }
  writeLine(s: string): void {
    this.writes.push(s);
  }
}

type Store = Map<string, string>;

function installMockSecrets(store: Store) {
  const original = (Bun as unknown as { secrets: unknown }).secrets;
  (Bun as unknown as { secrets: unknown }).secrets = {
    async get(opts: { service: string; name: string }) {
      return store.get(`${opts.service}:${opts.name}`) ?? null;
    },
    async set(opts: { service: string; name: string; value: string }): Promise<void> {
      store.set(`${opts.service}:${opts.name}`, opts.value);
    },
    async delete(opts: { service: string; name: string }) {
      return store.delete(`${opts.service}:${opts.name}`);
    },
  };
  return () => {
    (Bun as unknown as { secrets: unknown }).secrets = original;
  };
}

describe('loginJira', () => {
  let store: Store;
  let restore: () => void;

  beforeEach(() => {
    store = new Map();
    restore = installMockSecrets(store);
  });

  afterEach(() => restore());

  test('uses supplied flags without prompting', async () => {
    const p = new ScriptedPrompter([]);
    await loginJira(
      {
        url: 'https://x.atlassian.net',
        email: 'a@b.c',
        token: 'tkn',
      },
      { prompter: p }
    );
    const stored = JSON.parse(store.get('aide:jira') ?? '{}');
    expect(stored.url).toBe('https://x.atlassian.net');
    expect(stored.email).toBe('a@b.c');
    expect(stored.apiToken).toBe('tkn');
  });

  test('prompts for missing fields only', async () => {
    const p = new ScriptedPrompter(['a@b.c', 'tkn']);
    await loginJira(
      { url: 'https://x.atlassian.net' },
      { prompter: p }
    );
    const stored = JSON.parse(store.get('aide:jira') ?? '{}');
    expect(stored.email).toBe('a@b.c');
    expect(stored.apiToken).toBe('tkn');
  });

  test('prompts for all fields when no flags supplied', async () => {
    const p = new ScriptedPrompter([
      'https://x.atlassian.net',
      'a@b.c',
      'tkn',
    ]);
    await loginJira({}, { prompter: p });
    expect(store.has('aide:jira')).toBe(true);
  });
});

describe('loginAdo', () => {
  let store: Store;
  let restore: () => void;

  beforeEach(() => {
    store = new Map();
    restore = installMockSecrets(store);
  });

  afterEach(() => restore());

  test('stores with default authMethod of pat when not supplied', async () => {
    const p = new ScriptedPrompter([]);
    await loginAdo(
      { orgUrl: 'https://dev.azure.com/x', pat: 't' },
      { prompter: p }
    );
    const stored = JSON.parse(store.get('aide:ado') ?? '{}');
    expect(stored.authMethod).toBe('pat');
  });

  test('stores bearer authMethod when supplied', async () => {
    const p = new ScriptedPrompter([]);
    await loginAdo(
      {
        orgUrl: 'https://dev.azure.com/x',
        pat: 't',
        authMethod: 'bearer',
      },
      { prompter: p }
    );
    const stored = JSON.parse(store.get('aide:ado') ?? '{}');
    expect(stored.authMethod).toBe('bearer');
  });
});

describe('loginGithub', () => {
  let store: Store;
  let restore: () => void;

  beforeEach(() => {
    store = new Map();
    restore = installMockSecrets(store);
  });

  afterEach(() => restore());

  test('no-op when gh CLI is available', async () => {
    const p = new ScriptedPrompter([]);
    const result = await loginGithub(
      { token: 'should-be-ignored' },
      { prompter: p, ghAvailable: () => true }
    );
    expect(result).toBe('gh-cli');
    expect(store.has('aide:github')).toBe(false);
  });

  test('stores token when gh CLI is missing', async () => {
    const p = new ScriptedPrompter(['ghp_xxx']);
    const result = await loginGithub(
      {},
      { prompter: p, ghAvailable: () => false }
    );
    expect(result).toBe('stored');
    const stored = JSON.parse(store.get('aide:github') ?? '{}');
    expect(stored.token).toBe('ghp_xxx');
  });
});
