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
  rejectPublicPullRequestAuthSelectionInput,
  type AideInternalPullRequestInvocationOptions,
  type PullRequestAuthScopeSelectionError,
  type PullRequestProviderAuthScopeSelector,
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
const objectCreate = Object.create;
const objectFreeze = Object.freeze;
const objectGetOwnPropertyDescriptors = Object.getOwnPropertyDescriptors;
const objectHasOwn = Object.hasOwn;
const reflectGetOwnPropertyDescriptor = Reflect.getOwnPropertyDescriptor;

function frozenHostRecord<T extends object>(properties: T): T {
  return objectFreeze(
    objectCreate(null, objectGetOwnPropertyDescriptors(properties)) as T
  );
}

function ownDataPropertyValue<T>(
  value: object,
  key: PropertyKey
): T | undefined {
  try {
    const descriptor = reflectGetOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && objectHasOwn(descriptor, 'value')
      ? (descriptor.value as T)
      : undefined;
  } catch {
    return undefined;
  }
}

export interface AideHostServices {
  readonly authProviders: () => readonly AideDiscoveredCapability<AidePublicAuthProviderSnapshot>[];
  readonly primeContributions: () => readonly AideDiscoveredCapability<AidePublicPrimeContributionSnapshot>[];
  readonly resolvePullRequestProviderForRemote: (
    remoteUrl: string,
    options?: PullRequestProviderResolutionOptions<AidePullRequestRemoteMatch>
  ) => Effect.Effect<
    ResolvedPullRequestProvider<AidePullRequestRemoteMatch>,
    PullRequestProviderResolutionError | PullRequestAuthScopeSelectionError
  >;
  readonly resolvePullRequestProviderForUrl: (
    url: string,
    options?: PullRequestProviderResolutionOptions<AidePullRequestUrlMatch>
  ) => Effect.Effect<
    ResolvedPullRequestProvider<AidePullRequestUrlMatch>,
    PullRequestProviderResolutionError | PullRequestAuthScopeSelectionError
  >;
  readonly resolvePullRequestProviderForRepository: (
    repository: AidePullRequestRepositoryRef,
    options?: PullRequestProviderResolutionOptions<AidePullRequestRepositoryMatch>
  ) => Effect.Effect<
    ResolvedPullRequestProvider<AidePullRequestRepositoryMatch>,
    PullRequestProviderResolutionError | PullRequestAuthScopeSelectionError
  >;
  readonly resolvePullRequestProviderForRepositoryInput: (
    input: AidePullRequestRepositoryInput,
    options?: PullRequestProviderResolutionOptions<AidePullRequestRepositoryMatch>
  ) => Effect.Effect<
    ResolvedPullRequestProvider<AidePullRequestRepositoryMatch>,
    PullRequestProviderResolutionError | PullRequestAuthScopeSelectionError
  >;
  readonly listPullRequestsForRemote: (
    remoteUrl: string,
    request?: Omit<AidePullRequestListRequest, 'match' | 'authScope'>,
    options?: PullRequestProviderOperationOptions
  ) => Effect.Effect<
    AidePullRequestListResult,
    PullRequestProviderOperationInvocationError<'listPullRequests'>
  >;
  readonly listPullRequestsForRepository: (
    repository: AidePullRequestRepositoryRef,
    request?: Omit<AidePullRequestListRequest, 'match' | 'authScope'>,
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
    request: Omit<AidePullRequestCreateRequest, 'match' | 'authScope'>,
    options?: PullRequestProviderOperationOptions
  ) => Effect.Effect<
    AidePullRequestCreateResult,
    PullRequestProviderOperationInvocationError<'createPullRequest'>
  >;
  readonly createPullRequestForRepository: (
    repository: AidePullRequestRepositoryRef,
    request: Omit<AidePullRequestCreateRequest, 'match' | 'authScope'>,
    options?: PullRequestProviderOperationOptions
  ) => Effect.Effect<
    AidePullRequestCreateResult,
    PullRequestProviderOperationInvocationError<'createPullRequest'>
  >;
  readonly updatePullRequestForRemote: (
    remoteUrl: string,
    request: Omit<AidePullRequestUpdateRequest, 'match' | 'authScope'>,
    options?: PullRequestProviderOperationOptions
  ) => Effect.Effect<
    AidePullRequestUpdateResult,
    PullRequestProviderOperationInvocationError<'updatePullRequest'>
  >;
  readonly updatePullRequestForRepository: (
    repository: AidePullRequestRepositoryRef,
    request: Omit<AidePullRequestUpdateRequest, 'match' | 'authScope'>,
    options?: PullRequestProviderOperationOptions
  ) => Effect.Effect<
    AidePullRequestUpdateResult,
    PullRequestProviderOperationInvocationError<'updatePullRequest'>
  >;
  readonly updatePullRequestForUrl: (
    url: string,
    request: Omit<
      AidePullRequestUpdateRequest,
      'match' | 'pullRequest' | 'authScope'
    >,
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
    request: Omit<AidePullRequestAddCommentRequest, 'match' | 'authScope'>,
    options?: PullRequestProviderOperationOptions
  ) => Effect.Effect<
    AidePullRequestCommentMutationResult,
    PullRequestProviderOperationInvocationError<'addPullRequestComment'>
  >;
  readonly addPullRequestCommentForRepository: (
    repository: AidePullRequestRepositoryRef,
    request: Omit<AidePullRequestAddCommentRequest, 'match' | 'authScope'>,
    options?: PullRequestProviderOperationOptions
  ) => Effect.Effect<
    AidePullRequestCommentMutationResult,
    PullRequestProviderOperationInvocationError<'addPullRequestComment'>
  >;
  readonly addPullRequestCommentForUrl: (
    url: string,
    request: Omit<
      AidePullRequestAddCommentRequest,
      'match' | 'pullRequest' | 'authScope'
    >,
    options?: PullRequestProviderOperationOptions
  ) => Effect.Effect<
    AidePullRequestCommentMutationResult,
    PullRequestProviderOperationInvocationError<'addPullRequestComment'>
  >;
  readonly replyToPullRequestCommentForRemote: (
    remoteUrl: string,
    request: Omit<AidePullRequestReplyCommentRequest, 'match' | 'authScope'>,
    options?: PullRequestProviderOperationOptions
  ) => Effect.Effect<
    AidePullRequestCommentMutationResult,
    PullRequestProviderOperationInvocationError<'replyToPullRequestComment'>
  >;
  readonly replyToPullRequestCommentForRepository: (
    repository: AidePullRequestRepositoryRef,
    request: Omit<AidePullRequestReplyCommentRequest, 'match' | 'authScope'>,
    options?: PullRequestProviderOperationOptions
  ) => Effect.Effect<
    AidePullRequestCommentMutationResult,
    PullRequestProviderOperationInvocationError<'replyToPullRequestComment'>
  >;
  readonly replyToPullRequestCommentForUrl: (
    url: string,
    request: Omit<
      AidePullRequestReplyCommentRequest,
      'match' | 'pullRequest' | 'authScope'
    >,
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
  readonly withPullRequestAuthScopeSelector: (
    selector: PullRequestProviderAuthScopeSelector,
    options?: Pick<AideInternalPullRequestInvocationOptions, 'selectionTimeout'>
  ) => AideHostServices;
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

interface PullRequestInvocationSelection {
  readonly authScopeSelector?: PullRequestProviderAuthScopeSelector;
  readonly selectionTimeout?: AideInternalPullRequestInvocationOptions['selectionTimeout'];
}

function invokePublicPullRequestHostBoundary<A, E>(
  request: unknown,
  options: PullRequestProviderOperationOptions,
  selection: PullRequestInvocationSelection,
  invoke: (
    options: AideInternalPullRequestInvocationOptions
  ) => Effect.Effect<A, E, never>
): Effect.Effect<A, E | PullRequestAuthScopeSelectionError, never> {
  const rejection = rejectPublicPullRequestAuthSelectionInput(request, options);
  if (rejection !== undefined) return Effect.fail(rejection);
  const operationTimeout = ownDataPropertyValue<
    PullRequestProviderOperationOptions['operationTimeout']
  >(options, 'operationTimeout');
  const matcherTimeout = ownDataPropertyValue<
    PullRequestProviderOperationOptions['matcherTimeout']
  >(options, 'matcherTimeout');
  const authScopeSelector = ownDataPropertyValue<
    PullRequestInvocationSelection['authScopeSelector']
  >(selection, 'authScopeSelector');
  const selectionTimeout = ownDataPropertyValue<
    PullRequestInvocationSelection['selectionTimeout']
  >(selection, 'selectionTimeout');
  return Effect.suspend(() =>
    invoke(
      frozenHostRecord({
        ...(operationTimeout === undefined ? {} : { operationTimeout }),
        ...(matcherTimeout === undefined ? {} : { matcherTimeout }),
        ...(authScopeSelector === undefined ? {} : { authScopeSelector }),
        ...(selectionTimeout === undefined ? {} : { selectionTimeout }),
      })
    )
  );
}

function snapshotPublicPullRequestResolutionOptions<
  TMatch extends
    | AidePullRequestRemoteMatch
    | AidePullRequestRepositoryMatch
    | AidePullRequestUrlMatch,
>(options: unknown): PullRequestProviderResolutionOptions<TMatch> {
  if (
    (typeof options !== 'object' && typeof options !== 'function') ||
    options === null
  ) {
    return frozenHostRecord({});
  }
  const preferred = Reflect.getOwnPropertyDescriptor(options, 'preferred');
  const matcherTimeout = Reflect.getOwnPropertyDescriptor(
    options,
    'matcherTimeout'
  );
  return frozenHostRecord({
    ...(preferred !== undefined && Object.hasOwn(preferred, 'value')
      ? {
          preferred:
            preferred.value as PullRequestProviderResolutionOptions<TMatch>['preferred'],
        }
      : {}),
    ...(matcherTimeout !== undefined && Object.hasOwn(matcherTimeout, 'value')
      ? {
          matcherTimeout:
            matcherTimeout.value as PullRequestProviderResolutionOptions<TMatch>['matcherTimeout'],
        }
      : {}),
  });
}

function invokePublicPullRequestResolutionBoundary<
  TMatch extends
    | AidePullRequestRemoteMatch
    | AidePullRequestRepositoryMatch
    | AidePullRequestUrlMatch,
  A,
>(
  options: PullRequestProviderResolutionOptions<TMatch>,
  invoke: (
    options: PullRequestProviderResolutionOptions<TMatch>
  ) => Effect.Effect<A, PullRequestProviderResolutionError, never>
): Effect.Effect<
  A,
  PullRequestProviderResolutionError | PullRequestAuthScopeSelectionError,
  never
> {
  const rejection = rejectPublicPullRequestAuthSelectionInput(options);
  if (rejection !== undefined) return Effect.fail(rejection);
  return Effect.suspend(() =>
    invoke(snapshotPublicPullRequestResolutionOptions<TMatch>(options))
  );
}

function createPullRequestInvocationServices<
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
  >,
  selection: PullRequestInvocationSelection = frozenHostRecord({})
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
  const invokePullRequest = <A, E>(
    request: unknown,
    options: PullRequestProviderOperationOptions,
    invoke: (
      internalOptions: AideInternalPullRequestInvocationOptions
    ) => Effect.Effect<A, E, never>
  ) => invokePublicPullRequestHostBoundary(request, options, selection, invoke);
  const publicServices: AideHostServices = frozenHostRecord({
    authProviders: () => authProviders,
    primeContributions: () => primeContributions,
    resolvePullRequestProviderForRemote: (
      remoteUrl: string,
      options: PullRequestProviderResolutionOptions<AidePullRequestRemoteMatch> = {}
    ) =>
      invokePublicPullRequestResolutionBoundary(options, (safeOptions) =>
        resolvePullRequestProviderForRemote(
          pullRequestProviders,
          remoteUrl,
          safeOptions
        )
      ),
    resolvePullRequestProviderForUrl: (
      url: string,
      options: PullRequestProviderResolutionOptions<AidePullRequestUrlMatch> = {}
    ) =>
      invokePublicPullRequestResolutionBoundary(options, (safeOptions) =>
        resolvePullRequestProviderForUrl(pullRequestProviders, url, safeOptions)
      ),
    resolvePullRequestProviderForRepository: (
      repository: AidePullRequestRepositoryRef,
      options: PullRequestProviderResolutionOptions<AidePullRequestRepositoryMatch> = {}
    ) =>
      invokePublicPullRequestResolutionBoundary(options, (safeOptions) =>
        resolvePullRequestProviderForRepository(
          pullRequestProviders,
          repository,
          safeOptions
        )
      ),
    resolvePullRequestProviderForRepositoryInput: (
      input: AidePullRequestRepositoryInput,
      options: PullRequestProviderResolutionOptions<AidePullRequestRepositoryMatch> = {}
    ) =>
      invokePublicPullRequestResolutionBoundary(options, (safeOptions) =>
        resolvePullRequestProviderForRepositoryInput(
          pullRequestProviders,
          input,
          safeOptions
        )
      ),
    listPullRequestsForRemote: (
      remoteUrl: string,
      request: Omit<AidePullRequestListRequest, 'match' | 'authScope'> = {},
      options: PullRequestProviderOperationOptions = {}
    ) =>
      invokePullRequest(request, options, (internalOptions) =>
        listPullRequestsForRemote(
          pullRequestProviders,
          remoteUrl,
          request,
          internalOptions
        )
      ),
    listPullRequestsForRepository: (
      repository: AidePullRequestRepositoryRef,
      request: Omit<AidePullRequestListRequest, 'match' | 'authScope'> = {},
      options: PullRequestProviderOperationOptions = {}
    ) =>
      invokePullRequest(request, options, (internalOptions) =>
        listPullRequestsForRepository(
          pullRequestProviders,
          repository,
          request,
          internalOptions
        )
      ),
    getPullRequestForRemote: (
      remoteUrl: string,
      request: Pick<AidePullRequestViewRequest, 'pullRequest'>,
      options: PullRequestProviderOperationOptions = {}
    ) =>
      invokePullRequest(request, options, (internalOptions) =>
        getPullRequestForRemote(
          pullRequestProviders,
          remoteUrl,
          request,
          internalOptions
        )
      ),
    getPullRequestForRepository: (
      repository: AidePullRequestRepositoryRef,
      request: Pick<AidePullRequestViewRequest, 'pullRequest'>,
      options: PullRequestProviderOperationOptions = {}
    ) =>
      invokePullRequest(request, options, (internalOptions) =>
        getPullRequestForRepository(
          pullRequestProviders,
          repository,
          request,
          internalOptions
        )
      ),
    createPullRequestForRemote: (
      remoteUrl: string,
      request: Omit<AidePullRequestCreateRequest, 'match' | 'authScope'>,
      options: PullRequestProviderOperationOptions = {}
    ) =>
      invokePullRequest(request, options, (internalOptions) =>
        createPullRequestForRemote(
          pullRequestProviders,
          remoteUrl,
          request,
          internalOptions
        )
      ),
    createPullRequestForRepository: (
      repository: AidePullRequestRepositoryRef,
      request: Omit<AidePullRequestCreateRequest, 'match' | 'authScope'>,
      options: PullRequestProviderOperationOptions = {}
    ) =>
      invokePullRequest(request, options, (internalOptions) =>
        createPullRequestForRepository(
          pullRequestProviders,
          repository,
          request,
          internalOptions
        )
      ),
    updatePullRequestForRemote: (
      remoteUrl: string,
      request: Omit<AidePullRequestUpdateRequest, 'match' | 'authScope'>,
      options: PullRequestProviderOperationOptions = {}
    ) =>
      invokePullRequest(request, options, (internalOptions) =>
        updatePullRequestForRemote(
          pullRequestProviders,
          remoteUrl,
          request,
          internalOptions
        )
      ),
    updatePullRequestForRepository: (
      repository: AidePullRequestRepositoryRef,
      request: Omit<AidePullRequestUpdateRequest, 'match' | 'authScope'>,
      options: PullRequestProviderOperationOptions = {}
    ) =>
      invokePullRequest(request, options, (internalOptions) =>
        updatePullRequestForRepository(
          pullRequestProviders,
          repository,
          request,
          internalOptions
        )
      ),
    updatePullRequestForUrl: (
      url: string,
      request: Omit<
        AidePullRequestUpdateRequest,
        'match' | 'pullRequest' | 'authScope'
      >,
      options: PullRequestProviderOperationOptions = {}
    ) =>
      invokePullRequest(request, options, (internalOptions) =>
        updatePullRequestForUrl(
          pullRequestProviders,
          url,
          request,
          internalOptions
        )
      ),
    getPullRequestContextForRemote: (
      remoteUrl: string,
      request: Pick<AidePullRequestViewRequest, 'pullRequest'>,
      options: PullRequestProviderOperationOptions = {}
    ) =>
      invokePullRequest(request, options, (internalOptions) =>
        getPullRequestContextForRemote(
          pullRequestProviders,
          remoteUrl,
          request,
          internalOptions
        )
      ),
    getPullRequestContextForRepository: (
      repository: AidePullRequestRepositoryRef,
      request: Pick<AidePullRequestViewRequest, 'pullRequest'>,
      options: PullRequestProviderOperationOptions = {}
    ) =>
      invokePullRequest(request, options, (internalOptions) =>
        getPullRequestContextForRepository(
          pullRequestProviders,
          repository,
          request,
          internalOptions
        )
      ),
    getPullRequestContextForUrl: (
      url: string,
      options: PullRequestProviderOperationOptions = {}
    ) =>
      invokePullRequest(undefined, options, (internalOptions) =>
        getPullRequestContextForUrl(pullRequestProviders, url, internalOptions)
      ),
    getPullRequestDiffForRemote: (
      remoteUrl: string,
      request: Pick<AidePullRequestDiffRequest, 'pullRequest'>,
      options: PullRequestProviderOperationOptions = {}
    ) =>
      invokePullRequest(request, options, (internalOptions) =>
        getPullRequestDiffForRemote(
          pullRequestProviders,
          remoteUrl,
          request,
          internalOptions
        )
      ),
    getPullRequestDiffForRepository: (
      repository: AidePullRequestRepositoryRef,
      request: Pick<AidePullRequestDiffRequest, 'pullRequest'>,
      options: PullRequestProviderOperationOptions = {}
    ) =>
      invokePullRequest(request, options, (internalOptions) =>
        getPullRequestDiffForRepository(
          pullRequestProviders,
          repository,
          request,
          internalOptions
        )
      ),
    getPullRequestDiffForUrl: (
      url: string,
      options: PullRequestProviderOperationOptions = {}
    ) =>
      invokePullRequest(undefined, options, (internalOptions) =>
        getPullRequestDiffForUrl(pullRequestProviders, url, internalOptions)
      ),
    listPullRequestCommentsForRemote: (
      remoteUrl: string,
      request: Pick<AidePullRequestCommentsRequest, 'pullRequest'>,
      options: PullRequestProviderOperationOptions = {}
    ) =>
      invokePullRequest(request, options, (internalOptions) =>
        listPullRequestCommentsForRemote(
          pullRequestProviders,
          remoteUrl,
          request,
          internalOptions
        )
      ),
    listPullRequestCommentsForRepository: (
      repository: AidePullRequestRepositoryRef,
      request: Pick<AidePullRequestCommentsRequest, 'pullRequest'>,
      options: PullRequestProviderOperationOptions = {}
    ) =>
      invokePullRequest(request, options, (internalOptions) =>
        listPullRequestCommentsForRepository(
          pullRequestProviders,
          repository,
          request,
          internalOptions
        )
      ),
    listPullRequestCommentsForUrl: (
      url: string,
      options: PullRequestProviderOperationOptions = {}
    ) =>
      invokePullRequest(undefined, options, (internalOptions) =>
        listPullRequestCommentsForUrl(
          pullRequestProviders,
          url,
          internalOptions
        )
      ),
    addPullRequestCommentForRemote: (
      remoteUrl: string,
      request: Omit<AidePullRequestAddCommentRequest, 'match' | 'authScope'>,
      options: PullRequestProviderOperationOptions = {}
    ) =>
      invokePullRequest(request, options, (internalOptions) =>
        addPullRequestCommentForRemote(
          pullRequestProviders,
          remoteUrl,
          request,
          internalOptions
        )
      ),
    addPullRequestCommentForRepository: (
      repository: AidePullRequestRepositoryRef,
      request: Omit<AidePullRequestAddCommentRequest, 'match' | 'authScope'>,
      options: PullRequestProviderOperationOptions = {}
    ) =>
      invokePullRequest(request, options, (internalOptions) =>
        addPullRequestCommentForRepository(
          pullRequestProviders,
          repository,
          request,
          internalOptions
        )
      ),
    addPullRequestCommentForUrl: (
      url: string,
      request: Omit<
        AidePullRequestAddCommentRequest,
        'match' | 'pullRequest' | 'authScope'
      >,
      options: PullRequestProviderOperationOptions = {}
    ) =>
      invokePullRequest(request, options, (internalOptions) =>
        addPullRequestCommentForUrl(
          pullRequestProviders,
          url,
          request,
          internalOptions
        )
      ),
    replyToPullRequestCommentForRemote: (
      remoteUrl: string,
      request: Omit<AidePullRequestReplyCommentRequest, 'match' | 'authScope'>,
      options: PullRequestProviderOperationOptions = {}
    ) =>
      invokePullRequest(request, options, (internalOptions) =>
        replyToPullRequestCommentForRemote(
          pullRequestProviders,
          remoteUrl,
          request,
          internalOptions
        )
      ),
    replyToPullRequestCommentForRepository: (
      repository: AidePullRequestRepositoryRef,
      request: Omit<AidePullRequestReplyCommentRequest, 'match' | 'authScope'>,
      options: PullRequestProviderOperationOptions = {}
    ) =>
      invokePullRequest(request, options, (internalOptions) =>
        replyToPullRequestCommentForRepository(
          pullRequestProviders,
          repository,
          request,
          internalOptions
        )
      ),
    replyToPullRequestCommentForUrl: (
      url: string,
      request: Omit<
        AidePullRequestReplyCommentRequest,
        'match' | 'pullRequest' | 'authScope'
      >,
      options: PullRequestProviderOperationOptions = {}
    ) =>
      invokePullRequest(request, options, (internalOptions) =>
        replyToPullRequestCommentForUrl(
          pullRequestProviders,
          url,
          request,
          internalOptions
        )
      ),
    findPullRequestForBranchForRemote: (
      remoteUrl: string,
      request: Pick<AidePullRequestBranchLookupRequest, 'branch'>,
      options: PullRequestProviderOperationOptions = {}
    ) =>
      invokePullRequest(request, options, (internalOptions) =>
        findPullRequestForBranchForRemote(
          pullRequestProviders,
          remoteUrl,
          request,
          internalOptions
        )
      ),
    findPullRequestForBranchForRepository: (
      repository: AidePullRequestRepositoryRef,
      request: Pick<AidePullRequestBranchLookupRequest, 'branch'>,
      options: PullRequestProviderOperationOptions = {}
    ) =>
      invokePullRequest(request, options, (internalOptions) =>
        findPullRequestForBranchForRepository(
          pullRequestProviders,
          repository,
          request,
          internalOptions
        )
      ),
    findPullRequestForBranchContextForRemote: (
      remoteUrl: string,
      request: Pick<AidePullRequestBranchLookupRequest, 'branch'>,
      options: PullRequestProviderOperationOptions = {}
    ) =>
      invokePullRequest(request, options, (internalOptions) =>
        findPullRequestForBranchContextForRemote(
          pullRequestProviders,
          remoteUrl,
          request,
          internalOptions
        )
      ),
    findPullRequestForBranchContextForRepository: (
      repository: AidePullRequestRepositoryRef,
      request: Pick<AidePullRequestBranchLookupRequest, 'branch'>,
      options: PullRequestProviderOperationOptions = {}
    ) =>
      invokePullRequest(request, options, (internalOptions) =>
        findPullRequestForBranchContextForRepository(
          pullRequestProviders,
          repository,
          request,
          internalOptions
        )
      ),
    getPullRequestForUrl: (
      url: string,
      options: PullRequestProviderOperationOptions = {}
    ) =>
      invokePullRequest(undefined, options, (internalOptions) =>
        getPullRequestForUrl(pullRequestProviders, url, internalOptions)
      ),
  });
  return publicServices;
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
  return createPullRequestInvocationServices(registry);
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

  return frozenHostRecord({
    ...publicServices,
    publicServices,
    withPullRequestAuthScopeSelector: (
      selector: PullRequestProviderAuthScopeSelector,
      options: Pick<
        AideInternalPullRequestInvocationOptions,
        'selectionTimeout'
      > = {}
    ) => {
      const selectionTimeout = ownDataPropertyValue<
        AideInternalPullRequestInvocationOptions['selectionTimeout']
      >(options, 'selectionTimeout');
      return createPullRequestInvocationServices(
        registry,
        frozenHostRecord({
          authScopeSelector: selector,
          ...(selectionTimeout === undefined ? {} : { selectionTimeout }),
        })
      );
    },
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
