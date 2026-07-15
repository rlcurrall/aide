import { Context, Effect, Layer } from 'effect';

import type {
  CommandRegistry,
  KeyringCommandRegistry,
  PluginCapability,
  TrustedAuthDiscoveryServices,
} from './command-registry.js';
import type {
  AideAuthProviderCapability,
  AideAuthLoginMetadata,
  AideAuthLogoutMetadata,
  AideDiscoveredCapability,
  AidePrimeContributionCapability,
  AidePrimeSection,
  AidePrimeStatusMessages,
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
  AidePullRequestRepositoryInput,
  AidePullRequestRepositoryMatch,
  AidePullRequestRepositoryRef,
  AidePullRequestReplyCommentRequest,
  AidePullRequestUrlMatch,
  AidePullRequestUpdateRequest,
  AidePullRequestUpdateResult,
  AidePullRequestViewRequest,
  AidePullRequestViewResult,
} from './plugin-descriptor.js';
import type { KeyringService } from '@lib/auth-keyring.js';
import type { GitHubAuthCatalogService } from '@lib/github-auth-catalog.js';
import { isolatePublicCapabilityEffect } from './public-capability-invocation.js';
import {
  invokePrimeSectionsCallback,
  type PrimeContributionError,
} from './prime-contribution.js';
import {
  defineHostArrayIndex,
  ownArrayDataValue,
  ownArrayLength,
} from './host-owned-array.js';
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
  resolvePullRequestProviderForRepositoryInput,
  resolvePullRequestProviderForUrl,
  type PullRequestProviderResolutionError,
  type PullRequestProviderOperationOptions,
  type PullRequestProviderResolutionOptions,
  type ResolvedPullRequestProvider,
} from './pull-request-provider-resolver.js';

const aideHostContexts = new WeakMap<object, AideHostContext>();

