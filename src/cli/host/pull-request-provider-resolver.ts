import { Data, Effect, type Duration } from 'effect';

import type {
  CommandRegistry,
  OwnedPluginCapability,
} from './command-registry.js';
import type {
  AidePullRequestProviderCapability,
  AidePullRequestListItem,
  AidePullRequestListItemStatus,
  AidePullRequestListRequest,
  AidePullRequestListResult,
  AidePullRequestProviderFeatures,
  AidePullRequestProviderMatch,
  AidePullRequestProviderMatchSource,
  AidePullRequestRef,
  AidePullRequestRemoteMatch,
  AidePullRequestRepositoryRef,
  AidePullRequestUrlMatch,
} from './plugin-descriptor.js';

export type PullRequestProviderLookupSource =
  AidePullRequestProviderMatchSource;

export interface PullRequestProviderCandidate {
  readonly pluginId: string;
  readonly providerId: string;
  readonly priority: number;
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

export class UnsupportedPullRequestProviderError extends Data.TaggedError(
  'UnsupportedPullRequestProviderError'
)<{
  readonly source: PullRequestProviderLookupSource;
  readonly value: string;
}> {
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
  override get message(): string {
    const candidates = this.candidates
      .map((candidate) => `${candidate.pluginId}/${candidate.providerId}`)
      .join(', ');
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
  override get message(): string {
    const detail = this.cause instanceof Error ? `: ${this.cause.message}` : '';
    return `Pull request provider '${this.providerId}' from plugin '${this.pluginId}' failed while matching ${this.source} ${this.value}${detail}`;
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
  override get message(): string {
    return `Pull request provider '${this.providerId}' from plugin '${this.pluginId}' timed out while matching ${this.source} ${this.value}`;
  }
}

export class UnsupportedPullRequestProviderOperationError extends Data.TaggedError(
  'UnsupportedPullRequestProviderOperationError'
)<{
  readonly pluginId: string;
  readonly providerId: string;
  readonly operation: string;
}> {
  override get message(): string {
    return `Pull request provider '${this.providerId}' from plugin '${this.pluginId}' does not implement ${this.operation}`;
  }
}

export class InvalidPullRequestProviderOperationResultError extends Data.TaggedError(
  'InvalidPullRequestProviderOperationResultError'
)<{
  readonly pluginId: string;
  readonly providerId: string;
  readonly operation: string;
  readonly reason: string;
}> {
  override get message(): string {
    return `Pull request provider '${this.providerId}' from plugin '${this.pluginId}' returned invalid ${this.operation} result: ${this.reason}`;
  }
}

export class PullRequestProviderOperationError extends Data.TaggedError(
  'PullRequestProviderOperationError'
)<{
  readonly pluginId: string;
  readonly providerId: string;
  readonly operation: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    const detail = this.cause instanceof Error ? `: ${this.cause.message}` : '';
    return `Pull request provider '${this.providerId}' from plugin '${this.pluginId}' failed during ${this.operation}${detail}`;
  }
}

export class PullRequestProviderOperationTimeoutError extends Data.TaggedError(
  'PullRequestProviderOperationTimeoutError'
)<{
  readonly pluginId: string;
  readonly providerId: string;
  readonly operation: string;
}> {
  override get message(): string {
    return `Pull request provider '${this.providerId}' from plugin '${this.pluginId}' timed out during ${this.operation}`;
  }
}

export type PullRequestProviderResolutionError =
  | UnsupportedPullRequestProviderError
  | AmbiguousPullRequestProviderError
  | InvalidPullRequestProviderMatchError
  | PullRequestProviderInvocationError
  | PullRequestProviderTimeoutError;

export type PullRequestProviderOperationInvocationError =
  | PullRequestProviderResolutionError
  | UnsupportedPullRequestProviderOperationError
  | InvalidPullRequestProviderOperationResultError
  | PullRequestProviderOperationError
  | PullRequestProviderOperationTimeoutError;

const defaultMatcherTimeout = '2 seconds' satisfies Duration.DurationInput;
const defaultOperationTimeout = '10 seconds' satisfies Duration.DurationInput;

function candidateSummary<TMatch extends AidePullRequestProviderMatch>(
  resolved: ResolvedPullRequestProvider<TMatch>
): PullRequestProviderCandidate {
  return {
    pluginId: resolved.pluginId,
    providerId: resolved.providerId,
    priority: resolved.priority,
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
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
  return Object.prototype.hasOwnProperty.call(value, property);
}

function snapshotRepositoryMetadata(
  value: unknown
): Readonly<Record<string, string | number | boolean>> | undefined | null {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;

  const snapshot: Record<string, string | number | boolean> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (
      typeof entry !== 'string' &&
      typeof entry !== 'boolean' &&
      !isFiniteNumber(entry)
    ) {
      return null;
    }
    snapshot[key] = entry;
  }

  return Object.freeze(snapshot);
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
      return Object.freeze({
        kind: 'github',
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
      return Object.freeze({
        kind: 'azure-devops',
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
      return Object.freeze({
        kind: 'external',
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
        actual.displayName === expected.displayName
      );
  }
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

  return Object.freeze({ number: value.number });
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

function validatePullRequestListResult(
  provider: ResolvedPullRequestProviderCandidate<AidePullRequestRemoteMatch>,
  result: unknown
): Effect.Effect<
  AidePullRequestListResult,
  InvalidPullRequestProviderOperationResultError
> {
  const invalid = (reason: string) =>
    Effect.fail(
      new InvalidPullRequestProviderOperationResultError({
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
  if (!Array.isArray(result.pullRequests)) {
    return invalid('pullRequests must be an array');
  }

  const repositoryLabel = result.repositoryLabel;
  if (repositoryLabel !== undefined && typeof repositoryLabel !== 'string') {
    return invalid('repositoryLabel must be a string');
  }

  const pullRequests: AidePullRequestListItem[] = [];
  for (const item of result.pullRequests) {
    const snapshot = snapshotPullRequestListItem(item);
    if (snapshot === null) {
      return invalid('invalid pull request item');
    }
    pullRequests.push(snapshot);
  }

  return Effect.succeed(
    Object.freeze({
      repository,
      ...(repositoryLabel === undefined ? {} : { repositoryLabel }),
      pullRequests: Object.freeze(pullRequests),
    })
  );
}

function validationFailureReason(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function validationException(
  pluginId: string,
  capability: AidePullRequestProviderCapability,
  source: PullRequestProviderLookupSource,
  value: string,
  cause: unknown
): InvalidPullRequestProviderMatchError {
  return new InvalidPullRequestProviderMatchError({
    source,
    value,
    pluginId,
    providerId: capability.providerId,
    reason: `match validation failed: ${validationFailureReason(cause)}`,
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
  return Effect.try({
    try: () =>
      validateProviderMatch<TMatch>(pluginId, capability, source, value, match),
    catch: (cause) =>
      validationException(pluginId, capability, source, value, cause),
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
    catch: (cause) =>
      validationException(pluginId, capability, source, value, cause),
  }).pipe(Effect.flatMap((validation) => validation));
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
      new InvalidPullRequestProviderMatchError({
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
    return invalid(
      `expected source '${source}' but got '${String(candidateSource)}'`
    );
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

  if (source === 'git-remote') {
    if (hasOwn(candidate, 'pullRequest')) {
      return invalid('git-remote match must not include pull request ref');
    }
    return Effect.succeed(
      Object.freeze({
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
    Object.freeze({
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
      new InvalidPullRequestProviderMatchError({
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
      new InvalidPullRequestProviderMatchError({
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
  providers: readonly OwnedPluginCapability<AidePullRequestProviderCapability>[],
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
  return Effect.forEach(
    providers,
    ({ pluginId, capability }) => {
      const providerMatch = Effect.try({
        try: () => match(capability) as unknown,
        catch: (cause) =>
          new PullRequestProviderInvocationError({
            source,
            value,
            pluginId,
            providerId: capability.providerId,
            cause,
          }),
      }).pipe(
        Effect.timeoutFail({
          duration: options.matcherTimeout ?? defaultMatcherTimeout,
          onTimeout: () =>
            new PullRequestProviderTimeoutError({
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
                Effect.map((priority) => [
                  {
                    pluginId,
                    providerId: capability.providerId,
                    capability,
                    features: capability.features,
                    match: validMatch,
                    priority,
                  },
                ])
              )
            )
          );
        })
      );
    },
    { concurrency: 'unbounded' }
  ).pipe(Effect.map((matches) => matches.flat()));
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
  if (matches.length === 0) {
    return Effect.fail(
      new UnsupportedPullRequestProviderError({ source, value })
    );
  }

  const preferredMatches =
    options.preferred === undefined ? [] : matches.filter(options.preferred);
  const selectable = preferredMatches.length > 0 ? preferredMatches : matches;
  const sorted = [...selectable].sort((a, b) => b.priority - a.priority);
  const winner = sorted[0];
  if (winner === undefined) {
    return Effect.fail(
      new UnsupportedPullRequestProviderError({ source, value })
    );
  }

  const tied = sorted.filter((match) => match.priority === winner.priority);
  if (tied.length > 1) {
    return Effect.fail(
      new AmbiguousPullRequestProviderError({
        source,
        value,
        priority: winner.priority,
        candidates: tied.map(candidateSummary),
      })
    );
  }

  return Effect.succeed(winner);
}

function stripProviderCapability<TMatch extends AidePullRequestProviderMatch>(
  provider: ResolvedPullRequestProviderCandidate<TMatch>
): ResolvedPullRequestProvider<TMatch> {
  return Object.freeze({
    pluginId: provider.pluginId,
    providerId: provider.providerId,
    features: provider.features,
    match: provider.match,
    priority: provider.priority,
  });
}

function selectProviderCandidate<TMatch extends AidePullRequestProviderMatch>(
  providers: readonly OwnedPluginCapability<AidePullRequestProviderCapability>[],
  source: PullRequestProviderLookupSource,
  value: string,
  match: (capability: AidePullRequestProviderCapability) => TMatch | null,
  options: PullRequestProviderResolutionOptions<TMatch> = {}
): Effect.Effect<
  ResolvedPullRequestProviderCandidate<TMatch>,
  PullRequestProviderResolutionError
> {
  return collectMatches(providers, source, value, match, options).pipe(
    Effect.flatMap((matches) => selectProvider(matches, source, value, options))
  );
}

export function resolvePullRequestProviderForRemote(
  providers: readonly OwnedPluginCapability<AidePullRequestProviderCapability>[],
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
  providers: readonly OwnedPluginCapability<AidePullRequestProviderCapability>[],
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

export function listPullRequestsWithProvider(
  provider: ResolvedPullRequestProviderCandidate<AidePullRequestRemoteMatch>,
  request: Omit<AidePullRequestListRequest, 'match'>,
  options: Pick<PullRequestProviderOperationOptions, 'operationTimeout'> = {}
): Effect.Effect<
  AidePullRequestListResult,
  | UnsupportedPullRequestProviderOperationError
  | InvalidPullRequestProviderOperationResultError
  | PullRequestProviderOperationError
  | PullRequestProviderOperationTimeoutError
> {
  const operation = provider.capability.operations?.listPullRequests;
  if (operation === undefined) {
    return Effect.fail(
      new UnsupportedPullRequestProviderOperationError({
        pluginId: provider.pluginId,
        providerId: provider.providerId,
        operation: 'listPullRequests',
      })
    );
  }

  return Effect.suspend(
    (): Effect.Effect<
      AidePullRequestListResult,
      | InvalidPullRequestProviderOperationResultError
      | PullRequestProviderOperationError,
      never
    > => {
      let operationResult: unknown;
      try {
        operationResult = operation({ ...request, match: provider.match });
      } catch (cause) {
        return Effect.fail(
          new PullRequestProviderOperationError({
            pluginId: provider.pluginId,
            providerId: provider.providerId,
            operation: 'listPullRequests',
            cause,
          })
        );
      }

      if (!Effect.isEffect(operationResult)) {
        return Effect.fail(
          new InvalidPullRequestProviderOperationResultError({
            pluginId: provider.pluginId,
            providerId: provider.providerId,
            operation: 'listPullRequests',
            reason: 'operation must return an Effect',
          })
        );
      }

      return (
        operationResult as Effect.Effect<
          AidePullRequestListResult,
          unknown,
          never
        >
      ).pipe(
        Effect.mapError(
          (cause) =>
            new PullRequestProviderOperationError({
              pluginId: provider.pluginId,
              providerId: provider.providerId,
              operation: 'listPullRequests',
              cause,
            })
        )
      );
    }
  ).pipe(
    Effect.timeoutFail({
      duration: options.operationTimeout ?? defaultOperationTimeout,
      onTimeout: () =>
        new PullRequestProviderOperationTimeoutError({
          pluginId: provider.pluginId,
          providerId: provider.providerId,
          operation: 'listPullRequests',
        }),
    }),
    Effect.flatMap((result) => validatePullRequestListResult(provider, result))
  );
}

export function listPullRequestsForRemote(
  providers: readonly OwnedPluginCapability<AidePullRequestProviderCapability>[],
  remoteUrl: string,
  request: Omit<AidePullRequestListRequest, 'match'> = {},
  options: PullRequestProviderOperationOptions = {}
): Effect.Effect<
  AidePullRequestListResult,
  PullRequestProviderOperationInvocationError
> {
  return selectProviderCandidate(
    providers,
    'git-remote',
    remoteUrl,
    (provider) => provider.matchRemote(remoteUrl),
    options
  ).pipe(
    Effect.flatMap((provider) =>
      listPullRequestsWithProvider(provider, request, options)
    )
  );
}

export function resolvePullRequestProviderFromRegistryForRemote(
  registry: CommandRegistry,
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

export function resolvePullRequestProviderFromRegistryForUrl(
  registry: CommandRegistry,
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
