import { Data, Effect, type Duration } from 'effect';

import type {
  CommandRegistry,
  OwnedPluginCapability,
} from './command-registry.js';
import type {
  AidePullRequestProviderCapability,
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

export type PullRequestProviderResolutionError =
  | UnsupportedPullRequestProviderError
  | AmbiguousPullRequestProviderError
  | InvalidPullRequestProviderMatchError
  | PullRequestProviderInvocationError
  | PullRequestProviderTimeoutError;

const defaultMatcherTimeout = '2 seconds' satisfies Duration.DurationInput;

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
  ResolvedPullRequestProvider<TMatch>[],
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
  matches: readonly ResolvedPullRequestProvider<TMatch>[],
  source: PullRequestProviderLookupSource,
  value: string,
  options: PullRequestProviderResolutionOptions<TMatch> = {}
): Effect.Effect<
  ResolvedPullRequestProvider<TMatch>,
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

export function resolvePullRequestProviderForRemote(
  providers: readonly OwnedPluginCapability<AidePullRequestProviderCapability>[],
  remoteUrl: string,
  options: PullRequestProviderResolutionOptions<AidePullRequestRemoteMatch> = {}
): Effect.Effect<
  ResolvedPullRequestProvider<AidePullRequestRemoteMatch>,
  PullRequestProviderResolutionError
> {
  return collectMatches(
    providers,
    'git-remote',
    remoteUrl,
    (provider) => provider.matchRemote(remoteUrl),
    options
  ).pipe(
    Effect.flatMap((matches) =>
      selectProvider(matches, 'git-remote', remoteUrl, options)
    )
  );
}

export function resolvePullRequestProviderForUrl(
  providers: readonly OwnedPluginCapability<AidePullRequestProviderCapability>[],
  url: string,
  options: PullRequestProviderResolutionOptions<AidePullRequestUrlMatch> = {}
): Effect.Effect<
  ResolvedPullRequestProvider<AidePullRequestUrlMatch>,
  PullRequestProviderResolutionError
> {
  return collectMatches(
    providers,
    'pull-request-url',
    url,
    (provider) => provider.matchPullRequestUrl(url),
    options
  ).pipe(
    Effect.flatMap((matches) =>
      selectProvider(matches, 'pull-request-url', url, options)
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
