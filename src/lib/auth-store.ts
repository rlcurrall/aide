import { Effect } from 'effect';

import {
  deleteSecret,
  getSecret,
  setSecret,
  type LegacySecretName,
  type ScopedSecretName,
  type StoredSecretName,
} from './secrets.js';

export const legacyAuthSecretNames = Object.freeze({
  jira: 'jira',
  'azure-devops': 'ado',
  github: 'github',
} as const satisfies Record<string, LegacySecretName>);

export type BuiltinAuthProviderId = keyof typeof legacyAuthSecretNames;
export type AuthProviderId = BuiltinAuthProviderId | 'ado' | (string & {});

export interface AuthStoreScope {
  readonly id?: string;
  readonly providerId?: string;
  readonly host?: string;
  readonly org?: string;
  readonly account?: string;
}

export interface NormalizedAuthStoreScope {
  readonly providerId: string;
  readonly host?: string;
  readonly org?: string;
  readonly account?: string;
}

export type AuthSecretStorageKind = 'scoped' | 'legacy';

export interface AuthSecretReference {
  readonly name: StoredSecretName;
  readonly kind: AuthSecretStorageKind;
  readonly providerId: string;
  readonly scope?: NormalizedAuthStoreScope;
}

export interface ResolvedAuthSecret extends AuthSecretReference {
  readonly value: string;
}

const providerAliases = Object.freeze({
  ado: 'azure-devops',
} as const);

function normalizeNonEmpty(value: string | undefined): string | undefined {
  const normalized = value?.trim().normalize('NFC');
  return normalized === undefined || normalized.length === 0
    ? undefined
    : normalized;
}

export function normalizeAuthProviderId(
  providerId: string
): string | undefined {
  const normalized = normalizeNonEmpty(providerId)?.toLowerCase();
  if (normalized === undefined) return undefined;
  return (
    providerAliases[normalized as keyof typeof providerAliases] ?? normalized
  );
}

function normalizeHost(host: string | undefined): string | undefined {
  const normalized = normalizeNonEmpty(host);
  if (normalized === undefined) return undefined;

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(normalized)) {
    try {
      return new URL(normalized).host.toLowerCase();
    } catch {
      return normalized.toLowerCase();
    }
  }

  return normalized.toLowerCase();
}