export interface AideHostServices {
  readonly authProviders: () => readonly AideDiscoveredCapability<AidePublicAuthProviderSnapshot>[];
  readonly primeContributions: () => readonly AideDiscoveredCapability<AidePublicPrimeContributionSnapshot>[];
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
  readonly resolvePullRequestProviderForRepositoryInput: (
    input: AidePullRequestRepositoryInput,
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
    PullRequestProviderOperationInvocationError<'listPullRequests'>
  >;
  readonly listPullRequestsForRepository: (
    repository: AidePullRequestRepositoryRef,
    request?: Omit<AidePullRequestListRequest, 'match'>,
    options?: PullRequestProviderOperationOptions
  ) => Effect.Effect<
    AidePullRequestListResult,
    PullRequestProviderOperationInvocationError<'listPullRequests'>
  >;
  readonly getPullRequestForRemote: (
    remoteUrl: string,
    request: Pick<AidePullRequestViewRequest, 'pullRequest'>,
    options?: PullRequestProviderOperationOptions
  ) => Effect.Effect<
    AidePullRequestViewResult,
    PullRequestProviderOperationInvocationError<'getPullRequest'>
  >;
  readonly getPullRequestForRepository: (
    repository: AidePullRequestRepositoryRef,
    request: Pick<AidePullRequestViewRequest, 'pullRequest'>,
    options?: PullRequestProviderOperationOptions
  ) => Effect.Effect<
    AidePullRequestViewResult,
    PullRequestProviderOperationInvocationError<'getPullRequest'>
  >;
  readonly createPullRequestForRemote: (
    remoteUrl: string,
    request: Omit<AidePullRequestCreateRequest, 'match'>,
    options?: PullRequestProviderOperationOptions
  ) => Effect.Effect<
    AidePullRequestCreateResult,
    PullRequestProviderOperationInvocationError<'createPullRequest'>
  >;
  readonly createPullRequestForRepository: (
    repository: AidePullRequestRepositoryRef,
    request: Omit<AidePullRequestCreateRequest, 'match'>,
    options?: PullRequestProviderOperationOptions
  ) => Effect.Effect<
    AidePullRequestCreateResult,
    PullRequestProviderOperationInvocationError<'createPullRequest'>
  >;
  readonly updatePullRequestForRemote: (
    remoteUrl: string,
    request: Omit<AidePullRequestUpdateRequest, 'match'>,
    options?: PullRequestProviderOperationOptions
  ) => Effect.Effect<
    AidePullRequestUpdateResult,
    PullRequestProviderOperationInvocationError<'updatePullRequest'>
  >;
  readonly updatePullRequestForRepository: (
    repository: AidePullRequestRepositoryRef,
    request: Omit<AidePullRequestUpdateRequest, 'match'>,
    options?: PullRequestProviderOperationOptions
  ) => Effect.Effect<
    AidePullRequestUpdateResult,
    PullRequestProviderOperationInvocationError<'updatePullRequest'>
  >;
  readonly updatePullRequestForUrl: (
    url: string,
    request: Omit<AidePullRequestUpdateRequest, 'match' | 'pullRequest'>,
    options?: PullRequestProviderOperationOptions
  ) => Effect.Effect<
    AidePullRequestUpdateResult,
    PullRequestProviderOperationInvocationError<'updatePullRequest'>
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
    PullRequestProviderOperationInvocationError<'getPullRequest'>
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
    PullRequestProviderOperationInvocationError<'getPullRequest'>
  >;
  readonly getPullRequestContextForUrl: (
    url: string,
    options?: PullRequestProviderOperationOptions
  ) => Effect.Effect<
    PullRequestProviderOperationContext<
      AidePullRequestUrlMatch,
      AidePullRequestViewResult
    >,
    PullRequestProviderOperationInvocationError<'getPullRequest'>
  >;
  readonly getPullRequestDiffForRemote: (
    remoteUrl: string,
    request: Pick<AidePullRequestDiffRequest, 'pullRequest'>,
    options?: PullRequestProviderOperationOptions
  ) => Effect.Effect<
    AidePullRequestDiffResult,
    PullRequestProviderOperationInvocationError<'getPullRequestDiff'>
  >;
  readonly getPullRequestDiffForRepository: (
    repository: AidePullRequestRepositoryRef,
    request: Pick<AidePullRequestDiffRequest, 'pullRequest'>,
    options?: PullRequestProviderOperationOptions
  ) => Effect.Effect<
    AidePullRequestDiffResult,
    PullRequestProviderOperationInvocationError<'getPullRequestDiff'>
  >;
  readonly getPullRequestDiffForUrl: (
    url: string,
    options?: PullRequestProviderOperationOptions
  ) => Effect.Effect<
    AidePullRequestDiffResult,
    PullRequestProviderOperationInvocationError<'getPullRequestDiff'>
  >;
  readonly listPullRequestCommentsForRemote: (
    remoteUrl: string,
    request: Pick<AidePullRequestCommentsRequest, 'pullRequest'>,
    options?: PullRequestProviderOperationOptions
  ) => Effect.Effect<
    AidePullRequestCommentsResult,
    PullRequestProviderOperationInvocationError<'listPullRequestComments'>
  >;
  readonly listPullRequestCommentsForRepository: (
    repository: AidePullRequestRepositoryRef,
    request: Pick<AidePullRequestCommentsRequest, 'pullRequest'>,
    options?: PullRequestProviderOperationOptions
  ) => Effect.Effect<
    AidePullRequestCommentsResult,
    PullRequestProviderOperationInvocationError<'listPullRequestComments'>
  >;
  readonly listPullRequestCommentsForUrl: (
    url: string,
    options?: PullRequestProviderOperationOptions
  ) => Effect.Effect<
    AidePullRequestCommentsResult,
    PullRequestProviderOperationInvocationError<'listPullRequestComments'>
  >;
  readonly addPullRequestCommentForRemote: (
    remoteUrl: string,
    request: Omit<AidePullRequestAddCommentRequest, 'match'>,
    options?: PullRequestProviderOperationOptions
  ) => Effect.Effect<
    AidePullRequestCommentMutationResult,
    PullRequestProviderOperationInvocationError<'addPullRequestComment'>
  >;
  readonly addPullRequestCommentForRepository: (
    repository: AidePullRequestRepositoryRef,
    request: Omit<AidePullRequestAddCommentRequest, 'match'>,
    options?: PullRequestProviderOperationOptions
  ) => Effect.Effect<
    AidePullRequestCommentMutationResult,
    PullRequestProviderOperationInvocationError<'addPullRequestComment'>
  >;
  readonly addPullRequestCommentForUrl: (
    url: string,
    request: Omit<AidePullRequestAddCommentRequest, 'match' | 'pullRequest'>,
    options?: PullRequestProviderOperationOptions
  ) => Effect.Effect<
    AidePullRequestCommentMutationResult,
    PullRequestProviderOperationInvocationError<'addPullRequestComment'>
  >;
  readonly replyToPullRequestCommentForRemote: (
    remoteUrl: string,
    request: Omit<AidePullRequestReplyCommentRequest, 'match'>,
    options?: PullRequestProviderOperationOptions
  ) => Effect.Effect<
    AidePullRequestCommentMutationResult,
    PullRequestProviderOperationInvocationError<'replyToPullRequestComment'>
  >;
  readonly replyToPullRequestCommentForRepository: (
    repository: AidePullRequestRepositoryRef,
    request: Omit<AidePullRequestReplyCommentRequest, 'match'>,
    options?: PullRequestProviderOperationOptions
  ) => Effect.Effect<
    AidePullRequestCommentMutationResult,
    PullRequestProviderOperationInvocationError<'replyToPullRequestComment'>
  >;
  readonly replyToPullRequestCommentForUrl: (
    url: string,
    request: Omit<AidePullRequestReplyCommentRequest, 'match' | 'pullRequest'>,
    options?: PullRequestProviderOperationOptions
  ) => Effect.Effect<
    AidePullRequestCommentMutationResult,
    PullRequestProviderOperationInvocationError<'replyToPullRequestComment'>
  >;
  readonly findPullRequestForBranchForRemote: (
    remoteUrl: string,
    request: Pick<AidePullRequestBranchLookupRequest, 'branch'>,
    options?: PullRequestProviderOperationOptions
  ) => Effect.Effect<
    AidePullRequestBranchLookupResult,
    PullRequestProviderOperationInvocationError<'findPullRequestForBranch'>
  >;
  readonly findPullRequestForBranchForRepository: (
    repository: AidePullRequestRepositoryRef,
    request: Pick<AidePullRequestBranchLookupRequest, 'branch'>,
    options?: PullRequestProviderOperationOptions
  ) => Effect.Effect<
    AidePullRequestBranchLookupResult,
    PullRequestProviderOperationInvocationError<'findPullRequestForBranch'>
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
    PullRequestProviderOperationInvocationError<'findPullRequestForBranch'>
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
    PullRequestProviderOperationInvocationError<'findPullRequestForBranch'>
  >;
  readonly getPullRequestForUrl: (
    url: string,
    options?: PullRequestProviderOperationOptions
  ) => Effect.Effect<
    AidePullRequestViewResult,
    PullRequestProviderOperationInvocationError<'getPullRequest'>
  >;
}

export interface AidePublicAuthProviderSnapshot {
  readonly providerId: string;
  readonly label: string;
  readonly login?: AideAuthLoginMetadata;
  readonly logout?: AideAuthLogoutMetadata;
}

export interface AidePublicPrimeStatusSnapshot {
  readonly groupId: string;
  readonly groupLabel: string;
  readonly label: string;
  readonly messages?: AidePrimeStatusMessages;
}

export interface AidePublicPrimeContributionSnapshot {
  readonly status?: readonly AidePublicPrimeStatusSnapshot[];
  readonly sections?: () => Effect.Effect<
    readonly AidePrimeSection[],
    PrimeContributionError,
    never
  >;
}

export type AideTrustedAuthProviderRegistration = Readonly<{
  provenance: 'trusted';
  pluginId: string;
  capability: AideAuthProviderCapability<
    TrustedAuthDiscoveryServices,
    TrustedAuthDiscoveryServices,
    KeyringService,
    KeyringService
  >;
}>;

export type AideExternalAuthProviderRegistration = Readonly<{
  provenance: 'external';
  pluginId: string;
  capability: AideAuthProviderCapability<never, never, never, never>;
}>;

export type AideAuthProviderRegistration =
  | AideTrustedAuthProviderRegistration
  | AideExternalAuthProviderRegistration;

export type AideTrustedPrimeContributionRegistration = Readonly<{
  provenance: 'trusted';
  pluginId: string;
  capability: AidePrimeContributionCapability<KeyringService>;
}>;

export type AideExternalPrimeContributionRegistration = Readonly<{
  provenance: 'external';
  pluginId: string;
  capability: AidePrimeContributionCapability<never>;
}>;

export type AidePrimeContributionRegistration =
  | AideTrustedPrimeContributionRegistration
  | AideExternalPrimeContributionRegistration;

/** Trusted in-process services. Never export this contract from plugin-api. */
export interface AideInternalHostServices extends AideHostServices {
  readonly publicServices: AideHostServices;
  readonly authProviderRegistrations: () => readonly AideAuthProviderRegistration[];
  readonly primeContributionRegistrations: () => readonly AidePrimeContributionRegistration[];
  readonly trustedAuthProviders: () => readonly AideDiscoveredCapability<
    AideAuthProviderCapability<
      TrustedAuthDiscoveryServices,
      TrustedAuthDiscoveryServices,
      KeyringService,
      KeyringService
    >
  >[];
  readonly trustedPrimeContributions: () => readonly AideDiscoveredCapability<
    AidePrimeContributionCapability<KeyringService>
  >[];
  readonly provideTrustedKeyring: <A, E>(
    effect: Effect.Effect<A, E, KeyringService>
  ) => Effect.Effect<A, E, never>;
  readonly provideTrustedAuthDiscovery: <A, E>(
    effect: Effect.Effect<A, E, TrustedAuthDiscoveryServices>
  ) => Effect.Effect<A, E, never>;
  readonly isolatePublicEffect: <A, E>(
    effect: Effect.Effect<A, E, never>
  ) => Effect.Effect<A, E, never>;
}

export class AideHostServicesTag extends Context.Tag('AideHostServices')<
  AideHostServicesTag,
  AideHostServices
>() {}

export class AideInternalHostServicesTag extends Context.Tag(
  'AideInternalHostServices'
)<AideInternalHostServicesTag, AideInternalHostServices>() {}

export interface AideHostContext {
  readonly services: AideInternalHostServices;
  readonly keyringLayer: Layer.Layer<KeyringService>;
}

function discoveredCapabilities<TCapability>(
  capabilities: readonly PluginCapability<TCapability>[]
): readonly AideDiscoveredCapability<TCapability>[] {
  const discovered: AideDiscoveredCapability<TCapability>[] = [];
  const count = ownArrayLength(capabilities) ?? 0;
  for (let index = 0; index < count; index += 1) {
    const entry = ownArrayDataValue<PluginCapability<TCapability>>(
      capabilities,
      index
    );
    if (!entry.found) continue;
    defineHostArrayIndex(
      discovered,
      index,
      Object.freeze({
        pluginId: entry.value.pluginId,
        capability: entry.value.capability,
      })
    );
  }
  return Object.freeze(discovered);
}

export { isolatePublicCapabilityEffect } from './public-capability-invocation.js';

function invokePublicPrimeSections(
  pluginId: string,
  callback: () => Effect.Effect<readonly AidePrimeSection[], unknown, never>
): Effect.Effect<readonly AidePrimeSection[], PrimeContributionError, never> {
  return invokePrimeSectionsCallback(pluginId, callback);
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
        keyringLayer: context.keyringLayer,
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

export function createAideHostServices<
  RAuth,
  RAuthStatus,
  RAuthAccounts,
  RAuthLogin,
  RAuthLogout,
  RPrimeStatus,
  RPullRequestAuthStatus,
>(
  registry: CommandRegistry<
    RAuth,
    RAuthStatus,
    RAuthAccounts,
    RAuthLogin,
    RAuthLogout,
    RPrimeStatus,
    RPullRequestAuthStatus
  >
): AideHostServices {
  const discoveredAuthProviders = discoveredCapabilities(
    registry.capabilities.authProviders()
  );
  const discoveredPrimeContributions = discoveredCapabilities(
    registry.capabilities.primeContributions()
  );
  const authProviders: AideDiscoveredCapability<AidePublicAuthProviderSnapshot>[] =
    [];
  const authProviderCount = ownArrayLength(discoveredAuthProviders) ?? 0;
  for (let index = 0; index < authProviderCount; index += 1) {
    const entry = ownArrayDataValue<
      AideDiscoveredCapability<
        AideAuthProviderCapability<
          RAuthStatus,
          RAuthAccounts,
          RAuthLogin,
          RAuthLogout
        >
      >
    >(discoveredAuthProviders, index);
    if (!entry.found) continue;
    defineHostArrayIndex(
      authProviders,
      index,
      Object.freeze({
        pluginId: entry.value.pluginId,
        capability: Object.freeze({
          providerId: entry.value.capability.providerId,
          label: entry.value.capability.label,
          login: entry.value.capability.login,
          logout: entry.value.capability.logout,
        }),
      })
    );
  }
  Object.freeze(authProviders);

  const primeContributions: AideDiscoveredCapability<AidePublicPrimeContributionSnapshot>[] =
    [];
  const primeContributionCount =
    ownArrayLength(discoveredPrimeContributions) ?? 0;
  for (let index = 0; index < primeContributionCount; index += 1) {
    const entry = ownArrayDataValue<
      AideDiscoveredCapability<AidePrimeContributionCapability<RPrimeStatus>>
    >(discoveredPrimeContributions, index);
    if (!entry.found) continue;
    let statusSnapshots: AidePublicPrimeStatusSnapshot[] | undefined;
    const statuses = entry.value.capability.status;
    if (statuses !== undefined) {
      statusSnapshots = [];
      const statusCount = ownArrayLength(statuses) ?? 0;
      for (let statusIndex = 0; statusIndex < statusCount; statusIndex += 1) {
        const status = ownArrayDataValue<(typeof statuses)[number]>(
          statuses,
          statusIndex
        );
        if (!status.found) continue;
        defineHostArrayIndex(
          statusSnapshots,
          statusIndex,
          Object.freeze({
            groupId: status.value.groupId,
            groupLabel: status.value.groupLabel,
            label: status.value.label,
            messages: status.value.messages,
          })
        );
      }
      Object.freeze(statusSnapshots);
    }
    defineHostArrayIndex(
      primeContributions,
      index,
      Object.freeze({
        pluginId: entry.value.pluginId,
        capability: Object.freeze({
          status: statusSnapshots,
          sections:
            entry.value.capability.sections === undefined
              ? undefined
              : () =>
                  invokePublicPrimeSections(
                    entry.value.pluginId,
                    entry.value.capability.sections!
                  ),
        }),
      })
    );
  }
  Object.freeze(primeContributions);
  const pullRequestProviders = registry.capabilities.pullRequestProviders();
  const publicServices: AideHostServices = Object.freeze({
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
    resolvePullRequestProviderForRepositoryInput: (
      input: AidePullRequestRepositoryInput,
      options: PullRequestProviderResolutionOptions<AidePullRequestRepositoryMatch> = {}
    ) =>
      resolvePullRequestProviderForRepositoryInput(
        pullRequestProviders,
        input,
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
  return publicServices;
}

export function createAideInternalHostServices(
  registry: KeyringCommandRegistry,
  keyringLayer: Layer.Layer<KeyringService>,
  githubAuthCatalogLayer: Layer.Layer<GitHubAuthCatalogService>
): AideInternalHostServices {
  const trustedAuthDiscoveryLayer = Layer.merge(
    keyringLayer,
    githubAuthCatalogLayer
  );
  const publicServices = createAideHostServices(registry);
  const trustedAuthProviders = discoveredCapabilities(
    registry.capabilities.trustedAuthProviders()
  );
  const trustedPrimeContributions = discoveredCapabilities(
    registry.capabilities.trustedPrimeContributions()
  );
  const authProviderEntries = registry.capabilities.authProviders();
  const authProviderRegistrations: AideAuthProviderRegistration[] = [];
  const authProviderCount = ownArrayLength(authProviderEntries) ?? 0;
  for (let index = 0; index < authProviderCount; index += 1) {
    const entry = ownArrayDataValue<(typeof authProviderEntries)[number]>(
      authProviderEntries,
      index
    );
    if (!entry.found) continue;
    defineHostArrayIndex(
      authProviderRegistrations,
      index,
      entry.value.provenance === 'trusted'
        ? Object.freeze({
            provenance: 'trusted' as const,
            pluginId: entry.value.pluginId,
            capability: entry.value.capability,
          })
        : Object.freeze({
            provenance: 'external' as const,
            pluginId: entry.value.pluginId,
            capability: entry.value.capability,
          })
    );
  }
  Object.freeze(authProviderRegistrations);

  const primeContributionEntries = registry.capabilities.primeContributions();
  const primeContributionRegistrations: AidePrimeContributionRegistration[] =
    [];
  const primeContributionCount = ownArrayLength(primeContributionEntries) ?? 0;
  for (let index = 0; index < primeContributionCount; index += 1) {
    const entry = ownArrayDataValue<(typeof primeContributionEntries)[number]>(
      primeContributionEntries,
      index
    );
    if (!entry.found) continue;
    defineHostArrayIndex(
      primeContributionRegistrations,
      index,
      entry.value.provenance === 'trusted'
        ? Object.freeze({
            provenance: 'trusted' as const,
            pluginId: entry.value.pluginId,
            capability: entry.value.capability,
          })
        : Object.freeze({
            provenance: 'external' as const,
            pluginId: entry.value.pluginId,
            capability: entry.value.capability,
          })
    );
  }
  Object.freeze(primeContributionRegistrations);

  return Object.freeze({
    ...publicServices,
    publicServices,
    authProviderRegistrations: () => authProviderRegistrations,
    primeContributionRegistrations: () => primeContributionRegistrations,
    trustedAuthProviders: () => trustedAuthProviders,
    trustedPrimeContributions: () => trustedPrimeContributions,
    provideTrustedKeyring: <A, E>(
      effect: Effect.Effect<A, E, KeyringService>
    ) =>
      isolatePublicCapabilityEffect(effect.pipe(Effect.provide(keyringLayer))),
    provideTrustedAuthDiscovery: <A, E>(
      effect: Effect.Effect<A, E, TrustedAuthDiscoveryServices>
    ) =>
      isolatePublicCapabilityEffect(
        effect.pipe(Effect.provide(trustedAuthDiscoveryLayer))
      ),
    isolatePublicEffect: isolatePublicCapabilityEffect,
  });
}
