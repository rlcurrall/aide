import { Effect } from 'effect';
import type { Options } from 'yargs';

import type {
  AidePullRequestRepositoryInput,
  AidePullRequestRepositoryRef,
} from '@cli/host/plugin-descriptor.js';
import type { AideHostServices } from '@cli/host/runtime-context.js';

export interface PullRequestRepositoryArgs {
  readonly provider?: string;
  readonly host?: string;
  readonly owner?: string;
  readonly org?: string;
  readonly project?: string;
  readonly repo?: string;
}

export interface ResolvedPullRequestRepositoryRef {
  readonly repository: AidePullRequestRepositoryRef;
  readonly autoDiscovered: boolean;
}

export const pullRequestRepositoryOptions = Object.freeze({
  provider: {
    type: 'string',
    describe: 'PR provider for explicit repository context',
  },
  host: {
    type: 'string',
    describe: 'Repository host for explicit repository context',
  },
  owner: {
    type: 'string',
    describe: 'Repository owner for explicit repository context',
  },
  org: {
    type: 'string',
    describe: 'Organization for explicit repository context',
  },
  project: {
    type: 'string',
    describe: 'Project name for explicit repository context',
  },
  repo: {
    type: 'string',
    describe: 'Repository name for explicit repository context',
  },
} satisfies Record<string, Options>);

export function hasExplicitPullRequestRepositoryInput(
  args: PullRequestRepositoryArgs
): boolean {
  return (
    args.provider !== undefined ||
    args.host !== undefined ||
    args.owner !== undefined ||
    args.org !== undefined ||
    args.project !== undefined ||
    args.repo !== undefined
  );
}

export async function resolveExplicitPullRequestRepositoryRef(
  services: AideHostServices,
  args: PullRequestRepositoryArgs
): Promise<ResolvedPullRequestRepositoryRef> {
  const input = buildPullRequestRepositoryInput(args);
  const provider = await Effect.runPromise(
    services.resolvePullRequestProviderForRepositoryInput(input)
  );

  return {
    repository: provider.match.repository,
    autoDiscovered: false,
  };
}

function buildPullRequestRepositoryInput(
  args: PullRequestRepositoryArgs
): AidePullRequestRepositoryInput {
  return {
    ...(args.provider === undefined
      ? {}
      : { providerId: normalizePullRequestProviderId(args.provider) }),
    ...(args.host === undefined ? {} : { host: args.host }),
    ...(args.owner === undefined ? {} : { owner: args.owner }),
    ...(args.org === undefined ? {} : { org: args.org }),
    ...(args.project === undefined ? {} : { project: args.project }),
    ...(args.repo === undefined ? {} : { repo: args.repo }),
  };
}

function normalizePullRequestProviderId(provider: string): string {
  return provider === 'ado' ? 'azure-devops' : provider;
}
