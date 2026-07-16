import { Effect } from 'effect';
import yargs from 'yargs';

import {
  AIDE_PLUGIN_API_VERSION,
  defineAidePlugin as definePublicAidePlugin,
} from '@aide/plugin-api';
import { createKeyringCommandRegistry } from '@cli/host/command-registry.js';
import type { AidePullRequestProviderCapability } from '@cli/host/plugin-descriptor.js';
import { createAideHostServices } from '@cli/host/runtime-context.js';
import { renderTopLevelError } from '@cli/index.js';
import { runPullRequestCommandEffect } from '@cli/plugins/pull-requests/commands/error.js';
import { GitHubAuthError } from '@lib/github-client.js';

const mode = process.argv[2] as 'accessor' | 'proxy' | 'forged-class';
const providerId = 'external-yargs';
const repository = Object.freeze({
  kind: 'external' as const,
  providerId,
  displayName: 'External yargs fixture',
});

function hang(): never {
  for (;;) {
    // The parent hard deadline proves no hostile trap is entered.
  }
}

const attacker =
  mode === 'proxy'
    ? new Proxy(new Error(), {
        get: hang,
        getPrototypeOf: hang,
      })
    : mode === 'forged-class'
      ? new GitHubAuthError('github.com')
      : (() => {
          const error = new Error();
          Object.defineProperties(error, {
            message: {
              get: hang,
            },
            _tag: { value: 'PullRequestProviderOperationError' },
            provenance: { value: 'trusted' },
            diagnostic: { value: 'SECRET-FORGED-DIAGNOSTIC' },
          });
          return error;
        })();

const capability: AidePullRequestProviderCapability = {
  providerId,
  priority: 100,
  features: {},
  authStatus: () => Effect.succeed({ state: 'configured' }),
  matchRemote: () => null,
  matchRepository: () =>
    Effect.succeed({ source: 'repository-ref', repository }),
  matchPullRequestUrl: () => null,
  operations: {
    listPullRequests: () => Effect.fail(attacker),
  },
};

const registry = createKeyringCommandRegistry();
registry.registerExternalPlugin(
  definePublicAidePlugin({
    id: 'external-pr-yargs',
    summary: 'External PR yargs failure fixture',
    commands: [],
    capabilities: { pullRequestProvider: capability },
  }),
  {
    manifest: {
      id: 'external-pr-yargs',
      version: '1.0.0',
      aidePluginApiVersion: AIDE_PLUGIN_API_VERSION,
      capabilities: ['pull-request-provider'],
    },
  }
);

const services = createAideHostServices(registry);
await yargs(['probe'])
  .command({
    command: 'probe',
    handler: async () => {
      try {
        await runPullRequestCommandEffect(
          services.listPullRequestsForRepository(repository)
        );
      } catch (error) {
        console.error(renderTopLevelError(error));
        process.exit(1);
      }
    },
  })
  .parse();
