import { Context, type Effect } from 'effect';

import type {
  CommandRegistry,
  OwnedPluginCapability,
} from './command-registry.js';
import type {
  AideAuthProviderCapability,
  AideDiscoveredCapability,
  AidePrimeContributionCapability,
  AidePullRequestAddCommentRequest,
  AidePullRequestBranchLookupRequest,
  AidePullRequestBranchLookupResult,
  AidePullRequestCommentMutationResult,
  AidePullRequestCommentsRequest,
  AidePullRequestCommentsResult,
  AidePullRequestCreateRequest,
  AidePullRequestCreateResult,
  AidePullRequestDiffRequest,
  AidePullRequestDiffResult,
  AidePullRequestListRequest,
  AidePullRequestListResult,
  AidePullRequestRemoteMatch,
  AidePullRequestRepositoryMatch,
  AidePullRequestRepositoryRef,
  AidePullRequestReplyCommentRequest,
  AidePullRequestUrlMatch,
  AidePullRequestUpdateRequest,
  AidePullRequestUpdateResult,
  AidePullRequestViewRequest,
  AidePullRequestViewResult,
} from './plugin-descriptor.js';
import {
  addPullRequestCommentForRemote,
  addPullRequestCommentForRepository,
  addPullRequestCommentForUrl,
  createPullRequestForRemote,
  createPullRequestForRepository,
  findPullRequestForBranchContextForRemote,
  findPullRequestForBranchContextForRepository,
  findPullRequestForBranchForRemote,
  findPullRequestForBranchForRepository,
  getPullRequestContextForRemote,
  getPullRequestContextForRepository,
  getPullRequestContextForUrl,
  getPullRequestDiffForRemote,
  getPullRequestDiffForRepository,
  getPullRequestDiffForUrl,
  getPullRequestForRemote,
  getPullRequestForRepository,
  getPullRequestForUrl,
  listPullRequestCommentsForRemote,
  listPullRequestCommentsForRepository,
  listPullRequestCommentsForUrl,
  listPullRequestsForRemote,
  listPullRequestsForRepository,
  replyToPullRequestCommentForRemote,
  replyToPullRequestCommentForRepository,
  replyToPullRequestCommentForUrl,
  updatePullRequestForRemote,
  updatePullRequestForRepository,
  updatePullRequestForUrl,
  type PullRequestProviderOperationInvocationError,
  type PullRequestProviderOperationContext,
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
  readonly createPullRequestForRemote: (
    remoteUrl: string,
    request: Omit<AidePullRequestCreateRequest, 'match'>,
    options?: PullRequestProviderOperationOptions
  ) => Effect.Effect<
    AidePullRequestCreateResult,
    PullRequestProviderOperationInvocationError
  >;
  readonly createPullRequestForRepository: (
    repository: AidePullRequestRepositoryRef,
    request: Omit<AidePullRequestCreateRequest, 'match'>,
    options?: PullRequestProviderOperationOptions
  ) => Effect.Effect<
    AidePullRequestCreateResult,
    PullRequestProviderOperationInvocationError
  >;
  readonly updatePullRequestForRemote: (
    remoteUrl: string,
    request: Omit<AidePullRequestUpdateRequest, 'match'>,
    options?: PullRequestProviderOperationOptions
  ) => Effect.Effect<
    AidePullRequestUpdateResult,
    PullRequestProviderOperationInvocationError
  >;
  readonly updatePullRequestForRepository: (
    repository: AidePullRequestRepositoryRef,
    request: Omit<AidePullRequestUpdateRequest, 'match'>,
    options?: PullRequestProviderOperationOptions
  ) => Effect.Effect<
    AidePullRequestUpdateResult,
    PullRequestProviderOperationInvocationError
  >;
  readonly updatePullRequestForUrl: (
    url: string,
    request: Omit<AidePullRequestUpdateRequest, 'match' | 'pullRequest'>,
    options?: PullRequestProviderOperationOptions
  ) => Effect.Effect<
    AidePullRequestUpdateResult,
    PullRequestProviderOperationInvocationError
  >;
  readonly getPullRequestContextForRemote: (
    remoteUrl: string,
    request: Pick<AidePullRequestViewRequest, 'pullRequest'>,
    options?: PullRequestProviderOperationOptions
  ) => Effect.Effect<
    PullRequestProviderOperationContext<
      AidePullRequestRemoteMatch,
      AidePullRequestViewResult
    >,
    PullRequestProviderOperationInvocationError
  >;
  readonly getPullRequestContextForRepository: (
    repository: AidePullRequestRepositoryRef,
    request: Pick<AidePullRequestViewRequest, 'pullRequest'>,
    options?: PullRequestProviderOperationOptions
  ) => Effect.Effect<
    PullRequestProviderOperationContext<
      AidePullRequestRepositoryMatch,
      AidePullRequestViewResult
    >,
    PullRequestProviderOperationInvocationError
  >;
  readonly getPullRequestContextForUrl: (
    url: string,
    options?: PullRequestProviderOperationOptions
  ) => Effect.Effect<
    PullRequestProviderOperationContext<
      AidePullRequestUrlMatch,
      AidePullRequestViewResult
    >,
    PullRequestProviderOperationInvocationError
  >;
  readonly getPullRequestDiffForRemote: (
    remoteUrl: string,
    request: Pick<AidePullRequestDiffRequest, 'pullRequest'>,
    options?: PullRequestProviderOperationOptions
  ) => Effect.Effect<
    AidePullRequestDiffResult,
    PullRequestProviderOperationInvocationError
  >;
  readonly getPullRequestDiffForRepository: (
    repository: AidePullRequestRepositoryRef,
    request: Pick<AidePullRequestDiffRequest, 'pullRequest'>,
    options?: PullRequestProviderOperationOptions
  ) => Effect.Effect<
    AidePullRequestDiffResult,
    PullRequestProviderOperationInvocationError
  >;
  readonly getPullRequestDiffForUrl: (
    url: string,
    options?: PullRequestProviderOperationOptions
  ) => Effect.Effect<
    AidePullRequestDiffResult,
    PullRequestProviderOperationInvocationError
  >;
  readonly listPullRequestCommentsForRemote: (
    remoteUrl: string,
    request: Pick<AidePullRequestCommentsRequest, 'pullRequest'>,
    options?: PullRequestProviderOperationOptions
  ) => Effect.Effect<
    AidePullRequestCommentsResult,
    PullRequestProviderOperationInvocationError
  >;
  readonly listPullRequestCommentsForRepository: (
    repository: AidePullRequestRepositoryRef,
    request: Pick<AidePullRequestCommentsRequest, 'pullRequest'>,
    options?: PullRequestProviderOperationOptions
  ) => Effect.Effect<
    AidePullRequestCommentsResult,
    PullRequestProviderOperationInvocationError
  >;
  readonly listPullRequestCommentsForUrl: (
    url: string,
    options?: PullRequestProviderOperationOptions
  ) => Effect.Effect<
    AidePullRequestCommentsResult,
    PullRequestProviderOperationInvocationError
  >;
  readonly addPullRequestCommentForRemote: (
    remoteUrl: string,
    request: Omit<AidePullRequestAddCommentRequest, 'match'>,
    options?: PullRequestProviderOperationOptions
  ) => Effect.Effect<
    AidePullRequestCommentMutationResult,
    PullRequestProviderOperationInvocationError
  >;
  readonly addPullRequestCommentForRepository: (
    repository: AidePullRequestRepositoryRef,
    request: Omit<AidePullRequestAddCommentRequest, 'match'>,
    options?: PullRequestProviderOperationOptions
  ) => Effect.Effect<
    AidePullRequestCommentMutationResult,
    PullRequestProviderOperationInvocationError
  >;
  readonly addPullRequestCommentForUrl: (
    url: string,
    request: Omit<AidePullRequestAddCommentRequest, 'match' | 'pullRequest'>,
    options?: PullRequestProviderOperationOptions
  ) => Effect.Effect<
    AidePullRequestCommentMutationResult,
    PullRequestProviderOperationInvocationError
  >;
  readonly replyToPullRequestCommentForRemote: (
    remoteUrl: string,
    request: Omit<AidePullRequestReplyCommentRequest, 'match'>,
    options?: PullRequestProviderOperationOptions
  ) => Effect.Effect<
    AidePullRequestCommentMutationResult,
    PullRequestProviderOperationInvocationError
  >;
  readonly replyToPullRequestCommentForRepository: (
    repository: AidePullRequestRepositoryRef,
    request: Omit<AidePullRequestReplyCommentRequest, 'match'>,
    options?: PullRequestProviderOperationOptions
  ) => Effect.Effect<
    AidePullRequestCommentMutationResult,
    PullRequestProviderOperationInvocationError
  >;
  readonly replyToPullRequestCommentForUrl: (
    url: string,
    request: Omit<AidePullRequestReplyCommentRequest, 'match' | 'pullRequest'>,
    options?: PullRequestProviderOperationOptions
  ) => Effect.Effect<
    AidePullRequestCommentMutationResult,
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
  readonly findPullRequestForBranchContextForRemote: (
    remoteUrl: string,
    request: Pick<AidePullRequestBranchLookupRequest, 'branch'>,
    options?: PullRequestProviderOperationOptions
  ) => Effect.Effect<
    PullRequestProviderOperationContext<
      AidePullRequestRemoteMatch,
      AidePullRequestBranchLookupResult
    >,
    PullRequestProviderOperationInvocationError
  >;
  readonly findPullRequestForBranchContextForRepository: (
    repository: AidePullRequestRepositoryRef,
    request: Pick<AidePullRequestBranchLookupRequest, 'branch'>,
    options?: PullRequestProviderOperationOptions
  ) => Effect.Effect<
    PullRequestProviderOperationContext<
      AidePullRequestRepositoryMatch,
      AidePullRequestBranchLookupResult
    >,
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
    createPullRequestForRemote: (
      remoteUrl: string,
      request: Omit<AidePullRequestCreateRequest, 'match'>,
      options: PullRequestProviderOperationOptions = {}
    ) =>
      createPullRequestForRemote(
        pullRequestProviders,
        remoteUrl,
        request,
        options
      ),
    createPullRequestForRepository: (
      repository: AidePullRequestRepositoryRef,
      request: Omit<AidePullRequestCreateRequest, 'match'>,
      options: PullRequestProviderOperationOptions = {}
    ) =>
      createPullRequestForRepository(
        pullRequestProviders,
        repository,
        request,
        options
      ),
    updatePullRequestForRemote: (
      remoteUrl: string,
      request: Omit<AidePullRequestUpdateRequest, 'match'>,
      options: PullRequestProviderOperationOptions = {}
    ) =>
      updatePullRequestForRemote(
        pullRequestProviders,
        remoteUrl,
        request,
        options
      ),
    updatePullRequestForRepository: (
      repository: AidePullRequestRepositoryRef,
      request: Omit<AidePullRequestUpdateRequest, 'match'>,
      options: PullRequestProviderOperationOptions = {}
    ) =>
      updatePullRequestForRepository(
        pullRequestProviders,
        repository,
        request,
        options
      ),
    updatePullRequestForUrl: (
      url: string,
      request: Omit<AidePullRequestUpdateRequest, 'match' | 'pullRequest'>,
      options: PullRequestProviderOperationOptions = {}
    ) => updatePullRequestForUrl(pullRequestProviders, url, request, options),
    getPullRequestContextForRemote: (
      remoteUrl: string,
      request: Pick<AidePullRequestViewRequest, 'pullRequest'>,
      options: PullRequestProviderOperationOptions = {}
    ) =>
      getPullRequestContextForRemote(
        pullRequestProviders,
        remoteUrl,
        request,
        options
      ),
    getPullRequestContextForRepository: (
      repository: AidePullRequestRepositoryRef,
      request: Pick<AidePullRequestViewRequest, 'pullRequest'>,
      options: PullRequestProviderOperationOptions = {}
    ) =>
      getPullRequestContextForRepository(
        pullRequestProviders,
        repository,
        request,
        options
      ),
    getPullRequestContextForUrl: (
      url: string,
      options: PullRequestProviderOperationOptions = {}
    ) => getPullRequestContextForUrl(pullRequestProviders, url, options),
    getPullRequestDiffForRemote: (
      remoteUrl: string,
      request: Pick<AidePullRequestDiffRequest, 'pullRequest'>,
      options: PullRequestProviderOperationOptions = {}
    ) =>
      getPullRequestDiffForRemote(
        pullRequestProviders,
        remoteUrl,
        request,
        options
      ),
    getPullRequestDiffForRepository: (
      repository: AidePullRequestRepositoryRef,
      request: Pick<AidePullRequestDiffRequest, 'pullRequest'>,
      options: PullRequestProviderOperationOptions = {}
    ) =>
      getPullRequestDiffForRepository(
        pullRequestProviders,
        repository,
        request,
        options
      ),
    getPullRequestDiffForUrl: (
      url: string,
      options: PullRequestProviderOperationOptions = {}
    ) => getPullRequestDiffForUrl(pullRequestProviders, url, options),
    listPullRequestCommentsForRemote: (
      remoteUrl: string,
      request: Pick<AidePullRequestCommentsRequest, 'pullRequest'>,
      options: PullRequestProviderOperationOptions = {}
    ) =>
      listPullRequestCommentsForRemote(
        pullRequestProviders,
        remoteUrl,
        request,
        options
      ),
    listPullRequestCommentsForRepository: (
      repository: AidePullRequestRepositoryRef,
      request: Pick<AidePullRequestCommentsRequest, 'pullRequest'>,
      options: PullRequestProviderOperationOptions = {}
    ) =>
      listPullRequestCommentsForRepository(
        pullRequestProviders,
        repository,
        request,
        options
      ),
    listPullRequestCommentsForUrl: (
      url: string,
      options: PullRequestProviderOperationOptions = {}
    ) => listPullRequestCommentsForUrl(pullRequestProviders, url, options),
    addPullRequestCommentForRemote: (
      remoteUrl: string,
      request: Omit<AidePullRequestAddCommentRequest, 'match'>,
      options: PullRequestProviderOperationOptions = {}
    ) =>
      addPullRequestCommentForRemote(
        pullRequestProviders,
        remoteUrl,
        request,
        options
      ),
    addPullRequestCommentForRepository: (
      repository: AidePullRequestRepositoryRef,
      request: Omit<AidePullRequestAddCommentRequest, 'match'>,
      options: PullRequestProviderOperationOptions = {}
    ) =>
      addPullRequestCommentForRepository(
        pullRequestProviders,
        repository,
        request,
        options
      ),
    addPullRequestCommentForUrl: (
      url: string,
      request: Omit<AidePullRequestAddCommentRequest, 'match' | 'pullRequest'>,
      options: PullRequestProviderOperationOptions = {}
    ) =>
      addPullRequestCommentForUrl(pullRequestProviders, url, request, options),
    replyToPullRequestCommentForRemote: (
      remoteUrl: string,
      request: Omit<AidePullRequestReplyCommentRequest, 'match'>,
      options: PullRequestProviderOperationOptions = {}
    ) =>
      replyToPullRequestCommentForRemote(
        pullRequestProviders,
        remoteUrl,
        request,
        options
      ),
    replyToPullRequestCommentForRepository: (
      repository: AidePullRequestRepositoryRef,
      request: Omit<AidePullRequestReplyCommentRequest, 'match'>,
      options: PullRequestProviderOperationOptions = {}
    ) =>
      replyToPullRequestCommentForRepository(
        pullRequestProviders,
        repository,
        request,
        options
      ),
    replyToPullRequestCommentForUrl: (
      url: string,
      request: Omit<
        AidePullRequestReplyCommentRequest,
        'match' | 'pullRequest'
      >,
      options: PullRequestProviderOperationOptions = {}
    ) =>
      replyToPullRequestCommentForUrl(
        pullRequestProviders,
        url,
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
    findPullRequestForBranchContextForRemote: (
      remoteUrl: string,
      request: Pick<AidePullRequestBranchLookupRequest, 'branch'>,
      options: PullRequestProviderOperationOptions = {}
    ) =>
      findPullRequestForBranchContextForRemote(
        pullRequestProviders,
        remoteUrl,
        request,
        options
      ),
    findPullRequestForBranchContextForRepository: (
      repository: AidePullRequestRepositoryRef,
      request: Pick<AidePullRequestBranchLookupRequest, 'branch'>,
      options: PullRequestProviderOperationOptions = {}
    ) =>
      findPullRequestForBranchContextForRepository(
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
