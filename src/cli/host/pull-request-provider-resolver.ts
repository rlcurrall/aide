import { isIP as nodeIsIP } from 'node:net';
import {
  domainToASCII as nodeDomainToASCII,
  domainToUnicode as nodeDomainToUnicode,
} from 'node:url';
import { types as nodeUtilTypes } from 'node:util';

import { Cause, Data, Effect, type Duration } from 'effect';

import {
  certifiedBuiltinPullRequestProviderDiagnostic,
  type CommandRegistry,
  type PluginCapability,
} from './command-registry.js';
import type {
  AideAuthScope,
  AideInternalPullRequestProviderCapability as AideInternalPullRequestProviderCapabilityShape,
  AidePullRequestAddCommentRequest,
  AidePullRequestBranchLookupRequest,
  AidePullRequestBranchLookupResult,
  AidePullRequestComment,
  AidePullRequestCommentAuthor,
  AidePullRequestCommentKind,
  AidePullRequestCommentMutationResult,
  AidePullRequestCommentPosition,
  AidePullRequestCommentThread,
  AidePullRequestCommentsRequest,
  AidePullRequestCommentsResult,
  AidePullRequestCreateRequest,
  AidePullRequestCreateResult,
  AidePullRequestDiffFile,
  AidePullRequestDiffFileStatus,
  AidePullRequestDiffRequest,
  AidePullRequestDiffResult,
  AidePullRequestListItem,
  AidePullRequestListItemStatus,
  AidePullRequestListRequest,
  AidePullRequestListResult,
  AidePullRequestProviderFeatures,
  AidePullRequestProviderMatch,
  AidePullRequestProviderMatchSource,
  AidePullRequestRef,
  AidePullRequestReplyCommentRequest,
  AidePullRequestRemoteMatch,
  AidePullRequestRepositoryInput,
  AidePullRequestRepositoryMatch,
  AidePullRequestRepositoryRef,
  AidePullRequestUrlMatch,
  AidePullRequestUpdateRequest,
  AidePullRequestUpdateResult,
  AidePullRequestViewItem,
  AidePullRequestViewRequest,
  AidePullRequestViewResult,
} from './plugin-descriptor.js';
import {
  isolatePublicCapabilityEffect,
  invokePublicCapabilityEffect,
} from './public-capability-invocation.js';
import {
  filterHostArray,
  flattenHostArrayGroups,
  mapHostArray,
  selectHighestPriorityHostArray,
} from './host-owned-array.js';
type AidePullRequestProviderCapability = Omit<
  AideInternalPullRequestProviderCapabilityShape<unknown>,
  'authStatus'
>;

const arrayIsArray = Array.isArray;
const objectCreate = Object.create;
const objectDefineProperty = Object.defineProperty;
const objectFreeze = Object.freeze;
const objectGetOwnPropertyDescriptors = Object.getOwnPropertyDescriptors;
const objectHasOwn = Object.hasOwn;
const reflectGetOwnPropertyDescriptor = Reflect.getOwnPropertyDescriptor;
const reflectGetPrototypeOf = Reflect.getPrototypeOf;
const reflectOwnKeys = Reflect.ownKeys;
const hostUrlConstructor = URL;

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

const REDACTED_PULL_REQUEST_PROVIDER_LOOKUP = '<redacted>';
const MAX_PULL_REQUEST_PROVIDER_LOOKUP_LENGTH = 4_096;
const MAX_DNS_HOST_LENGTH = 253;
const MAX_DNS_LABEL_LENGTH = 63;
const repositoryLookupKeys = new Set([
  'provider',
  'host',
  'owner',
  'org',
  'project',
  'repo',
]);

/**
 * Validate an unbracketed display host before URL parsing can reinterpret it.
 * A single trailing root dot is allowed. Numeric-looking hosts are IPv4 only
 * when already written as canonical four-part decimal notation.
 */
function canonicalDisplayHostname(hostname: string): string | undefined {
  const asciiHostname = nodeDomainToASCII(hostname);
  if (asciiHostname.length === 0) return undefined;

  const unicodeHostname = nodeDomainToUnicode(asciiHostname);
  if (
    unicodeHostname.length === 0 ||
    nodeDomainToASCII(unicodeHostname).toLowerCase() !==
      asciiHostname.toLowerCase()
  ) {
    return undefined;
  }

  const hasTrailingRootDot = asciiHostname.endsWith('.');
  const unrootedHostname = hasTrailingRootDot
    ? asciiHostname.slice(0, -1)
    : asciiHostname;
  if (
    unrootedHostname.length === 0 ||
    unrootedHostname.length > MAX_DNS_HOST_LENGTH
  ) {
    return undefined;
  }

  const labels = unrootedHostname.split('.');
  if (
    labels.some(
      (label) =>
        label.length === 0 ||
        label.length > MAX_DNS_LABEL_LENGTH ||
        !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u.test(label)
    )
  ) {
    return undefined;
  }

  const isNumericLooking = labels.every((label) =>
    /^(?:\d+|0x[0-9A-Fa-f]+)$/iu.test(label)
  );
  if (isNumericLooking) {
    if (
      hasTrailingRootDot ||
      !/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/u.test(
        unrootedHostname
      ) ||
      nodeIsIP(unrootedHostname) !== 4
    ) {
      return undefined;
    }
  }

  return asciiHostname.toLowerCase();
}

/**
 * Total host policy for values retained by provider-resolution failures.
 * Network lookups lose userinfo, query, and fragment data; repository
 * descriptors apply the same policy to nested network values. Inputs that
 * cannot be described with a bounded, unambiguous grammar fail closed.
 */
