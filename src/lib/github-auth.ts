/**
 * Host-bound GitHub authentication helpers shared by the client, config
 * probes, and auth store. These helpers accept GitHub Enterprise Server host
 * names as well as the hosts recognized by the repository parser.
 */

import { isProxy } from 'node:util/types';

import * as v from 'valibot';

import {
  StoredGithubLegacySchema,
  StoredGithubScopedSchema,
} from '@schemas/config.js';

export const DEFAULT_GITHUB_HOST = 'github.com';

export const GITHUB_AUTH_ENV_VARS = Object.freeze([
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'GH_HOST',
] as const);

export type GitHubAuthEnvironment = Readonly<
  Record<string, string | undefined>
>;

export interface GitHubEnvironmentCredential {
  readonly host: string;
  readonly token: string;
  readonly variable:
    | 'GITHUB_TOKEN'
    | 'GH_TOKEN'
    | 'GH_ENTERPRISE_TOKEN'
    | 'GITHUB_ENTERPRISE_TOKEN';
}

export interface GitHubAuthScopeInput {
  readonly id?: string;
  readonly providerId?: string;
  readonly host?: string;
  readonly org?: string;
  readonly account?: string;
}

export type GitHubAuthRequestFailureCode =
  | 'invalid-host'
  | 'invalid-account'
  | 'scope-host-mismatch';

export type GitHubCredentialFailureCode =
  | 'malformed-credential'
  | 'scope-host-mismatch'
  | 'account-mismatch';

export type GitHubAuthErrorCode =
  | GitHubAuthRequestFailureCode
  | GitHubCredentialFailureCode
  | 'unqualified-environment-credential'
  | 'not-configured';

export interface CanonicalGitHubAuthRequest {
  readonly ok: true;
  readonly host: string;
  readonly account?: string;
  readonly keyringScope?: GitHubAuthScopeInput;
}

export type GitHubAuthRequestResolution =
  | CanonicalGitHubAuthRequest
  | {
      readonly ok: false;
      readonly code: GitHubAuthRequestFailureCode;
      readonly host: string;
      readonly reason: string;
    };

type OwnDataPropertySnapshot =
  | {
      readonly kind: 'data';
      readonly value: unknown;
      readonly enumerable: boolean;
      readonly configurable: boolean;
      readonly writable: boolean;
    }
  | { readonly kind: 'absent' }
  | { readonly kind: 'invalid' };

/** Read an own field without invoking accessors or walking a prototype. */
function snapshotOwnDataProperty(
  input: object,
  name: string
): OwnDataPropertySnapshot {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(input, name);
    if (descriptor === undefined) return { kind: 'absent' };
    return Object.hasOwn(descriptor, 'value')
      ? {
          kind: 'data',
          value: descriptor.value,
          enumerable: descriptor.enumerable ?? false,
          configurable: descriptor.configurable ?? false,
          writable: descriptor.writable ?? false,
        }
      : { kind: 'invalid' };
  } catch {
    return { kind: 'invalid' };
  }
}

function frozenNullRecord<T extends object>(
  fields: ReadonlyArray<readonly [string, unknown]>
): T {
  const result = Object.create(null) as Record<string, unknown>;
  for (const [name, value] of fields) result[name] = value;
  return Object.freeze(result) as T;
}

function requestFailure(
  code: GitHubAuthRequestFailureCode,
  host: string,
  reason: string
): GitHubAuthRequestResolution {
  return frozenNullRecord([
    ['ok', false],
    ['code', code],
    ['host', host],
    ['reason', reason],
  ]);
}

/** Typed operational failure created only after a pure request resolution. */
export class GitHubAuthRequestError extends Error {
  readonly code: GitHubAuthErrorCode;
  readonly host: string;
  readonly account?: string;

  constructor(
    code: GitHubAuthErrorCode,
    host: string,
    reason: string,
    account?: string
  ) {
    super(reason);
    this.name = 'GitHubAuthRequestError';
    this.code = code;
    this.host = host;
    this.account = account;
  }
}

