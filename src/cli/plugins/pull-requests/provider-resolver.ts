import { Data, Effect } from 'effect';

import type {
  CommandRegistry,
  OwnedPluginCapability,
} from '@cli/host/command-registry.js';
import type {
  AidePullRequestProviderCapability,
  AidePullRequestProviderMatch,
  AidePullRequestProviderMatchSource,
} from '@cli/host/plugin-descriptor.js';

export type PullRequestProviderLookupSource =
  AidePullRequestProviderMatchSource;

export interface PullRequestProviderCandidate {
  readonly pluginId: string;
  readonly providerId: string;
  readonly priority: number;
}

export interface ResolvedPullRequestProvider {
  readonly pluginId: string;
  readonly capability: AidePullRequestProviderCapability;
  readonly match: AidePullRequestProviderMatch;
  readonly priority: number;
}

export interface PullRequestProviderResolutionOptions {
  /**
   * Prefer a subset of matching providers when available. If no preferred
   * provider matches, resolution falls back to all matches.
   */
  readonly preferred?: (provider: ResolvedPullRequestProvider) => boolean;
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

export type PullRequestProviderResolutionError =
  | UnsupportedPullRequestProviderError
  | AmbiguousPullRequestProviderError;

function candidateSummary(
  resolved: ResolvedPullRequestProvider
): PullRequestProviderCandidate {
  return {
    pluginId: resolved.pluginId,
    providerId: resolved.capability.providerId,
    priority: resolved.priority,
  };
}

function collectMatches(
  providers: readonly OwnedPluginCapability<AidePullRequestProviderCapability>[],
  match: (
    capability: AidePullRequestProviderCapability
  ) => AidePullRequestProviderMatch | null
): ResolvedPullRequestProvider[] {
  return providers.flatMap(({ pluginId, capability }) => {
    const providerMatch = match(capability);
    if (providerMatch === null) return [];
    return [
      {
        pluginId,
        capability,
        match: providerMatch,
        priority: providerMatch.priority ?? capability.priority,
      },
    ];
  });
}

function selectProvider(
  matches: readonly ResolvedPullRequestProvider[],
  source: PullRequestProviderLookupSource,
  value: string,
  options: PullRequestProviderResolutionOptions = {}
): Effect.Effect<
  ResolvedPullRequestProvider,
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
  options: PullRequestProviderResolutionOptions = {}
): Effect.Effect<
  ResolvedPullRequestProvider,
  PullRequestProviderResolutionError
> {
  return selectProvider(
    collectMatches(providers, (provider) => provider.matchRemote(remoteUrl)),
    'git-remote',
    remoteUrl,
    options
  );
}

export function resolvePullRequestProviderForUrl(
  providers: readonly OwnedPluginCapability<AidePullRequestProviderCapability>[],
  url: string,
  options: PullRequestProviderResolutionOptions = {}
): Effect.Effect<
  ResolvedPullRequestProvider,
  PullRequestProviderResolutionError
> {
  return selectProvider(
    collectMatches(providers, (provider) => provider.matchPullRequestUrl(url)),
    'pull-request-url',
    url,
    options
  );
}

export function resolvePullRequestProviderFromRegistryForRemote(
  registry: CommandRegistry,
  remoteUrl: string
): Effect.Effect<
  ResolvedPullRequestProvider,
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
  ResolvedPullRequestProvider,
  PullRequestProviderResolutionError
> {
  return resolvePullRequestProviderForUrl(
    registry.capabilities.pullRequestProviders(),
    url
  );
}