function describePullRequestProviderLookup(
  source: PullRequestProviderLookupSource,
  value: string
): string {
  try {
    if (
      value.length === 0 ||
      value.length > MAX_PULL_REQUEST_PROVIDER_LOOKUP_LENGTH ||
      // oxlint-disable-next-line no-control-regex -- lookup descriptors reject all ASCII control input
      /[\u0000-\u001f\u007f]/u.test(value)
    ) {
      return REDACTED_PULL_REQUEST_PROVIDER_LOOKUP;
    }

    const describeNetworkValue = (candidate: string): string | undefined => {
      if (
        candidate.includes('\\') ||
        /\s/u.test(candidate) ||
        /%(?![0-9A-Fa-f]{2})/u.test(candidate)
      ) {
        return undefined;
      }

      const rawUrl =
        /^(git|https?|ssh):\/\/([^/?#]+)(?:\/[^?#]*)?(?:\?[^#]*)?(?:#.*)?$/iu.exec(
          candidate
        );
      if (rawUrl !== null) {
        let urlCandidate = candidate;
        const authority = rawUrl[2];
        if (authority === undefined) return undefined;
        const userinfoSeparator = authority.indexOf('@');
        if (
          userinfoSeparator === 0 ||
          (userinfoSeparator >= 0 &&
            userinfoSeparator !== authority.lastIndexOf('@'))
        ) {
          return undefined;
        }
        const hostAndPort = authority.slice(userinfoSeparator + 1);
        let canonicalHostname: string | undefined;
        if (hostAndPort.startsWith('[')) {
          const bracket = hostAndPort.indexOf(']');
          const suffix = hostAndPort.slice(bracket + 1);
          if (
            bracket <= 1 ||
            hostAndPort.indexOf('[', 1) >= 0 ||
            hostAndPort.indexOf(']', bracket + 1) >= 0 ||
            (suffix.length > 0 && !/^:\d+$/u.test(suffix))
          ) {
            return undefined;
          }
          if (nodeIsIP(hostAndPort.slice(1, bracket)) !== 6) {
            return undefined;
          }
        } else {
          if (hostAndPort.includes('[') || hostAndPort.includes(']')) {
            return undefined;
          }
          const portSeparator = hostAndPort.lastIndexOf(':');
          if (
            portSeparator !== hostAndPort.indexOf(':') ||
            (portSeparator >= 0 &&
              !/^\d+$/u.test(hostAndPort.slice(portSeparator + 1)))
          ) {
            return undefined;
          }
          const hostname = hostAndPort.slice(
            0,
            portSeparator >= 0 ? portSeparator : undefined
          );
          if (hostname.length === 0 || hostname.includes('%')) return undefined;
          canonicalHostname = canonicalDisplayHostname(hostname);
          if (canonicalHostname === undefined) return undefined;
          if (hostname.toLowerCase() !== canonicalHostname) {
            const hostnameStart =
              candidate.indexOf('://') + 3 + userinfoSeparator + 1;
            urlCandidate = `${candidate.slice(
              0,
              hostnameStart
            )}${canonicalHostname}${candidate.slice(
              hostnameStart + hostname.length
            )}`;
          }
        }

        let parsed: URL;
        try {
          parsed = new hostUrlConstructor(urlCandidate);
        } catch {
          return undefined;
        }
        if (
          parsed.host.length === 0 ||
          !['git:', 'http:', 'https:', 'ssh:'].includes(parsed.protocol) ||
          (canonicalHostname !== undefined &&
            parsed.hostname.toLowerCase() !== canonicalHostname)
        ) {
          return undefined;
        }
        parsed.username = '';
        parsed.password = '';
        parsed.search = '';
        parsed.hash = '';
        return parsed.toString();
      }

      if (
        /^(?:git|https?|ssh):/iu.test(candidate) ||
        candidate.includes('://')
      ) {
        return undefined;
      }

      const scpLike =
        /^(?:[^@\s/:]+@)?(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+):([\p{L}\p{M}\p{N}._~/-]+)(?:\?[^#]*)?(?:#.*)?$/u.exec(
          candidate
        );
      if (scpLike === null) return undefined;
      const host = scpLike[1];
      const path = scpLike[2];
      if (host === undefined || path === undefined) return undefined;
      if (host.startsWith('[')) {
        if (nodeIsIP(host.slice(1, -1)) !== 6) return undefined;
      } else if (canonicalDisplayHostname(host) === undefined) {
        return undefined;
      }
      return `${host}:${path}`;
    };

    if (source === 'git-remote' || source === 'pull-request-url') {
      return (
        describeNetworkValue(value) ?? REDACTED_PULL_REQUEST_PROVIDER_LOOKUP
      );
    }

    if (
      value === 'invalid repository input' ||
      value === 'invalid repository ref'
    ) {
      return value;
    }

    const directNetworkValue = describeNetworkValue(value);
    if (directNetworkValue !== undefined) {
      return directNetworkValue;
    }

    const parts = value.split(' ');
    if (parts.length > 1 || parts[0]?.includes('=')) {
      const described: string[] = [];
      for (const part of parts) {
        const separator = part.indexOf('=');
        if (separator <= 0 || separator === part.length - 1) {
          return REDACTED_PULL_REQUEST_PROVIDER_LOOKUP;
        }
        const key = part.slice(0, separator);
        const rawComponent = part.slice(separator + 1);
        if (!repositoryLookupKeys.has(key)) {
          return REDACTED_PULL_REQUEST_PROVIDER_LOOKUP;
        }
        const component =
          rawComponent.includes('://') ||
          (rawComponent.includes(':') &&
            (rawComponent.includes('@') || key === 'repo'))
            ? describeNetworkValue(rawComponent)
            : /^[A-Za-z0-9._~/-]+$/u.test(rawComponent)
              ? rawComponent
              : undefined;
        if (component === undefined) {
          return REDACTED_PULL_REQUEST_PROVIDER_LOOKUP;
        }
        described.push(`${key}=${component}`);
      }
      return described.join(' ');
    }

    return /^[A-Za-z0-9][A-Za-z0-9 ._~/-]*$/u.test(value)
      ? value
      : REDACTED_PULL_REQUEST_PROVIDER_LOOKUP;
  } catch {
    return REDACTED_PULL_REQUEST_PROVIDER_LOOKUP;
  }
}

function hostArrayLength(value: object): number | undefined {
  const descriptor = reflectGetOwnPropertyDescriptor(value, 'length');
  return descriptor !== undefined &&
    objectHasOwn(descriptor, 'value') &&
    typeof descriptor.value === 'number' &&
    Number.isSafeInteger(descriptor.value) &&
    descriptor.value >= 0
    ? descriptor.value
    : undefined;
}

function hostArrayDataValue<T>(value: object, index: number): T | undefined {
  const descriptor = reflectGetOwnPropertyDescriptor(value, String(index));
  return descriptor !== undefined && objectHasOwn(descriptor, 'value')
    ? (descriptor.value as T)
    : undefined;
}

export type PullRequestProviderLookupSource =
  AidePullRequestProviderMatchSource;

export interface PullRequestProviderCandidate {
  readonly pluginId: string;
  readonly providerId: string;
  readonly priority: number;
}

function formatPullRequestProviderCandidates(
  candidates: readonly PullRequestProviderCandidate[]
): string {
  const length = hostArrayLength(candidates) ?? 0;
  let formatted = '';
  let found = false;
  for (let index = 0; index < length; index += 1) {
    const candidate = hostArrayDataValue<PullRequestProviderCandidate>(
      candidates,
      index
    );
    if (candidate === undefined) continue;
    const summary = `${candidate.pluginId}/${candidate.providerId}`;
    formatted = found ? `${formatted}, ${summary}` : summary;
    found = true;
  }
  return formatted;
}

export interface ResolvedPullRequestProvider<
  TMatch extends AidePullRequestProviderMatch = AidePullRequestProviderMatch,
> {
  readonly pluginId: string;
  readonly providerId: string;
  readonly features: AidePullRequestProviderFeatures;
  readonly match: TMatch;
  readonly priority: number;
}

interface ResolvedPullRequestProviderCandidate<
  TMatch extends AidePullRequestProviderMatch = AidePullRequestProviderMatch,
> extends ResolvedPullRequestProvider<TMatch> {
  readonly capability: AidePullRequestProviderCapability;
}

export interface PullRequestProviderResolutionOptions<
  TMatch extends AidePullRequestProviderMatch = AidePullRequestProviderMatch,
> {
  /**
   * Prefer a subset of matching providers when available. If no preferred
   * provider matches, resolution falls back to all matches.
   */
  readonly preferred?: (
    provider: ResolvedPullRequestProvider<TMatch>
  ) => boolean;
  readonly matcherTimeout?: Duration.DurationInput;
}

export interface PullRequestProviderOperationOptions {
  readonly operationTimeout?: Duration.DurationInput;
  readonly matcherTimeout?: Duration.DurationInput;
}

export type PullRequestProviderAuthScopeSelector = (
  provider: ResolvedPullRequestProvider
) => Effect.Effect<
  AideAuthScope | undefined,
  PullRequestAuthScopeSelectionError,
  never
>;

/** @internal Trusted host invocation settings. Never export from plugin-api. */
export interface AideInternalPullRequestInvocationOptions extends PullRequestProviderOperationOptions {
  readonly authScopeSelector?: PullRequestProviderAuthScopeSelector;
  readonly selectionTimeout?: Duration.DurationInput;
}

export interface PullRequestProviderOperationContext<
  TMatch extends AidePullRequestProviderMatch,
  TResult,
> {
  readonly provider: ResolvedPullRequestProvider<TMatch>;
  readonly result: TResult;
  readonly getPullRequestDiff: (
    request: Pick<AidePullRequestDiffRequest, 'pullRequest'>,
    options?: Pick<PullRequestProviderOperationOptions, 'operationTimeout'>
  ) => Effect.Effect<
    AidePullRequestDiffResult,
    | PullRequestProviderOperationExecutionError<'getPullRequestDiff'>
    | PullRequestAuthScopeSelectionError
  >;
  readonly updatePullRequest: (
    request: Omit<AidePullRequestUpdateRequest, 'match' | 'authScope'>,
    options?: Pick<PullRequestProviderOperationOptions, 'operationTimeout'>
  ) => Effect.Effect<
    AidePullRequestUpdateResult,
    | PullRequestProviderOperationExecutionError<'updatePullRequest'>
    | PullRequestAuthScopeSelectionError
  >;
  readonly listPullRequestComments: (
    request: Pick<AidePullRequestCommentsRequest, 'pullRequest'>,
    options?: Pick<PullRequestProviderOperationOptions, 'operationTimeout'>
  ) => Effect.Effect<
    AidePullRequestCommentsResult,
    | PullRequestProviderOperationExecutionError<'listPullRequestComments'>
    | PullRequestAuthScopeSelectionError
  >;
  readonly addPullRequestComment: (
    request: Omit<AidePullRequestAddCommentRequest, 'match' | 'authScope'>,
    options?: Pick<PullRequestProviderOperationOptions, 'operationTimeout'>
  ) => Effect.Effect<
    AidePullRequestCommentMutationResult,
    | PullRequestProviderOperationExecutionError<'addPullRequestComment'>
    | PullRequestAuthScopeSelectionError
  >;
  readonly replyToPullRequestComment: (
    request: Omit<AidePullRequestReplyCommentRequest, 'match' | 'authScope'>,
    options?: Pick<PullRequestProviderOperationOptions, 'operationTimeout'>
  ) => Effect.Effect<
    AidePullRequestCommentMutationResult,
    | PullRequestProviderOperationExecutionError<'replyToPullRequestComment'>
    | PullRequestAuthScopeSelectionError
  >;
}

const MAX_HOST_PULL_REQUEST_DIAGNOSTIC_LENGTH = 16_384;
const hostPullRequestProviderDiagnostics = new WeakMap<object, string>();
const pullRequestAuthScopeSelectionDiagnostics = new WeakMap<object, string>();
const pullRequestProviderFailureCauses = new WeakMap<object, unknown>();
const hostPullRequestProviderMatcherFailureReasons = new WeakMap<
  object,
  string
>();
const pullRequestProviderCandidateEntries = new WeakMap<
  object,
  PluginCapability<AidePullRequestProviderCapability>
>();

function certifiedPullRequestProviderDiagnostic(
  entry: PluginCapability<AidePullRequestProviderCapability> | undefined,
  failure: unknown
): string | undefined {
  return entry === undefined
    ? undefined
    : certifiedBuiltinPullRequestProviderDiagnostic(entry, failure);
}

function boundedHostPullRequestDiagnostic(message: string): string {
  return message.length <= MAX_HOST_PULL_REQUEST_DIAGNOSTIC_LENGTH
    ? message
    : `${message.slice(0, MAX_HOST_PULL_REQUEST_DIAGNOSTIC_LENGTH - 3)}...`;
}

function captureHostPullRequestDiagnostic<T extends object>(
  error: T,
  message: string
): T {
  hostPullRequestProviderDiagnostics.set(
    error,
    boundedHostPullRequestDiagnostic(message)
  );
  return error;
}

function hostPullRequestProviderMatcherFailureCause(message: string): object {
  const cause = objectFreeze(objectCreate(null) as object);
  hostPullRequestProviderMatcherFailureReasons.set(cause, message);
  return cause;
}

function hostPullRequestProviderOperationFailureCause(): object {
  return objectFreeze(objectCreate(null) as object);
}

const GENERIC_PULL_REQUEST_AUTH_SELECTION_DIAGNOSTIC =
  'Pull request authentication selection failed.';
const TIMEOUT_PULL_REQUEST_AUTH_SELECTION_DIAGNOSTIC =
  'Pull request authentication selection timed out.';
const unsafePullRequestAuthSelectionDiagnostic =
  // oxlint-disable-next-line no-control-regex -- source-internal diagnostics reject control text
  /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/u;

/** @internal Source-owned typed failure with WeakMap-certified display text. */
export class PullRequestAuthScopeSelectionError extends Data.TaggedError(
  'PullRequestAuthScopeSelectionError'
)<Record<never, never>> {
  constructor() {
    super();
  }
}

/** @internal Install already-safe selection-domain text without public fields. */
export function certifiedPullRequestAuthScopeSelectionError(
  diagnostic: string
): PullRequestAuthScopeSelectionError {
  if (
    typeof diagnostic !== 'string' ||
    diagnostic.length === 0 ||
    diagnostic.length > MAX_HOST_PULL_REQUEST_DIAGNOSTIC_LENGTH ||
    diagnostic.trim().length === 0 ||
    unsafePullRequestAuthSelectionDiagnostic.test(diagnostic)
  ) {
    throw new Error('Invalid pull request authentication selection diagnostic');
  }
  const error = new PullRequestAuthScopeSelectionError();
  pullRequestAuthScopeSelectionDiagnostics.set(error, diagnostic);
  return error;
}

function genericPullRequestAuthScopeSelectionError(): PullRequestAuthScopeSelectionError {
  return certifiedPullRequestAuthScopeSelectionError(
    GENERIC_PULL_REQUEST_AUTH_SELECTION_DIAGNOSTIC
  );
}

function timeoutPullRequestAuthScopeSelectionError(): PullRequestAuthScopeSelectionError {
  return certifiedPullRequestAuthScopeSelectionError(
    TIMEOUT_PULL_REQUEST_AUTH_SELECTION_DIAGNOSTIC
  );
}

function certifiedPullRequestAuthSelectionDiagnostic(
  value: unknown
): string | undefined {
  return (typeof value === 'object' && value !== null) ||
    typeof value === 'function'
    ? pullRequestAuthScopeSelectionDiagnostics.get(value)
    : undefined;
}

export class UnsupportedPullRequestProviderError extends Data.TaggedError(
  'UnsupportedPullRequestProviderError'
)<{
  readonly source: PullRequestProviderLookupSource;
  readonly value: string;
}> {
  constructor(args: {
    readonly source: PullRequestProviderLookupSource;
    readonly value: string;
  }) {
    super({
      ...args,
      value: describePullRequestProviderLookup(args.source, args.value),
    });
  }

  override get message(): string {
    return `No pull request provider matched ${this.source}: ${this.value}`;
  }
}

export class AmbiguousPullRequestProviderError extends Data.TaggedError(
  'AmbiguousPullRequestProviderError'
)<{
  readonly source: PullRequestProviderLookupSource;
  readonly value: string;
  readonly priority: number;
  readonly candidates: readonly PullRequestProviderCandidate[];
}> {
  constructor(args: {
    readonly source: PullRequestProviderLookupSource;
    readonly value: string;
    readonly priority: number;
    readonly candidates: readonly PullRequestProviderCandidate[];
  }) {
    super({
      ...args,
      value: describePullRequestProviderLookup(args.source, args.value),
    });
  }

  override get message(): string {
    const candidates = formatPullRequestProviderCandidates(this.candidates);
    return `Multiple pull request providers matched ${this.source}: ${this.value} (${candidates})`;
  }
}

export class InvalidPullRequestProviderMatchError extends Data.TaggedError(
  'InvalidPullRequestProviderMatchError'
)<{
  readonly source: PullRequestProviderLookupSource;
  readonly value: string;
  readonly pluginId: string;
  readonly providerId: string;
  readonly reason: string;
}> {
  constructor(args: {
    readonly source: PullRequestProviderLookupSource;
    readonly value: string;
    readonly pluginId: string;
    readonly providerId: string;
    readonly reason: string;
  }) {
    super({
      ...args,
      value: describePullRequestProviderLookup(args.source, args.value),
    });
  }

  override get message(): string {
    return `Pull request provider '${this.providerId}' from plugin '${this.pluginId}' returned invalid ${this.source} match for ${this.value}: ${this.reason}`;
  }
}

export class PullRequestProviderInvocationError extends Data.TaggedError(
  'PullRequestProviderInvocationError'
)<{
  readonly source: PullRequestProviderLookupSource;
  readonly value: string;
  readonly pluginId: string;
  readonly providerId: string;
  readonly cause: unknown;
}> {
  constructor(args: {
    readonly source: PullRequestProviderLookupSource;
    readonly value: string;
    readonly pluginId: string;
    readonly providerId: string;
    readonly cause: unknown;
  }) {
    const { cause, ...hostFields } = args;
    super({
      ...hostFields,
      value: describePullRequestProviderLookup(
        hostFields.source,
        hostFields.value
      ),
    } as typeof hostFields & {
      readonly cause: unknown;
    });
    const failureReason =
      (typeof cause === 'object' && cause !== null) ||
      typeof cause === 'function'
        ? hostPullRequestProviderMatcherFailureReasons.get(cause)
        : undefined;
    pullRequestProviderFailureCauses.set(
      this,
      new Error(failureReason ?? 'Pull request provider matcher failed')
    );
  }

  override get cause(): unknown {
    return pullRequestProviderFailureCauses.get(this);
  }

  override get message(): string {
    return (
      hostPullRequestProviderDiagnostics.get(this) ??
      `Pull request provider '${this.providerId}' from plugin '${this.pluginId}' failed while matching ${this.source} ${this.value}`
    );
  }
}

export class PullRequestProviderTimeoutError extends Data.TaggedError(
  'PullRequestProviderTimeoutError'
)<{
  readonly source: PullRequestProviderLookupSource;
  readonly value: string;
  readonly pluginId: string;
  readonly providerId: string;
}> {
  constructor(args: {
    readonly source: PullRequestProviderLookupSource;
    readonly value: string;
    readonly pluginId: string;
    readonly providerId: string;
  }) {
    super({
      ...args,
      value: describePullRequestProviderLookup(args.source, args.value),
    });
  }

  override get message(): string {
    return `Pull request provider '${this.providerId}' from plugin '${this.pluginId}' timed out while matching ${this.source} ${this.value}`;
  }
}

export type PullRequestProviderReadOperationName =
  | 'listPullRequests'
  | 'getPullRequest'
  | 'getPullRequestDiff'
  | 'listPullRequestComments'
  | 'findPullRequestForBranch';

export type PullRequestProviderMutationOperationName =
  | 'createPullRequest'
  | 'updatePullRequest'
  | 'addPullRequestComment'
  | 'replyToPullRequestComment';

export type PullRequestProviderOperationName =
  | PullRequestProviderReadOperationName
  | PullRequestProviderMutationOperationName;

export class UnsupportedPullRequestProviderOperationError<
  TOperation extends PullRequestProviderOperationName =
    PullRequestProviderOperationName,
> extends Data.TaggedError('UnsupportedPullRequestProviderOperationError')<{
  readonly pluginId: string;
  readonly providerId: string;
  readonly operation: TOperation;
}> {
  override get message(): string {
    return `Pull request provider '${this.providerId}' from plugin '${this.pluginId}' does not implement ${this.operation}`;
  }
}

export class InvalidPullRequestProviderOperationResultError<
  TOperation extends PullRequestProviderOperationName =
    PullRequestProviderOperationName,
> extends Data.TaggedError('InvalidPullRequestProviderOperationResultError')<{
  readonly pluginId: string;
  readonly providerId: string;
  readonly operation: TOperation;
  readonly reason: string;
}> {
  override get message(): string {
    return `Pull request provider '${this.providerId}' from plugin '${this.pluginId}' returned invalid ${this.operation} result: ${this.reason}`;
  }
}

export class PullRequestProviderOperationError<
  TOperation extends PullRequestProviderOperationName =
    PullRequestProviderOperationName,
> extends Data.TaggedError('PullRequestProviderOperationError')<{
  readonly pluginId: string;
  readonly providerId: string;
  readonly operation: TOperation;
  readonly cause: unknown;
}> {
  constructor(args: {
    readonly pluginId: string;
    readonly providerId: string;
    readonly operation: TOperation;
    readonly cause: unknown;
  }) {
    const { cause, ...hostFields } = args;
    super(
      hostFields as typeof hostFields & {
        readonly cause: unknown;
      }
    );
    pullRequestProviderFailureCauses.set(this, cause);
  }

  override get cause(): unknown {
    return pullRequestProviderFailureCauses.get(this);
  }

  override get message(): string {
    return (
      hostPullRequestProviderDiagnostics.get(this) ??
      `Pull request provider '${this.providerId}' from plugin '${this.pluginId}' failed during ${this.operation}`
    );
  }
}

export function pullRequestProviderErrorMessage(
  error: unknown
): string | undefined {
  const message =
    certifiedPullRequestAuthSelectionDiagnostic(error) ??
    hostPullRequestProviderDiagnostics.get(error as object);
  return typeof message === 'string' &&
    message.length > 0 &&
    message.length <= MAX_HOST_PULL_REQUEST_DIAGNOSTIC_LENGTH
    ? message
    : undefined;
}

export class PullRequestProviderOperationTimeoutError<
  TOperation extends PullRequestProviderReadOperationName =
    PullRequestProviderReadOperationName,
> extends Data.TaggedError('PullRequestProviderOperationTimeoutError')<{
  readonly pluginId: string;
  readonly providerId: string;
  readonly operation: TOperation;
}> {
  override get message(): string {
    return `Pull request provider '${this.providerId}' from plugin '${this.pluginId}' timed out during ${this.operation}`;
  }
}

export class PullRequestProviderMutationIndeterminateError<
  TOperation extends PullRequestProviderMutationOperationName =
    PullRequestProviderMutationOperationName,
> extends Data.TaggedError('PullRequestProviderMutationIndeterminateError')<{
  readonly pluginId: string;
  readonly providerId: string;
  readonly operation: TOperation;
}> {
  override get message(): string {
    return `Pull request mutation outcome is indeterminate for provider '${this.providerId}' from plugin '${this.pluginId}' during ${this.operation}: the operation may have succeeded; do not retry blindly. Verify the remote state before taking further action.`;
  }
}

type UnsupportedProviderArgs = {
  readonly source: PullRequestProviderLookupSource;
  readonly value: string;
};

type AmbiguousProviderArgs = UnsupportedProviderArgs & {
  readonly priority: number;
  readonly candidates: readonly PullRequestProviderCandidate[];
};

type InvalidMatchArgs = UnsupportedProviderArgs & {
  readonly pluginId: string;
  readonly providerId: string;
  readonly reason: string;
};

type InvocationArgs = UnsupportedProviderArgs & {
  readonly pluginId: string;
  readonly providerId: string;
  readonly cause: unknown;
};

type MatcherTimeoutArgs = UnsupportedProviderArgs & {
  readonly pluginId: string;
  readonly providerId: string;
};

type OperationArgs<
  TOperation extends PullRequestProviderOperationName =
    PullRequestProviderOperationName,
> = {
  readonly pluginId: string;
  readonly providerId: string;
  readonly operation: TOperation;
};

type InvalidOperationResultArgs<
  TOperation extends PullRequestProviderOperationName =
    PullRequestProviderOperationName,
> = OperationArgs<TOperation> & {
  readonly reason: string;
};

type OperationFailureArgs<
  TOperation extends PullRequestProviderOperationName =
    PullRequestProviderOperationName,
> = OperationArgs<TOperation> & {
  readonly cause: unknown;
};

function hostUnsupportedPullRequestProviderError(
  args: UnsupportedProviderArgs
): UnsupportedPullRequestProviderError {
  const error = new UnsupportedPullRequestProviderError(args);
  return captureHostPullRequestDiagnostic(
    error,
    `No pull request provider matched ${error.source}: ${error.value}`
  );
}

function hostAmbiguousPullRequestProviderError(
  args: AmbiguousProviderArgs
): AmbiguousPullRequestProviderError {
  const candidates = formatPullRequestProviderCandidates(args.candidates);
  const error = new AmbiguousPullRequestProviderError(args);
  return captureHostPullRequestDiagnostic(
    error,
    `Multiple pull request providers matched ${error.source}: ${error.value} (${candidates})`
  );
}

function hostInvalidPullRequestProviderMatchError(
  args: InvalidMatchArgs
): InvalidPullRequestProviderMatchError {
  const error = new InvalidPullRequestProviderMatchError(args);
  return captureHostPullRequestDiagnostic(
    error,
    `Pull request provider '${error.providerId}' from plugin '${error.pluginId}' returned invalid ${error.source} match for ${error.value}: ${error.reason}`
  );
}

function hostPullRequestProviderInvocationError(
  args: InvocationArgs
): PullRequestProviderInvocationError {
  const error = new PullRequestProviderInvocationError(args);
  return captureHostPullRequestDiagnostic(
    error,
    `Pull request provider '${error.providerId}' from plugin '${error.pluginId}' failed while matching ${error.source} ${error.value}`
  );
}

function hostPullRequestProviderTimeoutError(
  args: MatcherTimeoutArgs
): PullRequestProviderTimeoutError {
  const error = new PullRequestProviderTimeoutError(args);
  return captureHostPullRequestDiagnostic(
    error,
    `Pull request provider '${error.providerId}' from plugin '${error.pluginId}' timed out while matching ${error.source} ${error.value}`
  );
}

function hostUnsupportedPullRequestProviderOperationError<
  TOperation extends PullRequestProviderOperationName,
>(
  args: OperationArgs<TOperation>
): UnsupportedPullRequestProviderOperationError<TOperation> {
  return captureHostPullRequestDiagnostic(
    new UnsupportedPullRequestProviderOperationError(args),
    `Pull request provider '${args.providerId}' from plugin '${args.pluginId}' does not implement ${args.operation}`
  );
}

function hostInvalidPullRequestProviderOperationResultError<
  TOperation extends PullRequestProviderOperationName,
>(
  args: InvalidOperationResultArgs<TOperation>
): InvalidPullRequestProviderOperationResultError<TOperation> {
  return captureHostPullRequestDiagnostic(
    new InvalidPullRequestProviderOperationResultError(args),
    `Pull request provider '${args.providerId}' from plugin '${args.pluginId}' returned invalid ${args.operation} result: ${args.reason}`
  );
}

function hostPullRequestProviderOperationError<
  TOperation extends PullRequestProviderOperationName,
>(
  args: OperationFailureArgs<TOperation>,
  entry?: PluginCapability<AidePullRequestProviderCapability>,
  sanitizeCause = false
): PullRequestProviderOperationError<TOperation> {
  const certified = certifiedPullRequestProviderDiagnostic(entry, args.cause);
  return captureHostPullRequestDiagnostic(
    new PullRequestProviderOperationError(
      sanitizeCause
        ? {
            ...args,
            cause: hostPullRequestProviderOperationFailureCause(),
          }
        : args
    ),
    certified ??
      `Pull request provider '${args.providerId}' from plugin '${args.pluginId}' failed during ${args.operation}`
  );
}

function hostPullRequestProviderOperationTimeoutError<
  TOperation extends PullRequestProviderReadOperationName,
>(
  args: OperationArgs<TOperation>
): PullRequestProviderOperationTimeoutError<TOperation> {
  return captureHostPullRequestDiagnostic(
    new PullRequestProviderOperationTimeoutError(args),
    `Pull request provider '${args.providerId}' from plugin '${args.pluginId}' timed out during ${args.operation}`
  );
}

function hostPullRequestProviderMutationIndeterminateError<
  TOperation extends PullRequestProviderMutationOperationName,
>(
  args: OperationArgs<TOperation>
): PullRequestProviderMutationIndeterminateError<TOperation> {
  return captureHostPullRequestDiagnostic(
    new PullRequestProviderMutationIndeterminateError(args),
    `Pull request mutation outcome is indeterminate for provider '${args.providerId}' from plugin '${args.pluginId}' during ${args.operation}: the operation may have succeeded; do not retry blindly. Verify the remote state before taking further action.`
  );
}

export type PullRequestProviderResolutionError =
  | UnsupportedPullRequestProviderError
  | AmbiguousPullRequestProviderError
  | InvalidPullRequestProviderMatchError
  | PullRequestProviderInvocationError
  | PullRequestProviderTimeoutError;

export type PullRequestProviderOperationExecutionError<
  TOperation extends PullRequestProviderOperationName =
    PullRequestProviderOperationName,
> =
  | UnsupportedPullRequestProviderOperationError<TOperation>
  | InvalidPullRequestProviderOperationResultError<TOperation>
  | PullRequestProviderOperationError<TOperation>
  | PullRequestProviderOperationDeadlineError<TOperation>;

export type PullRequestProviderOperationInvocationError<
  TOperation extends PullRequestProviderOperationName =
    PullRequestProviderOperationName,
> =
  | PullRequestProviderResolutionError
  | PullRequestAuthScopeSelectionError
  | PullRequestProviderOperationExecutionError<TOperation>;

const defaultMatcherTimeout = '2 seconds' satisfies Duration.DurationInput;
const defaultOperationTimeout = '10 seconds' satisfies Duration.DurationInput;
const defaultSelectionTimeout = '10 seconds' satisfies Duration.DurationInput;

const isNodeProxy = nodeUtilTypes.isProxy;
const MAX_PULL_REQUEST_AUTH_SCOPE_ID_LENGTH = 1_024;
const MAX_PULL_REQUEST_AUTH_SCOPE_HOST_LENGTH = 253;
const MAX_PULL_REQUEST_AUTH_SCOPE_IDENTITY_LENGTH = 256;
const unsafePullRequestAuthScopeIdentity =
  // oxlint-disable-next-line no-control-regex -- identity snapshots reject control and bidi text
  /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/u;

type AuthScopeStringSnapshot =
  | { readonly kind: 'absent' }
  | { readonly kind: 'value'; readonly value: string }
  | { readonly kind: 'invalid' };

function isWellFormedPullRequestAuthScopeText(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function snapshotAuthScopeString(
  value: object,
  field: 'id' | 'providerId' | 'host' | 'org' | 'account',
  maximumLength: number
): AuthScopeStringSnapshot {
  try {
    const descriptor = reflectGetOwnPropertyDescriptor(value, field);
    if (descriptor === undefined) return { kind: 'absent' };
    if (!objectHasOwn(descriptor, 'value')) return { kind: 'invalid' };
    if (descriptor.value === undefined && field !== 'id') {
      return { kind: 'absent' };
    }
    if (
      typeof descriptor.value !== 'string' ||
      descriptor.value.length === 0 ||
      descriptor.value.length > maximumLength ||
      descriptor.value.trim() !== descriptor.value ||
      !isWellFormedPullRequestAuthScopeText(descriptor.value) ||
      unsafePullRequestAuthScopeIdentity.test(descriptor.value)
    ) {
      return { kind: 'invalid' };
    }
    return { kind: 'value', value: descriptor.value };
  } catch {
    return { kind: 'invalid' };
  }
}

/** Pure hostile-input snapshot used only after provider resolution. */
function snapshotPullRequestAuthScope(
  value: unknown,
  providerId: string
): AideAuthScope | undefined | null {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'object' ||
    value === null ||
    isNodeProxy(value) ||
    arrayIsArray(value)
  ) {
    return null;
  }
  try {
    const prototype = reflectGetPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
  } catch {
    return null;
  }

  const id = snapshotAuthScopeString(
    value,
    'id',
    MAX_PULL_REQUEST_AUTH_SCOPE_ID_LENGTH
  );
  const selectedProviderId = snapshotAuthScopeString(
    value,
    'providerId',
    MAX_PULL_REQUEST_AUTH_SCOPE_IDENTITY_LENGTH
  );
  const host = snapshotAuthScopeString(
    value,
    'host',
    MAX_PULL_REQUEST_AUTH_SCOPE_HOST_LENGTH
  );
  const org = snapshotAuthScopeString(
    value,
    'org',
    MAX_PULL_REQUEST_AUTH_SCOPE_IDENTITY_LENGTH
  );
  const account = snapshotAuthScopeString(
    value,
    'account',
    MAX_PULL_REQUEST_AUTH_SCOPE_IDENTITY_LENGTH
  );
  if (
    id.kind !== 'value' ||
    selectedProviderId.kind === 'invalid' ||
    host.kind === 'invalid' ||
    org.kind === 'invalid' ||
    account.kind === 'invalid' ||
    (selectedProviderId.kind === 'value' &&
      selectedProviderId.value !== providerId)
  ) {
    return null;
  }

  return frozenHostRecord({
    id: id.value,
    ...(selectedProviderId.kind === 'value'
      ? { providerId: selectedProviderId.value }
      : {}),
    ...(host.kind === 'value' ? { host: host.value } : {}),
    ...(org.kind === 'value' ? { org: org.value } : {}),
    ...(account.kind === 'value' ? { account: account.value } : {}),
  });
}

function selectionErrorFromCause(
  cause: Cause.Cause<unknown>
): PullRequestAuthScopeSelectionError {
  const failures = Cause.failures(cause);
  const defects = Cause.defects(cause);
  if (
    !Cause.isInterrupted(cause) &&
    failures.length === 1 &&
    defects.length === 0
  ) {
    let failure: unknown;
    for (const candidate of failures) {
      failure = candidate;
      break;
    }
    if (certifiedPullRequestAuthSelectionDiagnostic(failure) !== undefined) {
      return failure as PullRequestAuthScopeSelectionError;
    }
  }
  return genericPullRequestAuthScopeSelectionError();
}

export function selectAndSnapshotPullRequestAuthScope(
  provider: ResolvedPullRequestProviderCandidate,
  options: AideInternalPullRequestInvocationOptions = {}
): Effect.Effect<
  AideAuthScope | undefined,
  PullRequestAuthScopeSelectionError,
  never
> {
  const selector = ownDataPropertyValue<PullRequestProviderAuthScopeSelector>(
    options,
    'authScopeSelector'
  );
  if (selector === undefined) return Effect.succeed(undefined);
  const selectionTimeout = ownDataPropertyValue<Duration.DurationInput>(
    options,
    'selectionTimeout'
  );

  return invokePublicCapabilityEffect<
    AideAuthScope | undefined,
    PullRequestAuthScopeSelectionError,
    AideAuthScope | undefined,
    PullRequestAuthScopeSelectionError,
    PullRequestAuthScopeSelectionError
  >(
    () => selector(stripProviderCapability(provider)),
    {
      onCallbackThrow: genericPullRequestAuthScopeSelectionError,
      onInvalidReturn: genericPullRequestAuthScopeSelectionError,
      onCompositionFailure: genericPullRequestAuthScopeSelectionError,
      onLaunchFailure: genericPullRequestAuthScopeSelectionError,
    },
    (effect) =>
      Effect.matchCauseEffect(effect, {
        onFailure: (cause) => Effect.fail(selectionErrorFromCause(cause)),
        onSuccess: (selected) => {
          const snapshot = snapshotPullRequestAuthScope(
            selected,
            provider.providerId
          );
          return snapshot === null
            ? Effect.fail(genericPullRequestAuthScopeSelectionError())
            : Effect.succeed(snapshot);
        },
      })
  ).pipe(
    Effect.timeoutFail({
      duration: selectionTimeout ?? defaultSelectionTimeout,
      onTimeout: timeoutPullRequestAuthScopeSelectionError,
    })
  );
}

/**
 * Reject public request/option smuggling using descriptors only. Proxies fail
 * without invoking traps; inherited lookalikes are intentionally ignored.
 */
export function rejectPublicPullRequestAuthSelectionInput(
  ...values: readonly unknown[]
): PullRequestAuthScopeSelectionError | undefined {
  for (const value of values) {
    if (
      (typeof value !== 'object' && typeof value !== 'function') ||
      value === null
    ) {
      continue;
    }
    try {
      if (isNodeProxy(value)) {
        return genericPullRequestAuthScopeSelectionError();
      }
      if (
        reflectGetOwnPropertyDescriptor(value, 'authScope') !== undefined ||
        reflectGetOwnPropertyDescriptor(value, 'authScopeSelector') !==
          undefined
      ) {
        return genericPullRequestAuthScopeSelectionError();
      }
    } catch {
      return genericPullRequestAuthScopeSelectionError();
    }
  }
  return undefined;
}

const MAX_PR_RESULT_DEPTH = 8;
const MAX_PR_RESULT_ARRAY_LENGTH = 1_000;
const MAX_PR_RESULT_RECORD_FIELDS = 128;
const MAX_PR_RESULT_NODES = 20_000;
const MAX_PR_RESULT_STRING_LENGTH = 65_536;
const MAX_PR_RESULT_STRING_UNITS = 1_048_576;

type PullRequestCaptureSchema =
  | { readonly kind: 'reject' }
  | { readonly kind: 'scalar' }
  | { readonly kind: 'boolean' }
  | {
      readonly kind: 'array';
      readonly entry: PullRequestCaptureSchema;
    }
  | {
      readonly kind: 'record';
      readonly fields: Readonly<
        Record<
          string,
          {
            readonly schema: PullRequestCaptureSchema;
            readonly optional: boolean;
          }
        >
      >;
    }
  | {
      readonly kind: 'dictionary';
      readonly entry: PullRequestCaptureSchema;
    }
  | {
      readonly kind: 'discriminated';
      readonly field: string;
      readonly variants: Readonly<Record<string, PullRequestCaptureSchema>>;
      readonly fallback: PullRequestCaptureSchema;
    };

type PullRequestCaptureSchemaName =
  | 'features'
  | 'match'
  | 'listPullRequests'
  | 'getPullRequest'
  | 'createPullRequest'
  | 'updatePullRequest'
  | 'getPullRequestDiff'
  | 'listPullRequestComments'
  | 'addPullRequestComment'
  | 'replyToPullRequestComment'
  | 'findPullRequestForBranch';

type PullRequestOperationCaptureSchemaName = Exclude<
  PullRequestCaptureSchemaName,
  'features' | 'match'
>;

export type PullRequestProviderOperationDeadlineError<
  TOperation extends PullRequestProviderOperationName,
> = TOperation extends PullRequestProviderMutationOperationName
  ? PullRequestProviderMutationIndeterminateError<TOperation>
  : TOperation extends PullRequestProviderReadOperationName
    ? PullRequestProviderOperationTimeoutError<TOperation>
    : never;

interface PullRequestCaptureState {
  readonly active: WeakSet<object>;
  nodes: number;
  stringUnits: number;
}

type PullRequestCaptureResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false };

const pullRequestCaptureFailure = objectFreeze({});

type PullRequestCaptureField = {
  readonly schema: PullRequestCaptureSchema;
  readonly optional: boolean;
};

type PullRequestCaptureFields = Readonly<
  Record<string, PullRequestCaptureField>
>;

function invalidPullRequestCaptureSchemaDefinition(): never {
  throw new TypeError('Invalid host pull request capture schema definition');
}

function immutablePullRequestCaptureRecord<const T extends object>(
  source: T
): Readonly<T>;
function immutablePullRequestCaptureRecord<
  const TFirst extends object,
  const TSecond extends object,
>(first: TFirst, second: TSecond): Readonly<TFirst & TSecond>;
function immutablePullRequestCaptureRecord(
  ...sources: readonly object[]
): Readonly<object> {
  const snapshot = objectCreate(null) as Record<string, unknown>;
  const seen = new Set<string>();
  const sourceCount = hostArrayLength(sources);
  if (sourceCount === undefined) invalidPullRequestCaptureSchemaDefinition();
  for (let sourceIndex = 0; sourceIndex < sourceCount; sourceIndex += 1) {
    const source = hostArrayDataValue<object>(sources, sourceIndex);
    if (source === undefined) invalidPullRequestCaptureSchemaDefinition();
    const prototype = isNodeProxy(source)
      ? undefined
      : reflectGetPrototypeOf(source);
    if (
      prototype === undefined ||
      arrayIsArray(source) ||
      (prototype !== Object.prototype && prototype !== null)
    ) {
      invalidPullRequestCaptureSchemaDefinition();
    }
    const keys = reflectOwnKeys(source);
    const keyCount = hostArrayLength(keys);
    if (keyCount === undefined) invalidPullRequestCaptureSchemaDefinition();
    for (let keyIndex = 0; keyIndex < keyCount; keyIndex += 1) {
      const key = hostArrayDataValue<PropertyKey>(keys, keyIndex);
      if (typeof key !== 'string' || seen.has(key)) {
        invalidPullRequestCaptureSchemaDefinition();
      }
      const descriptor = reflectGetOwnPropertyDescriptor(source, key);
      if (
        descriptor === undefined ||
        !objectHasOwn(descriptor, 'value') ||
        descriptor.enumerable !== true
      ) {
        invalidPullRequestCaptureSchemaDefinition();
      }
      seen.add(key);
      objectDefineProperty(snapshot, key, {
        configurable: false,
        enumerable: true,
        writable: false,
        value: descriptor.value,
      });
    }
  }
  return objectFreeze(snapshot);
}

const scalarCaptureSchema: PullRequestCaptureSchema =
  immutablePullRequestCaptureRecord({ kind: 'scalar' as const });
const booleanCaptureSchema: PullRequestCaptureSchema =
  immutablePullRequestCaptureRecord({ kind: 'boolean' as const });
const rejectCaptureSchema: PullRequestCaptureSchema =
  immutablePullRequestCaptureRecord({ kind: 'reject' as const });

function optionalCaptureField(
  schema: PullRequestCaptureSchema
): PullRequestCaptureField {
  return immutablePullRequestCaptureRecord({ schema, optional: true });
}

function requiredCaptureField(
  schema: PullRequestCaptureSchema
): PullRequestCaptureField {
  return immutablePullRequestCaptureRecord({ schema, optional: false });
}

function recordCaptureSchema(
  fields: PullRequestCaptureFields,
  additionalFields?: PullRequestCaptureFields
): PullRequestCaptureSchema {
  const ownedFields =
    additionalFields === undefined
      ? immutablePullRequestCaptureRecord(fields)
      : immutablePullRequestCaptureRecord(fields, additionalFields);
  return immutablePullRequestCaptureRecord({
    kind: 'record' as const,
    fields: ownedFields,
  });
}

function arrayCaptureSchema(
  entry: PullRequestCaptureSchema
): PullRequestCaptureSchema {
  return immutablePullRequestCaptureRecord({ kind: 'array' as const, entry });
}

function dictionaryCaptureSchema(
  entry: PullRequestCaptureSchema
): PullRequestCaptureSchema {
  return immutablePullRequestCaptureRecord({
    kind: 'dictionary' as const,
    entry,
  });
}

function discriminatedCaptureSchema(
  field: string,
  variants: Readonly<Record<string, PullRequestCaptureSchema>>,
  fallback: PullRequestCaptureSchema
): PullRequestCaptureSchema {
  return immutablePullRequestCaptureRecord({
    kind: 'discriminated' as const,
    field,
    variants: immutablePullRequestCaptureRecord(variants),
    fallback,
  });
}

const repositoryMetadataCaptureSchema =
  dictionaryCaptureSchema(scalarCaptureSchema);
const githubRepositoryCaptureSchema = recordCaptureSchema({
  kind: requiredCaptureField(scalarCaptureSchema),
  host: requiredCaptureField(scalarCaptureSchema),
  owner: requiredCaptureField(scalarCaptureSchema),
  repo: requiredCaptureField(scalarCaptureSchema),
});
const azureRepositoryCaptureSchema = recordCaptureSchema({
  kind: requiredCaptureField(scalarCaptureSchema),
  org: requiredCaptureField(scalarCaptureSchema),
  project: requiredCaptureField(scalarCaptureSchema),
  repo: requiredCaptureField(scalarCaptureSchema),
});
const externalRepositoryCaptureSchema = recordCaptureSchema({
  kind: requiredCaptureField(scalarCaptureSchema),
  providerId: requiredCaptureField(scalarCaptureSchema),
  displayName: requiredCaptureField(scalarCaptureSchema),
  metadata: optionalCaptureField(repositoryMetadataCaptureSchema),
});
const repositoryCaptureSchema = discriminatedCaptureSchema(
  'kind',
  {
    github: githubRepositoryCaptureSchema,
    'azure-devops': azureRepositoryCaptureSchema,
    external: externalRepositoryCaptureSchema,
  },
  rejectCaptureSchema
);
const pullRequestRefCaptureSchema = recordCaptureSchema({
  number: requiredCaptureField(scalarCaptureSchema),
});
const authorCaptureSchema = recordCaptureSchema({
  displayName: requiredCaptureField(scalarCaptureSchema),
  username: optionalCaptureField(scalarCaptureSchema),
  email: optionalCaptureField(scalarCaptureSchema),
});
const pullRequestListItemCaptureFields = immutablePullRequestCaptureRecord({
  id: requiredCaptureField(scalarCaptureSchema),
  title: requiredCaptureField(scalarCaptureSchema),
  status: requiredCaptureField(scalarCaptureSchema),
  createdAt: requiredCaptureField(scalarCaptureSchema),
  author: requiredCaptureField(authorCaptureSchema),
  description: optionalCaptureField(scalarCaptureSchema),
  url: optionalCaptureField(scalarCaptureSchema),
  draft: optionalCaptureField(scalarCaptureSchema),
});
const pullRequestListItemCaptureSchema = recordCaptureSchema(
  pullRequestListItemCaptureFields
);
const stringArrayCaptureSchema = arrayCaptureSchema(scalarCaptureSchema);
const pullRequestViewItemCaptureSchema = recordCaptureSchema(
  pullRequestListItemCaptureFields,
  {
    sourceBranch: optionalCaptureField(scalarCaptureSchema),
    targetBranch: optionalCaptureField(scalarCaptureSchema),
    labels: optionalCaptureField(stringArrayCaptureSchema),
  }
);
const diffFileCaptureSchema = recordCaptureSchema({
  path: requiredCaptureField(scalarCaptureSchema),
  status: requiredCaptureField(scalarCaptureSchema),
  providerStatus: optionalCaptureField(scalarCaptureSchema),
  previousPath: optionalCaptureField(scalarCaptureSchema),
  additions: optionalCaptureField(scalarCaptureSchema),
  deletions: optionalCaptureField(scalarCaptureSchema),
  changes: optionalCaptureField(scalarCaptureSchema),
  patch: optionalCaptureField(scalarCaptureSchema),
});
const commentCaptureSchema = recordCaptureSchema({
  id: requiredCaptureField(scalarCaptureSchema),
  kind: requiredCaptureField(scalarCaptureSchema),
  author: requiredCaptureField(authorCaptureSchema),
  body: requiredCaptureField(scalarCaptureSchema),
  createdAt: requiredCaptureField(scalarCaptureSchema),
  updatedAt: optionalCaptureField(scalarCaptureSchema),
  url: optionalCaptureField(scalarCaptureSchema),
  filePath: optionalCaptureField(scalarCaptureSchema),
  lineNumber: optionalCaptureField(scalarCaptureSchema),
  parentId: optionalCaptureField(scalarCaptureSchema),
  providerType: optionalCaptureField(scalarCaptureSchema),
});
const commentThreadCaptureSchema = recordCaptureSchema({
  id: requiredCaptureField(scalarCaptureSchema),
  status: optionalCaptureField(scalarCaptureSchema),
  filePath: optionalCaptureField(scalarCaptureSchema),
  lineNumber: optionalCaptureField(scalarCaptureSchema),
  rootComment: optionalCaptureField(commentCaptureSchema),
  replies: requiredCaptureField(arrayCaptureSchema(commentCaptureSchema)),
});
const matchBaseCaptureFields = immutablePullRequestCaptureRecord({
  priority: optionalCaptureField(scalarCaptureSchema),
  detail: optionalCaptureField(scalarCaptureSchema),
});
const nonUrlMatchCaptureSchema = recordCaptureSchema({
  source: requiredCaptureField(scalarCaptureSchema),
  repository: requiredCaptureField(repositoryCaptureSchema),
  pullRequest: optionalCaptureField(rejectCaptureSchema),
  priority: optionalCaptureField(scalarCaptureSchema),
  detail: optionalCaptureField(scalarCaptureSchema),
});
const urlMatchCaptureSchema = recordCaptureSchema(matchBaseCaptureFields, {
  source: requiredCaptureField(scalarCaptureSchema),
  repository: requiredCaptureField(repositoryCaptureSchema),
  pullRequest: requiredCaptureField(pullRequestRefCaptureSchema),
});
const matchCaptureSchema = discriminatedCaptureSchema(
  'source',
  {
    'git-remote': nonUrlMatchCaptureSchema,
    'repository-ref': nonUrlMatchCaptureSchema,
    'pull-request-url': urlMatchCaptureSchema,
  },
  rejectCaptureSchema
);
const featuresCaptureSchema = recordCaptureSchema({
  draftPullRequests: optionalCaptureField(booleanCaptureSchema),
  reviewComments: optionalCaptureField(booleanCaptureSchema),
  threadedComments: optionalCaptureField(booleanCaptureSchema),
  enterpriseHosts: optionalCaptureField(booleanCaptureSchema),
});
const viewResultCaptureFields = immutablePullRequestCaptureRecord({
  repository: requiredCaptureField(repositoryCaptureSchema),
  repositoryLabel: optionalCaptureField(scalarCaptureSchema),
  pullRequest: requiredCaptureField(pullRequestViewItemCaptureSchema),
});
const pullRequestCaptureSchemas: Readonly<
  Record<PullRequestCaptureSchemaName, PullRequestCaptureSchema>
> = immutablePullRequestCaptureRecord({
  features: featuresCaptureSchema,
  match: matchCaptureSchema,
  listPullRequests: recordCaptureSchema({
    repository: requiredCaptureField(repositoryCaptureSchema),
    repositoryLabel: optionalCaptureField(scalarCaptureSchema),
    pullRequests: requiredCaptureField(
      arrayCaptureSchema(pullRequestListItemCaptureSchema)
    ),
  }),
  getPullRequest: recordCaptureSchema(viewResultCaptureFields),
  createPullRequest: recordCaptureSchema(viewResultCaptureFields, {
    warnings: optionalCaptureField(stringArrayCaptureSchema),
  }),
  updatePullRequest: recordCaptureSchema(viewResultCaptureFields, {
    warnings: optionalCaptureField(stringArrayCaptureSchema),
  }),
  getPullRequestDiff: recordCaptureSchema(viewResultCaptureFields, {
    files: requiredCaptureField(arrayCaptureSchema(diffFileCaptureSchema)),
  }),
  listPullRequestComments: recordCaptureSchema({
    repository: requiredCaptureField(repositoryCaptureSchema),
    repositoryLabel: optionalCaptureField(scalarCaptureSchema),
    pullRequest: requiredCaptureField(pullRequestRefCaptureSchema),
    threads: requiredCaptureField(
      arrayCaptureSchema(commentThreadCaptureSchema)
    ),
  }),
  addPullRequestComment: recordCaptureSchema({
    repository: requiredCaptureField(repositoryCaptureSchema),
    repositoryLabel: optionalCaptureField(scalarCaptureSchema),
    pullRequest: requiredCaptureField(pullRequestRefCaptureSchema),
    comment: requiredCaptureField(commentCaptureSchema),
    thread: optionalCaptureField(commentThreadCaptureSchema),
  }),
  replyToPullRequestComment: recordCaptureSchema({
    repository: requiredCaptureField(repositoryCaptureSchema),
    repositoryLabel: optionalCaptureField(scalarCaptureSchema),
    pullRequest: requiredCaptureField(pullRequestRefCaptureSchema),
    comment: requiredCaptureField(commentCaptureSchema),
    thread: optionalCaptureField(commentThreadCaptureSchema),
  }),
  findPullRequestForBranch: recordCaptureSchema(viewResultCaptureFields, {
    branch: requiredCaptureField(scalarCaptureSchema),
  }),
});

function failPullRequestCapture(): never {
  throw pullRequestCaptureFailure;
}

function accountPullRequestCapture(
  state: PullRequestCaptureState,
  value: unknown,
  depth: number,
  countNode = true
): void {
  if (depth > MAX_PR_RESULT_DEPTH) failPullRequestCapture();
  if (countNode) {
    state.nodes += 1;
    if (state.nodes > MAX_PR_RESULT_NODES) failPullRequestCapture();
  }
  if (typeof value !== 'string') return;
  if (value.length > MAX_PR_RESULT_STRING_LENGTH) failPullRequestCapture();
  state.stringUnits += value.length;
  if (state.stringUnits > MAX_PR_RESULT_STRING_UNITS) {
    failPullRequestCapture();
  }
}

function guardedPullRequestRecord(value: unknown): object {
  if (typeof value !== 'object' || value === null) failPullRequestCapture();
  if (isNodeProxy(value) || arrayIsArray(value)) failPullRequestCapture();
  const prototype = reflectGetPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    failPullRequestCapture();
  }
  return value;
}

