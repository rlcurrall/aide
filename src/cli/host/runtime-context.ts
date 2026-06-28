import { Context, type Effect } from 'effect';

import type { CommandRegistry } from './command-registry.js';
import type {
  AidePullRequestRemoteMatch,
  AidePullRequestUrlMatch,
} from './plugin-descriptor.js';
import {
  resolvePullRequestProviderForRemote,
  resolvePullRequestProviderForUrl,
  type PullRequestProviderResolutionError,
  type PullRequestProviderResolutionOptions,
  type ResolvedPullRequestProvider,
} from './pull-request-provider-resolver.js';

const aideHostContextSymbol = Symbol.for('aide.hostContext');

export interface AideHostServices {
  readonly resolvePullRequestProviderForRemote: (
    remoteUrl: string,
    options?: PullRequestProviderResolutionOptions<AidePullRequestRemoteMatch>
  ) => Effect.Effect<
    ResolvedPullRequestProvider<AidePullRequestRemoteMatch>,
    PullRequestProviderResolutionError
  >;
  readonly resolvePullRequestProviderForUrl: (
    url: string,
    options?: PullRequestProviderResolutionOptions<AidePullRequestUrlMatch>
  ) => Effect.Effect<
    ResolvedPullRequestProvider<AidePullRequestUrlMatch>,
    PullRequestProviderResolutionError
  >;
}

export class AideHostServicesTag extends Context.Tag('AideHostServices')<
  AideHostServicesTag,
  AideHostServices
>() {}

export interface AideHostContext {
  readonly services: AideHostServices;
}

type AideHostContextCarrier = {
  [aideHostContextSymbol]?: AideHostContext;
};

export function attachAideHostContext<TArgv extends object>(
  argv: TArgv,
  context: AideHostContext
): TArgv {
  Object.defineProperty(argv, aideHostContextSymbol, {
    value: context,
    enumerable: false,
    configurable: true,
  });
  return argv;
}

export function getAideHostContext(argv: unknown): AideHostContext | null {
  if (argv === null || typeof argv !== 'object') {
    return null;
  }
  return (argv as AideHostContextCarrier)[aideHostContextSymbol] ?? null;
}

export function createAideHostServices(
  registry: CommandRegistry
): AideHostServices {
  const pullRequestProviders = registry.capabilities.pullRequestProviders();
  return Object.freeze({
    resolvePullRequestProviderForRemote: (
      remoteUrl: string,
      options: PullRequestProviderResolutionOptions<AidePullRequestRemoteMatch> = {}
    ) =>
      resolvePullRequestProviderForRemote(
        pullRequestProviders,
        remoteUrl,
        options
      ),
    resolvePullRequestProviderForUrl: (
      url: string,
      options: PullRequestProviderResolutionOptions<AidePullRequestUrlMatch> = {}
    ) => resolvePullRequestProviderForUrl(pullRequestProviders, url, options),
  });
}
