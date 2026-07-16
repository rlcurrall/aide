import { describe, expect, test } from 'bun:test';
import { Effect } from 'effect';

import {
  type AideAuthScope,
  type AidePullRequestProviderOperations,
} from '@cli/host/plugin-descriptor.js';
import {
  certifiedBuiltinPullRequestProviderDiagnostic,
  createKeyringCommandRegistry,
} from '@cli/host/command-registry.js';
import { createAideHostServices } from '@cli/host/runtime-context.js';
import { createBuiltinCommandRegistry } from '@cli/plugins/builtin.js';
import {
  listPullRequestsForRepository,
  type ResolvedPullRequestProvider,
} from '@cli/plugins/pull-requests/provider-resolver.js';
import {
  platformContextFromPullRequestProvider,
  resolvePullRequestPlatformContextForRemote,
  type PullRequestProviderContextClients,
} from '@cli/plugins/pull-requests/provider-context.js';
import { runPullRequestCommandEffect } from '@cli/plugins/pull-requests/commands/error.js';
import { GitHubAuthError, type GitHubClient } from '@lib/github-client.js';
import type {
  GitHubIssueComment,
  GitHubPullRequest,
  GitHubReviewComment,
} from '@lib/github-types.js';
import { authIndexScopeName, type AuthStoreScope } from '@lib/auth-store.js';
import { createGitHubPlugin } from './plugin.js';
import {
  createProductionGitHubPullRequestClient,
  createSelectedGitHubPullRequestClient,
  githubPullRequestErrorDiagnostic,
  SelectedGitHubPullRequestAuthError,
} from './pull-request-client.js';

function canonicalSelectedScope(
  host = 'github.com',
  account = 'alice'
): AideAuthScope {
  const id = authIndexScopeName({ providerId: 'github', host, account });
  return Object.freeze({ id, providerId: 'github', host, account });
}

function canonicalHostScope(host = 'github.com'): AideAuthScope {
  const id = authIndexScopeName({ providerId: 'github', host });
  return Object.freeze({ id, providerId: 'github', host });
}

function fakePullRequest(number = 7): GitHubPullRequest {
  return {
    number,
    node_id: `PR_${number}`,
    title: 'Selected client test',
    body: 'body',
    state: 'open',
    draft: false,
    merged: false,
    merged_at: null,
    user: { login: 'alice', id: 1 },
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
    closed_at: null,
    head: { ref: 'feature', sha: 'abc123', label: 'acme:feature' },
    base: { ref: 'main', sha: 'def456', label: 'acme:main' },
    labels: [],
    html_url: `https://github.com/acme/widgets/pull/${number}`,
  };
}

function fakeIssueComment(): GitHubIssueComment {
  return {
    id: 11,
    user: { login: 'alice', id: 1 },
    body: 'issue comment',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    html_url: 'https://github.com/acme/widgets/pull/7#issuecomment-11',
  };
}

function fakeReviewComment(): GitHubReviewComment {
  return {
    id: 12,
    user: { login: 'alice', id: 1 },
    body: 'review comment',
    path: 'src/index.ts',
    line: 1,
    original_line: 1,
    start_line: null,
    side: 'RIGHT',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    html_url: 'https://github.com/acme/widgets/pull/7#discussion_r12',
    commit_id: 'abc123',
  };
}

function fakeClient() {
  const pr = fakePullRequest();
  return {
    listPullRequests: async () => [pr],
    getPullRequest: async () => pr,
    getPullRequestFiles: async () => [],
    getIssueComments: async () => [],
    getReviewComments: async () => [],
    createPullRequest: async () => pr,
    updatePullRequest: async () => pr,
    createIssueComment: async () => fakeIssueComment(),
    createReviewComment: async () => fakeReviewComment(),
    replyToReviewComment: async () => fakeReviewComment(),
    publishDraftPR: async () => undefined,
    convertToDraft: async () => undefined,
    addLabels: async () => [],
    removeLabel: async () => undefined,
  };
}

function githubOperations(
  plugin: ReturnType<typeof createGitHubPlugin>
): AidePullRequestProviderOperations {
  const operations = plugin.capabilities?.pullRequestProvider?.operations;
  if (operations === undefined) throw new Error('Missing GitHub operations');
  return operations;
}