const missingPullRequestOwnData = Symbol('missing-pull-request-own-data');

function ownPullRequestDataValue(
  value: object,
  key: PropertyKey
): unknown | typeof missingPullRequestOwnData {
  const descriptor = reflectGetOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) return missingPullRequestOwnData;
  if (!objectHasOwn(descriptor, 'value')) failPullRequestCapture();
  return descriptor.value;
}

function definePullRequestArrayEntry<T>(
  target: T[],
  index: number,
  value: T
): void {
  objectDefineProperty(target, String(index), {
    configurable: false,
    enumerable: true,
    writable: false,
    value,
  });
}

function pullRequestCaptureSchemaProperty<T>(
  schemaRecord: object,
  key: PropertyKey
): T {
  const value = ownPullRequestDataValue(schemaRecord, key);
  if (value === missingPullRequestOwnData) failPullRequestCapture();
  return value as T;
}

function asPullRequestCaptureSchema(value: unknown): PullRequestCaptureSchema {
  if (typeof value !== 'object' || value === null) failPullRequestCapture();
  return value as PullRequestCaptureSchema;
}

function asPullRequestCaptureSchemaRecord(value: unknown): object {
  if (typeof value !== 'object' || value === null) failPullRequestCapture();
  return value;
}

function capturePullRequestArray(
  value: unknown,
  schema: PullRequestCaptureSchema,
  state: PullRequestCaptureState,
  depth: number
): readonly unknown[] {
  if (typeof value !== 'object' || value === null || isNodeProxy(value)) {
    failPullRequestCapture();
  }
  if (
    !arrayIsArray(value) ||
    reflectGetPrototypeOf(value) !== Array.prototype
  ) {
    failPullRequestCapture();
  }
  const source = value as object;
  if (state.active.has(source)) failPullRequestCapture();
  state.active.add(source);
  try {
    const length = ownPullRequestDataValue(source, 'length');
    if (
      length === missingPullRequestOwnData ||
      typeof length !== 'number' ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > MAX_PR_RESULT_ARRAY_LENGTH
    ) {
      failPullRequestCapture();
    }

    const keys = reflectOwnKeys(source);
    const keyCount = hostArrayLength(keys);
    if (keyCount === undefined || keyCount !== length + 1) {
      failPullRequestCapture();
    }
    for (let keyIndex = 0; keyIndex < keyCount; keyIndex += 1) {
      const key = hostArrayDataValue<PropertyKey>(keys, keyIndex);
      if (key === 'length') continue;
      if (typeof key !== 'string') failPullRequestCapture();
      const index = Number(key);
      if (!Number.isSafeInteger(index) || index < 0 || index >= length) {
        failPullRequestCapture();
      }
    }

    const snapshot: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const key = String(index);
      accountPullRequestCapture(state, key, depth + 1, false);
      const entry = ownPullRequestDataValue(source, key);
      if (entry === missingPullRequestOwnData) failPullRequestCapture();
      definePullRequestArrayEntry(
        snapshot,
        index,
        capturePullRequestNode(
          entry,
          asPullRequestCaptureSchema(
            pullRequestCaptureSchemaProperty(schema, 'entry')
          ),
          state,
          depth + 1
        )
      );
    }
    return objectFreeze(snapshot);
  } finally {
    state.active.delete(source);
  }
}

function capturePullRequestRecord(
  value: unknown,
  schema: PullRequestCaptureSchema,
  state: PullRequestCaptureState,
  depth: number
): Readonly<Record<string, unknown>> {
  const source = guardedPullRequestRecord(value);
  if (state.active.has(source)) failPullRequestCapture();
  state.active.add(source);
  try {
    const keys = reflectOwnKeys(source);
    const keyCount = hostArrayLength(keys);
    if (keyCount === undefined || keyCount > MAX_PR_RESULT_RECORD_FIELDS) {
      failPullRequestCapture();
    }
    const snapshot = objectCreate(null) as Record<string, unknown>;
    const seen = new Set<string>();
    const kind = pullRequestCaptureSchemaProperty<'record' | 'dictionary'>(
      schema,
      'kind'
    );
    const fields =
      kind === 'record'
        ? asPullRequestCaptureSchemaRecord(
            pullRequestCaptureSchemaProperty(schema, 'fields')
          )
        : undefined;
    const dictionaryEntry =
      kind === 'dictionary'
        ? asPullRequestCaptureSchema(
            pullRequestCaptureSchemaProperty(schema, 'entry')
          )
        : undefined;
    if (kind !== 'record' && kind !== 'dictionary') failPullRequestCapture();
    for (let keyIndex = 0; keyIndex < keyCount; keyIndex += 1) {
      const key = hostArrayDataValue<PropertyKey>(keys, keyIndex);
      if (typeof key !== 'string' || seen.has(key)) failPullRequestCapture();
      seen.add(key);
      accountPullRequestCapture(state, key, depth + 1, false);
      let fieldSchema: PullRequestCaptureSchema;
      let fieldOptional: boolean;
      if (kind === 'dictionary') {
        fieldSchema = dictionaryEntry!;
        fieldOptional = false;
      } else {
        const field = asPullRequestCaptureSchemaRecord(
          ownPullRequestDataValue(fields!, key)
        );
        fieldSchema = asPullRequestCaptureSchema(
          pullRequestCaptureSchemaProperty(field, 'schema')
        );
        const optional = pullRequestCaptureSchemaProperty(field, 'optional');
        if (typeof optional !== 'boolean') failPullRequestCapture();
        fieldOptional = optional;
      }
      const entry = ownPullRequestDataValue(source, key);
      if (entry === missingPullRequestOwnData) failPullRequestCapture();
      if (entry === undefined && fieldOptional) continue;
      objectDefineProperty(snapshot, key, {
        configurable: false,
        enumerable: true,
        writable: false,
        value: capturePullRequestNode(entry, fieldSchema, state, depth + 1),
      });
    }
    if (kind === 'record') {
      const fieldKeys = reflectOwnKeys(fields!);
      const fieldKeyCount = hostArrayLength(fieldKeys);
      if (fieldKeyCount === undefined) failPullRequestCapture();
      for (let keyIndex = 0; keyIndex < fieldKeyCount; keyIndex += 1) {
        const key = hostArrayDataValue<PropertyKey>(fieldKeys, keyIndex);
        if (typeof key !== 'string') failPullRequestCapture();
        const field = asPullRequestCaptureSchemaRecord(
          ownPullRequestDataValue(fields!, key)
        );
        const optional = pullRequestCaptureSchemaProperty(field, 'optional');
        if (typeof optional !== 'boolean') failPullRequestCapture();
        if (!optional && !seen.has(key)) failPullRequestCapture();
      }
    }
    return objectFreeze(snapshot);
  } finally {
    state.active.delete(source);
  }
}