// Key values are normalized by role, then URI-component encoded so ':' remains
// a structural separator and exact key strings stay deterministic in tests.
export function encodeAuthStoreKeySegment(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

export function normalizeAuthStoreScope(
  providerId: AuthProviderId,
  scope: AuthStoreScope | undefined
): NormalizedAuthStoreScope | null {
  const normalizedProviderId = normalizeAuthProviderId(providerId);
  if (normalizedProviderId === undefined) return null;
  const host = normalizeHost(scope?.host);
  const org = normalizeNonEmpty(scope?.org);
  const account = normalizeNonEmpty(scope?.account);

  return {
    providerId: normalizedProviderId,
    ...(host === undefined ? {} : { host }),
    ...(org === undefined ? {} : { org }),
    ...(account === undefined ? {} : { account }),
  };
}

export function legacyAuthSecretName(
  providerId: AuthProviderId
): LegacySecretName | null {
  const normalizedProviderId = normalizeAuthProviderId(providerId);
  if (normalizedProviderId === undefined) return null;

  return (
    legacyAuthSecretNames[
      normalizedProviderId as keyof typeof legacyAuthSecretNames
    ] ?? null
  );
}

function buildScopedName(
  providerId: string,
  parts: readonly (readonly [string, string])[]
): ScopedSecretName {
  const encoded = [
    'auth',
    encodeAuthStoreKeySegment(providerId),
    ...parts.flatMap(([key, value]) => [key, encodeAuthStoreKeySegment(value)]),
  ];
  return encoded.join(':') as ScopedSecretName;
}

export function scopedAuthSecretName(
  providerId: AuthProviderId,
  scope: AuthStoreScope | undefined
): ScopedSecretName | null {
  const normalized = normalizeAuthStoreScope(providerId, scope);
  if (normalized === null || normalized.host === undefined) return null;

  switch (normalized.providerId) {
    case 'jira':
      if (normalized.account === undefined) return null;
      return buildScopedName(normalized.providerId, [
        ['host', normalized.host],
        ['account', normalized.account],
      ]);
    case 'azure-devops':
      if (normalized.org === undefined) return null;
      return buildScopedName(normalized.providerId, [
        ['host', normalized.host],
        ['org', normalized.org],
      ]);
    case 'github':
      return buildScopedName(
        normalized.providerId,
        normalized.account === undefined
          ? [['host', normalized.host]]
          : [
              ['host', normalized.host],
              ['account', normalized.account],
            ]
      );
    default: {
      const parts: Array<readonly [string, string]> = [
        ['host', normalized.host],
      ];
      if (normalized.org !== undefined) parts.push(['org', normalized.org]);
      if (normalized.account !== undefined) {
        parts.push(['account', normalized.account]);
      }
      return buildScopedName(normalized.providerId, parts);
    }
  }
}

export function authSecretCandidates(
  providerId: AuthProviderId,
  scope: AuthStoreScope | undefined
): readonly AuthSecretReference[] {
  const normalized = normalizeAuthStoreScope(providerId, scope);
  const scopedName = scopedAuthSecretName(providerId, scope);
  const legacyName = legacyAuthSecretName(providerId);
  const candidates: AuthSecretReference[] = [];

  if (scopedName !== null && normalized !== null) {
    candidates.push({
      name: scopedName,
      kind: 'scoped',
      providerId: normalized.providerId,
      scope: normalized,
    });
  }

  if (legacyName !== null && normalized !== null) {
    candidates.push({
      name: legacyName,
      kind: 'legacy',
      providerId: normalized.providerId,
    });
  }

  return Object.freeze(candidates);
}

export function authSecretTarget(
  providerId: AuthProviderId,
  scope: AuthStoreScope | undefined
): AuthSecretReference | null {
  const candidates = authSecretCandidates(providerId, scope);
  return candidates[0] ?? null;
}

export function readAuthSecret(
  reference: AuthSecretReference
): Effect.Effect<ResolvedAuthSecret | null, unknown, never> {
  return Effect.tryPromise({
    try: async () => {
      const value = await getSecret(reference.name);
      return value === null ? null : { ...reference, value };
    },
    catch: (error) => error,
  });
}

export function resolveAuthSecret(
  providerId: AuthProviderId,
  scope?: AuthStoreScope
): Effect.Effect<ResolvedAuthSecret | null, unknown, never> {
  return Effect.gen(function* () {
    for (const candidate of authSecretCandidates(providerId, scope)) {
      const resolved = yield* readAuthSecret(candidate);
      if (resolved !== null) return resolved;
    }
    return null;
  });
}

export function listAuthSecrets(
  providerId: AuthProviderId,
  scope?: AuthStoreScope
): Effect.Effect<readonly ResolvedAuthSecret[], unknown, never> {
  return Effect.gen(function* () {
    const resolved: ResolvedAuthSecret[] = [];
    for (const candidate of authSecretCandidates(providerId, scope)) {
      const entry = yield* readAuthSecret(candidate);
      if (entry !== null) resolved.push(entry);
    }
    return Object.freeze(resolved);
  });
}

export function writeAuthSecret(
  providerId: AuthProviderId,
  value: string,
  scope?: AuthStoreScope
): Effect.Effect<AuthSecretReference, unknown, never> {
  const target = authSecretTarget(providerId, scope);
  if (target === null) {
    return Effect.fail(
      new Error(`Cannot build an auth secret key for provider '${providerId}'.`)
    );
  }

  return Effect.tryPromise({
    try: async () => {
      await setSecret(target.name, value);
      return target;
    },
    catch: (error) => error,
  });
}

export function deleteAuthSecret(
  providerId: AuthProviderId,
  scope?: AuthStoreScope
): Effect.Effect<boolean, unknown, never> {
  const target = authSecretTarget(providerId, scope);
  if (target === null) {
    return Effect.fail(
      new Error(`Cannot build an auth secret key for provider '${providerId}'.`)
    );
  }

  return Effect.tryPromise({
    try: () => deleteSecret(target.name),
    catch: (error) => error,
  });
}
