import { Effect } from 'effect';

import type {
  AideAuthAccount,
  AidePluginAuthStatus,
} from '@cli/host/plugin-descriptor.js';
import {
  AuthIndexConsistencyError,
  AuthIndexDocumentError,
  captureAuthProviderCatalogEffect,
  type AuthProviderId,
  type AuthStoreScope,
} from '@lib/auth-store.js';
import { AuthIndexLockError } from '@lib/auth-index-lock.js';
import { KeyringService, KeyringUnavailableError } from '@lib/auth-keyring.js';
import type { ConfigStatus } from '@lib/config.js';
import {
  assembleBuiltinAuthAccounts,
  type BuiltinAuthAccountCandidate,
} from './auth-account-assembly.js';

type DiscoverySource =
  | { readonly kind: 'env'; readonly name: 'environment' }
  | {
      readonly kind: 'keyring';
      readonly name: 'keyring';
      readonly storageKind: 'legacy' | 'scoped';
    };

type StoredConfigParser<T> = (
  raw: string | null,
  scope?: AuthStoreScope
) => ConfigStatus<T>;

export interface BuiltinAuthProviderDiscoveryOptions<T> {
  readonly providerId: AuthProviderId;
  readonly probeEnvironment: () => ConfigStatus<T> | null;
  readonly parseStored: StoredConfigParser<T>;
  readonly candidate: (
    value: T,
    source: DiscoverySource
  ) => BuiltinAuthAccountCandidate;
  readonly mapStatus: (status: ConfigStatus<T>) => AidePluginAuthStatus;
  readonly malformedReason: string;
}

type CandidateState<T> =
  | {
      readonly kind: 'usable';
      readonly candidate: BuiltinAuthAccountCandidate;
      readonly value: T;
    }
  | { readonly kind: 'missing' | 'malformed' | 'unreachable' };

interface StoredDiscovery<T> {
  readonly legacy: ConfigStatus<T>;
  readonly indexed: readonly ConfigStatus<T>[];
}

const environmentSource = Object.freeze({
  kind: 'env',
  name: 'environment',
} as const);
const legacySource = Object.freeze({
  kind: 'keyring',
  name: 'keyring',
  storageKind: 'legacy',
} as const);
const scopedSource = Object.freeze({
  kind: 'keyring',
  name: 'keyring',
  storageKind: 'scoped',
} as const);

function candidateState<T>(
  status: ConfigStatus<T> | null,
  source: DiscoverySource,
  makeCandidate: BuiltinAuthProviderDiscoveryOptions<T>['candidate']
): CandidateState<T> {
  if (status === null || status.kind === 'missing') return { kind: 'missing' };
  if (status.kind === 'malformed') return { kind: 'malformed' };
  if (status.kind === 'unreachable') return { kind: 'unreachable' };

  try {
    const candidate = makeCandidate(status.value, source);
    // Reuse the authoritative pure grammar as the runtime admission check.
    assembleBuiltinAuthAccounts([candidate]);
    return { kind: 'usable', candidate, value: status.value };
  } catch {
    return { kind: 'malformed' };
  }
}

function collectStoredConfigs<T>(
  options: BuiltinAuthProviderDiscoveryOptions<T>
): Effect.Effect<StoredDiscovery<T>, unknown, KeyringService> {
  return Effect.map(
    captureAuthProviderCatalogEffect(options.providerId),
    // captureAuthProviderCatalogEffect returns only after its lock finalizer;
    // schema parsing and every later candidate operation use captured values.
    (snapshot) => snapshot.parse(options.parseStored)
  );
}

function storedCandidateStates<T>(
  discovery: StoredDiscovery<T>,
  options: BuiltinAuthProviderDiscoveryOptions<T>
): readonly CandidateState<T>[] {
  return [
    candidateState(discovery.legacy, legacySource, options.candidate),
    ...discovery.indexed.map((status) =>
      candidateState(status, scopedSource, options.candidate)
    ),
  ];
}

function statusForDiscoveryFailure<T>(
  error: unknown,
  options: BuiltinAuthProviderDiscoveryOptions<T>
): AidePluginAuthStatus {
  if (error instanceof AuthIndexDocumentError) {
    return options.mapStatus({
      kind: 'malformed',
      reason: options.malformedReason,
    });
  }
  if (
    error instanceof KeyringUnavailableError ||
    error instanceof AuthIndexConsistencyError ||
    error instanceof AuthIndexLockError
  ) {
    return options.mapStatus({ kind: 'unreachable' });
  }
  return options.mapStatus({
    kind: 'malformed',
    reason: options.malformedReason,
  });
}

export function discoverBuiltinAuthAccountsEffect<T>(
  options: BuiltinAuthProviderDiscoveryOptions<T>
): Effect.Effect<readonly AideAuthAccount[], unknown, KeyringService> {
  const environment = candidateState(
    options.probeEnvironment(),
    environmentSource,
    options.candidate
  );

  return Effect.flatMap(collectStoredConfigs(options), (discovery) => {
    const states = [environment, ...storedCandidateStates(discovery, options)];
    if (states.some((state) => state.kind === 'unreachable')) {
      return Effect.fail(new KeyringUnavailableError('get'));
    }
    const candidates = states.flatMap((state) =>
      state.kind === 'usable' ? [state.candidate] : []
    );
    return Effect.try({
      try: () => assembleBuiltinAuthAccounts(candidates),
      catch: (error) => error,
    });
  });
}

export function discoverBuiltinAuthStatusEffect<T>(
  options: BuiltinAuthProviderDiscoveryOptions<T>
): Effect.Effect<AidePluginAuthStatus, never, KeyringService> {
  const environmentStatus = options.probeEnvironment();
  const environment = candidateState(
    environmentStatus,
    environmentSource,
    options.candidate
  );
  if (environment.kind === 'usable' && environmentStatus?.kind === 'env') {
    return Effect.succeed(options.mapStatus(environmentStatus));
  }

  return Effect.match(collectStoredConfigs(options), {
    onFailure: (error) => statusForDiscoveryFailure(error, options),
    onSuccess: (discovery) => {
      const stored = storedCandidateStates(discovery, options);
      if (stored.some((state) => state.kind === 'unreachable')) {
        return options.mapStatus({ kind: 'unreachable' });
      }
      const usable = stored.find((state) => state.kind === 'usable');
      if (usable?.kind === 'usable') {
        return options.mapStatus({
          kind: 'keyring',
          value: usable.value,
        });
      }
      if (
        environment.kind === 'malformed' ||
        stored.some((state) => state.kind === 'malformed')
      ) {
        return options.mapStatus({
          kind: 'malformed',
          reason: options.malformedReason,
        });
      }
      return options.mapStatus({ kind: 'missing' });
    },
  });
}