function capturePullRequestNode(
  value: unknown,
  schema: PullRequestCaptureSchema,
  state: PullRequestCaptureState,
  depth: number
): unknown {
  const kind = pullRequestCaptureSchemaProperty<
    PullRequestCaptureSchema['kind']
  >(schema, 'kind');
  if (kind === 'discriminated') {
    const source = guardedPullRequestRecord(value);
    const field = pullRequestCaptureSchemaProperty(schema, 'field');
    if (typeof field !== 'string') failPullRequestCapture();
    const variants = asPullRequestCaptureSchemaRecord(
      pullRequestCaptureSchemaProperty(schema, 'variants')
    );
    const fallback = asPullRequestCaptureSchema(
      pullRequestCaptureSchemaProperty(schema, 'fallback')
    );
    const discriminator = ownPullRequestDataValue(source, field);
    const selected =
      discriminator !== missingPullRequestOwnData &&
      typeof discriminator === 'string'
        ? ownPullRequestDataValue(variants, discriminator)
        : missingPullRequestOwnData;
    return capturePullRequestNode(
      value,
      selected === missingPullRequestOwnData
        ? fallback
        : asPullRequestCaptureSchema(selected),
      state,
      depth
    );
  }

  accountPullRequestCapture(state, value, depth);
  switch (kind) {
    case 'scalar':
      if (
        value === null ||
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean'
      ) {
        return value;
      }
      return failPullRequestCapture();
    case 'reject':
      return failPullRequestCapture();
    case 'boolean':
      return typeof value === 'boolean' ? value : failPullRequestCapture();
    case 'array':
      return capturePullRequestArray(value, schema, state, depth);
    case 'record':
    case 'dictionary':
      return capturePullRequestRecord(value, schema, state, depth);
  }
}

/**
 * Total host-owned structural capture for every public PR success value. It
 * never uses ordinary property reads, iteration, coercion, or source methods.
 * Aliases are copied per occurrence; active cycles are rejected.
 */
function capturePullRequestPublicStructure(
  value: unknown,
  schemaName: PullRequestCaptureSchemaName
): PullRequestCaptureResult {
  try {
    const schema = ownPullRequestDataValue(
      pullRequestCaptureSchemas,
      schemaName
    );
    if (schema === missingPullRequestOwnData) failPullRequestCapture();
    return {
      ok: true,
      value: capturePullRequestNode(
        value,
        asPullRequestCaptureSchema(schema),
        { active: new WeakSet<object>(), nodes: 0, stringUnits: 0 },
        0
      ),
    };
  } catch {
    return { ok: false };
  }
}

function guardPullRequestOperationValidation<
  A,
  TOperation extends PullRequestProviderOperationName,
>(
  validation: Effect.Effect<
    A,
    InvalidPullRequestProviderOperationResultError<TOperation>
  >,
  invalid: () => InvalidPullRequestProviderOperationResultError<TOperation>
): Effect.Effect<
  A,
  InvalidPullRequestProviderOperationResultError<TOperation>
> {
  // Validation runs only on a detached host snapshot. Map its Fail leaves to
  // the one admitted host error type while retaining every Sequential,
  // Parallel, Die and Interrupt node exactly.
  return Effect.mapErrorCause(validation, (cause) =>
    Cause.map(cause, (failure) =>
      failure instanceof InvalidPullRequestProviderOperationResultError
        ? failure
        : invalid()
    )
  );
}

function retainPullRequestProviderCandidateEntry<
  TMatch extends AidePullRequestProviderMatch,
>(
  candidate: ResolvedPullRequestProviderCandidate<TMatch>,
  entry: PluginCapability<AidePullRequestProviderCapability>
): ResolvedPullRequestProviderCandidate<TMatch> {
  pullRequestProviderCandidateEntries.set(candidate, entry);
  return candidate;
}

function candidateSummary<TMatch extends AidePullRequestProviderMatch>(
  resolved: ResolvedPullRequestProvider<TMatch>
): PullRequestProviderCandidate {
  return {
    pluginId: resolved.pluginId,
    providerId: resolved.providerId,
    priority: resolved.priority,
  };
}

function repositoryRefValue(repository: AidePullRequestRepositoryRef): string {
  let value: string;
  switch (repository.kind) {
    case 'github':
      value = `${repository.host}/${repository.owner}/${repository.repo}`;
      break;
    case 'azure-devops':
      value = `${repository.org}/${repository.project}/${repository.repo}`;
      break;
    case 'external':
      value = repository.displayName;
      break;
  }
  return describePullRequestProviderLookup('repository-ref', value);
}

function repositoryInputValue(input: AidePullRequestRepositoryInput): string {
  return describePullRequestProviderLookup(
    'repository-ref',
    [
      input.providerId === undefined
        ? undefined
        : `provider=${input.providerId}`,
      input.host === undefined ? undefined : `host=${input.host}`,
      input.owner === undefined ? undefined : `owner=${input.owner}`,
      input.org === undefined ? undefined : `org=${input.org}`,
      input.project === undefined ? undefined : `project=${input.project}`,
      input.repo === undefined ? undefined : `repo=${input.repo}`,
    ]
      .filter((part): part is string => part !== undefined)
      .join(' ')
  );
}

function repositoryRefProviderId(
  repository: AidePullRequestRepositoryRef
): string {
  switch (repository.kind) {
    case 'github':
      return 'github';
    case 'azure-devops':
      return 'azure-devops';
    case 'external':
      return repository.providerId;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

const invalidPullRequestArrayShape = Symbol('invalidPullRequestArrayShape');
const invalidPullRequestArrayEntry = Symbol('invalidPullRequestArrayEntry');

function snapshotOwnDenseArray<T>(
  value: unknown,
  snapshotEntry: (entry: unknown, index: number) => T | null
):
  | readonly T[]
  | typeof invalidPullRequestArrayShape
  | typeof invalidPullRequestArrayEntry {
  if (
    typeof value !== 'object' ||
    value === null ||
    isNodeProxy(value) ||
    !arrayIsArray(value) ||
    reflectGetPrototypeOf(value) !== Array.prototype
  ) {
    return invalidPullRequestArrayShape;
  }

  const source = value as object;
  const length = ownPullRequestDataValue(source, 'length');
  if (
    length === missingPullRequestOwnData ||
    typeof length !== 'number' ||
    !Number.isSafeInteger(length) ||
    length < 0
  ) {
    return invalidPullRequestArrayShape;
  }
  const keys = reflectOwnKeys(source);
  const keyCount = hostArrayLength(keys);
  if (keyCount === undefined || keyCount !== length + 1) {
    return invalidPullRequestArrayShape;
  }

  const snapshot: T[] = [];
  for (let index = 0; index < length; index += 1) {
    const entry = ownPullRequestDataValue(source, String(index));
    if (entry === missingPullRequestOwnData) {
      return invalidPullRequestArrayShape;
    }
    const captured = snapshotEntry(entry, index);
    if (captured === null) return invalidPullRequestArrayEntry;
    definePullRequestArrayEntry(snapshot, index, captured);
  }
  return objectFreeze(snapshot);
}

function snapshotStringArray(value: unknown): readonly string[] | null {
  const snapshot = snapshotOwnDenseArray(value, (entry) =>
    typeof entry === 'string' ? entry : null
  );
  return snapshot === invalidPullRequestArrayShape ||
    snapshot === invalidPullRequestArrayEntry
    ? null
    : snapshot;
}

function snapshotRequiredStringArray(
  value: readonly string[]
): readonly string[] {
  const snapshot = snapshotStringArray(value);
  if (snapshot === null) throw new TypeError('Invalid host string array');
  return snapshot;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isValidDateString(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function hasOwn(
  value: Readonly<Record<string, unknown>>,
  property: string
): boolean {
  return objectHasOwn(value, property);
}

function optionalNonEmptyString(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  return isNonEmptyString(value) ? value : null;
}

function snapshotRepositoryInput(
  value: unknown
): AidePullRequestRepositoryInput | null {
  if (!isRecord(value)) return null;

  const providerId = optionalNonEmptyString(value.providerId);
  const host = optionalNonEmptyString(value.host);
  const owner = optionalNonEmptyString(value.owner);
  const org = optionalNonEmptyString(value.org);
  const project = optionalNonEmptyString(value.project);
  const repo = optionalNonEmptyString(value.repo);
  if (
    providerId === null ||
    host === null ||
    owner === null ||
    org === null ||
    project === null ||
    repo === null
  ) {
    return null;
  }

  const snapshot = {
    ...(providerId === undefined ? {} : { providerId }),
    ...(host === undefined ? {} : { host }),
    ...(owner === undefined ? {} : { owner }),
    ...(org === undefined ? {} : { org }),
    ...(project === undefined ? {} : { project }),
    ...(repo === undefined ? {} : { repo }),
  };

  return providerId === undefined &&
    host === undefined &&
    owner === undefined &&
    org === undefined &&
    project === undefined &&
    repo === undefined
    ? null
    : objectFreeze(snapshot);
}

function snapshotRepositoryMetadata(
  value: unknown
): Readonly<Record<string, string | number | boolean>> | undefined | null {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;

  const snapshot = objectCreate(null) as Record<
    string,
    string | number | boolean
  >;
  const keys = reflectOwnKeys(value);
  const keyCount = hostArrayLength(keys);
  if (keyCount === undefined) return null;
  for (let keyIndex = 0; keyIndex < keyCount; keyIndex += 1) {
    const key = hostArrayDataValue<PropertyKey>(keys, keyIndex);
    if (typeof key !== 'string') return null;
    const entry = ownPullRequestDataValue(value, key);
    if (entry === missingPullRequestOwnData) return null;
    if (
      typeof entry !== 'string' &&
      typeof entry !== 'boolean' &&
      !isFiniteNumber(entry)
    ) {
      return null;
    }
    objectDefineProperty(snapshot, key, {
      configurable: false,
      enumerable: true,
      writable: false,
      value: entry,
    });
  }

  return objectFreeze(snapshot);
}

function snapshotRepositoryRef(
  value: unknown
): AidePullRequestRepositoryRef | null {
  if (!isRecord(value)) return null;

  switch (value.kind) {
    case 'github':
      if (
        !isNonEmptyString(value.host) ||
        !isNonEmptyString(value.owner) ||
        !isNonEmptyString(value.repo)
      ) {
        return null;
      }
      return frozenHostRecord({
        kind: 'github' as const,
        host: value.host,
        owner: value.owner,
        repo: value.repo,
      });
    case 'azure-devops':
      if (
        !isNonEmptyString(value.org) ||
        !isNonEmptyString(value.project) ||
        !isNonEmptyString(value.repo)
      ) {
        return null;
      }
      return frozenHostRecord({
        kind: 'azure-devops' as const,
        org: value.org,
        project: value.project,
        repo: value.repo,
      });
    case 'external': {
      const metadata = snapshotRepositoryMetadata(value.metadata);
      if (
        !isNonEmptyString(value.providerId) ||
        !isNonEmptyString(value.displayName) ||
        metadata === null
      ) {
        return null;
      }
      return frozenHostRecord({
        kind: 'external' as const,
        providerId: value.providerId,
        displayName: value.displayName,
        ...(metadata === undefined ? {} : { metadata }),
      });
    }
    default:
      return null;
  }
}

function repositoryRefsMatch(
  actual: AidePullRequestRepositoryRef,
  expected: AidePullRequestRepositoryRef
): boolean {
  switch (actual.kind) {
    case 'github':
      if (expected.kind !== 'github') return false;
      return (
        actual.host === expected.host &&
        actual.owner === expected.owner &&
        actual.repo === expected.repo
      );
    case 'azure-devops':
      if (expected.kind !== 'azure-devops') return false;
      return (
        actual.org === expected.org &&
        actual.project === expected.project &&
        actual.repo === expected.repo
      );
    case 'external':
      if (expected.kind !== 'external') return false;
      return (
        actual.providerId === expected.providerId &&
        actual.displayName === expected.displayName &&
        repositoryMetadataMatches(actual.metadata, expected.metadata)
      );
  }
}

function repositoryMetadataMatches(
  actual: Extract<
    AidePullRequestRepositoryRef,
    { kind: 'external' }
  >['metadata'],
  expected: Extract<
    AidePullRequestRepositoryRef,
    { kind: 'external' }
  >['metadata']
): boolean {
  const actualRecord = actual ?? objectCreate(null);
  const expectedRecord = expected ?? objectCreate(null);
  const actualKeys = reflectOwnKeys(actualRecord);
  const expectedKeys = reflectOwnKeys(expectedRecord);
  const actualKeyCount = hostArrayLength(actualKeys);
  const expectedKeyCount = hostArrayLength(expectedKeys);
  if (
    actualKeyCount === undefined ||
    expectedKeyCount === undefined ||
    actualKeyCount !== expectedKeyCount
  ) {
    return false;
  }

  for (let index = 0; index < actualKeyCount; index += 1) {
    const key = ownPullRequestDataValue(actualKeys, String(index));
    if (key === missingPullRequestOwnData || typeof key !== 'string') {
      return false;
    }
    const actualValue = ownPullRequestDataValue(actualRecord, key);
    const expectedValue = ownPullRequestDataValue(expectedRecord, key);
    if (
      actualValue === missingPullRequestOwnData ||
      expectedValue === missingPullRequestOwnData ||
      actualValue !== expectedValue
    ) {
      return false;
    }
  }
  return true;
}

function snapshotPullRequestRef(value: unknown): AidePullRequestRef | null {
  if (
    !isRecord(value) ||
    typeof value.number !== 'number' ||
    !Number.isSafeInteger(value.number) ||
    value.number <= 0
  ) {
    return null;
  }

  return frozenHostRecord({ number: value.number });
}

function snapshotPullRequestAuthor(
  value: unknown
): AidePullRequestListItem['author'] | null {
  if (!isRecord(value) || !isNonEmptyString(value.displayName)) {
    return null;
  }

  const username = value.username;
  const email = value.email;
  if (username !== undefined && typeof username !== 'string') {
    return null;
  }
  if (email !== undefined && typeof email !== 'string') {
    return null;
  }

  return Object.freeze({
    displayName: value.displayName,
    ...(username === undefined ? {} : { username }),
    ...(email === undefined ? {} : { email }),
  });
}

function isPullRequestListItemStatus(
  value: unknown
): value is AidePullRequestListItemStatus {
  return (
    value === 'active' ||
    value === 'completed' ||
    value === 'abandoned' ||
    value === 'draft'
  );
}

function snapshotPullRequestListItem(
  value: unknown
): AidePullRequestListItem | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'number' ||
    !Number.isSafeInteger(value.id) ||
    value.id <= 0 ||
    !isNonEmptyString(value.title) ||
    !isPullRequestListItemStatus(value.status) ||
    !isNonEmptyString(value.createdAt) ||
    !isValidDateString(value.createdAt)
  ) {
    return null;
  }

  const author = snapshotPullRequestAuthor(value.author);
  if (author === null) {
    return null;
  }

  const description = value.description;
  const url = value.url;
  const draft = value.draft;
  if (description !== undefined && typeof description !== 'string') {
    return null;
  }
  if (url !== undefined && typeof url !== 'string') {
    return null;
  }
  if (draft !== undefined && typeof draft !== 'boolean') {
    return null;
  }

  return Object.freeze({
    id: value.id,
    title: value.title,
    status: value.status,
    createdAt: value.createdAt,
    author,
    ...(description === undefined ? {} : { description }),
    ...(url === undefined ? {} : { url }),
    ...(draft === undefined ? {} : { draft }),
  });
}

function snapshotPullRequestViewItem(
  value: unknown
): AidePullRequestViewItem | null {
  const base = snapshotPullRequestListItem(value);
  if (base === null || !isRecord(value)) {
    return null;
  }

  const sourceBranch = value.sourceBranch;
  const targetBranch = value.targetBranch;
  const labels = value.labels;
  const labelSnapshots =
    labels === undefined ? undefined : snapshotStringArray(labels);

  if (sourceBranch !== undefined && typeof sourceBranch !== 'string') {
    return null;
  }
  if (targetBranch !== undefined && typeof targetBranch !== 'string') {
    return null;
  }
  if (labelSnapshots === null) {
    return null;
  }

  return Object.freeze({
    ...base,
    ...(sourceBranch === undefined ? {} : { sourceBranch }),
    ...(targetBranch === undefined ? {} : { targetBranch }),
    ...(labelSnapshots === undefined ? {} : { labels: labelSnapshots }),
  });
}

function isPullRequestDiffFileStatus(
  value: unknown
): value is AidePullRequestDiffFileStatus {
  return (
    value === 'added' ||
    value === 'modified' ||
    value === 'deleted' ||
    value === 'renamed' ||
    value === 'copied' ||
    value === 'unchanged' ||
    value === 'unknown'
  );
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function snapshotPullRequestDiffFile(
  value: unknown
): AidePullRequestDiffFile | null {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.path) ||
    !isPullRequestDiffFileStatus(value.status)
  ) {
    return null;
  }

  const providerStatus = value.providerStatus;
  const previousPath = value.previousPath;
  const additions = value.additions;
  const deletions = value.deletions;
  const changes = value.changes;
  const patch = value.patch;

  if (providerStatus !== undefined && typeof providerStatus !== 'string') {
    return null;
  }
  if (previousPath !== undefined && typeof previousPath !== 'string') {
    return null;
  }
  if (additions !== undefined && !isNonNegativeSafeInteger(additions)) {
    return null;
  }
  if (deletions !== undefined && !isNonNegativeSafeInteger(deletions)) {
    return null;
  }
  if (changes !== undefined && !isNonNegativeSafeInteger(changes)) {
    return null;
  }
  if (patch !== undefined && typeof patch !== 'string') {
    return null;
  }

  return Object.freeze({
    path: value.path,
    status: value.status,
    ...(providerStatus === undefined ? {} : { providerStatus }),
    ...(previousPath === undefined ? {} : { previousPath }),
    ...(additions === undefined ? {} : { additions }),
    ...(deletions === undefined ? {} : { deletions }),
    ...(changes === undefined ? {} : { changes }),
    ...(patch === undefined ? {} : { patch }),
  });
}

function isPullRequestCommentKind(
  value: unknown
): value is AidePullRequestCommentKind {
  return (
    value === 'issue' ||
    value === 'review' ||
    value === 'reply' ||
    value === 'system' ||
    value === 'unknown'
  );
}

function snapshotPullRequestCommentAuthor(
  value: unknown
): AidePullRequestCommentAuthor | null {
  if (!isRecord(value) || !isNonEmptyString(value.displayName)) {
    return null;
  }

  const username = value.username;
  const email = value.email;
  if (username !== undefined && typeof username !== 'string') {
    return null;
  }
  if (email !== undefined && typeof email !== 'string') {
    return null;
  }

  return Object.freeze({
    displayName: value.displayName,
    ...(username === undefined ? {} : { username }),
    ...(email === undefined ? {} : { email }),
  });
}

function snapshotPullRequestComment(
  value: unknown
): AidePullRequestComment | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'number' ||
    !Number.isSafeInteger(value.id) ||
    value.id <= 0 ||
    !isPullRequestCommentKind(value.kind) ||
    typeof value.body !== 'string' ||
    !isNonEmptyString(value.createdAt) ||
    !isValidDateString(value.createdAt)
  ) {
    return null;
  }

  const author = snapshotPullRequestCommentAuthor(value.author);
  if (author === null) {
    return null;
  }

  const updatedAt = value.updatedAt;
  const url = value.url;
  const filePath = value.filePath;
  const lineNumber = value.lineNumber;
  const parentId = value.parentId;
  const providerType = value.providerType;
  if (
    updatedAt !== undefined &&
    (typeof updatedAt !== 'string' || !isValidDateString(updatedAt))
  ) {
    return null;
  }
  if (url !== undefined && typeof url !== 'string') {
    return null;
  }
  if (filePath !== undefined && typeof filePath !== 'string') {
    return null;
  }
  if (lineNumber !== undefined && !isNonNegativeSafeInteger(lineNumber)) {
    return null;
  }
  if (
    parentId !== undefined &&
    (typeof parentId !== 'number' ||
      !Number.isSafeInteger(parentId) ||
      parentId <= 0)
  ) {
    return null;
  }
  if (providerType !== undefined && typeof providerType !== 'string') {
    return null;
  }

  return Object.freeze({
    id: value.id,
    kind: value.kind,
    author,
    body: value.body,
    createdAt: value.createdAt,
    ...(updatedAt === undefined ? {} : { updatedAt }),
    ...(url === undefined ? {} : { url }),
    ...(filePath === undefined ? {} : { filePath }),
    ...(lineNumber === undefined ? {} : { lineNumber }),
    ...(parentId === undefined ? {} : { parentId }),
    ...(providerType === undefined ? {} : { providerType }),
  });
}