const repository = Object.freeze({
  kind: 'github' as const,
  host: 'github.com',
  owner: 'acme',
  repo: 'widgets',
});
const match = Object.freeze({
  source: 'repository-ref' as const,
  priority: 100,
  repository,
});

async function runAllGitHubOperations(
  operations: AidePullRequestProviderOperations,
  authScope: AideAuthScope
): Promise<void> {
  const pullRequest = { number: 7 };
  await Effect.runPromise(
    operations.listPullRequests!({ match, authScope, status: 'active' })
  );
  await Effect.runPromise(
    operations.getPullRequest!({ match, authScope, pullRequest })
  );
  await Effect.runPromise(
    operations.createPullRequest!({
      match,
      authScope,
      title: 'Title',
      sourceBranch: 'feature',
      targetBranch: 'main',
    })
  );
  await Effect.runPromise(
    operations.updatePullRequest!({ match, authScope, pullRequest })
  );
  await Effect.runPromise(
    operations.getPullRequestDiff!({ match, authScope, pullRequest })
  );
  await Effect.runPromise(
    operations.listPullRequestComments!({ match, authScope, pullRequest })
  );
  await Effect.runPromise(
    operations.addPullRequestComment!({
      match,
      authScope,
      pullRequest,
      body: 'comment',
    })
  );
  await Effect.runPromise(
    operations.replyToPullRequestComment!({
      match,
      authScope,
      pullRequest,
      threadId: 12,
      body: 'reply',
    })
  );
  await Effect.runPromise(
    operations.findPullRequestForBranch!({
      match,
      authScope,
      branch: 'feature',
    })
  );
}

function trustedGitHubProvider(
  host = 'github.com'
): ResolvedPullRequestProvider {
  return {
    pluginId: 'github',
    providerId: 'github',
    features: {},
    priority: 100,
    match: {
      source: 'git-remote',
      priority: 100,
      repository: {
        kind: 'github',
        host,
        owner: 'acme',
        repo: 'widgets',
      },
    },
  };
}

async function captureFailure(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('Expected operation to reject');
}

function builtinGitHubProviderEntry() {
  const entry = createBuiltinCommandRegistry()
    .capabilities.pullRequestProviders()
    .find(({ pluginId }) => pluginId === 'github');
  if (entry === undefined) throw new Error('Missing built-in GitHub entry');
  return entry;
}

describe('selected GitHub pull request client routing', () => {
  test('routes all nine plugin operations through the selected account scope', async () => {
    const calls: unknown[] = [];
    const authScope = canonicalSelectedScope();
    const plugin = createGitHubPlugin({
      createClient: async (options) => {
        calls.push(options);
        return fakeClient();
      },
    });

    await runAllGitHubOperations(githubOperations(plugin), authScope);

    expect(calls).toHaveLength(9);
    for (const call of calls) {
      expect(call).toEqual({
        host: 'github.com',
        scope: { providerId: 'github', host: 'github.com', account: 'alice' },
      });
      expect(Object.isFrozen((call as { scope: object }).scope)).toBe(true);
      expect(
        Object.getPrototypeOf((call as { scope: object }).scope)
      ).toBeNull();
    }
    expect(
      new Set(calls.map((call) => (call as { scope: object }).scope)).size
    ).toBe(9);
  });

  test('routes both legacy provider-context paths through the selected scope', async () => {
    const calls: unknown[] = [];
    const receiverChecks: boolean[] = [];
    const clients: PullRequestProviderContextClients = {
      async createGitHubClient(options) {
        receiverChecks.push(this === clients);
        calls.push(options);
        return { kind: 'github-client' } as unknown as GitHubClient;
      },
      createAzureDevOpsClient: async () => {
        throw new Error('Azure DevOps client must not be created');
      },
    };
    const authScope = canonicalSelectedScope('acme.ghe.com', 'octo user');
    const direct = platformContextFromPullRequestProvider as unknown as (
      provider: ResolvedPullRequestProvider,
      clients: PullRequestProviderContextClients,
      authScope?: AideAuthScope
    ) => Promise<unknown>;
    const remote = resolvePullRequestPlatformContextForRemote as unknown as (
      services: Pick<
        ReturnType<typeof createAideHostServices>,
        'resolvePullRequestProviderForRemote'
      >,
      remoteUrl: string,
      clients: PullRequestProviderContextClients,
      authScope?: AideAuthScope
    ) => Promise<unknown>;

    await direct(trustedGitHubProvider('acme.ghe.com'), clients, authScope);
    await remote(
      createAideHostServices(createBuiltinCommandRegistry()),
      'git@ssh.acme.ghe.com:acme/widgets.git',
      clients,
      authScope
    );

    expect(calls).toEqual([
      {
        host: 'acme.ghe.com',
        scope: {
          providerId: 'github',
          host: 'acme.ghe.com',
          account: 'octo user',
        },
      },
      {
        host: 'acme.ghe.com',
        scope: {
          providerId: 'github',
          host: 'acme.ghe.com',
          account: 'octo user',
        },
      },
    ]);
    expect(receiverChecks).toEqual([true, true]);
  });
});

