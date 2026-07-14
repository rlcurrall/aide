import { describe, expect, test } from 'bun:test';
import { Effect } from 'effect';

import {
  AIDE_PLUGIN_API_VERSION,
  defineAidePlugin as definePublicAidePlugin,
} from '@aide/plugin-api';
import { GitHubAuthError } from '@lib/github-client.js';
import { ConfigError } from '@lib/config.js';
import { createBuiltinCommandRegistry } from '@cli/plugins/builtin.js';
import { createAzureDevOpsPlugin } from '@cli/plugins/azure-devops/plugin.js';
import { createGitHubPlugin } from '@cli/plugins/github/plugin.js';
import {
  certifiedBuiltinPullRequestProviderDiagnostic,
  createKeyringCommandRegistry,
} from './command-registry.js';
import {
  defineAidePlugin,
  type AidePluginDescriptor,
  type AidePullRequestProviderCapability,
} from './plugin-descriptor.js';
import { createAideHostServices } from './runtime-context.js';
import { listPullRequestsForRepository } from './pull-request-provider-resolver.js';
import { runPullRequestCommandEffect } from '@cli/plugins/pull-requests/commands/error.js';

const repository = Object.freeze({
  kind: 'external' as const,
  providerId: 'diagnostic-authority',
  displayName: 'Diagnostic authority',
});

async function rejectedByRawProvider(
  registry: ReturnType<typeof createKeyringCommandRegistry>
) {
  try {
    await runPullRequestCommandEffect(
      createAideHostServices(registry).listPullRequestsForRepository(repository)
    );
  } catch (error) {
    return error;
  }
  throw new Error('Expected raw provider operation to reject');
}

function rawDiagnosticPlugin(
  diagnosticDescriptor: PropertyDescriptor,
  failure: unknown
): AidePluginDescriptor {
  const capability: AidePullRequestProviderCapability &
    Record<string, unknown> = {
    providerId: repository.providerId,
    priority: 100,
    features: {},
    authStatus: () => Effect.succeed({ state: 'configured' }),
    matchRemote: () => null,
    matchRepository: () =>
      Effect.succeed({ source: 'repository-ref', repository }),
    matchPullRequestUrl: () => null,
    operations: {
      listPullRequests: () => Effect.fail(failure),
    },
  };
  Object.defineProperty(capability, 'failureDiagnostic', diagnosticDescriptor);
  return defineAidePlugin({
    id: 'raw-diagnostic-authority',
    summary: 'Raw diagnostic authority probe',
    commands: [],
    capabilities: { pullRequestProvider: capability },
  });
}

