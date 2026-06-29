import { Context, type Effect } from 'effect';

import type {
  CommandRegistry,
  OwnedPluginCapability,
} from './command-registry.js';
import type {
  AideAuthProviderCapability,
  AideDiscoveredCapability,
  AidePrimeContributionCapability,
  AidePullRequestBranchLookupRequest,
  AidePullRequestBranchLookupResult,
  AidePullRequestListRequest,
  AidePullRequestListResult,
  AidePullRequestRemoteMatch,
  AidePullRequestRepositoryMatch,
  AidePullRequestRepositoryRef,
  AidePullRequestUrlMatch,
  AidePullRequestViewRequest,
  AidePullRequestViewResult,
} from './plugin-descriptor.js';
import {
  findPullRequestForBranchForRemote,
  findPullRequestForBranchForRepository,
  getPullRequestForRemote,
  getPullRequestForRepository,
  getPullRequestForUrl,
  listPullRequestsForRemote,
  listPullRequestsForRepository,
  type PullRequestProviderOperationInvocationError,
  resolvePullRequestProviderForRemote,
  resolvePullRequestProviderForRepository,
  resolvePullRequestProviderForUrl,
  type PullRequestProviderResolutionError,
  type PullRequestProviderOperationOptions,
  type PullRequestProviderResolutionOptions,
  type ResolvedPullRequestProvider,
} from './pull-request-provider-resolver.js';

const aideHostContexts = new WeakMap<object, AideHostContext>();

export interface AideHostServices {
  readonly authProviders: () => readonly AideDiscoveredCapability<AideAuthProviderCapability>[];
  readonly primeContributions: () => readonly AideDiscoveredCapability<AidePrimeContributionCapability>[];
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
  readonly resolvePullRequestProviderForRepository: (
    repository: AidePullRequestRepositoryRef,
    options?: PullRequestProviderResolutionOptions<AidePullRequestRepositoryMatch>
  ) => Effect.Effect<
    ResolvedPullRequestProvider<AidePullRequestRepositoryMatch>,
    PullRequestProviderResolutionError
  >;
  readonly listPullRequestsForRemote: (
    remoteUrl: string,
    request?: Omit<AidePullRequestListRequest, 'match'>,
    options?: PullRequestProviderOperationOptions
  ) => Effect.Effect<
    AidePullRequestListResult,
    PullRequestProviderOperationInvocationError
  >;
  readonly listPullRequestsForRepository: (
    repository: AidePullRequestRepositoryRef,
    request?: Omit<AidePullRequestListRequest, 'match'>,
    options?: PullRequestProviderOperationOptions
  ) => Effect.Effect<
    AidePullRequestListResult,
    PullRequestProviderOperationInvocationError
  >;
  readonly getPullRequestForRemote: (
    remoteUrl: string,
    request: Pick<AidePullRequestViewRequest, 'pullRequest'>,
    options?: PullRequestProviderOperationOptions
  ) => Effect.Effect<
    AidePullRequestViewResult,
    PullRequestProviderOperationInvocationError
  >;
  readonly getPullRequestForRepository: (
    repository: AidePullRequestRepositoryRef,
    request: Pick<AidePullRequestViewRequest, 'pullRequest'>,
    options?: PullRequestProviderOperationOptions
  ) => Effect.Effect<
    AidePullRequestViewResult,
    PullRequestProviderOperationInvocationError
  >;
  readonly findPullRequestForBranchForRemote: (
    remoteUrl: string,
    request: Pick<AidePullRequestBranchLookupRequest, 'branch'>,
    options?: PullRequestProviderOperationOptions
  ) => Effect.Effect<
    AidePullRequestBranchLookupResult,
    PullRequestProviderOperationInvocationError
  >;
  readonly findPullRequestForBranchForRepository: (
    repository: AidePullRequestRepositoryRef,
    request: Pick<AidePullRequestBranchLookupRequest, 'branch'>,
    options?: PullRequestProviderOperationOptions
  ) => Effect.Effect<
    AidePullRequestBranchLookupResult,
    PullRequestProviderOperationInvocationError
  >;
  readonly getPullRequestForUrl: (
    url: string,
    options?: PullRequestProviderOperationOptions
  ) => Effect.Effect<
    AidePullRequestViewResult,
    PullRequestProviderOperationInvocationError
  >;
}