function explicitPort(value: string): string | undefined {
  const authority =
    /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(value)?.[1] ??
    /^[^/?#]*/.exec(value)?.[0];
  if (authority === undefined) return undefined;
  const match = authority.startsWith('[')
    ? /^\[[^\]]+\]:(\d+)$/.exec(authority)
    : /:(\d+)$/.exec(authority);
  return match?.[1] === undefined ? undefined : String(Number(match[1]));
}

/** Canonical identity used to bind GitHub credentials to a requested host. */
export function canonicalizeGitHubAuthHost(
  rawHost: string | undefined
): string | null {
  const normalized = rawHost?.trim().normalize('NFC');
  if (normalized === undefined || normalized.length === 0) return null;

  try {
    const port = explicitPort(normalized);
    const url = new URL(
      /^[a-z][a-z0-9+.-]*:\/\//i.test(normalized)
        ? normalized
        : `https://${normalized}`
    );
    if (
      url.hostname.length === 0 ||
      url.username.length > 0 ||
      url.password.length > 0
    ) {
      return null;
    }

    const host = `${url.hostname.toLowerCase()}${
      port === undefined ? '' : `:${port}`
    }`;
    if (host === 'ssh.github.com') return DEFAULT_GITHUB_HOST;

    const dataResidencyAlias = /^ssh\.([a-z0-9][a-z0-9-]*\.ghe\.com)$/.exec(
      host
    );
    return dataResidencyAlias?.[1] ?? host;
  } catch {
    return null;
  }
}

/**
 * GitHub login matching is case-insensitive. The canonical returned form is
 * trimmed, NFC-normalized lowercase text.
 */
export function canonicalizeGitHubAuthAccount(
  rawAccount: string | undefined
): string | null {
  const normalized = rawAccount?.trim().normalize('NFC');
  return normalized === undefined || normalized.length === 0
    ? null
    : normalized.toLowerCase();
}

/**
 * Resolve the one canonical host and keyring scope for an auth request.
 * Explicit hosts/scopes always produce an exact-host keyring lookup. Only a
 * request omitting both retains the legacy github.com keyring behavior.
 */