describe('certified built-in pull request diagnostic authority', () => {
  test('recognizes only an exact built-in registry entry', () => {
    const registry = createBuiltinCommandRegistry();
    const entry = registry.capabilities
      .pullRequestProviders()
      .find(({ pluginId }) => pluginId === 'github');
    if (entry === undefined) throw new Error('Missing GitHub built-in entry');
    const failure = new GitHubAuthError('github.com');

    expect(
      certifiedBuiltinPullRequestProviderDiagnostic(entry, failure)
    ).toContain("GitHub authentication is not configured for 'github.com'");
    expect(
      certifiedBuiltinPullRequestProviderDiagnostic({ ...entry }, failure)
    ).toBeUndefined();

    const snapshot = registry.plugins().find(({ id }) => id === 'github');
    if (snapshot === undefined) throw new Error('Missing GitHub snapshot');
    expect(
      Object.prototype.hasOwnProperty.call(
        snapshot.capabilities?.pullRequestProvider,
        'failureDiagnostic'
      )
    ).toBe(false);
    const replayEntry = createKeyringCommandRegistry()
      .registerPlugin(snapshot)
      .capabilities.pullRequestProviders()[0];
    expect(replayEntry).toBeDefined();
    expect(
      certifiedBuiltinPullRequestProviderDiagnostic(replayEntry!, failure)
    ).toBeUndefined();
  });

  test('factory-created GitHub and Azure descriptors remain uncertified', () => {
    const cases = [
      {
        plugin: createGitHubPlugin(),
        failure: new GitHubAuthError('github.com'),
      },
      {
        plugin: createAzureDevOpsPlugin(),
        failure: new ConfigError('SECRET-FACTORY-CONFIG-DIAGNOSTIC'),
      },
    ] as const;

    for (const { plugin, failure } of cases) {
      const entry = createKeyringCommandRegistry()
        .registerPlugin(plugin)
        .capabilities.pullRequestProviders()[0];
      expect(entry).toBeDefined();
      expect(
        certifiedBuiltinPullRequestProviderDiagnostic(entry!, failure)
      ).toBeUndefined();
    }
  });

  test('ignores forged properties and never inspects hostile entry or failure objects', () => {
    let reads = 0;
    const forged = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(forged, 'failureDiagnostic', {
      get() {
        reads += 1;
        throw new Error('forged diagnostic getter ran');
      },
    });
    const failure = new Proxy(Object.create(null), {
      get() {
        reads += 1;
        throw new Error('failure getter ran');
      },
      getPrototypeOf() {
        reads += 1;
        throw new Error('failure prototype trap ran');
      },
    });

    expect(
      certifiedBuiltinPullRequestProviderDiagnostic(forged as never, failure)
    ).toBeUndefined();
    expect(reads).toBe(0);
  });

  test('spread and forged built-in capabilities render only fixed generic text', async () => {
    const entry = createBuiltinCommandRegistry()
      .capabilities.pullRequestProviders()
      .find(({ pluginId }) => pluginId === 'github');
    if (entry === undefined) throw new Error('Missing GitHub built-in entry');
    const forgedEntry = {
      ...entry,
      capability: {
        ...entry.capability,
        operations: {
          ...entry.capability.operations,
          listPullRequests: () =>
            Effect.fail(new GitHubAuthError('github.com')),
        },
      },
    };
    const error = await (async () => {
      try {
        await runPullRequestCommandEffect(
          listPullRequestsForRepository(
            [forgedEntry],
            {
              kind: 'github',
              host: 'github.com',
              owner: 'openai',
              repo: 'aide',
            },
            {}
          )
        );
      } catch (failure) {
        return failure;
      }
      throw new Error('Expected forged built-in operation to reject');
    })();

    expect((error as Error).message).toBe(
      "Pull request provider 'github' from plugin 'github' failed during listPullRequests"
    );
    expect((error as Error).message).not.toContain('GitHub authentication');
  });

  test('raw trusted registration neither retains nor invokes formatter authority', async () => {
    let calls = 0;
    const failure = Object.freeze({ kind: 'raw failure' });
    const registry = createKeyringCommandRegistry().registerPlugin(
      rawDiagnosticPlugin(
        {
          value: () => {
            calls += 1;
            return 'SECRET-PLUGIN-OWNED-DIAGNOSTIC';
          },
        },
        failure
      )
    );
    const snapshotCapability =
      registry.plugins()[0]?.capabilities?.pullRequestProvider;
    expect(
      Object.prototype.hasOwnProperty.call(
        snapshotCapability,
        'failureDiagnostic'
      )
    ).toBe(false);

    const error = await rejectedByRawProvider(registry);
    expect((error as Error).message).toBe(
      "Pull request provider 'diagnostic-authority' from plugin 'raw-diagnostic-authority' failed during listPullRequests"
    );
    expect(Object.hasOwn(error as object, 'cause')).toBe(false);
    expect(calls).toBe(0);

    const snapshot = registry.plugins()[0];
    if (snapshot === undefined) throw new Error('Missing raw snapshot');
    const replayError = await rejectedByRawProvider(
      createKeyringCommandRegistry().registerPlugin(snapshot)
    );
    expect((replayError as Error).message).toBe(
      "Pull request provider 'diagnostic-authority' from plugin 'raw-diagnostic-authority' failed during listPullRequests"
    );
    expect(calls).toBe(0);
  });

  test('raw trusted forged accessors are not read', () => {
    let reads = 0;
    const registry = createKeyringCommandRegistry();
    expect(() =>
      registry.registerPlugin(
        rawDiagnosticPlugin(
          {
            get() {
              reads += 1;
              throw new Error('forged formatter accessor ran');
            },
          },
          new Error('raw failure')
        )
      )
    ).not.toThrow();
    expect(reads).toBe(0);
  });

  test('public external registration rejects formatter data atomically without invocation', () => {
    let calls = 0;
    const capability = {
      providerId: 'public-diagnostic-authority',
      priority: 100,
      features: {},
      authStatus: () => Effect.succeed({ state: 'configured' as const }),
      matchRemote: () => null,
      matchPullRequestUrl: () => null,
      failureDiagnostic: () => {
        calls += 1;
        return 'SECRET-PUBLIC-DIAGNOSTIC';
      },
    };
    const registry = createKeyringCommandRegistry();

    expect(() =>
      registry.registerExternalPlugin(
        definePublicAidePlugin({
          id: 'public-diagnostic-authority',
          summary: 'Public diagnostic authority probe',
          commands: [],
          capabilities: { pullRequestProvider: capability },
        } as never),
        {
          manifest: {
            id: 'public-diagnostic-authority',
            version: '1.0.0',
            aidePluginApiVersion: AIDE_PLUGIN_API_VERSION,
            capabilities: ['pull-request-provider'],
          },
        }
      )
    ).toThrow('External plugin metadata capture failed');
    expect(registry.plugins()).toEqual([]);
    expect(calls).toBe(0);
  });
});