export class AideHostServicesTag extends Context.Tag('AideHostServices')<
  AideHostServicesTag,
  AideHostServices
>() {}

export interface AideHostContext {
  readonly services: AideHostServices;
}

function discoveredCapabilities<TCapability>(
  capabilities: readonly OwnedPluginCapability<TCapability>[]
): readonly AideDiscoveredCapability<TCapability>[] {
  return Object.freeze(
    capabilities.map((entry) =>
      Object.freeze({
        pluginId: entry.pluginId,
        capability: entry.capability,
      })
    )
  );
}

/** @internal Legacy yargs bridge. Descriptor commands should use Effect context. */
export function attachAideHostContext<TArgv extends object>(
  argv: TArgv,
  context: AideHostContext
): TArgv {
  if (!aideHostContexts.has(argv)) {
    aideHostContexts.set(
      argv,
      Object.freeze({
        services: context.services,
      })
    );
  }
  return argv;
}

export function getAideHostContext(argv: unknown): AideHostContext | null {
  if (argv === null || typeof argv !== 'object') {
    return null;
  }
  return aideHostContexts.get(argv) ?? null;
}

export function createAideHostServices(
  registry: CommandRegistry
): AideHostServices {
  const authProviders = discoveredCapabilities(
    registry.capabilities.authProviders()
  );
  const primeContributions = discoveredCapabilities(
    registry.capabilities.primeContributions()
  );
  const pullRequestProviders = registry.capabilities.pullRequestProviders();
  return Object.freeze({
    authProviders: () => authProviders,
    primeContributions: () => primeContributions,
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
    resolvePullRequestProviderForRepository: (
      repository: AidePullRequestRepositoryRef,
      options: PullRequestProviderResolutionOptions<AidePullRequestRepositoryMatch> = {}
    ) =>
      resolvePullRequestProviderForRepository(
        pullRequestProviders,
        repository,
        options
      ),
    listPullRequestsForRemote: (
      remoteUrl: string,
      request: Omit<AidePullRequestListRequest, 'match'> = {},
      options: PullRequestProviderOperationOptions = {}
    ) =>
      listPullRequestsForRemote(
        pullRequestProviders,
        remoteUrl,
        request,
        options
      ),
    listPullRequestsForRepository: (
      repository: AidePullRequestRepositoryRef,
      request: Omit<AidePullRequestListRequest, 'match'> = {},
      options: PullRequestProviderOperationOptions = {}
    ) =>
      listPullRequestsForRepository(
        pullRequestProviders,
        repository,
        request,
        options
      ),
    getPullRequestForRemote: (
      remoteUrl: string,
      request: Pick<AidePullRequestViewRequest, 'pullRequest'>,
      options: PullRequestProviderOperationOptions = {}
    ) =>
      getPullRequestForRemote(
        pullRequestProviders,
        remoteUrl,
        request,
        options
      ),
    getPullRequestForRepository: (
      repository: AidePullRequestRepositoryRef,
      request: Pick<AidePullRequestViewRequest, 'pullRequest'>,
      options: PullRequestProviderOperationOptions = {}
    ) =>
      getPullRequestForRepository(
        pullRequestProviders,
        repository,
        request,
        options
      ),
    findPullRequestForBranchForRemote: (
      remoteUrl: string,
      request: Pick<AidePullRequestBranchLookupRequest, 'branch'>,
      options: PullRequestProviderOperationOptions = {}
    ) =>
      findPullRequestForBranchForRemote(
        pullRequestProviders,
        remoteUrl,
        request,
        options
      ),
    findPullRequestForBranchForRepository: (
      repository: AidePullRequestRepositoryRef,
      request: Pick<AidePullRequestBranchLookupRequest, 'branch'>,
      options: PullRequestProviderOperationOptions = {}
    ) =>
      findPullRequestForBranchForRepository(
        pullRequestProviders,
        repository,
        request,
        options
      ),
    getPullRequestForUrl: (
      url: string,
      options: PullRequestProviderOperationOptions = {}
    ) => getPullRequestForUrl(pullRequestProviders, url, options),
  });
}