function snapshotPullRequestCommentThread(
  value: unknown
): AidePullRequestCommentThread | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = value.id;
  if (
    !(
      (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) ||
      isNonEmptyString(id)
    )
  ) {
    return null;
  }

  const status = value.status;
  const filePath = value.filePath;
  const lineNumber = value.lineNumber;
  const rootComment = value.rootComment;
  if (status !== undefined && typeof status !== 'string') {
    return null;
  }
  if (filePath !== undefined && typeof filePath !== 'string') {
    return null;
  }
  if (lineNumber !== undefined && !isNonNegativeSafeInteger(lineNumber)) {
    return null;
  }

  const root =
    rootComment === undefined
      ? undefined
      : snapshotPullRequestComment(rootComment);
  if (root === null) {
    return null;
  }
  const replies = snapshotOwnDenseArray(
    value.replies,
    snapshotPullRequestComment
  );
  if (
    replies === invalidPullRequestArrayShape ||
    replies === invalidPullRequestArrayEntry
  ) {
    return null;
  }

  if (root === undefined && replies.length === 0) {
    return null;
  }

  return Object.freeze({
    id,
    ...(status === undefined ? {} : { status }),
    ...(filePath === undefined ? {} : { filePath }),
    ...(lineNumber === undefined ? {} : { lineNumber }),
    ...(root === undefined ? {} : { rootComment: root }),
    replies,
  });
}

function snapshotPullRequestCommentPosition(
  value: AidePullRequestCommentPosition
): AidePullRequestCommentPosition {
  return Object.freeze({
    filePath: value.filePath,
    lineNumber: value.lineNumber,
    ...(value.endLineNumber === undefined
      ? {}
      : { endLineNumber: value.endLineNumber }),
  });
}

function validatePullRequestListResult(
  provider: ResolvedPullRequestProviderCandidate<
    AidePullRequestRemoteMatch | AidePullRequestRepositoryMatch
  >,
  result: unknown
): Effect.Effect<
  AidePullRequestListResult,
  InvalidPullRequestProviderOperationResultError<'listPullRequests'>
> {
  const invalid = (reason: string) =>
    Effect.fail(
      hostInvalidPullRequestProviderOperationResultError({
        pluginId: provider.pluginId,
        providerId: provider.providerId,
        operation: 'listPullRequests',
        reason,
      })
    );

  if (!isRecord(result)) {
    return invalid('result must be an object');
  }

  const repository = snapshotRepositoryRef(result.repository);
  if (repository === null) {
    return invalid('invalid repository ref');
  }
  if (!repositoryRefsMatch(repository, provider.match.repository)) {
    return invalid('repository ref does not match selected provider match');
  }
  const repositoryLabel = result.repositoryLabel;
  if (repositoryLabel !== undefined && typeof repositoryLabel !== 'string') {
    return invalid('repositoryLabel must be a string');
  }

  const pullRequests = snapshotOwnDenseArray(
    result.pullRequests,
    snapshotPullRequestListItem
  );
  if (pullRequests === invalidPullRequestArrayShape) {
    return invalid('invalid pull request item array');
  }
  if (pullRequests === invalidPullRequestArrayEntry) {
    return invalid('invalid pull request item');
  }

  return Effect.succeed(
    Object.freeze({
      repository,
      ...(repositoryLabel === undefined ? {} : { repositoryLabel }),
      pullRequests,
    })
  );
}

function validatePullRequestViewResult(
  provider: ResolvedPullRequestProviderCandidate,
  request: Pick<AidePullRequestViewRequest, 'pullRequest'>,
  result: unknown
): Effect.Effect<
  AidePullRequestViewResult,
  InvalidPullRequestProviderOperationResultError<'getPullRequest'>
> {
  const invalid = (reason: string) =>
    Effect.fail(
      hostInvalidPullRequestProviderOperationResultError({
        pluginId: provider.pluginId,
        providerId: provider.providerId,
        operation: 'getPullRequest',
        reason,
      })
    );

  if (!isRecord(result)) {
    return invalid('result must be an object');
  }

  const repository = snapshotRepositoryRef(result.repository);
  if (repository === null) {
    return invalid('invalid repository ref');
  }
  if (!repositoryRefsMatch(repository, provider.match.repository)) {
    return invalid('repository ref does not match selected provider match');
  }

  const repositoryLabel = result.repositoryLabel;
  if (repositoryLabel !== undefined && typeof repositoryLabel !== 'string') {
    return invalid('repositoryLabel must be a string');
  }

  const pullRequest = snapshotPullRequestViewItem(result.pullRequest);
  if (pullRequest === null) {
    return invalid('invalid pull request item');
  }
  if (pullRequest.id !== request.pullRequest.number) {
    return invalid('pull request id does not match selected pull request');
  }

  return Effect.succeed(
    Object.freeze({
      repository,
      ...(repositoryLabel === undefined ? {} : { repositoryLabel }),
      pullRequest,
    })
  );
}

function validatePullRequestCreateResult(
  provider: ResolvedPullRequestProviderCandidate<
    AidePullRequestRemoteMatch | AidePullRequestRepositoryMatch
  >,
  result: unknown
): Effect.Effect<
  AidePullRequestCreateResult,
  InvalidPullRequestProviderOperationResultError<'createPullRequest'>
> {
  const invalid = (reason: string) =>
    Effect.fail(
      hostInvalidPullRequestProviderOperationResultError({
        pluginId: provider.pluginId,
        providerId: provider.providerId,
        operation: 'createPullRequest',
        reason,
      })
    );

  if (!isRecord(result)) {
    return invalid('result must be an object');
  }

  const repository = snapshotRepositoryRef(result.repository);
  if (repository === null) {
    return invalid('invalid repository ref');
  }
  if (!repositoryRefsMatch(repository, provider.match.repository)) {
    return invalid('repository ref does not match selected provider match');
  }

  const repositoryLabel = result.repositoryLabel;
  if (repositoryLabel !== undefined && typeof repositoryLabel !== 'string') {
    return invalid('repositoryLabel must be a string');
  }

  const pullRequest = snapshotPullRequestViewItem(result.pullRequest);
  if (pullRequest === null) {
    return invalid('invalid pull request item');
  }

  const warnings = result.warnings;
  const warningSnapshots =
    warnings === undefined ? undefined : snapshotStringArray(warnings);
  if (warningSnapshots === null) {
    return invalid('warnings must be an array of strings');
  }

  return Effect.succeed(
    Object.freeze({
      repository,
      ...(repositoryLabel === undefined ? {} : { repositoryLabel }),
      pullRequest,
      ...(warningSnapshots === undefined ? {} : { warnings: warningSnapshots }),
    })
  );
}

function validatePullRequestUpdateResult(
  provider: ResolvedPullRequestProviderCandidate,
  request: Pick<AidePullRequestUpdateRequest, 'pullRequest'>,
  result: unknown
): Effect.Effect<
  AidePullRequestUpdateResult,
  InvalidPullRequestProviderOperationResultError<'updatePullRequest'>
> {
  const invalid = (reason: string) =>
    Effect.fail(
      hostInvalidPullRequestProviderOperationResultError({
        pluginId: provider.pluginId,
        providerId: provider.providerId,
        operation: 'updatePullRequest',
        reason,
      })
    );

  return validatePullRequestViewResult(provider, request, result).pipe(
    Effect.flatMap((viewResult) => {
      if (!isRecord(result)) {
        return invalid('result must be an object');
      }

      const warnings = result.warnings;
      const warningSnapshots =
        warnings === undefined ? undefined : snapshotStringArray(warnings);
      if (warningSnapshots === null) {
        return invalid('warnings must be an array of strings');
      }

      return Effect.succeed(
        Object.freeze({
          ...viewResult,
          ...(warningSnapshots === undefined
            ? {}
            : { warnings: warningSnapshots }),
        })
      );
    }),
    Effect.mapErrorCause((cause) =>
      Cause.map(cause, (error) =>
        hostInvalidPullRequestProviderOperationResultError({
          pluginId: error.pluginId,
          providerId: error.providerId,
          operation: 'updatePullRequest',
          reason: error.reason,
        })
      )
    )
  );
}

function validatePullRequestDiffResult(
  provider: ResolvedPullRequestProviderCandidate,
  request: Pick<AidePullRequestDiffRequest, 'pullRequest'>,
  result: unknown
): Effect.Effect<
  AidePullRequestDiffResult,
  InvalidPullRequestProviderOperationResultError<'getPullRequestDiff'>
> {
  const invalid = (reason: string) =>
    Effect.fail(
      hostInvalidPullRequestProviderOperationResultError({
        pluginId: provider.pluginId,
        providerId: provider.providerId,
        operation: 'getPullRequestDiff',
        reason,
      })
    );

  if (!isRecord(result)) {
    return invalid('result must be an object');
  }

  const repository = snapshotRepositoryRef(result.repository);
  if (repository === null) {
    return invalid('invalid repository ref');
  }
  if (!repositoryRefsMatch(repository, provider.match.repository)) {
    return invalid('repository ref does not match selected provider match');
  }

  const repositoryLabel = result.repositoryLabel;
  if (repositoryLabel !== undefined && typeof repositoryLabel !== 'string') {
    return invalid('repositoryLabel must be a string');
  }

  const pullRequest = snapshotPullRequestViewItem(result.pullRequest);
  if (pullRequest === null) {
    return invalid('invalid pull request item');
  }
  if (pullRequest.id !== request.pullRequest.number) {
    return invalid('pull request id does not match selected pull request');
  }

  const files = snapshotOwnDenseArray(
    result.files,
    snapshotPullRequestDiffFile
  );
  if (files === invalidPullRequestArrayShape) {
    return invalid('invalid diff file array');
  }
  if (files === invalidPullRequestArrayEntry) {
    return invalid('invalid diff file');
  }

  return Effect.succeed(
    Object.freeze({
      repository,
      ...(repositoryLabel === undefined ? {} : { repositoryLabel }),
      pullRequest,
      files,
    })
  );
}

function validatePullRequestCommentsResult(
  provider: ResolvedPullRequestProviderCandidate,
  request: Pick<AidePullRequestCommentsRequest, 'pullRequest'>,
  result: unknown
): Effect.Effect<
  AidePullRequestCommentsResult,
  InvalidPullRequestProviderOperationResultError<'listPullRequestComments'>
> {
  const invalid = (reason: string) =>
    Effect.fail(
      hostInvalidPullRequestProviderOperationResultError({
        pluginId: provider.pluginId,
        providerId: provider.providerId,
        operation: 'listPullRequestComments',
        reason,
      })
    );

  if (!isRecord(result)) {
    return invalid('result must be an object');
  }

  const repository = snapshotRepositoryRef(result.repository);
  if (repository === null) {
    return invalid('invalid repository ref');
  }
  if (!repositoryRefsMatch(repository, provider.match.repository)) {
    return invalid('repository ref does not match selected provider match');
  }

  const repositoryLabel = result.repositoryLabel;
  if (repositoryLabel !== undefined && typeof repositoryLabel !== 'string') {
    return invalid('repositoryLabel must be a string');
  }

  const pullRequest = snapshotPullRequestRef(result.pullRequest);
  if (pullRequest === null) {
    return invalid('invalid pull request ref');
  }
  if (pullRequest.number !== request.pullRequest.number) {
    return invalid('pull request id does not match selected pull request');
  }

  const threads = snapshotOwnDenseArray(
    result.threads,
    snapshotPullRequestCommentThread
  );
  if (threads === invalidPullRequestArrayShape) {
    return invalid('invalid comment thread array');
  }
  if (threads === invalidPullRequestArrayEntry) {
    return invalid('invalid comment thread');
  }

  return Effect.succeed(
    Object.freeze({
      repository,
      ...(repositoryLabel === undefined ? {} : { repositoryLabel }),
      pullRequest,
      threads,
    })
  );
}

function validatePullRequestCommentMutationResult<
  TOperation extends 'addPullRequestComment' | 'replyToPullRequestComment',
>(
  provider: ResolvedPullRequestProviderCandidate,
  operation: TOperation,
  request: Pick<AidePullRequestAddCommentRequest, 'pullRequest'> &
    Partial<Pick<AidePullRequestReplyCommentRequest, 'threadId'>>,
  result: unknown
): Effect.Effect<
  AidePullRequestCommentMutationResult,
  InvalidPullRequestProviderOperationResultError<TOperation>
> {
  const invalid = (reason: string) =>
    Effect.fail(
      hostInvalidPullRequestProviderOperationResultError({
        pluginId: provider.pluginId,
        providerId: provider.providerId,
        operation,
        reason,
      })
    );

  if (!isRecord(result)) {
    return invalid('result must be an object');
  }

  const repository = snapshotRepositoryRef(result.repository);
  if (repository === null) {
    return invalid('invalid repository ref');
  }
  if (!repositoryRefsMatch(repository, provider.match.repository)) {
    return invalid('repository ref does not match selected provider match');
  }

  const repositoryLabel = result.repositoryLabel;
  if (repositoryLabel !== undefined && typeof repositoryLabel !== 'string') {
    return invalid('repositoryLabel must be a string');
  }

  const pullRequest = snapshotPullRequestRef(result.pullRequest);
  if (pullRequest === null) {
    return invalid('invalid pull request ref');
  }
  if (pullRequest.number !== request.pullRequest.number) {
    return invalid('pull request id does not match selected pull request');
  }

  const comment = snapshotPullRequestComment(result.comment);
  if (comment === null) {
    return invalid('invalid comment');
  }

  const thread =
    result.thread === undefined
      ? undefined
      : snapshotPullRequestCommentThread(result.thread);
  if (thread === null) {
    return invalid('invalid comment thread');
  }
  if (
    operation === 'replyToPullRequestComment' &&
    thread !== undefined &&
    thread.id !== request.threadId
  ) {
    return invalid('thread id does not match selected thread');
  }

  return Effect.succeed(
    Object.freeze({
      repository,
      ...(repositoryLabel === undefined ? {} : { repositoryLabel }),
      pullRequest,
      comment,
      ...(thread === undefined ? {} : { thread }),
    })
  );
}

function validatePullRequestBranchLookupResult(
  provider: ResolvedPullRequestProviderCandidate<
    AidePullRequestRemoteMatch | AidePullRequestRepositoryMatch
  >,
  request: Pick<AidePullRequestBranchLookupRequest, 'branch'>,
  result: unknown
): Effect.Effect<
  AidePullRequestBranchLookupResult,
  InvalidPullRequestProviderOperationResultError<'findPullRequestForBranch'>
> {
  const invalid = (reason: string) =>
    Effect.fail(
      hostInvalidPullRequestProviderOperationResultError({
        pluginId: provider.pluginId,
        providerId: provider.providerId,
        operation: 'findPullRequestForBranch',
        reason,
      })
    );

  if (!isRecord(result)) {
    return invalid('result must be an object');
  }
  if (result.branch !== request.branch) {
    return invalid('branch does not match requested branch');
  }

  const repository = snapshotRepositoryRef(result.repository);
  if (repository === null) {
    return invalid('invalid repository ref');
  }
  if (!repositoryRefsMatch(repository, provider.match.repository)) {
    return invalid('repository ref does not match selected provider match');
  }

  const repositoryLabel = result.repositoryLabel;
  if (repositoryLabel !== undefined && typeof repositoryLabel !== 'string') {
    return invalid('repositoryLabel must be a string');
  }

  const pullRequest = snapshotPullRequestViewItem(result.pullRequest);
  if (pullRequest === null) {
    return invalid('invalid pull request item');
  }
  if (pullRequest.sourceBranch !== request.branch) {
    return invalid(
      'pull request source branch does not match requested branch'
    );
  }

  return Effect.succeed(
    Object.freeze({
      branch: request.branch,
      repository,
      ...(repositoryLabel === undefined ? {} : { repositoryLabel }),
      pullRequest,
    })
  );
}

function validationException(
  pluginId: string,
  capability: AidePullRequestProviderCapability,
  source: PullRequestProviderLookupSource,
  value: string
): InvalidPullRequestProviderMatchError {
  return hostInvalidPullRequestProviderMatchError({
    source,
    value,
    pluginId,
    providerId: capability.providerId,
    reason: 'match result failed structural capture',
  });
}

function validateProviderMatchSafely<
  TMatch extends AidePullRequestProviderMatch,
>(
  pluginId: string,
  capability: AidePullRequestProviderCapability,
  source: PullRequestProviderLookupSource,
  value: string,
  match: unknown
): Effect.Effect<TMatch, InvalidPullRequestProviderMatchError> {
  const captured = capturePullRequestPublicStructure(match, 'match');
  if (!captured.ok) {
    return Effect.fail(
      validationException(pluginId, capability, source, value)
    );
  }
  match = captured.value;

  return Effect.try({
    try: () =>
      validateProviderMatch<TMatch>(pluginId, capability, source, value, match),
    catch: () => validationException(pluginId, capability, source, value),
  }).pipe(Effect.flatMap((validation) => validation));
}

function validateProviderPrioritySafely(
  pluginId: string,
  capability: AidePullRequestProviderCapability,
  source: PullRequestProviderLookupSource,
  value: string,
  match: AidePullRequestProviderMatch
): Effect.Effect<number, InvalidPullRequestProviderMatchError> {
  return Effect.try({
    try: () =>
      validateProviderPriority(pluginId, capability, source, value, match),
    catch: () => validationException(pluginId, capability, source, value),
  }).pipe(Effect.flatMap((validation) => validation));
}

function captureProviderFeaturesSafely(
  pluginId: string,
  capability: AidePullRequestProviderCapability,
  source: PullRequestProviderLookupSource,
  value: string
): Effect.Effect<
  AidePullRequestProviderFeatures,
  InvalidPullRequestProviderMatchError
> {
  if (isNodeProxy(capability)) {
    return Effect.fail(
      validationException(pluginId, capability, source, value)
    );
  }
  const descriptor = Reflect.getOwnPropertyDescriptor(capability, 'features');
  if (descriptor === undefined || !objectHasOwn(descriptor, 'value')) {
    return Effect.fail(
      validationException(pluginId, capability, source, value)
    );
  }
  const captured = capturePullRequestPublicStructure(
    descriptor.value,
    'features'
  );
  return captured.ok
    ? Effect.succeed(captured.value as AidePullRequestProviderFeatures)
    : Effect.fail(validationException(pluginId, capability, source, value));
}

function validateProviderMatch<TMatch extends AidePullRequestProviderMatch>(
  pluginId: string,
  capability: AidePullRequestProviderCapability,
  source: PullRequestProviderLookupSource,
  value: string,
  match: unknown
): Effect.Effect<TMatch, InvalidPullRequestProviderMatchError> {
  const invalid = (reason: string) =>
    Effect.fail(
      hostInvalidPullRequestProviderMatchError({
        source,
        value,
        pluginId,
        providerId: capability.providerId,
        reason,
      })
    );

  if (!isRecord(match)) {
    return invalid('match must be an object or null');
  }

  const candidate = match;
  const candidateSource = candidate.source;
  if (candidateSource !== source) {
    return invalid(`expected source '${source}'`);
  }

  if (!hasOwn(candidate, 'repository')) {
    return invalid('missing repository ref');
  }

  const repository = snapshotRepositoryRef(candidate.repository);
  if (repository === null) {
    return invalid('invalid repository ref');
  }

  if (
    repository.kind === 'external' &&
    repository.providerId !== capability.providerId
  ) {
    return invalid('external repository providerId must match provider id');
  }

  const hasPriority = hasOwn(candidate, 'priority');
  const priority = hasPriority ? candidate.priority : undefined;
  const hasDetail = hasOwn(candidate, 'detail');
  const detail = hasDetail ? candidate.detail : undefined;
  if (hasDetail && typeof detail !== 'string') {
    return invalid('invalid detail');
  }

  if (source === 'git-remote' || source === 'repository-ref') {
    if (hasOwn(candidate, 'pullRequest')) {
      return invalid(`${source} match must not include pull request ref`);
    }
    return Effect.succeed(
      frozenHostRecord({
        source,
        repository,
        ...(hasPriority ? { priority } : {}),
        ...(detail === undefined ? {} : { detail }),
      }) as TMatch
    );
  }

  if (!hasOwn(candidate, 'pullRequest')) {
    return invalid('missing pull request ref');
  }

  const pullRequest = snapshotPullRequestRef(candidate.pullRequest);
  if (pullRequest === null) {
    return invalid('invalid pull request ref');
  }

  return Effect.succeed(
    frozenHostRecord({
      source,
      repository,
      pullRequest,
      ...(hasPriority ? { priority } : {}),
      ...(detail === undefined ? {} : { detail }),
    }) as TMatch
  );
}