export function resolveGitHubAuthRequest(input: {
  readonly host?: string;
  readonly scope?: GitHubAuthScopeInput;
}): GitHubAuthRequestResolution {
  if (typeof input !== 'object' || input === null || isProxy(input)) {
    return requestFailure(
      'invalid-host',
      DEFAULT_GITHUB_HOST,
      'Invalid GitHub authentication request.'
    );
  }

  const hostProperty = snapshotOwnDataProperty(input, 'host');
  const scopeProperty = snapshotOwnDataProperty(input, 'scope');
  if (
    hostProperty.kind === 'invalid' ||
    (hostProperty.kind === 'data' &&
      hostProperty.value !== undefined &&
      typeof hostProperty.value !== 'string') ||
    scopeProperty.kind === 'invalid'
  ) {
    return requestFailure(
      'invalid-host',
      DEFAULT_GITHUB_HOST,
      'Invalid GitHub authentication request. Host and scope must be own data properties.'
    );
  }

  const scopeValue =
    scopeProperty.kind === 'data' ? scopeProperty.value : undefined;
  if (
    scopeValue !== undefined &&
    (typeof scopeValue !== 'object' ||
      scopeValue === null ||
      isProxy(scopeValue))
  ) {
    return requestFailure(
      'scope-host-mismatch',
      DEFAULT_GITHUB_HOST,
      'Invalid GitHub authentication scope.'
    );
  }

  const scope = scopeValue as GitHubAuthScopeInput | undefined;
  const scopeHostProperty =
    scope === undefined
      ? ({ kind: 'absent' } as const)
      : snapshotOwnDataProperty(scope, 'host');
  const providerProperty =
    scope === undefined
      ? ({ kind: 'absent' } as const)
      : snapshotOwnDataProperty(scope, 'providerId');
  const accountProperty =
    scope === undefined
      ? ({ kind: 'absent' } as const)
      : snapshotOwnDataProperty(scope, 'account');

  if (
    scopeHostProperty.kind === 'invalid' ||
    (scopeHostProperty.kind === 'data' &&
      scopeHostProperty.value !== undefined &&
      typeof scopeHostProperty.value !== 'string') ||
    providerProperty.kind === 'invalid' ||
    (providerProperty.kind === 'data' &&
      providerProperty.value !== undefined &&
      typeof providerProperty.value !== 'string')
  ) {
    return requestFailure(
      'scope-host-mismatch',
      DEFAULT_GITHUB_HOST,
      'Invalid GitHub authentication scope. Identity fields must be own data properties.'
    );
  }
  if (
    accountProperty.kind === 'invalid' ||
    (accountProperty.kind === 'data' &&
      accountProperty.value !== undefined &&
      typeof accountProperty.value !== 'string')
  ) {
    return requestFailure(
      'invalid-account',
      DEFAULT_GITHUB_HOST,
      'Invalid GitHub authentication account. Account must be an own string data property.'
    );
  }

  const explicitHost =
    hostProperty.kind === 'data' && hostProperty.value !== undefined
      ? (hostProperty.value as string)
      : undefined;
  const scopeHost =
    scopeHostProperty.kind === 'data' && scopeHostProperty.value !== undefined
      ? (scopeHostProperty.value as string)
      : undefined;
  const rawHost = explicitHost ?? scopeHost ?? DEFAULT_GITHUB_HOST;
  const host = canonicalizeGitHubAuthHost(rawHost);
  if (host === null) {
    return requestFailure(
      'invalid-host',
      rawHost,
      `Invalid GitHub authentication ${scope === undefined ? 'host' : 'scope host'} '${rawHost}'.`
    );
  }

  const rawAccount =
    accountProperty.kind === 'data' && accountProperty.value !== undefined
      ? (accountProperty.value as string)
      : undefined;
  const hasExplicitAccount = rawAccount !== undefined;
  const account = canonicalizeGitHubAuthAccount(rawAccount);
  if (hasExplicitAccount && account === null) {
    return requestFailure(
      'invalid-account',
      host,
      'Invalid GitHub authentication account. An explicitly provided account cannot be blank.'
    );
  }

  if (scope !== undefined) {
    const rawProviderId =
      providerProperty.kind === 'data' && providerProperty.value !== undefined
        ? (providerProperty.value as string)
        : undefined;
    const providerId = rawProviderId?.trim().toLowerCase();
    const canonicalScopeHost = canonicalizeGitHubAuthHost(scopeHost);
    if (
      (providerId !== undefined && providerId !== 'github') ||
      canonicalScopeHost !== host
    ) {
      const detail =
        providerId !== undefined && providerId !== 'github'
          ? `The scope belongs to provider '${rawProviderId}'.`
          : canonicalScopeHost === null
            ? 'The explicit scope has no valid GitHub host.'
            : `The scope resolves to '${canonicalScopeHost}'.`;
      return requestFailure(
        'scope-host-mismatch',
        host,
        `GitHub credential scope does not match requested host '${host}'. ${detail}`
      );
    }
    const keyringScope = frozenNullRecord<GitHubAuthScopeInput>([
      ['providerId', 'github'],
      ['host', host],
      ...(account === null ? [] : ([['account', account]] as const)),
    ]);
    return frozenNullRecord<CanonicalGitHubAuthRequest>([
      ['ok', true],
      ['host', host],
      ...(account === null ? [] : ([['account', account]] as const)),
      ['keyringScope', keyringScope],
    ]);
  }

  if (explicitHost === undefined) {
    return frozenNullRecord<CanonicalGitHubAuthRequest>([
      ['ok', true],
      ['host', host],
    ]);
  }
  return frozenNullRecord<CanonicalGitHubAuthRequest>([
    ['ok', true],
    ['host', host],
    [
      'keyringScope',
      frozenNullRecord<GitHubAuthScopeInput>([
        ['providerId', 'github'],
        ['host', host],
      ]),
    ],
  ]);
}

