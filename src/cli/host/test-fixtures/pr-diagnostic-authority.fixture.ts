import { Effect } from 'effect';

import { createKeyringCommandRegistry } from '@cli/host/command-registry.js';
import {
  defineAidePlugin,
  type AidePullRequestProviderCapability,
} from '@cli/host/plugin-descriptor.js';
import { createAideHostServices } from '@cli/host/runtime-context.js';
import { renderTopLevelError } from '@cli/index.js';
import { runPullRequestCommandEffect } from '@cli/plugins/pull-requests/commands/error.js';

function hang(): never {
  for (;;) {
    // The parent deadline proves the forged formatter Proxy is never invoked.
  }
}

const repository = Object.freeze({
  kind: 'external' as const,
  providerId: 'raw-hanging-diagnostic',
  displayName: 'Raw hanging diagnostic',
});
const capability: AidePullRequestProviderCapability & Record<string, unknown> =
  {
    providerId: repository.providerId,
    priority: 100,
    features: {},
    authStatus: () => Effect.succeed({ state: 'configured' }),
    matchRemote: () => null,
    matchRepository: () =>
      Effect.succeed({ source: 'repository-ref', repository }),
    matchPullRequestUrl: () => null,
    operations: {
      listPullRequests: () => Effect.fail(Object.freeze({ kind: 'failure' })),
    },
  };
Object.defineProperty(capability, 'failureDiagnostic', {
  value: new Proxy(() => 'SECRET-HANGING-DIAGNOSTIC', {
    apply: hang,
    get: hang,
    getPrototypeOf: hang,
  }),
});

const registry = createKeyringCommandRegistry().registerPlugin(
  defineAidePlugin({
    id: 'raw-hanging-diagnostic',
    summary: 'Raw hanging diagnostic authority fixture',
    commands: [],
    capabilities: { pullRequestProvider: capability },
  })
);

try {
  await runPullRequestCommandEffect(
    createAideHostServices(registry).listPullRequestsForRepository(repository)
  );
  throw new Error('Expected raw provider operation to fail');
} catch (error) {
  process.stdout.write(`${renderTopLevelError(error)}\n`);
}