describe('selected GitHub pull request client validation', () => {
  test('validates and reduces selected scope before factory or network work', async () => {
    let factoryCalls = 0;
    let networkCalls = 0;
    const factory = async () => {
      factoryCalls += 1;
      return {
        request: () => {
          networkCalls += 1;
        },
      };
    };
    const valid = canonicalSelectedScope();
    const invalidScopes: unknown[] = [
      { ...valid, providerId: 'gitlab' },
      { ...valid, host: 'acme.ghe.com' },
      { ...valid, host: 'GitHub.com' },
      { ...valid, account: 'Alice' },
      { ...valid, id: 'github.com:alice' },
      { ...valid, org: 'acme' },
      { providerId: 'github', host: 'github.com', account: 'alice' },
      canonicalSelectedScope('github.example.com', 'alice'),
      canonicalSelectedScope('github.com', 'a'.repeat(257)),
      canonicalSelectedScope('github.com', 'token=SECRET_SCOPE_SENTINEL_147'),
      new Proxy(valid, {
        get() {
          throw new Error('PROXY_SCOPE_SENTINEL_147');
        },
      }),
      Object.defineProperty({}, 'providerId', {
        get() {
          throw new Error('ACCESSOR_SCOPE_SENTINEL_147');
        },
      }),
    ];

    for (const authScope of invalidScopes) {
      await expect(
        createSelectedGitHubPullRequestClient(
          'github.com',
          authScope as AideAuthScope,
          factory
        )
      ).rejects.toThrow('Invalid GitHub pull request authentication scope.');
    }
    expect(factoryCalls).toBe(0);
    expect(networkCalls).toBe(0);
  });

  test('rejects exotic scope prototypes without inherited or proxy observation', async () => {
    const valid = canonicalSelectedScope();
    let factoryCalls = 0;
    let inheritedGetterReads = 0;
    let proxyTrapReads = 0;
    const factory = async () => {
      factoryCalls += 1;
      return { kind: 'client' } as const;
    };

    const customPrototype = Object.assign(
      Object.create(Object.freeze({ custom: true })),
      valid
    ) as AideAuthScope;

    class ClassScope {
      readonly id = valid.id;
      readonly providerId = valid.providerId;
      readonly host = valid.host;
      readonly account = valid.account;
    }

    const hostilePrototype = Object.create(null) as Record<string, unknown>;
    Object.defineProperties(hostilePrototype, {
      metadata: {
        get() {
          inheritedGetterReads += 1;
          throw new Error('INHERITED_METADATA_SENTINEL_147');
        },
      },
      org: {
        get() {
          inheritedGetterReads += 1;
          throw new Error('INHERITED_ORG_SENTINEL_147');
        },
      },
    });
    const hostileInherited = Object.assign(
      Object.create(hostilePrototype),
      valid
    ) as AideAuthScope;

    const proxy = new Proxy(valid, {
      get() {
        proxyTrapReads += 1;
        throw new Error('PROXY_GET_SENTINEL_147');
      },
      getOwnPropertyDescriptor() {
        proxyTrapReads += 1;
        throw new Error('PROXY_DESCRIPTOR_SENTINEL_147');
      },
      getPrototypeOf() {
        proxyTrapReads += 1;
        throw new Error('PROXY_PROTOTYPE_SENTINEL_147');
      },
    });
    const revocable = Proxy.revocable(valid, {
      get() {
        proxyTrapReads += 1;
        throw new Error('REVOKED_PROXY_GET_SENTINEL_147');
      },
      getOwnPropertyDescriptor() {
        proxyTrapReads += 1;
        throw new Error('REVOKED_PROXY_DESCRIPTOR_SENTINEL_147');
      },
      getPrototypeOf() {
        proxyTrapReads += 1;
        throw new Error('REVOKED_PROXY_PROTOTYPE_SENTINEL_147');
      },
    });
    revocable.revoke();

    const outcomes: string[] = [];
    for (const scope of [
      customPrototype,
      new ClassScope(),
      hostileInherited,
      proxy,
      revocable.proxy,
    ]) {
      try {
        await createSelectedGitHubPullRequestClient(
          'github.com',
          scope,
          factory
        );
        outcomes.push('resolved');
      } catch (error) {
        outcomes.push(
          error instanceof Error ? error.message : 'non-error rejection'
        );
      }
    }

    expect(outcomes).toEqual(
      Array.from(
        { length: 5 },
        () => 'Invalid GitHub pull request authentication scope.'
      )
    );
    expect(inheritedGetterReads).toBe(0);
    expect(proxyTrapReads).toBe(0);
    expect(factoryCalls).toBe(0);
  });

  for (const host of ['github.com', 'acme.ghe.com'] as const) {
    test(`preserves absent-scope host-only compatibility for ${host}`, async () => {
      const calls: unknown[] = [];
      const result = await createSelectedGitHubPullRequestClient(
        host,
        undefined,
        async (options) => {
          calls.push(options);
          return { kind: 'client' } as const;
        }
      );

      expect(result).toEqual({ kind: 'client' });
      expect(calls).toEqual([{ host, scope: { providerId: 'github', host } }]);
      expect(Object.isFrozen((calls[0] as { scope: object }).scope)).toBe(true);
      expect(
        Object.getPrototypeOf((calls[0] as { scope: object }).scope)
      ).toBeNull();
    });
  }

  test('accepts and freshly reduces a canonical selected host-only scope', async () => {
    const selected = canonicalHostScope();
    let received: AuthStoreScope | undefined;
    await createSelectedGitHubPullRequestClient(
      'github.com',
      selected,
      async ({ scope }) => {
        received = scope;
        return { kind: 'client' };
      }
    );

    expect(received).toEqual({ providerId: 'github', host: 'github.com' });
    expect(received).not.toBe(selected);
    expect(Object.isFrozen(received)).toBe(true);
    expect(Object.getPrototypeOf(received!)).toBeNull();
  });

  test('accepts and freshly reduces a canonical null-prototype selected scope', async () => {
    const selected = Object.assign(
      Object.create(null),
      canonicalSelectedScope()
    ) as AideAuthScope;
    Object.freeze(selected);
    let received: AuthStoreScope | undefined;

    await createSelectedGitHubPullRequestClient(
      'github.com',
      selected,
      async ({ scope }) => {
        received = scope;
        return { kind: 'client' };
      }
    );

    expect(received).toEqual({
      providerId: 'github',
      host: 'github.com',
      account: 'alice',
    });
    expect(received).not.toBe(selected);
    expect(Object.isFrozen(received)).toBe(true);
    expect(Object.getPrototypeOf(received!)).toBeNull();
  });

  test('does not broaden matched repository hosts to GHES', async () => {
    let factoryCalls = 0;
    await expect(
      createSelectedGitHubPullRequestClient(
        'github.example.com',
        undefined,
        async () => {
          factoryCalls += 1;
          return { kind: 'client' };
        }
      )
    ).rejects.toThrow('Unsupported GitHub pull request host.');
    expect(factoryCalls).toBe(0);

    const matcher = createGitHubPlugin().capabilities?.pullRequestProvider;
    expect(
      matcher?.matchRemote('git@github.com:acme/widgets.git')
    ).not.toBeNull();
    expect(
      matcher?.matchRemote('git@acme.ghe.com:acme/widgets.git')
    ).not.toBeNull();
    expect(
      matcher?.matchRemote('git@github.example.com:acme/widgets.git')
    ).toBeNull();
  });
});