function canonicalizeGitHubEnvironmentHost(rawHost: string): string | null {
  const normalized = rawHost.trim();
  // GH_HOST is a hostname, not a URL or repository path. Reject those forms
  // instead of interpreting a malformed binding more permissively than gh.
  if (
    normalized.length === 0 ||
    /^[a-z][a-z0-9+.-]*:\/\//i.test(normalized) ||
    /[/?#@]/.test(normalized)
  ) {
    return null;
  }
  return canonicalizeGitHubAuthHost(normalized);
}

/**
 * Resolve an environment token for one canonical requested host.
 *
 * Precedence is intentionally host-specific:
 * - github.com: GITHUB_TOKEN, then GH_TOKEN (the historical aide order).
 * - enterprise: GH_ENTERPRISE_TOKEN, then GITHUB_ENTERPRISE_TOKEN, but only
 *   when an explicit GH_HOST binding canonically matches the requested host.
 *
 * Public tokens are never candidates for enterprise hosts, including ghe.com.
 */
export function githubEnvironmentCredential(
  requestedHost: string,
  env: GitHubAuthEnvironment = Bun.env,
  requestedAccount?: string
): GitHubEnvironmentCredential | null {
  // Standard GitHub token variables carry no independently verifiable login.
  if (requestedAccount !== undefined) return null;

  const host = canonicalizeGitHubAuthHost(requestedHost);
  if (host === null) return null;

  const snapshot = snapshotGitHubAuthEnvironment(env);
  if (snapshot === null) return null;

  if (host === DEFAULT_GITHUB_HOST) {
    if (snapshot.GITHUB_TOKEN) {
      return {
        host,
        token: snapshot.GITHUB_TOKEN,
        variable: 'GITHUB_TOKEN',
      };
    }
    if (snapshot.GH_TOKEN) {
      return { host, token: snapshot.GH_TOKEN, variable: 'GH_TOKEN' };
    }
    return null;
  }

  const environmentHost = snapshot.GH_HOST;
  if (
    environmentHost === undefined ||
    canonicalizeGitHubEnvironmentHost(environmentHost) !== host
  ) {
    return null;
  }

  if (snapshot.GH_ENTERPRISE_TOKEN) {
    return {
      host,
      token: snapshot.GH_ENTERPRISE_TOKEN,
      variable: 'GH_ENTERPRISE_TOKEN',
    };
  }
  if (snapshot.GITHUB_ENTERPRISE_TOKEN) {
    return {
      host,
      token: snapshot.GITHUB_ENTERPRISE_TOKEN,
      variable: 'GITHUB_ENTERPRISE_TOKEN',
    };
  }
  return null;
}

/** Snapshot only allowlisted auth fields without consulting an env prototype. */
export function snapshotGitHubAuthEnvironment(
  env: GitHubAuthEnvironment
): GitHubAuthEnvironment | null {
  if (typeof env !== 'object' || env === null || isProxy(env)) return null;

  const fields: Array<readonly [string, unknown]> = [];
  for (const variable of GITHUB_AUTH_ENV_VARS) {
    const property = snapshotOwnDataProperty(env, variable);
    if (
      property.kind === 'invalid' ||
      (property.kind === 'data' &&
        property.value !== undefined &&
        typeof property.value !== 'string')
    ) {
      return null;
    }
    fields.push([
      variable,
      property.kind === 'data' ? property.value : undefined,
    ]);
  }
  return frozenNullRecord<GitHubAuthEnvironment>(fields);
}

export interface GitHubStoredCredentialSuccess {
  readonly ok: true;
  readonly token: string;
  readonly host: string;
  readonly account?: string;
}

export interface GitHubStoredCredentialFailure {
  readonly ok: false;
  readonly code: GitHubCredentialFailureCode;
  readonly reason: string;
}

export type GitHubStoredCredentialValidation =
  | GitHubStoredCredentialSuccess
  | GitHubStoredCredentialFailure;

function malformedStoredCredential(
  reason?: string
): GitHubStoredCredentialFailure {
  return {
    ok: false,
    code: 'malformed-credential',
    reason:
      reason ??
      "Stored GitHub credentials are malformed. Re-run 'aide login github' to reconfigure.",
  };
}

type StoredPayloadSnapshot =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly legacyIdentity: boolean };