function validateProviderPriority(
  pluginId: string,
  capability: AidePullRequestProviderCapability,
  source: PullRequestProviderLookupSource,
  value: string,
  match: AidePullRequestProviderMatch
): Effect.Effect<number, InvalidPullRequestProviderMatchError> {
  const candidate = match as unknown as Readonly<Record<string, unknown>>;
  if (!isFiniteNumber(capability.priority)) {
    return Effect.fail(
      hostInvalidPullRequestProviderMatchError({
        source,
        value,
        pluginId,
        providerId: capability.providerId,
        reason: 'invalid capability priority',
      })
    );
  }

  const hasMatchPriority = hasOwn(candidate, 'priority');
  const priority = hasMatchPriority ? candidate.priority : capability.priority;

  if (!isFiniteNumber(priority)) {
    return Effect.fail(
      hostInvalidPullRequestProviderMatchError({
        source,
        value,
        pluginId,
        providerId: capability.providerId,
        reason: 'invalid match priority',
      })
    );
  }

  return Effect.succeed(priority);
}

function collectMatches<TMatch extends AidePullRequestProviderMatch>(
  providers: readonly PluginCapability<AidePullRequestProviderCapability>[],
  source: PullRequestProviderLookupSource,
  value: string,
  match: (capability: AidePullRequestProviderCapability) => TMatch | null,
  options: Pick<
    PullRequestProviderResolutionOptions<TMatch>,
    'matcherTimeout'
  > = {}
): Effect.Effect<
  ResolvedPullRequestProviderCandidate<TMatch>[],
  | InvalidPullRequestProviderMatchError
  | PullRequestProviderInvocationError
  | PullRequestProviderTimeoutError
> {
  const matcherTimeout = ownDataPropertyValue<Duration.DurationInput>(
    options,
    'matcherTimeout'
  );
  return Effect.forEach(
    providers,
    (entry) => {
      const { pluginId, capability } = entry;
      const callbackFailureReason =
        source === 'git-remote'
          ? 'matchRemote callback threw'
          : 'matchPullRequestUrl callback threw';
      const providerMatch = isolatePublicCapabilityEffect(
        Effect.try({
          try: () => match(capability) as unknown,
          catch: () =>
            hostPullRequestProviderInvocationError({
              source,
              value,
              pluginId,
              providerId: capability.providerId,
              cause: hostPullRequestProviderMatcherFailureCause(
                callbackFailureReason
              ),
            }),
        })
      ).pipe(
        Effect.timeoutFail({
          duration: matcherTimeout ?? defaultMatcherTimeout,
          onTimeout: () =>
            hostPullRequestProviderTimeoutError({
              source,
              value,
              pluginId,
              providerId: capability.providerId,
            }),
        })
      );

      return providerMatch.pipe(
        Effect.flatMap((matchResult) => {
          if (matchResult === null) {
            return Effect.succeed([]);
          }

          return validateProviderMatchSafely<TMatch>(
            pluginId,
            capability,
            source,
            value,
            matchResult
          ).pipe(
            Effect.flatMap((validMatch) =>
              validateProviderPrioritySafely(
                pluginId,
                capability,
                source,
                value,
                validMatch
              ).pipe(
                Effect.flatMap((priority) =>
                  captureProviderFeaturesSafely(
                    pluginId,
                    capability,
                    source,
                    value
                  ).pipe(
                    Effect.map((features) => [
                      retainPullRequestProviderCandidateEntry(
                        {
                          pluginId,
                          providerId: capability.providerId,
                          capability,
                          features,
                          match: validMatch,
                          priority,
                        },
                        entry
                      ),
                    ])
                  )
                )
              )
            )
          );
        })
      );
    },
    { concurrency: 'unbounded' }
  ).pipe(Effect.map(flattenHostArrayGroups));
}

function selectProvider<TMatch extends AidePullRequestProviderMatch>(
  matches: readonly ResolvedPullRequestProviderCandidate<TMatch>[],
  source: PullRequestProviderLookupSource,
  value: string,
  options: PullRequestProviderResolutionOptions<TMatch> = {}
): Effect.Effect<
  ResolvedPullRequestProviderCandidate<TMatch>,
  PullRequestProviderResolutionError
> {
  if ((hostArrayLength(matches) ?? 0) === 0) {
    return Effect.fail(
      hostUnsupportedPullRequestProviderError({ source, value })
    );
  }

  const preferred = ownDataPropertyValue<
    PullRequestProviderResolutionOptions<TMatch>['preferred']
  >(options, 'preferred');
  const preferredMatches =
    preferred === undefined ? [] : filterHostArray(matches, preferred);
  const selectable =
    (hostArrayLength(preferredMatches) ?? 0) > 0 ? preferredMatches : matches;
  const { winner, tied } = selectHighestPriorityHostArray(
    selectable,
    (candidate) => candidate.priority
  );
  if (winner === undefined) {
    return Effect.fail(
      hostUnsupportedPullRequestProviderError({ source, value })
    );
  }

  if ((hostArrayLength(tied) ?? 0) > 1) {
    return Effect.fail(
      hostAmbiguousPullRequestProviderError({
        source,
        value,
        priority: winner.priority,
        candidates: mapHostArray(tied, candidateSummary),
      })
    );
  }

  return Effect.succeed(winner);
}

function stripProviderCapability<TMatch extends AidePullRequestProviderMatch>(
  provider: ResolvedPullRequestProviderCandidate<TMatch>
): ResolvedPullRequestProvider<TMatch> {
  return frozenHostRecord({
    pluginId: provider.pluginId,
    providerId: provider.providerId,
    features: provider.features,
    match: provider.match,
    priority: provider.priority,
  });
}

function invokeBoundPullRequestOperation<A, E>(
  request: unknown,
  options: unknown,
  invoke: () => Effect.Effect<A, E, never>
): Effect.Effect<A, E | PullRequestAuthScopeSelectionError, never> {
  const rejection = rejectPublicPullRequestAuthSelectionInput(request, options);
  return rejection === undefined
    ? Effect.suspend(invoke)
    : Effect.fail(rejection);
}

function bindProviderOperationContext<
  TMatch extends AidePullRequestProviderMatch,
  TResult,
>(
  provider: ResolvedPullRequestProviderCandidate<TMatch>,
  result: TResult,
  authScope: AideAuthScope | undefined
): PullRequestProviderOperationContext<TMatch, TResult> {
  return frozenHostRecord({
    provider: stripProviderCapability(provider),
    result,
    getPullRequestDiff: (
      request: Pick<AidePullRequestDiffRequest, 'pullRequest'>,
      options: Pick<
        PullRequestProviderOperationOptions,
        'operationTimeout'
      > = {}
    ) =>
      invokeBoundPullRequestOperation(request, options, () =>
        getPullRequestDiffWithProvider(provider, request, options, authScope)
      ),
    updatePullRequest: (
      request: Omit<AidePullRequestUpdateRequest, 'match' | 'authScope'>,
      options: Pick<
        PullRequestProviderOperationOptions,
        'operationTimeout'
      > = {}
    ) =>
      invokeBoundPullRequestOperation(request, options, () =>
        updatePullRequestWithProvider(provider, request, options, authScope)
      ),
    listPullRequestComments: (
      request: Pick<AidePullRequestCommentsRequest, 'pullRequest'>,
      options: Pick<
        PullRequestProviderOperationOptions,
        'operationTimeout'
      > = {}
    ) =>
      invokeBoundPullRequestOperation(request, options, () =>
        listPullRequestCommentsWithProvider(
          provider,
          request,
          options,
          authScope
        )
      ),
    addPullRequestComment: (
      request: Omit<AidePullRequestAddCommentRequest, 'match' | 'authScope'>,
      options: Pick<
        PullRequestProviderOperationOptions,
        'operationTimeout'
      > = {}
    ) =>
      invokeBoundPullRequestOperation(request, options, () =>
        addPullRequestCommentWithProvider(provider, request, options, authScope)
      ),
    replyToPullRequestComment: (
      request: Omit<AidePullRequestReplyCommentRequest, 'match' | 'authScope'>,
      options: Pick<
        PullRequestProviderOperationOptions,
        'operationTimeout'
      > = {}
    ) =>
      invokeBoundPullRequestOperation(request, options, () =>
        replyToPullRequestCommentWithProvider(
          provider,
          request,
          options,
          authScope
        )
      ),
  });
}

function selectProviderCandidate<TMatch extends AidePullRequestProviderMatch>(
  providers: readonly PluginCapability<AidePullRequestProviderCapability>[],
  source: PullRequestProviderLookupSource,
  value: string,
  match: (capability: AidePullRequestProviderCapability) => TMatch | null,
  options: PullRequestProviderResolutionOptions<TMatch> = {}
): Effect.Effect<
  ResolvedPullRequestProviderCandidate<TMatch>,
  PullRequestProviderResolutionError
> {
  const descriptor = describePullRequestProviderLookup(source, value);
  return collectMatches(providers, source, descriptor, match, options).pipe(
    Effect.flatMap((matches) =>
      selectProvider(matches, source, descriptor, options)
    )
  );
}

function selectProviderCandidateForOperation<
  TMatch extends AidePullRequestProviderMatch,
>(
  providers: readonly PluginCapability<AidePullRequestProviderCapability>[],
  source: PullRequestProviderLookupSource,
  value: string,
  match: (capability: AidePullRequestProviderCapability) => TMatch | null,
  hasOperation: (
    provider: ResolvedPullRequestProviderCandidate<TMatch>
  ) => boolean,
  options: PullRequestProviderResolutionOptions<TMatch> = {}
): Effect.Effect<
  ResolvedPullRequestProviderCandidate<TMatch>,
  PullRequestProviderResolutionError
> {
  const descriptor = describePullRequestProviderLookup(source, value);
  return collectMatches(providers, source, descriptor, match, options).pipe(
    Effect.flatMap((matches) => {
      const operationMatches = filterHostArray(matches, hasOperation);
      return selectProvider(
        (hostArrayLength(operationMatches) ?? 0) > 0
          ? operationMatches
          : matches,
        source,
        descriptor,
        options
      );
    })
  );
}

function invokeRepositoryMatcher(
  pluginId: string,
  capability: AidePullRequestProviderCapability,
  request: AidePullRequestRepositoryInput,
  value: string,
  options: Pick<
    PullRequestProviderResolutionOptions<AidePullRequestRepositoryMatch>,
    'matcherTimeout'
  > = {}
): Effect.Effect<
  AidePullRequestRepositoryMatch | null,
  | InvalidPullRequestProviderMatchError
  | PullRequestProviderInvocationError
  | PullRequestProviderTimeoutError
> {
  const matcherTimeout = ownDataPropertyValue<Duration.DurationInput>(
    options,
    'matcherTimeout'
  );
  const matchRepository = capability.matchRepository;
  if (matchRepository === undefined) {
    return Effect.succeed(null);
  }

  const invalidMatch = (reason: string) =>
    hostInvalidPullRequestProviderMatchError({
      source: 'repository-ref',
      value,
      pluginId,
      providerId: capability.providerId,
      reason,
    });

  return invokePublicCapabilityEffect<
    AidePullRequestRepositoryMatch | null,
    unknown,
    AidePullRequestRepositoryMatch | null,
    InvalidPullRequestProviderMatchError | PullRequestProviderInvocationError,
    InvalidPullRequestProviderMatchError | PullRequestProviderInvocationError
  >(
    () => matchRepository(request),
    {
      onCallbackThrow: () =>
        hostPullRequestProviderInvocationError({
          source: 'repository-ref',
          value,
          pluginId,
          providerId: capability.providerId,
          cause: hostPullRequestProviderMatcherFailureCause(
            'matchRepository callback threw'
          ),
        }),
      onInvalidReturn: () =>
        invalidMatch('matchRepository must return an Effect'),
      onCompositionFailure: () =>
        invalidMatch('matchRepository Effect composition failed'),
      onLaunchFailure: () =>
        invalidMatch('matchRepository Effect execution was invalid'),
    },
    (effect) =>
      Effect.flatMap(
        Effect.mapErrorCause(effect, (cause) =>
          Cause.map(cause, (failure) =>
            hostPullRequestProviderInvocationError({
              source: 'repository-ref',
              value,
              pluginId,
              providerId: capability.providerId,
              cause: failure,
            })
          )
        ),
        (matchResult) =>
          matchResult === null
            ? Effect.succeed(null)
            : validateProviderMatchSafely<AidePullRequestRepositoryMatch>(
                pluginId,
                capability,
                'repository-ref',
                value,
                matchResult
              )
      )
  ).pipe(
    Effect.timeoutFail({
      duration: matcherTimeout ?? defaultMatcherTimeout,
      onTimeout: () =>
        hostPullRequestProviderTimeoutError({
          source: 'repository-ref',
          value,
          pluginId,
          providerId: capability.providerId,
        }),
    })
  );
}

function collectRepositoryInputMatches(
  providers: readonly PluginCapability<AidePullRequestProviderCapability>[],
  input: AidePullRequestRepositoryInput,
  options: Pick<
    PullRequestProviderResolutionOptions<AidePullRequestRepositoryMatch>,
    'matcherTimeout'
  > = {}
): Effect.Effect<
  ResolvedPullRequestProviderCandidate<AidePullRequestRepositoryMatch>[],
  | InvalidPullRequestProviderMatchError
  | PullRequestProviderInvocationError
  | PullRequestProviderTimeoutError
> {
  const request = snapshotRepositoryInput(input);
  const value =
    request === null
      ? 'invalid repository input'
      : repositoryInputValue(request);
  if (request === null) {
    return Effect.fail(
      hostInvalidPullRequestProviderMatchError({
        source: 'repository-ref',
        value,
        pluginId: 'host',
        providerId: 'unknown',
        reason: 'invalid repository input',
      })
    );
  }

  return Effect.forEach(
    providers,
    (entry) => {
      const { pluginId, capability } = entry;
      if (
        request.providerId !== undefined &&
        capability.providerId !== request.providerId
      ) {
        return Effect.succeed([]);
      }

      return invokeRepositoryMatcher(
        pluginId,
        capability,
        request,
        value,
        options
      ).pipe(
        Effect.flatMap((matchResult) => {
          if (matchResult === null) {
            return Effect.succeed([]);
          }

          return validateProviderPrioritySafely(
            pluginId,
            capability,
            'repository-ref',
            value,
            matchResult
          ).pipe(
            Effect.flatMap((priority) =>
              captureProviderFeaturesSafely(
                pluginId,
                capability,
                'repository-ref',
                value
              ).pipe(
                Effect.map((features) => [
                  retainPullRequestProviderCandidateEntry(
                    {
                      pluginId,
                      providerId: capability.providerId,
                      capability,
                      features,
                      match: matchResult,
                      priority,
                    },
                    entry
                  ),
                ])
              )
            )
          );
        })
      );
    },
    { concurrency: 'unbounded' }
  ).pipe(Effect.map(flattenHostArrayGroups));
}

function selectProviderCandidateForRepositoryInput(
  providers: readonly PluginCapability<AidePullRequestProviderCapability>[],
  input: AidePullRequestRepositoryInput,
  options: PullRequestProviderResolutionOptions<AidePullRequestRepositoryMatch> = {}
): Effect.Effect<
  ResolvedPullRequestProviderCandidate<AidePullRequestRepositoryMatch>,
  PullRequestProviderResolutionError
> {
  const request = snapshotRepositoryInput(input);
  const value =
    request === null
      ? 'invalid repository input'
      : repositoryInputValue(request);
  return collectRepositoryInputMatches(providers, input, options).pipe(
    Effect.flatMap((matches) =>
      selectProvider(matches, 'repository-ref', value, options)
    )
  );
}

function collectRepositoryRefMatches(
  providers: readonly PluginCapability<AidePullRequestProviderCapability>[],
  repositoryRef: AidePullRequestRepositoryRef
): Effect.Effect<
  ResolvedPullRequestProviderCandidate<AidePullRequestRepositoryMatch>[],
  InvalidPullRequestProviderMatchError
> {
  const repository = snapshotRepositoryRef(repositoryRef);
  const value =
    repository === null
      ? 'invalid repository ref'
      : repositoryRefValue(repository);
  if (repository === null) {
    return Effect.fail(
      hostInvalidPullRequestProviderMatchError({
        source: 'repository-ref',
        value,
        pluginId: 'host',
        providerId: 'unknown',
        reason: 'invalid repository ref',
      })
    );
  }

  const expectedProviderId = repositoryRefProviderId(repository);
  return Effect.forEach(providers, (entry) => {
    const { pluginId, capability } = entry;
    if (capability.providerId !== expectedProviderId) {
      return Effect.succeed([]);
    }

    const match = frozenHostRecord({
      source: 'repository-ref' as const,
      repository,
    });
    return validateProviderPrioritySafely(
      pluginId,
      capability,
      'repository-ref',
      value,
      match
    ).pipe(
      Effect.flatMap((priority) =>
        captureProviderFeaturesSafely(
          pluginId,
          capability,
          'repository-ref',
          value
        ).pipe(
          Effect.map((features) => [
            retainPullRequestProviderCandidateEntry(
              {
                pluginId,
                providerId: capability.providerId,
                capability,
                features,
                match,
                priority,
              },
              entry
            ),
          ])
        )
      )
    );
  }).pipe(Effect.map(flattenHostArrayGroups));
}

function selectProviderCandidateForRepository(
  providers: readonly PluginCapability<AidePullRequestProviderCapability>[],
  repository: AidePullRequestRepositoryRef,
  options: PullRequestProviderResolutionOptions<AidePullRequestRepositoryMatch> = {}
): Effect.Effect<
  ResolvedPullRequestProviderCandidate<AidePullRequestRepositoryMatch>,
  PullRequestProviderResolutionError
> {
  const value =
    snapshotRepositoryRef(repository) === null
      ? 'invalid repository ref'
      : repositoryRefValue(repository);
  return collectRepositoryRefMatches(providers, repository).pipe(
    Effect.flatMap((matches) =>
      selectProvider(matches, 'repository-ref', value, options)
    )
  );
}

function selectProviderCandidateForRepositoryOperation(
  providers: readonly PluginCapability<AidePullRequestProviderCapability>[],
  repository: AidePullRequestRepositoryRef,
  hasOperation: (
    provider: ResolvedPullRequestProviderCandidate<AidePullRequestRepositoryMatch>
  ) => boolean,
  options: PullRequestProviderResolutionOptions<AidePullRequestRepositoryMatch> = {}
): Effect.Effect<
  ResolvedPullRequestProviderCandidate<AidePullRequestRepositoryMatch>,
  PullRequestProviderResolutionError
> {
  const value =
    snapshotRepositoryRef(repository) === null
      ? 'invalid repository ref'
      : repositoryRefValue(repository);
  return collectRepositoryRefMatches(providers, repository).pipe(
    Effect.flatMap((matches) => {
      const operationMatches = filterHostArray(matches, hasOperation);
      return selectProvider(
        (hostArrayLength(operationMatches) ?? 0) > 0
          ? operationMatches
          : matches,
        'repository-ref',
        value,
        options
      );
    })
  );
}

export function resolvePullRequestProviderForRemote(
  providers: readonly PluginCapability<AidePullRequestProviderCapability>[],
  remoteUrl: string,
  options: PullRequestProviderResolutionOptions<AidePullRequestRemoteMatch> = {}
): Effect.Effect<
  ResolvedPullRequestProvider<AidePullRequestRemoteMatch>,
  PullRequestProviderResolutionError
> {
  return selectProviderCandidate(
    providers,
    'git-remote',
    remoteUrl,
    (provider) => provider.matchRemote(remoteUrl),
    options
  ).pipe(Effect.map(stripProviderCapability));
}

export function resolvePullRequestProviderForUrl(
  providers: readonly PluginCapability<AidePullRequestProviderCapability>[],
  url: string,
  options: PullRequestProviderResolutionOptions<AidePullRequestUrlMatch> = {}
): Effect.Effect<
  ResolvedPullRequestProvider<AidePullRequestUrlMatch>,
  PullRequestProviderResolutionError
> {
  return selectProviderCandidate(
    providers,
    'pull-request-url',
    url,
    (provider) => provider.matchPullRequestUrl(url),
    options
  ).pipe(Effect.map(stripProviderCapability));
}

export function resolvePullRequestProviderForRepository(
  providers: readonly PluginCapability<AidePullRequestProviderCapability>[],
  repository: AidePullRequestRepositoryRef,
  options: PullRequestProviderResolutionOptions<AidePullRequestRepositoryMatch> = {}
): Effect.Effect<
  ResolvedPullRequestProvider<AidePullRequestRepositoryMatch>,
  PullRequestProviderResolutionError
> {
  return selectProviderCandidateForRepository(
    providers,
    repository,
    options
  ).pipe(Effect.map(stripProviderCapability));
}

export function resolvePullRequestProviderForRepositoryInput(
  providers: readonly PluginCapability<AidePullRequestProviderCapability>[],
  input: AidePullRequestRepositoryInput,
  options: PullRequestProviderResolutionOptions<AidePullRequestRepositoryMatch> = {}
): Effect.Effect<
  ResolvedPullRequestProvider<AidePullRequestRepositoryMatch>,
  PullRequestProviderResolutionError
> {
  return selectProviderCandidateForRepositoryInput(
    providers,
    input,
    options
  ).pipe(Effect.map(stripProviderCapability));
}

function mapPullRequestProviderOperationCause<
  TOperation extends PullRequestOperationCaptureSchemaName,
>(
  cause: Cause.Cause<unknown>,
  provider: ResolvedPullRequestProviderCandidate,
  operation: TOperation,
  sanitizeFailureCause: boolean
): Cause.Cause<PullRequestProviderOperationError<TOperation>> {
  const wrapFailure = (failure: unknown) =>
    hostPullRequestProviderOperationError(
      {
        pluginId: provider.pluginId,
        providerId: provider.providerId,
        operation,
        cause: failure,
      },
      pullRequestProviderCandidateEntries.get(provider),
      sanitizeFailureCause
    );

  if (!sanitizeFailureCause) {
    return Cause.map(cause, wrapFailure);
  }

  return Cause.match(cause, {
    onEmpty: Cause.empty,
    onFail: (failure) => Cause.fail(wrapFailure(failure)),
    onDie: () => Cause.die(hostPullRequestProviderOperationFailureCause()),
    onInterrupt: (fiberId) => Cause.interrupt(fiberId),
    onSequential: (left, right) => Cause.sequential(left, right),
    onParallel: (left, right) => Cause.parallel(left, right),
  });
}

