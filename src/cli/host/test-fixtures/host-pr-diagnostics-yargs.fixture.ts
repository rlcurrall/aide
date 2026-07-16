import { Effect } from 'effect';
import yargs from 'yargs';

import type { PluginCapability } from '@cli/host/command-registry.js';
import type { AidePullRequestProviderCapability } from '@cli/host/plugin-descriptor.js';
import {
  createPullRequestForRemote,
  listPullRequestsForRemote,
  resolvePullRequestProviderForRepositoryInput,
} from '@cli/host/pull-request-provider-resolver.js';
import { renderTopLevelError } from '@cli/index.js';
import { runPullRequestCommandEffect } from '@cli/plugins/pull-requests/commands/error.js';

type Mode =
  | 'unsupported'
  | 'ambiguous'
  | 'invalid-matcher'
  | 'invocation'
  | 'invalid-result'
  | 'unsupported-operation'
  | 'matcher-timeout'
  | 'operation-timeout'
  | 'mutation-indeterminate';

const mode = process.argv[2] as Mode;
const remote =
  'https://TODO160-YARGS-USER:TODO160-YARGS-PASSWORD@example.invalid/owner/widgets.git?token=TODO160-YARGS-QUERY#TODO160-YARGS-FRAGMENT';

function provider(
  id: string,
  overrides: Partial<AidePullRequestProviderCapability> = {}
): PluginCapability<AidePullRequestProviderCapability> {
  const repository = Object.freeze({
    kind: 'external' as const,
    providerId: id,
    displayName: id,
  });
  return {
    pluginId: `${id}-plugin`,
    capability: {
      providerId: id,
      priority: 100,
      features: {},
      authStatus: () => Effect.succeed({ state: 'configured' }),
      matchRemote: () => ({
        source: 'git-remote',
        repository,
      }),
      matchRepository: () =>
        Effect.succeed({ source: 'repository-ref', repository }),
      matchPullRequestUrl: () => null,
      operations: {
        listPullRequests: () =>
          Effect.succeed({
            repository,
            pullRequests: [],
          }),
      },
      ...overrides,
    },
  };
}

function diagnosticEffect() {
  switch (mode) {
    case 'unsupported':
      return listPullRequestsForRemote([], remote);
    case 'ambiguous':
      return listPullRequestsForRemote(
        [provider('ambiguous-a'), provider('ambiguous-b')],
        remote
      );
    case 'invocation':
      return listPullRequestsForRemote(
        [
          provider('invocation', {
            matchRemote: () => {
              throw new Error('TODO160-YARGS-MATCHER-FAILURE');
            },
          }),
        ],
        remote
      );
    case 'invalid-matcher':
      return listPullRequestsForRemote(
        [
          provider('invalid-matcher', {
            matchRemote: () => ({ attacker: true }) as never,
          }),
        ],
        remote
      );
    case 'invalid-result':
      return listPullRequestsForRemote(
        [
          provider('invalid-result', {
            operations: {
              listPullRequests: () => Effect.succeed({}) as never,
            },
          }),
        ],
        remote
      );
    case 'unsupported-operation':
      return listPullRequestsForRemote(
        [provider('unsupported-operation', { operations: {} })],
        remote
      );
    case 'matcher-timeout':
      return resolvePullRequestProviderForRepositoryInput(
        [
          provider('matcher-timeout', {
            matchRepository: () => Effect.never,
          }),
        ],
        {
          providerId: 'matcher-timeout',
          repo: 'https://TODO160-TIMEOUT-USER:TODO160-TIMEOUT-PASSWORD@example.invalid/owner/widgets.git?token=TODO160-TIMEOUT-QUERY#TODO160-TIMEOUT-FRAGMENT',
        },
        { matcherTimeout: '10 millis' }
      );
    case 'operation-timeout':
      return listPullRequestsForRemote(
        [
          provider('operation-timeout', {
            operations: { listPullRequests: () => Effect.never },
          }),
        ],
        remote,
        {},
        { operationTimeout: '10 millis' }
      );
    case 'mutation-indeterminate':
      return createPullRequestForRemote(
        [
          provider('mutation-indeterminate', {
            operations: { createPullRequest: () => Effect.never },
          }),
        ],
        remote,
        {
          title: 'Indeterminate probe',
          sourceBranch: 'feature',
          targetBranch: 'main',
        },
        { operationTimeout: '10 millis' }
      );
  }
}

await yargs(['probe'])
  .exitProcess(false)
  .command({
    command: 'probe',
    handler: async () => {
      try {
        await runPullRequestCommandEffect(
          diagnosticEffect() as Effect.Effect<unknown, unknown, never>
        );
        throw new Error(`Expected ${mode} probe to fail`);
      } catch (error) {
        console.error(renderTopLevelError(error));
        process.exitCode = 1;
      }
    },
  })
  .parse();