function hasJsonDataDescriptors(
  input: unknown,
  inheritedCredentialFields: readonly string[]
): input is Record<string, unknown> {
  if (typeof input !== 'object' || input === null || isProxy(input)) {
    return false;
  }

  try {
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== null) {
      if (
        prototype !== Object.prototype ||
        Object.getPrototypeOf(prototype) !== null
      ) {
        return false;
      }
      for (const name of inheritedCredentialFields) {
        if (
          Object.getOwnPropertyDescriptor(input, name) === undefined &&
          Object.getOwnPropertyDescriptor(prototype, name) !== undefined
        ) {
          return false;
        }
      }
    }

    for (const key of Reflect.ownKeys(input)) {
      if (typeof key !== 'string') return false;
      const property = snapshotOwnDataProperty(input, key);
      if (
        property.kind !== 'data' ||
        !property.configurable ||
        !property.enumerable ||
        !property.writable
      ) {
        return false;
      }
    }
  } catch {
    return false;
  }

  return true;
}

function isJsonDataProperty(
  property: OwnDataPropertySnapshot
): property is Extract<OwnDataPropertySnapshot, { readonly kind: 'data' }> {
  return (
    property.kind === 'data' &&
    property.configurable &&
    property.enumerable &&
    property.writable
  );
}

function snapshotStoredPayload(
  json: unknown,
  storageKind: 'legacy' | 'scoped'
): StoredPayloadSnapshot {
  if (!hasJsonDataDescriptors(json, ['token', 'identity'])) {
    return { ok: false, legacyIdentity: false };
  }

  const tokenProperty = snapshotOwnDataProperty(json, 'token');
  const identityProperty = snapshotOwnDataProperty(json, 'identity');
  if (!isJsonDataProperty(tokenProperty)) {
    return { ok: false, legacyIdentity: false };
  }

  if (storageKind === 'legacy') {
    if (identityProperty.kind !== 'absent') {
      return {
        ok: false,
        legacyIdentity: isJsonDataProperty(identityProperty),
      };
    }
    return {
      ok: true,
      value: frozenNullRecord([['token', tokenProperty.value]]),
    };
  }

  if (
    !isJsonDataProperty(identityProperty) ||
    !hasJsonDataDescriptors(identityProperty.value, ['host', 'account'])
  ) {
    return { ok: false, legacyIdentity: false };
  }

  const hostProperty = snapshotOwnDataProperty(identityProperty.value, 'host');
  const accountProperty = snapshotOwnDataProperty(
    identityProperty.value,
    'account'
  );
  if (
    !isJsonDataProperty(hostProperty) ||
    (accountProperty.kind !== 'absent' && !isJsonDataProperty(accountProperty))
  ) {
    return { ok: false, legacyIdentity: false };
  }

  const identity = frozenNullRecord([
    ['host', hostProperty.value],
    [
      'account',
      accountProperty.kind === 'data' ? accountProperty.value : undefined,
    ],
  ]);
  return {
    ok: true,
    value: frozenNullRecord([
      ['token', tokenProperty.value],
      ['identity', identity],
    ]),
  };
}

/**
 * Pure, key-aware validation for a selected GitHub keyring payload.
 * Token-only blobs are intentionally accepted only from the legacy key.
 */