function invokePullRequestProviderOperation<
  A,
  B,
  I,
  TOperation extends PullRequestOperationCaptureSchemaName,
>(
  provider: ResolvedPullRequestProviderCandidate,
  operationName: TOperation,
  deadlineError: (
    args: OperationArgs<TOperation>
  ) => PullRequestProviderOperationDeadlineError<TOperation>,
  operation: ((request: I) => Effect.Effect<A, unknown, never>) | undefined,
  request: I,
  validate: (
    result: A
  ) => Effect.Effect<
    B,
    InvalidPullRequestProviderOperationResultError<TOperation>
  >,
  options: Pick<PullRequestProviderOperationOptions, 'operationTimeout'> = {},
  sanitizeFailureCause = false
): Effect.Effect<
  B,
  | UnsupportedPullRequestProviderOperationError<TOperation>
  | InvalidPullRequestProviderOperationResultError<TOperation>
  | PullRequestProviderOperationError<TOperation>
  | PullRequestProviderOperationDeadlineError<TOperation>
> {
  if (operation === undefined) {
    return Effect.fail(
      hostUnsupportedPullRequestProviderOperationError({
        pluginId: provider.pluginId,
        providerId: provider.providerId,
        operation: operationName,
      })
    );
  }

  const invalidOperation = (reason: string) =>
    hostInvalidPullRequestProviderOperationResultError({
      pluginId: provider.pluginId,
      providerId: provider.providerId,
      operation: operationName,
      reason,
    });

  const invocation = invokePublicCapabilityEffect<
    A,
    unknown,
    B,
    | InvalidPullRequestProviderOperationResultError<TOperation>
    | PullRequestProviderOperationError<TOperation>,
    | InvalidPullRequestProviderOperationResultError<TOperation>
    | PullRequestProviderOperationError<TOperation>
  >(
    () => operation(request),
    {
      onCallbackThrow: () =>
        hostPullRequestProviderOperationError({
          pluginId: provider.pluginId,
          providerId: provider.providerId,
          operation: operationName,
          cause: new Error('provider operation callback threw'),
        }),
      onInvalidReturn: () =>
        invalidOperation('operation must return an Effect'),
      onCompositionFailure: () =>
        invalidOperation('operation Effect composition failed'),
      onLaunchFailure: () =>
        invalidOperation('operation Effect execution was invalid'),
    },
    (effect) =>
      Effect.flatMap(
        Effect.mapErrorCause(effect, (cause) =>
          mapPullRequestProviderOperationCause(
            cause,
            provider,
            operationName,
            sanitizeFailureCause
          )
        ),
        (result) => {
          const captured = capturePullRequestPublicStructure(
            result,
            operationName
          );
          if (!captured.ok) {
            return Effect.fail(
              invalidOperation('operation result failed structural capture')
            );
          }
          return guardPullRequestOperationValidation(
            Effect.try({
              try: () => validate(captured.value as A),
              catch: () =>
                invalidOperation('operation result failed structural capture'),
            }).pipe(Effect.flatMap((validation) => validation)),
            () => invalidOperation('operation result failed structural capture')
          );
        }
      )
  ).pipe(
    Effect.timeoutFail({
      duration:
        ownDataPropertyValue<Duration.DurationInput>(
          options,
          'operationTimeout'
        ) ?? defaultOperationTimeout,
      onTimeout: () =>
        deadlineError({
          pluginId: provider.pluginId,
          providerId: provider.providerId,
          operation: operationName,
        }),
    })
  );
  return invocation;
}

export function listPullRequestsWithProvider(
  provider: ResolvedPullRequestProviderCandidate<
    AidePullRequestRemoteMatch | AidePullRequestRepositoryMatch
  >,
  request: Omit<AidePullRequestListRequest, 'match' | 'authScope'>,
  options: Pick<PullRequestProviderOperationOptions, 'operationTimeout'> = {},
  authScope?: AideAuthScope
): Effect.Effect<
  AidePullRequestListResult,
  PullRequestProviderOperationExecutionError<'listPullRequests'>
> {
  const operationRequest = frozenHostRecord({
    match: provider.match,
    ...(authScope === undefined ? {} : { authScope }),
    ...(request.status === undefined ? {} : { status: request.status }),
    ...(request.limit === undefined ? {} : { limit: request.limit }),
    ...(request.createdBy === undefined
      ? {}
      : { createdBy: request.createdBy }),
  });
  return invokePullRequestProviderOperation(
    provider,
    'listPullRequests',
    hostPullRequestProviderOperationTimeoutError,
    provider.capability.operations?.listPullRequests,
    operationRequest,
    (result) => validatePullRequestListResult(provider, result),
    options,
    authScope !== undefined
  );
}

export function createPullRequestWithProvider(
  provider: ResolvedPullRequestProviderCandidate<
    AidePullRequestRemoteMatch | AidePullRequestRepositoryMatch
  >,
  request: Omit<AidePullRequestCreateRequest, 'match' | 'authScope'>,
  options: Pick<PullRequestProviderOperationOptions, 'operationTimeout'> = {},
  authScope?: AideAuthScope
): Effect.Effect<
  AidePullRequestCreateResult,
  PullRequestProviderOperationExecutionError<'createPullRequest'>
> {
  const operationRequest = frozenHostRecord({
    match: provider.match,
    ...(authScope === undefined ? {} : { authScope }),
    title: request.title,
    ...(request.description === undefined
      ? {}
      : { description: request.description }),
    sourceBranch: request.sourceBranch,
    targetBranch: request.targetBranch,
    ...(request.draft === undefined ? {} : { draft: request.draft }),
    ...(request.labels === undefined
      ? {}
      : { labels: snapshotRequiredStringArray(request.labels) }),
  });
  return invokePullRequestProviderOperation(
    provider,
    'createPullRequest',
    hostPullRequestProviderMutationIndeterminateError,
    provider.capability.operations?.createPullRequest,
    operationRequest,
    (result) => validatePullRequestCreateResult(provider, result),
    options,
    authScope !== undefined
  );
}

export function getPullRequestWithProvider(
  provider: ResolvedPullRequestProviderCandidate,
  request: Pick<AidePullRequestViewRequest, 'pullRequest'>,
  options: Pick<PullRequestProviderOperationOptions, 'operationTimeout'> = {},
  authScope?: AideAuthScope
): Effect.Effect<
  AidePullRequestViewResult,
  PullRequestProviderOperationExecutionError<'getPullRequest'>
> {
  const operationRequest = frozenHostRecord({
    match: provider.match,
    ...(authScope === undefined ? {} : { authScope }),
    pullRequest: frozenHostRecord({
      number: request.pullRequest.number,
    }),
  });
  return invokePullRequestProviderOperation(
    provider,
    'getPullRequest',
    hostPullRequestProviderOperationTimeoutError,
    provider.capability.operations?.getPullRequest,
    operationRequest,
    (result) =>
      validatePullRequestViewResult(provider, operationRequest, result),
    options,
    authScope !== undefined
  );
}

export function updatePullRequestWithProvider(
  provider: ResolvedPullRequestProviderCandidate,
  request: Omit<AidePullRequestUpdateRequest, 'match' | 'authScope'>,
  options: Pick<PullRequestProviderOperationOptions, 'operationTimeout'> = {},
  authScope?: AideAuthScope
): Effect.Effect<
  AidePullRequestUpdateResult,
  PullRequestProviderOperationExecutionError<'updatePullRequest'>
> {
  const operationRequest = frozenHostRecord({
    match: provider.match,
    ...(authScope === undefined ? {} : { authScope }),
    pullRequest: frozenHostRecord({
      number: request.pullRequest.number,
    }),
    ...(request.title === undefined ? {} : { title: request.title }),
    ...(request.description === undefined
      ? {}
      : { description: request.description }),
    ...(request.targetBranch === undefined
      ? {}
      : { targetBranch: request.targetBranch }),
    ...(request.draft === undefined ? {} : { draft: request.draft }),
    ...(request.status === undefined ? {} : { status: request.status }),
    ...(request.labelsToAdd === undefined
      ? {}
      : { labelsToAdd: snapshotRequiredStringArray(request.labelsToAdd) }),
    ...(request.labelsToRemove === undefined
      ? {}
      : {
          labelsToRemove: snapshotRequiredStringArray(request.labelsToRemove),
        }),
  });
  return invokePullRequestProviderOperation(
    provider,
    'updatePullRequest',
    hostPullRequestProviderMutationIndeterminateError,
    provider.capability.operations?.updatePullRequest,
    operationRequest,
    (result) =>
      validatePullRequestUpdateResult(provider, operationRequest, result),
    options,
    authScope !== undefined
  );
}

export function getPullRequestDiffWithProvider(
  provider: ResolvedPullRequestProviderCandidate,
  request: Pick<AidePullRequestDiffRequest, 'pullRequest'>,
  options: Pick<PullRequestProviderOperationOptions, 'operationTimeout'> = {},
  authScope?: AideAuthScope
): Effect.Effect<
  AidePullRequestDiffResult,
  PullRequestProviderOperationExecutionError<'getPullRequestDiff'>
> {
  const operationRequest = frozenHostRecord({
    match: provider.match,
    ...(authScope === undefined ? {} : { authScope }),
    pullRequest: frozenHostRecord({
      number: request.pullRequest.number,
    }),
  });
  return invokePullRequestProviderOperation(
    provider,
    'getPullRequestDiff',
    hostPullRequestProviderOperationTimeoutError,
    provider.capability.operations?.getPullRequestDiff,
    operationRequest,
    (result) =>
      validatePullRequestDiffResult(provider, operationRequest, result),
    options,
    authScope !== undefined
  );
}

export function listPullRequestCommentsWithProvider(
  provider: ResolvedPullRequestProviderCandidate,
  request: Pick<AidePullRequestCommentsRequest, 'pullRequest'>,
  options: Pick<PullRequestProviderOperationOptions, 'operationTimeout'> = {},
  authScope?: AideAuthScope
): Effect.Effect<
  AidePullRequestCommentsResult,
  PullRequestProviderOperationExecutionError<'listPullRequestComments'>
> {
  const operationRequest = frozenHostRecord({
    match: provider.match,
    ...(authScope === undefined ? {} : { authScope }),
    pullRequest: frozenHostRecord({
      number: request.pullRequest.number,
    }),
  });
  return invokePullRequestProviderOperation(
    provider,
    'listPullRequestComments',
    hostPullRequestProviderOperationTimeoutError,
    provider.capability.operations?.listPullRequestComments,
    operationRequest,
    (result) =>
      validatePullRequestCommentsResult(provider, operationRequest, result),
    options,
    authScope !== undefined
  );
}

export function addPullRequestCommentWithProvider(
  provider: ResolvedPullRequestProviderCandidate,
  request: Omit<AidePullRequestAddCommentRequest, 'match' | 'authScope'>,
  options: Pick<PullRequestProviderOperationOptions, 'operationTimeout'> = {},
  authScope?: AideAuthScope
): Effect.Effect<
  AidePullRequestCommentMutationResult,
  PullRequestProviderOperationExecutionError<'addPullRequestComment'>
> {
  const operationRequest = frozenHostRecord({
    match: provider.match,
    ...(authScope === undefined ? {} : { authScope }),
    pullRequest: frozenHostRecord({
      number: request.pullRequest.number,
    }),
    body: request.body,
    ...(request.position === undefined
      ? {}
      : { position: snapshotPullRequestCommentPosition(request.position) }),
  });
  return invokePullRequestProviderOperation(
    provider,
    'addPullRequestComment',
    hostPullRequestProviderMutationIndeterminateError,
    provider.capability.operations?.addPullRequestComment,
    operationRequest,
    (result) =>
      validatePullRequestCommentMutationResult(
        provider,
        'addPullRequestComment',
        operationRequest,
        result
      ),
    options,
    authScope !== undefined
  );
}

export function replyToPullRequestCommentWithProvider(
  provider: ResolvedPullRequestProviderCandidate,
  request: Omit<AidePullRequestReplyCommentRequest, 'match' | 'authScope'>,
  options: Pick<PullRequestProviderOperationOptions, 'operationTimeout'> = {},
  authScope?: AideAuthScope
): Effect.Effect<
  AidePullRequestCommentMutationResult,
  PullRequestProviderOperationExecutionError<'replyToPullRequestComment'>
> {
  const operationRequest = frozenHostRecord({
    match: provider.match,
    ...(authScope === undefined ? {} : { authScope }),
    pullRequest: frozenHostRecord({
      number: request.pullRequest.number,
    }),
    threadId: request.threadId,
    body: request.body,
    ...(request.parentCommentId === undefined
      ? {}
      : { parentCommentId: request.parentCommentId }),
  });
  return invokePullRequestProviderOperation(
    provider,
    'replyToPullRequestComment',
    hostPullRequestProviderMutationIndeterminateError,
    provider.capability.operations?.replyToPullRequestComment,
    operationRequest,
    (result) =>
      validatePullRequestCommentMutationResult(
        provider,
        'replyToPullRequestComment',
        operationRequest,
        result
      ),
    options,
    authScope !== undefined
  );
}

export function findPullRequestForBranchWithProvider(
  provider: ResolvedPullRequestProviderCandidate<
    AidePullRequestRemoteMatch | AidePullRequestRepositoryMatch
  >,
  request: Pick<AidePullRequestBranchLookupRequest, 'branch'>,
  options: Pick<PullRequestProviderOperationOptions, 'operationTimeout'> = {},
  authScope?: AideAuthScope
): Effect.Effect<
  AidePullRequestBranchLookupResult,
  PullRequestProviderOperationExecutionError<'findPullRequestForBranch'>
> {
  const operationRequest = frozenHostRecord({
    branch: request.branch,
    match: provider.match,
    ...(authScope === undefined ? {} : { authScope }),
  });
  return invokePullRequestProviderOperation(
    provider,
    'findPullRequestForBranch',
    hostPullRequestProviderOperationTimeoutError,
    provider.capability.operations?.findPullRequestForBranch,
    operationRequest,
    (result) =>
      validatePullRequestBranchLookupResult(provider, operationRequest, result),
    options,
    authScope !== undefined
  );
}

function selectPullRequestAuthScopeAndThen<A, E>(
  provider: ResolvedPullRequestProviderCandidate,
  options: AideInternalPullRequestInvocationOptions,
  invoke: (authScope: AideAuthScope | undefined) => Effect.Effect<A, E, never>
): Effect.Effect<A, E | PullRequestAuthScopeSelectionError, never> {
  return selectAndSnapshotPullRequestAuthScope(provider, options).pipe(
    Effect.flatMap(invoke)
  );
}

export function listPullRequestsForRemote(
  providers: readonly PluginCapability<AidePullRequestProviderCapability>[],
  remoteUrl: string,
  request: Omit<AidePullRequestListRequest, 'match' | 'authScope'> = {},
  options: AideInternalPullRequestInvocationOptions = {}
): Effect.Effect<
  AidePullRequestListResult,
  PullRequestProviderOperationInvocationError<'listPullRequests'>
> {
  return selectProviderCandidateForOperation(
    providers,
    'git-remote',
    remoteUrl,
    (provider) => provider.matchRemote(remoteUrl),
    (provider) =>
      provider.capability.operations?.listPullRequests !== undefined,
    options
  ).pipe(
    Effect.flatMap((provider) =>
      selectPullRequestAuthScopeAndThen(provider, options, (authScope) =>
        listPullRequestsWithProvider(provider, request, options, authScope)
      )
    )
  );
}

export function listPullRequestsForRepository(
  providers: readonly PluginCapability<AidePullRequestProviderCapability>[],
  repository: AidePullRequestRepositoryRef,
  request: Omit<AidePullRequestListRequest, 'match' | 'authScope'> = {},
  options: AideInternalPullRequestInvocationOptions = {}
): Effect.Effect<
  AidePullRequestListResult,
  PullRequestProviderOperationInvocationError<'listPullRequests'>
> {
  return selectProviderCandidateForRepositoryOperation(
    providers,
    repository,
    (provider) =>
      provider.capability.operations?.listPullRequests !== undefined,
    options
  ).pipe(
    Effect.flatMap((provider) =>
      selectPullRequestAuthScopeAndThen(provider, options, (authScope) =>
        listPullRequestsWithProvider(provider, request, options, authScope)
      )
    )
  );
}

export function createPullRequestForRemote(
  providers: readonly PluginCapability<AidePullRequestProviderCapability>[],
  remoteUrl: string,
  request: Omit<AidePullRequestCreateRequest, 'match' | 'authScope'>,
  options: AideInternalPullRequestInvocationOptions = {}
): Effect.Effect<
  AidePullRequestCreateResult,
  PullRequestProviderOperationInvocationError<'createPullRequest'>
> {
  return selectProviderCandidateForOperation(
    providers,
    'git-remote',
    remoteUrl,
    (provider) => provider.matchRemote(remoteUrl),
    (provider) =>
      provider.capability.operations?.createPullRequest !== undefined,
    options
  ).pipe(
    Effect.flatMap((provider) =>
      selectPullRequestAuthScopeAndThen(provider, options, (authScope) =>
        createPullRequestWithProvider(provider, request, options, authScope)
      )
    )
  );
}

export function createPullRequestForRepository(
  providers: readonly PluginCapability<AidePullRequestProviderCapability>[],
  repository: AidePullRequestRepositoryRef,
  request: Omit<AidePullRequestCreateRequest, 'match' | 'authScope'>,
  options: AideInternalPullRequestInvocationOptions = {}
): Effect.Effect<
  AidePullRequestCreateResult,
  PullRequestProviderOperationInvocationError<'createPullRequest'>
> {
  return selectProviderCandidateForRepositoryOperation(
    providers,
    repository,
    (provider) =>
      provider.capability.operations?.createPullRequest !== undefined,
    options
  ).pipe(
    Effect.flatMap((provider) =>
      selectPullRequestAuthScopeAndThen(provider, options, (authScope) =>
        createPullRequestWithProvider(provider, request, options, authScope)
      )
    )
  );
}

export function findPullRequestForBranchForRemote(
  providers: readonly PluginCapability<AidePullRequestProviderCapability>[],
  remoteUrl: string,
  request: Pick<AidePullRequestBranchLookupRequest, 'branch'>,
  options: AideInternalPullRequestInvocationOptions = {}
): Effect.Effect<
  AidePullRequestBranchLookupResult,
  PullRequestProviderOperationInvocationError<'findPullRequestForBranch'>
> {
  return selectProviderCandidateForOperation(
    providers,
    'git-remote',
    remoteUrl,
    (provider) => provider.matchRemote(remoteUrl),
    (provider) =>
      provider.capability.operations?.findPullRequestForBranch !== undefined,
    options
  ).pipe(
    Effect.flatMap((provider) =>
      selectPullRequestAuthScopeAndThen(provider, options, (authScope) =>
        findPullRequestForBranchWithProvider(
          provider,
          request,
          options,
          authScope
        )
      )
    )
  );
}

export function findPullRequestForBranchForRepository(
  providers: readonly PluginCapability<AidePullRequestProviderCapability>[],
  repository: AidePullRequestRepositoryRef,
  request: Pick<AidePullRequestBranchLookupRequest, 'branch'>,
  options: AideInternalPullRequestInvocationOptions = {}
): Effect.Effect<
  AidePullRequestBranchLookupResult,
  PullRequestProviderOperationInvocationError<'findPullRequestForBranch'>
> {
  return selectProviderCandidateForRepositoryOperation(
    providers,
    repository,
    (provider) =>
      provider.capability.operations?.findPullRequestForBranch !== undefined,
    options
  ).pipe(
    Effect.flatMap((provider) =>
      selectPullRequestAuthScopeAndThen(provider, options, (authScope) =>
        findPullRequestForBranchWithProvider(
          provider,
          request,
          options,
          authScope
        )
      )
    )
  );
}

export function findPullRequestForBranchContextForRemote(
  providers: readonly PluginCapability<AidePullRequestProviderCapability>[],
  remoteUrl: string,
  request: Pick<AidePullRequestBranchLookupRequest, 'branch'>,
  options: AideInternalPullRequestInvocationOptions = {}
): Effect.Effect<
  PullRequestProviderOperationContext<
    AidePullRequestRemoteMatch,
    AidePullRequestBranchLookupResult
  >,
  PullRequestProviderOperationInvocationError<'findPullRequestForBranch'>
> {
  return selectProviderCandidateForOperation(
    providers,
    'git-remote',
    remoteUrl,
    (provider) => provider.matchRemote(remoteUrl),
    (provider) =>
      provider.capability.operations?.findPullRequestForBranch !== undefined,
    options
  ).pipe(
    Effect.flatMap((provider) =>
      selectPullRequestAuthScopeAndThen(provider, options, (authScope) =>
        findPullRequestForBranchWithProvider(
          provider,
          request,
          options,
          authScope
        ).pipe(
          Effect.map((result) =>
            bindProviderOperationContext(provider, result, authScope)
          )
        )
      )
    )
  );
}