describe('selected GitHub pull request authentication diagnostics', () => {
  const sentinels = [
    'ACTIVE_IDENTITY_SENTINEL_147',
    'RAW_CAUSE_SENTINEL_147',
    'DETAIL_SENTINEL_147',
    'MESSAGE_SENTINEL_147',
    'KEY_SENTINEL_147',
    'CATALOG_SENTINEL_147',
    'STDOUT_SENTINEL_147',
    'STDERR_SENTINEL_147',
    'TOKEN_SENTINEL_147',
    'PAT_SENTINEL_147',
    'CREDENTIAL_SENTINEL_147',
    'LABEL_SENTINEL_147',
    'METADATA_SENTINEL_147',
    'INJECTED_SENTINEL_147',
  ] as const;
  const host = 'acme.ghe.com';
  const account = 'ali" ce,`$();|\\😀';
  const authScope = canonicalSelectedScope(host, account);
  const expected =
    `GitHub PR authentication is unavailable for account ${JSON.stringify(account)} on host ${JSON.stringify(host)}. ` +
    'Remedy 1: In gh, switch to or sign in as that account for that host. ' +
    `Remedy 2 (JSON argv): ${JSON.stringify([
      'aide',
      'login',
      'github',
      '--scope-host',
      host,
      '--scope-account',
      account,
    ])}`;

  test('exposes separate fixed-arity injected and production client paths', () => {
    expect(createSelectedGitHubPullRequestClient).toHaveLength(3);
    expect(createProductionGitHubPullRequestClient).toHaveLength(2);
  });

  test('keeps production authority lexical across pre-import static replacement', async () => {
    const githubClientUrl = new URL(
      '../../../lib/github-client.ts',
      import.meta.url
    ).href;
    const authStoreUrl = new URL('../../../lib/auth-store.ts', import.meta.url)
      .href;
    const boundaryUrl = new URL('./pull-request-client.ts', import.meta.url)
      .href;
    const registryUrl = new URL(
      '../../host/command-registry.ts',
      import.meta.url
    ).href;
    const builtinUrl = new URL('../builtin.ts', import.meta.url).href;
    const source = `
      const github = await import(${JSON.stringify(githubClientUrl)});
      const { GitHubClient, GitHubAuthError } = github;
      const host = 'github.com';
      const account = 'alice';
      const preImportFailure = new GitHubAuthError(
        host,
        'not-configured',
        'PRE_IMPORT_STATIC_SENTINEL_147',
        account
      );
      const postImportFailure = new GitHubAuthError(
        host,
        'account-mismatch',
        'POST_IMPORT_STATIC_SENTINEL_147',
        account
      );
      let preImportCalls = 0;
      let postImportCalls = 0;
      GitHubClient.create = async () => {
        preImportCalls += 1;
        throw preImportFailure;
      };

      const boundary = await import(${JSON.stringify(boundaryUrl)});
      GitHubClient.create = async () => {
        postImportCalls += 1;
        throw postImportFailure;
      };

      const { authIndexScopeName } = await import(${JSON.stringify(authStoreUrl)});
      const { createBuiltinCommandRegistry } = await import(${JSON.stringify(builtinUrl)});
      const { certifiedBuiltinPullRequestProviderDiagnostic } = await import(
        ${JSON.stringify(registryUrl)}
      );
      const entry = createBuiltinCommandRegistry()
        .capabilities.pullRequestProviders()
        .find(({ pluginId }) => pluginId === 'github');
      if (entry === undefined) throw new Error('Missing built-in GitHub entry');

      const originalSecrets = Bun.secrets;
      const secretGetNames = [];
      Bun.secrets = {
        async get({ name }) {
          secretGetNames.push(name);
          if (name !== 'auth:github:host:github.com:account:alice') return null;
          return JSON.stringify({
            token: 'SYNTHETIC_ACCOUNT_TOKEN_147',
            identity: { host, account },
          });
        },
        async set() {
          throw new Error('Unexpected test keyring write');
        },
        async delete() {
          throw new Error('Unexpected test keyring delete');
        },
      };

      let client;
      let productionFailure;
      try {
        client = await boundary.createProductionGitHubPullRequestClient(
          host,
          Object.freeze({
            id: authIndexScopeName({ providerId: 'github', host, account }),
            providerId: 'github',
            host,
            account,
          })
        );
      } catch (failure) {
        productionFailure = failure;
      } finally {
        Bun.secrets = originalSecrets;
      }

      const isSelected = (diagnostic) =>
        diagnostic?.startsWith(
          'GitHub PR authentication is unavailable for account '
        ) ?? false;
      const directDiagnostic = (failure) =>
        boundary.githubPullRequestErrorDiagnostic(failure);
      const builtinDiagnostic = (failure) =>
        certifiedBuiltinPullRequestProviderDiagnostic(entry, failure);

      console.log(JSON.stringify({
        resolved: productionFailure === undefined,
        clientIsGitHubClient: client instanceof GitHubClient,
        preImportCalls,
        postImportCalls,
        secretGetNames,
        productionSelectedDirect: isSelected(directDiagnostic(productionFailure)),
        productionSelectedBuiltin: isSelected(builtinDiagnostic(productionFailure)),
        preImportSelectedDirect: isSelected(directDiagnostic(preImportFailure)),
        preImportSelectedBuiltin: isSelected(builtinDiagnostic(preImportFailure)),
        postImportSelectedDirect: isSelected(directDiagnostic(postImportFailure)),
        postImportSelectedBuiltin: isSelected(builtinDiagnostic(postImportFailure)),
      }));
    `;
    const environment: Record<string, string | undefined> = {
      ...Bun.env,
      AIDE_SECRET_SERVICE_OVERRIDE: 'aide-todo147-lexical-factory-process',
      GH_CONFIG_DIR: '/private/tmp/aide-todo147-disabled-gh',
      HOME: '/private/tmp/aide-todo147-disabled-home',
      PATH: '',
    };
    for (const name of [
      'FORCE_COLOR',
      'GH_ENTERPRISE_TOKEN',
      'GH_HOST',
      'GH_TOKEN',
      'GITHUB_ENTERPRISE_TOKEN',
      'GITHUB_TOKEN',
    ]) {
      delete environment[name];
    }

    const child = Bun.spawn({
      cmd: [process.execPath, '--eval', source],
      cwd: import.meta.dir,
      env: environment,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const outcome = await Promise.race([
      Promise.all([
        child.exited,
        new Response(child.stdout as ReadableStream<Uint8Array>).text(),
        new Response(child.stderr as ReadableStream<Uint8Array>).text(),
      ]).then(([exitCode, stdout, stderr]) => ({
        kind: 'exit' as const,
        exitCode,
        stdout,
        stderr,
      })),
      Bun.sleep(5_000).then(() => ({ kind: 'timeout' as const })),
    ]);
    if (outcome.kind === 'timeout') {
      child.kill('SIGKILL');
      await child.exited;
      throw new Error('lexical production factory fixture exceeded deadline');
    }

    expect(outcome.exitCode).toBe(0);
    expect(outcome.stderr).toBe('');
    expect(outcome.stdout.length).toBeLessThan(4_096);
    expect(outcome.stdout).not.toContain('SYNTHETIC_ACCOUNT_TOKEN_147');
    expect(JSON.parse(outcome.stdout.trim())).toEqual({
      resolved: true,
      clientIsGitHubClient: true,
      preImportCalls: 0,
      postImportCalls: 0,
      secretGetNames: ['auth:github:host:github.com:account:alice'],
      productionSelectedDirect: false,
      productionSelectedBuiltin: false,
      preImportSelectedDirect: false,
      preImportSelectedBuiltin: false,
      postImportSelectedDirect: false,
      postImportSelectedBuiltin: false,
    });
  });

  test('never lets an injected factory mint a selected diagnostic through public APIs', async () => {
    class InjectedGitHubAuthErrorSubclass extends GitHubAuthError {}

    let proxyTrapReads = 0;
    const proxiedAuthentic = new Proxy(
      new GitHubAuthError(host, 'not-configured', sentinels.join('|'), account),
      {
        getOwnPropertyDescriptor() {
          proxyTrapReads += 1;
          throw new Error('ERROR_PROXY_DESCRIPTOR_SENTINEL_147');
        },
        getPrototypeOf() {
          proxyTrapReads += 1;
          throw new Error('ERROR_PROXY_PROTOTYPE_SENTINEL_147');
        },
      }
    );
    const failures = [
      new GitHubAuthError(host, 'not-configured', sentinels.join('|'), account),
      new InjectedGitHubAuthErrorSubclass(
        host,
        'account-mismatch',
        sentinels.join('|'),
        account
      ),
      Object.freeze({
        name: 'GitHubAuthError',
        code: 'not-configured',
        host,
        account,
        message: sentinels[3],
      }),
      proxiedAuthentic,
      new SelectedGitHubPullRequestAuthError(),
      Object.freeze({
        name: 'SelectedGitHubPullRequestAuthError',
        message: expected,
      }),
    ] as const;
    const directBoundary = createSelectedGitHubPullRequestClient as unknown as <
      T,
    >(
      repositoryHost: string,
      selectedScope: AideAuthScope | undefined,
      createClient: (options: {
        readonly host: string;
        readonly scope: AuthStoreScope;
      }) => Promise<T>,
      callerProductionClaim?: boolean
    ) => Promise<T>;
    const entry = builtinGitHubProviderEntry();
    const isSelectedDiagnostic = (value: string | undefined) =>
      value?.startsWith(
        'GitHub PR authentication is unavailable for account '
      ) ?? false;

    for (const failure of failures) {
      const caught = await captureFailure(() =>
        directBoundary(
          host,
          authScope,
          async () => {
            throw failure;
          },
          true
        )
      );

      expect(caught).toBe(failure);
      expect(
        isSelectedDiagnostic(githubPullRequestErrorDiagnostic(caught))
      ).toBe(false);
      expect(
        isSelectedDiagnostic(
          certifiedBuiltinPullRequestProviderDiagnostic(entry, caught)
        )
      ).toBe(false);
    }
    expect(proxyTrapReads).toBe(0);
  });

  test('retains the existing authenticated GitHub diagnostic path for other codes', async () => {
    const failure = new GitHubAuthError(
      host,
      'malformed-credential',
      'Existing bounded GitHub diagnostic.',
      account
    );

    const caught = await captureFailure(() =>
      createSelectedGitHubPullRequestClient(host, authScope, async () => {
        throw failure;
      })
    );
    expect(caught).toBe(failure);
    expect(githubPullRequestErrorDiagnostic(caught)).toBe(
      'Existing bounded GitHub diagnostic.'
    );
  });

  test('does not translate host-only injected authentication failures', async () => {
    const failure = new GitHubAuthError(host, 'not-configured');
    const caught = await captureFailure(() =>
      createSelectedGitHubPullRequestClient(
        host,
        canonicalHostScope(host),
        async () => {
          throw failure;
        }
      )
    );

    expect(caught).toBe(failure);
    expect(githubPullRequestErrorDiagnostic(caught)).toContain(
      `GitHub authentication is not configured for '${host}'`
    );
  });

  test('does not translate injected, unknown, or forged factory failures', async () => {
    const injected = new GitHubAuthError(
      host,
      'not-configured',
      sentinels.join('|'),
      account
    );
    const unknown = new Error(sentinels[13]);
    const forged = Object.freeze({
      name: 'GitHubAuthError',
      code: 'not-configured',
      host,
      account,
      message: sentinels[3],
    });

    for (const failure of [injected, unknown, forged] as const) {
      const caught = await captureFailure(() =>
        createSelectedGitHubPullRequestClient(host, authScope, async () => {
          throw failure;
        })
      );
      expect(caught).toBe(failure);
    }
  });

  test('does not certify directly constructed selected errors through the real built-in boundary', () => {
    const entry = builtinGitHubProviderEntry();

    expect(
      certifiedBuiltinPullRequestProviderDiagnostic(
        entry,
        new SelectedGitHubPullRequestAuthError()
      )
    ).toBeUndefined();
    expect(
      certifiedBuiltinPullRequestProviderDiagnostic(entry, {
        name: 'SelectedGitHubPullRequestAuthError',
        message: expected,
      })
    ).toBeUndefined();
  });

  test('leaves injected factory errors generic at the host operation boundary', async () => {
    for (const raw of [
      new GitHubAuthError(
        'github.com',
        'not-configured',
        sentinels.join('|'),
        'alice'
      ),
      new Error(sentinels[13]),
    ]) {
      const plugin = createGitHubPlugin({
        createClient: async () => {
          throw raw;
        },
      });
      const registry = createKeyringCommandRegistry().registerPlugin(plugin);
      const error = await captureFailure(() =>
        runPullRequestCommandEffect(
          listPullRequestsForRepository(
            registry.capabilities.pullRequestProviders(),
            repository,
            {}
          )
        )
      );

      expect((error as Error).message).toBe(
        "Pull request provider 'github' from plugin 'github' failed during listPullRequests"
      );
      expect(Object.hasOwn(error as object, 'cause')).toBe(false);
      for (const sentinel of sentinels) {
        expect((error as Error).message).not.toContain(sentinel);
      }
    }
  });
});