export function validateGitHubStoredCredential(
  request: CanonicalGitHubAuthRequest,
  storageKind: 'legacy' | 'scoped',
  raw: string
): GitHubStoredCredentialValidation {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return malformedStoredCredential();
  }

  const snapshot = snapshotStoredPayload(json, storageKind);
  if (!snapshot.ok) {
    return snapshot.legacyIdentity
      ? malformedStoredCredential(
          'A legacy GitHub credential cannot contain scoped identity metadata.'
        )
      : malformedStoredCredential();
  }

  if (storageKind === 'legacy') {
    if (request.keyringScope !== undefined) {
      return malformedStoredCredential(
        'A legacy GitHub credential cannot satisfy a scoped authentication request.'
      );
    }
    const parsed = v.safeParse(StoredGithubLegacySchema, snapshot.value);
    return parsed.success
      ? {
          ok: true,
          token: parsed.output.token,
          host: request.host,
        }
      : malformedStoredCredential();
  }

  const parsed = v.safeParse(StoredGithubScopedSchema, snapshot.value);
  if (!parsed.success) {
    return malformedStoredCredential(
      'Stored scoped GitHub credentials have no valid identity. ' +
        "Re-run 'aide login github' to migrate this credential."
    );
  }

  const storedHost = canonicalizeGitHubAuthHost(parsed.output.identity.host);
  if (storedHost === null) return malformedStoredCredential();
  if (storedHost !== request.host) {
    return {
      ok: false,
      code: 'scope-host-mismatch',
      reason: `Stored GitHub credential host '${storedHost}' does not match requested host '${request.host}'.`,
    };
  }

  const hasStoredAccount = parsed.output.identity.account !== undefined;
  const storedAccount = canonicalizeGitHubAuthAccount(
    parsed.output.identity.account
  );
  if (hasStoredAccount && storedAccount === null) {
    return malformedStoredCredential();
  }
  if (storedAccount !== (request.account ?? null)) {
    return {
      ok: false,
      code: 'account-mismatch',
      reason:
        `Stored GitHub credential account '${storedAccount ?? '(host-only)'}' ` +
        `does not match requested account '${request.account ?? '(host-only)'}'.`,
    };
  }

  return {
    ok: true,
    token: parsed.output.token,
    host: storedHost,
    ...(storedAccount === null ? {} : { account: storedAccount }),
  };
}

/** Build the generation-appropriate payload for one resolved request. */
export function githubStoredCredentialPayload(
  request: CanonicalGitHubAuthRequest,
  token: string
):
  | { readonly token: string }
  | {
      readonly token: string;
      readonly identity: { readonly host: string; readonly account?: string };
    } {
  if (request.keyringScope === undefined) return { token };
  return {
    token,
    identity: {
      host: request.host,
      ...(request.account === undefined ? {} : { account: request.account }),
    },
  };
}

/** Remove auth-selection variables before exact-host gh probes/transports. */
export function githubCliEnvironment(
  env: GitHubAuthEnvironment = Bun.env
): Record<string, string | undefined> {
  const sanitized = Object.create(null) as Record<string, string | undefined>;
  if (isProxy(env)) return Object.freeze(sanitized);
  let keys: readonly (string | symbol)[];
  try {
    keys = Reflect.ownKeys(env);
  } catch {
    return Object.freeze(sanitized);
  }

  for (const key of keys) {
    if (
      typeof key !== 'string' ||
      key === 'GH_TOKEN' ||
      key === 'GITHUB_TOKEN' ||
      key === 'GH_ENTERPRISE_TOKEN' ||
      key === 'GITHUB_ENTERPRISE_TOKEN' ||
      key === 'GH_HOST'
    ) {
      continue;
    }
    const property = snapshotOwnDataProperty(env, key);
    if (
      property.kind !== 'data' ||
      !property.enumerable ||
      (property.value !== undefined && typeof property.value !== 'string')
    ) {
      continue;
    }
    sanitized[key] = property.value as string | undefined;
  }
  return Object.freeze(sanitized);
}