export function findPullRequestForBranchContextForRepository(
  providers: readonly PluginCapability<AidePullRequestProviderCapability>[],
  repository: AidePullRequestRepositoryRef,
  request: Pick<AidePullRequestBranchLookupRequest, 'branch'>,
  options: AideInternalPullRequestInvocationOptions = {}
): Effect.Effect<
  PullRequestProviderOperationContext<
    AidePullRequestRepositoryMatch,
    AidePullRequestBranchLookupResult
  >,
  PullRequestProviderOperationInvocationError<'findPullRequestForBranch'>
> {
  return selectProviderCandidateForRepositoryOperation(
    providers,
    repository,
    (provider) =>
      provider.capability.operations?.findPullRequestForBranch !== undefined,
    options
  ).pipe(
    Effect.flatMap((provider) =>
      selectPullRequestAuthScopeAndThen(provider, options, (authScope) =>
        findPullRequestForBranchWithProvider(
          provider,
          request,
          options,
          authScope
        ).pipe(
          Effect.map((result) =>
            bindProviderOperationContext(provider, result, authScope)
          )
        )
      )
    )
  );
}

export function getPullRequestForRemote(
  providers: readonly PluginCapability<AidePullRequestProviderCapability>[],
  remoteUrl: string,
  request: Pick<AidePullRequestViewRequest, 'pullRequest'>,
  options: AideInternalPullRequestInvocationOptions = {}
): Effect.Effect<
  AidePullRequestViewResult,
  PullRequestProviderOperationInvocationError<'getPullRequest'>
> {
  return selectProviderCandidateForOperation(
    providers,
    'git-remote',
    remoteUrl,
    (provider) => provider.matchRemote(remoteUrl),
    (provider) => provider.capability.operations?.getPullRequest !== undefined,
    options
  ).pipe(
    Effect.flatMap((provider) =>
      selectPullRequestAuthScopeAndThen(provider, options, (authScope) =>
        getPullRequestWithProvider(provider, request, options, authScope)
      )
    )
  );
}

export function getPullRequestForRepository(
  providers: readonly PluginCapability<AidePullRequestProviderCapability>[],
  repository: AidePullRequestRepositoryRef,
  request: Pick<AidePullRequestViewRequest, 'pullRequest'>,
  options: AideInternalPullRequestInvocationOptions = {}
): Effect.Effect<
  AidePullRequestViewResult,
  PullRequestProviderOperationInvocationError<'getPullRequest'>
> {
  return selectProviderCandidateForRepositoryOperation(
    providers,
    repository,
    (provider) => provider.capability.operations?.getPullRequest !== undefined,
    options
  ).pipe(
    Effect.flatMap((provider) =>
      selectPullRequestAuthScopeAndThen(provider, options, (authScope) =>
        getPullRequestWithProvider(provider, request, options, authScope)
      )
    )
  );
}

export function updatePullRequestForRemote(
  providers: readonly PluginCapability<AidePullRequestProviderCapability>[],
  remoteUrl: string,
  request: Omit<AidePullRequestUpdateRequest, 'match' | 'authScope'>,
  options: AideInternalPullRequestInvocationOptions = {}
): Effect.Effect<
  AidePullRequestUpdateResult,
  PullRequestProviderOperationInvocationError<'updatePullRequest'>
> {
  return selectProviderCandidateForOperation(
    providers,
    'git-remote',
    remoteUrl,
    (provider) => provider.matchRemote(remoteUrl),
    (provider) =>
      provider.capability.operations?.updatePullRequest !== undefined,
    options
  ).pipe(
    Effect.flatMap((provider) =>
      selectPullRequestAuthScopeAndThen(provider, options, (authScope) =>
        updatePullRequestWithProvider(provider, request, options, authScope)
      )
    )
  );
}

export function updatePullRequestForRepository(
  providers: readonly PluginCapability<AidePullRequestProviderCapability>[],
  repository: AidePullRequestRepositoryRef,
  request: Omit<AidePullRequestUpdateRequest, 'match' | 'authScope'>,
  options: AideInternalPullRequestInvocationOptions = {}
): Effect.Effect<
  AidePullRequestUpdateResult,
  PullRequestProviderOperationInvocationError<'updatePullRequest'>
> {
  return selectProviderCandidateForRepositoryOperation(
    providers,
    repository,
    (provider) =>
      provider.capability.operations?.updatePullRequest !== undefined,
    options
  ).pipe(
    Effect.flatMap((provider) =>
      selectPullRequestAuthScopeAndThen(provider, options, (authScope) =>
        updatePullRequestWithProvider(provider, request, options, authScope)
      )
    )
  );
}

export function updatePullRequestForUrl(
  providers: readonly PluginCapability<AidePullRequestProviderCapability>[],
  url: string,
  request: Omit<
    AidePullRequestUpdateRequest,
    'match' | 'pullRequest' | 'authScope'
  >,
  options: AideInternalPullRequestInvocationOptions = {}
): Effect.Effect<
  AidePullRequestUpdateResult,
  PullRequestProviderOperationInvocationError<'updatePullRequest'>
> {
  return selectProviderCandidateForOperation(
    providers,
    'pull-request-url',
    url,
    (provider) => provider.matchPullRequestUrl(url),
    (provider) =>
      provider.capability.operations?.updatePullRequest !== undefined,
    options
  ).pipe(
    Effect.flatMap((provider) =>
      selectPullRequestAuthScopeAndThen(provider, options, (authScope) =>
        updatePullRequestWithProvider(
          provider,
          {
            ...request,
            pullRequest: provider.match.pullRequest,
          },
          options,
          authScope
        )
      )
    )
  );
}

export function getPullRequestContextForRemote(
  providers: readonly PluginCapability<AidePullRequestProviderCapability>[],
  remoteUrl: string,
  request: Pick<AidePullRequestViewRequest, 'pullRequest'>,
  options: AideInternalPullRequestInvocationOptions = {}
): Effect.Effect<
  PullRequestProviderOperationContext<
    AidePullRequestRemoteMatch,
    AidePullRequestViewResult
  >,
  PullRequestProviderOperationInvocationError<'getPullRequest'>
> {
  return selectProviderCandidateForOperation(
    providers,
    'git-remote',
    remoteUrl,
    (provider) => provider.matchRemote(remoteUrl),
    (provider) => provider.capability.operations?.getPullRequest !== undefined,
    options
  ).pipe(
    Effect.flatMap((provider) =>
      selectPullRequestAuthScopeAndThen(provider, options, (authScope) =>
        getPullRequestWithProvider(provider, request, options, authScope).pipe(
          Effect.map((result) =>
            bindProviderOperationContext(provider, result, authScope)
          )
        )
      )
    )
  );
}

export function getPullRequestContextForRepository(
  providers: readonly PluginCapability<AidePullRequestProviderCapability>[],
  repository: AidePullRequestRepositoryRef,
  request: Pick<AidePullRequestViewRequest, 'pullRequest'>,
  options: AideInternalPullRequestInvocationOptions = {}
): Effect.Effect<
  PullRequestProviderOperationContext<
    AidePullRequestRepositoryMatch,
    AidePullRequestViewResult
  >,
  PullRequestProviderOperationInvocationError<'getPullRequest'>
> {
  return selectProviderCandidateForRepositoryOperation(
    providers,
    repository,
    (provider) => provider.capability.operations?.getPullRequest !== undefined,
    options
  ).pipe(
    Effect.flatMap((provider) =>
      selectPullRequestAuthScopeAndThen(provider, options, (authScope) =>
        getPullRequestWithProvider(provider, request, options, authScope).pipe(
          Effect.map((result) =>
            bindProviderOperationContext(provider, result, authScope)
          )
        )
      )
    )
  );
}

export function getPullRequestDiffForRemote(
  providers: readonly PluginCapability<AidePullRequestProviderCapability>[],
  remoteUrl: string,
  request: Pick<AidePullRequestDiffRequest, 'pullRequest'>,
  options: AideInternalPullRequestInvocationOptions = {}
): Effect.Effect<
  AidePullRequestDiffResult,
  PullRequestProviderOperationInvocationError<'getPullRequestDiff'>
> {
  return selectProviderCandidateForOperation(
    providers,
    'git-remote',
    remoteUrl,
    (provider) => provider.matchRemote(remoteUrl),
    (provider) =>
      provider.capability.operations?.getPullRequestDiff !== undefined,
    options
  ).pipe(
    Effect.flatMap((provider) =>
      selectPullRequestAuthScopeAndThen(provider, options, (authScope) =>
        getPullRequestDiffWithProvider(provider, request, options, authScope)
      )
    )
  );
}

export function getPullRequestDiffForRepository(
  providers: readonly PluginCapability<AidePullRequestProviderCapability>[],
  repository: AidePullRequestRepositoryRef,
  request: Pick<AidePullRequestDiffRequest, 'pullRequest'>,
  options: AideInternalPullRequestInvocationOptions = {}
): Effect.Effect<
  AidePullRequestDiffResult,
  PullRequestProviderOperationInvocationError<'getPullRequestDiff'>
> {
  return selectProviderCandidateForRepositoryOperation(
    providers,
    repository,
    (provider) =>
      provider.capability.operations?.getPullRequestDiff !== undefined,
    options
  ).pipe(
    Effect.flatMap((provider) =>
      selectPullRequestAuthScopeAndThen(provider, options, (authScope) =>
        getPullRequestDiffWithProvider(provider, request, options, authScope)
      )
    )
  );
}

export function listPullRequestCommentsForRemote(
  providers: readonly PluginCapability<AidePullRequestProviderCapability>[],
  remoteUrl: string,
  request: Pick<AidePullRequestCommentsRequest, 'pullRequest'>,
  options: AideInternalPullRequestInvocationOptions = {}
): Effect.Effect<
  AidePullRequestCommentsResult,
  PullRequestProviderOperationInvocationError<'listPullRequestComments'>
> {
  return selectProviderCandidateForOperation(
    providers,
    'git-remote',
    remoteUrl,
    (provider) => provider.matchRemote(remoteUrl),
    (provider) =>
      provider.capability.operations?.listPullRequestComments !== undefined,
    options
  ).pipe(
    Effect.flatMap((provider) =>
      selectPullRequestAuthScopeAndThen(provider, options, (authScope) =>
        listPullRequestCommentsWithProvider(
          provider,
          request,
          options,
          authScope
        )
      )
    )
  );
}

export function listPullRequestCommentsForRepository(
  providers: readonly PluginCapability<AidePullRequestProviderCapability>[],
  repository: AidePullRequestRepositoryRef,
  request: Pick<AidePullRequestCommentsRequest, 'pullRequest'>,
  options: AideInternalPullRequestInvocationOptions = {}
): Effect.Effect<
  AidePullRequestCommentsResult,
  PullRequestProviderOperationInvocationError<'listPullRequestComments'>
> {
  return selectProviderCandidateForRepositoryOperation(
    providers,
    repository,
    (provider) =>
      provider.capability.operations?.listPullRequestComments !== undefined,
    options
  ).pipe(
    Effect.flatMap((provider) =>
      selectPullRequestAuthScopeAndThen(provider, options, (authScope) =>
        listPullRequestCommentsWithProvider(
          provider,
          request,
          options,
          authScope
        )
      )
    )
  );
}

export function addPullRequestCommentForRemote(
  providers: readonly PluginCapability<AidePullRequestProviderCapability>[],
  remoteUrl: string,
  request: Omit<AidePullRequestAddCommentRequest, 'match' | 'authScope'>,
  options: AideInternalPullRequestInvocationOptions = {}
): Effect.Effect<
  AidePullRequestCommentMutationResult,
  PullRequestProviderOperationInvocationError<'addPullRequestComment'>
> {
  return selectProviderCandidateForOperation(
    providers,
    'git-remote',
    remoteUrl,
    (provider) => provider.matchRemote(remoteUrl),
    (provider) =>
      provider.capability.operations?.addPullRequestComment !== undefined,
    options
  ).pipe(
    Effect.flatMap((provider) =>
      selectPullRequestAuthScopeAndThen(provider, options, (authScope) =>
        addPullRequestCommentWithProvider(provider, request, options, authScope)
      )
    )
  );
}

export function addPullRequestCommentForRepository(
  providers: readonly PluginCapability<AidePullRequestProviderCapability>[],
  repository: AidePullRequestRepositoryRef,
  request: Omit<AidePullRequestAddCommentRequest, 'match' | 'authScope'>,
  options: AideInternalPullRequestInvocationOptions = {}
): Effect.Effect<
  AidePullRequestCommentMutationResult,
  PullRequestProviderOperationInvocationError<'addPullRequestComment'>
> {
  return selectProviderCandidateForRepositoryOperation(
    providers,
    repository,
    (provider) =>
      provider.capability.operations?.addPullRequestComment !== undefined,
    options
  ).pipe(
    Effect.flatMap((provider) =>
      selectPullRequestAuthScopeAndThen(provider, options, (authScope) =>
        addPullRequestCommentWithProvider(provider, request, options, authScope)
      )
    )
  );
}

export function replyToPullRequestCommentForRemote(
  providers: readonly PluginCapability<AidePullRequestProviderCapability>[],
  remoteUrl: string,
  request: Omit<AidePullRequestReplyCommentRequest, 'match' | 'authScope'>,
  options: AideInternalPullRequestInvocationOptions = {}
): Effect.Effect<
  AidePullRequestCommentMutationResult,
  PullRequestProviderOperationInvocationError<'replyToPullRequestComment'>
> {
  return selectProviderCandidateForOperation(
    providers,
    'git-remote',
    remoteUrl,
    (provider) => provider.matchRemote(remoteUrl),
    (provider) =>
      provider.capability.operations?.replyToPullRequestComment !== undefined,
    options
  ).pipe(
    Effect.flatMap((provider) =>
      selectPullRequestAuthScopeAndThen(provider, options, (authScope) =>
        replyToPullRequestCommentWithProvider(
          provider,
          request,
          options,
          authScope
        )
      )
    )
  );
}

export function replyToPullRequestCommentForRepository(
  providers: readonly PluginCapability<AidePullRequestProviderCapability>[],
  repository: AidePullRequestRepositoryRef,
  request: Omit<AidePullRequestReplyCommentRequest, 'match' | 'authScope'>,
  options: AideInternalPullRequestInvocationOptions = {}
): Effect.Effect<
  AidePullRequestCommentMutationResult,
  PullRequestProviderOperationInvocationError<'replyToPullRequestComment'>
> {
  return selectProviderCandidateForRepositoryOperation(
    providers,
    repository,
    (provider) =>
      provider.capability.operations?.replyToPullRequestComment !== undefined,
    options
  ).pipe(
    Effect.flatMap((provider) =>
      selectPullRequestAuthScopeAndThen(provider, options, (authScope) =>
        replyToPullRequestCommentWithProvider(
          provider,
          request,
          options,
          authScope
        )
      )
    )
  );
}

export function getPullRequestForUrl(
  providers: readonly PluginCapability<AidePullRequestProviderCapability>[],
  url: string,
  options: AideInternalPullRequestInvocationOptions = {}
): Effect.Effect<
  AidePullRequestViewResult,
  PullRequestProviderOperationInvocationError<'getPullRequest'>
> {
  return selectProviderCandidateForOperation(
    providers,
    'pull-request-url',
    url,
    (provider) => provider.matchPullRequestUrl(url),
    (provider) => provider.capability.operations?.getPullRequest !== undefined,
    options
  ).pipe(
    Effect.flatMap((provider) =>
      selectPullRequestAuthScopeAndThen(provider, options, (authScope) =>
        getPullRequestWithProvider(
          provider,
          { pullRequest: provider.match.pullRequest },
          options,
          authScope
        )
      )
    )
  );
}

export function getPullRequestContextForUrl(
  providers: readonly PluginCapability<AidePullRequestProviderCapability>[],
  url: string,
  options: AideInternalPullRequestInvocationOptions = {}
): Effect.Effect<
  PullRequestProviderOperationContext<
    AidePullRequestUrlMatch,
    AidePullRequestViewResult
  >,
  PullRequestProviderOperationInvocationError<'getPullRequest'>
> {
  return selectProviderCandidateForOperation(
    providers,
    'pull-request-url',
    url,
    (provider) => provider.matchPullRequestUrl(url),
    (provider) => provider.capability.operations?.getPullRequest !== undefined,
    options
  ).pipe(
    Effect.flatMap((provider) =>
      selectPullRequestAuthScopeAndThen(provider, options, (authScope) =>
        getPullRequestWithProvider(
          provider,
          { pullRequest: provider.match.pullRequest },
          options,
          authScope
        ).pipe(
          Effect.map((result) =>
            bindProviderOperationContext(provider, result, authScope)
          )
        )
      )
    )
  );
}

export function getPullRequestDiffForUrl(
  providers: readonly PluginCapability<AidePullRequestProviderCapability>[],
  url: string,
  options: AideInternalPullRequestInvocationOptions = {}
): Effect.Effect<
  AidePullRequestDiffResult,
  PullRequestProviderOperationInvocationError<'getPullRequestDiff'>
> {
  return selectProviderCandidateForOperation(
    providers,
    'pull-request-url',
    url,
    (provider) => provider.matchPullRequestUrl(url),
    (provider) =>
      provider.capability.operations?.getPullRequestDiff !== undefined,
    options
  ).pipe(
    Effect.flatMap((provider) =>
      selectPullRequestAuthScopeAndThen(provider, options, (authScope) =>
        getPullRequestDiffWithProvider(
          provider,
          { pullRequest: provider.match.pullRequest },
          options,
          authScope
        )
      )
    )
  );
}

export function listPullRequestCommentsForUrl(
  providers: readonly PluginCapability<AidePullRequestProviderCapability>[],
  url: string,
  options: AideInternalPullRequestInvocationOptions = {}
): Effect.Effect<
  AidePullRequestCommentsResult,
  PullRequestProviderOperationInvocationError<'listPullRequestComments'>
> {
  return selectProviderCandidateForOperation(
    providers,
    'pull-request-url',
    url,
    (provider) => provider.matchPullRequestUrl(url),
    (provider) =>
      provider.capability.operations?.listPullRequestComments !== undefined,
    options
  ).pipe(
    Effect.flatMap((provider) =>
      selectPullRequestAuthScopeAndThen(provider, options, (authScope) =>
        listPullRequestCommentsWithProvider(
          provider,
          { pullRequest: provider.match.pullRequest },
          options,
          authScope
        )
      )
    )
  );
}

export function addPullRequestCommentForUrl(
  providers: readonly PluginCapability<AidePullRequestProviderCapability>[],
  url: string,
  request: Omit<
    AidePullRequestAddCommentRequest,
    'match' | 'pullRequest' | 'authScope'
  >,
  options: AideInternalPullRequestInvocationOptions = {}
): Effect.Effect<
  AidePullRequestCommentMutationResult,
  PullRequestProviderOperationInvocationError<'addPullRequestComment'>
> {
  return selectProviderCandidateForOperation(
    providers,
    'pull-request-url',
    url,
    (provider) => provider.matchPullRequestUrl(url),
    (provider) =>
      provider.capability.operations?.addPullRequestComment !== undefined,
    options
  ).pipe(
    Effect.flatMap((provider) =>
      selectPullRequestAuthScopeAndThen(provider, options, (authScope) =>
        addPullRequestCommentWithProvider(
          provider,
          { ...request, pullRequest: provider.match.pullRequest },
          options,
          authScope
        )
      )
    )
  );
}

export function replyToPullRequestCommentForUrl(
  providers: readonly PluginCapability<AidePullRequestProviderCapability>[],
  url: string,
  request: Omit<
    AidePullRequestReplyCommentRequest,
    'match' | 'pullRequest' | 'authScope'
  >,
  options: AideInternalPullRequestInvocationOptions = {}
): Effect.Effect<
  AidePullRequestCommentMutationResult,
  PullRequestProviderOperationInvocationError<'replyToPullRequestComment'>
> {
  return selectProviderCandidateForOperation(
    providers,
    'pull-request-url',
    url,
    (provider) => provider.matchPullRequestUrl(url),
    (provider) =>
      provider.capability.operations?.replyToPullRequestComment !== undefined,
    options
  ).pipe(
    Effect.flatMap((provider) =>
      selectPullRequestAuthScopeAndThen(provider, options, (authScope) =>
        replyToPullRequestCommentWithProvider(
          provider,
          { ...request, pullRequest: provider.match.pullRequest },
          options,
          authScope
        )
      )
    )
  );
}

export function resolvePullRequestProviderFromRegistryForRemote<
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
  remoteUrl: string
): Effect.Effect<
  ResolvedPullRequestProvider<AidePullRequestRemoteMatch>,
  PullRequestProviderResolutionError
> {
  return resolvePullRequestProviderForRemote(
    registry.capabilities.pullRequestProviders(),
    remoteUrl
  );
}

export function resolvePullRequestProviderFromRegistryForUrl<
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
  url: string
): Effect.Effect<
  ResolvedPullRequestProvider<AidePullRequestUrlMatch>,
  PullRequestProviderResolutionError
> {
  return resolvePullRequestProviderForUrl(
    registry.capabilities.pullRequestProviders(),
    url
  );
}

export function resolvePullRequestProviderFromRegistryForRepository<
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
  repository: AidePullRequestRepositoryRef
): Effect.Effect<
  ResolvedPullRequestProvider<AidePullRequestRepositoryMatch>,
  PullRequestProviderResolutionError
> {
  return resolvePullRequestProviderForRepository(
    registry.capabilities.pullRequestProviders(),
    repository
  );
}

export function resolvePullRequestProviderFromRegistryForRepositoryInput<
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
  input: AidePullRequestRepositoryInput
): Effect.Effect<
  ResolvedPullRequestProvider<AidePullRequestRepositoryMatch>,
  PullRequestProviderResolutionError
> {
  return resolvePullRequestProviderForRepositoryInput(
    registry.capabilities.pullRequestProviders(),
    input
  );
}
