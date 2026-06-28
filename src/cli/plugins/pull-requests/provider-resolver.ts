import { Data, Effect } from 'effect';

import type {
  CommandRegistry,
  OwnedPluginCapability,
} from '@cli/host/command-registry.js';
import type {
  AidePullRequestProviderCapability,
  AidePullRequestProviderMatch,
  AidePullRequestProviderMatchSource,
  AidePullRequestRemoteMatch,
  AidePullRequestRepositoryRef,
  AidePullRequestUrlMatch,
} from '@cli/host/plugin-descriptor.js';

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
  readonly capability: AidePullRequestProviderCapability;
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

export type PullRequestProviderResolutionError =
  | UnsupportedPullRequestProviderError
  | AmbiguousPullRequestProviderError
  | InvalidPullRequestProviderMatchError;

function candidateSummary<TMatch extends AidePullRequestProviderMatch>(
  resolved: ResolvedPullRequestProvider<TMatch>
): PullRequestProviderCandidate {
  return {
    pluginId: resolved.pluginId,
    providerId: resolved.capability.providerId,
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

function isRepositoryMetadata(
  value: unknown
): value is Readonly<Record<string, string | number | boolean>> {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;

  return Object.values(value).every(
    (entry) =>
      typeof entry === 'string' ||
      typeof entry === 'boolean' ||
      isFiniteNumber(entry)
  );
}

function isRepositoryRef(
  value: unknown
): value is AidePullRequestRepositoryRef {
  if (!isRecord(value)) return false;

  switch (value.kind) {
    case 'github':
      return (
        isNonEmptyString(value.host) &&
        isNonEmptyString(value.owner) &&
        isNonEmptyString(value.repo)
      );
    case 'azure-devops':
      return (
        isNonEmptyString(value.org) &&
        isNonEmptyString(value.project) &&
        isNonEmptyString(value.repo)
      );
    case 'external':
      return (
        isNonEmptyString(value.providerId) &&
        isNonEmptyString(value.displayName) &&
        isRepositoryMetadata(value.metadata)
      );
    default:
      return false;
  }
}

function isPullRequestRef(
  value: unknown
): value is { readonly number: number } {
  return (
    isRecord(value) &&
    typeof value.number === 'number' &&
    Number.isSafeInteger(value.number) &&
    value.number > 0
  );
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
  if (candidate.source !== source) {
    return invalid(
      `expected source '${source}' but got '${String(candidate.source)}'`
    );
  }

  if (!Object.prototype.hasOwnProperty.call(candidate, 'repository')) {
    return invalid('missing repository ref');
  }

  if (!isRepositoryRef(candidate.repository)) {
    return invalid('invalid repository ref');
  }

  if (
    candidate.repository.kind === 'external' &&
    candidate.repository.providerId !== capability.providerId
  ) {
    return invalid('external repository providerId must match provider id');
  }

  if (source === 'git-remote') {
    if (Object.prototype.hasOwnProperty.call(candidate, 'pullRequest')) {
      return invalid('git-remote match must not include pull request ref');
    }
    return Effect.succeed(match as TMatch);
  }

  if (!Object.prototype.hasOwnProperty.call(candidate, 'pullRequest')) {
    return invalid('missing pull request ref');
  }

  if (!isPullRequestRef(candidate.pullRequest)) {
    return invalid('invalid pull request ref');
  }

  return Effect.succeed(match as TMatch);
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

  const hasMatchPriority = Object.prototype.hasOwnProperty.call(
    candidate,
    'priority'
  );
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
  match: (capability: AidePullRequestProviderCapability) => TMatch | null
): Effect.Effect<
  ResolvedPullRequestProvider<TMatch>[],
  InvalidPullRequestProviderMatchError
> {
  return Effect.forEach(providers, ({ pluginId, capability }) => {
    const providerMatch: unknown = match(capability);
    if (providerMatch === null) {
      return Effect.succeed([]);
    }

    return validateProviderMatch<TMatch>(
      pluginId,
      capability,
      source,
      value,
      providerMatch
    ).pipe(
      Effect.flatMap((validMatch) =>
        validateProviderPriority(
          pluginId,
          capability,
          source,
          value,
          validMatch
        ).pipe(
          Effect.map((priority) => [
            {
              pluginId,
              capability,
              match: validMatch,
              priority,
            },
          ])
        )
      )
    );
  }).pipe(Effect.map((matches) => matches.flat()));
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
  return collectMatches(providers, 'git-remote', remoteUrl, (provider) =>
    provider.matchRemote(remoteUrl)
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
  return collectMatches(providers, 'pull-request-url', url, (provider) =>
    provider.matchPullRequestUrl(url)
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
