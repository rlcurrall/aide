import { isProxy } from 'node:util/types';

import { Data, Effect } from 'effect';

import { canonicalizeAzureDevOpsAuthIdentity } from './azure-devops-auth-identity.js';
import {
  canonicalizeGitHubAuthAccount,
  canonicalizeGitHubAuthHost,
} from './github-auth.js';
import type {
  AuthIndexSecretName,
  LegacySecretName,
  ScopedSecretName,
} from './auth-keyring.js';

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

export const AUTH_INDEX_VERSION = 1 as const;

export type AuthIndexDocumentFailureCode =
  | 'malformed-json'
  | 'invalid-document'
  | 'unsupported-version'
  | 'provider-mismatch'
  | 'invalid-scope'
  | 'noncanonical-scope'
  | 'noncanonical-document'
  | 'duplicate-scope';

export class AuthIndexProviderError extends Data.TaggedError(
  'AuthIndexProviderError'
)<{}> {
  constructor() {
    super();
  }

  override get message(): string {
    return 'Cannot build an auth index key for an invalid provider id.';
  }
}

interface AuthIndexDocumentErrorFields {
  readonly code: AuthIndexDocumentFailureCode;
  readonly providerId: string;
}

export class AuthIndexDocumentError extends Data.TaggedError(
  'AuthIndexDocumentError'
)<AuthIndexDocumentErrorFields> {
  constructor(code: AuthIndexDocumentFailureCode, providerId: string) {
    super({ code, providerId });
  }

  override get message(): string {
    return `The ${this.providerId} auth index is invalid (${this.code}).`;
  }
}

export interface AuthIndexDocument {
  readonly version: typeof AUTH_INDEX_VERSION;
  readonly providerId: string;
  readonly scopes: readonly NormalizedAuthStoreScope[];
}

const providerAliases: ReadonlyMap<string, string> = new Map([
  ['ado', 'azure-devops'],
]);
const canonicalProviderIdPattern = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const dangerousProviderIds = new Set([
  '__definegetter__',
  '__definesetter__',
  '__lookupgetter__',
  '__lookupsetter__',
  '__proto__',
  'constructor',
  'hasownproperty',
  'isprototypeof',
  'propertyisenumerable',
  'prototype',
  'tolocalestring',
  'tostring',
  'valueof',
]);

function normalizeNonEmpty(value: string | undefined): string | undefined {
  if (value !== undefined && typeof value !== 'string') return undefined;
  const normalized = value?.trim().normalize('NFC');
  return normalized === undefined || normalized.length === 0
    ? undefined
    : normalized;
}

function trimAsciiWhitespace(value: string): string {
  return value.replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g, '');
}

function isAscii(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 0x7f) return false;
  }
  return true;
}

export function isWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const trailingCodeUnit = value.charCodeAt(index + 1);
      if (trailingCodeUnit < 0xdc00 || trailingCodeUnit > 0xdfff) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function normalizeJiraAccount(value: string | undefined): string | undefined {
  return normalizeNonEmpty(value)?.toLowerCase();
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

export function normalizeAuthProviderId(
  providerId: string
): string | undefined {
  if (typeof providerId !== 'string') return undefined;

  const source = trimAsciiWhitespace(providerId);
  if (!isAscii(source)) return undefined;

  const normalized = source.toLowerCase();
  if (
    !canonicalProviderIdPattern.test(normalized) ||
    dangerousProviderIds.has(normalized)
  ) {
    return undefined;
  }

  return providerAliases.get(normalized) ?? normalized;
}

function normalizeHost(host: string | undefined): string | undefined {
  const normalized = normalizeNonEmpty(host);
  if (normalized === undefined) return undefined;

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
      return undefined;
    }
    return `${url.hostname.toLowerCase()}${port === undefined ? '' : `:${port}`}`;
  } catch {
    return undefined;
  }
}

export function encodeAuthStoreKeySegment(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

export function authIndexSecretName(
  providerId: AuthProviderId
): AuthIndexSecretName {
  const normalizedProviderId = normalizeAuthProviderId(providerId);
  if (normalizedProviderId === undefined) throw new AuthIndexProviderError();
  return `auth-index:v${AUTH_INDEX_VERSION}:provider:${encodeAuthStoreKeySegment(normalizedProviderId)}`;
}

type AuthScopePropertySnapshot =
  | { readonly kind: 'data'; readonly value: string | undefined }
  | { readonly kind: 'absent' }
  | { readonly kind: 'invalid' };

function snapshotAuthScopeProperty(
  scope: object,
  name: string
): AuthScopePropertySnapshot {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(scope, name);
    if (descriptor === undefined) return { kind: 'absent' };
    if (!Object.hasOwn(descriptor, 'value')) return { kind: 'invalid' };
    return descriptor.value === undefined ||
      typeof descriptor.value === 'string'
      ? { kind: 'data', value: descriptor.value }
      : { kind: 'invalid' };
  } catch {
    return { kind: 'invalid' };
  }
}

type AuthScopeSnapshot = Readonly<
  Record<'id' | 'providerId' | 'host' | 'org' | 'account', string | undefined>
>;

function snapshotAuthStoreScope(
  scope: AuthStoreScope
): AuthScopeSnapshot | null {
  if (
    typeof scope !== 'object' ||
    scope === null ||
    isProxy(scope) ||
    Array.isArray(scope)
  ) {
    return null;
  }

  const fields = Object.create(null) as Record<
    keyof AuthScopeSnapshot,
    string | undefined
  >;
  for (const name of ['id', 'providerId', 'host', 'org', 'account'] as const) {
    const property = snapshotAuthScopeProperty(scope, name);
    if (property.kind === 'invalid') return null;
    if (
      name !== 'id' &&
      property.kind === 'data' &&
      property.value !== undefined &&
      !isWellFormedUtf16(property.value)
    ) {
      return null;
    }
    fields[name] = property.kind === 'data' ? property.value : undefined;
  }
  return Object.freeze(fields);
}

function normalizedAuthStoreScope(
  fields: ReadonlyArray<readonly [keyof NormalizedAuthStoreScope, string]>
): NormalizedAuthStoreScope {
  const providerId = fields.find(([name]) => name === 'providerId')?.[1];
  if (providerId === undefined) {
    throw new AuthIndexProviderError();
  }
  const normalized: Record<string, string> & { providerId: string } =
    Object.assign(Object.create(null), { providerId });
  for (const [name, value] of fields) normalized[name] = value;
  return Object.freeze(normalized);
}

export function normalizeAuthStoreScope(
  providerId: AuthProviderId,
  scope: AuthStoreScope | undefined
): NormalizedAuthStoreScope | null {
  const normalizedProviderId = normalizeAuthProviderId(providerId);
  if (normalizedProviderId === undefined) return null;
  if (scope === undefined) {
    return normalizedAuthStoreScope([['providerId', normalizedProviderId]]);
  }

  const scopeSnapshot = snapshotAuthStoreScope(scope);
  if (scopeSnapshot === null) return null;

  if (scopeSnapshot.providerId !== undefined) {
    const scopeProviderId = normalizeAuthProviderId(scopeSnapshot.providerId);
    if (scopeProviderId !== normalizedProviderId) return null;
  }

  const account =
    normalizedProviderId === 'jira'
      ? normalizeJiraAccount(scopeSnapshot.account)
      : normalizeNonEmpty(scopeSnapshot.account);

  switch (normalizedProviderId) {
    case 'jira': {
      const host = normalizeHost(scopeSnapshot.host);
      if (host === undefined || account === undefined) return null;
      return normalizedAuthStoreScope([
        ['providerId', normalizedProviderId],
        ['host', host],
        ['account', account],
      ]);
    }
    case 'azure-devops': {
      if (scopeSnapshot.host === undefined) return null;
      const identity = canonicalizeAzureDevOpsAuthIdentity({
        host: scopeSnapshot.host,
        org: scopeSnapshot.org,
      });
      if (identity === null) return null;
      return normalizedAuthStoreScope([
        ['providerId', normalizedProviderId],
        ['host', identity.host],
        ['org', identity.org],
      ]);
    }
    case 'github': {
      const host = canonicalizeGitHubAuthHost(scopeSnapshot.host);
      if (host === null) return null;
      const githubAccount = canonicalizeGitHubAuthAccount(
        scopeSnapshot.account
      );
      if (scopeSnapshot.account !== undefined && githubAccount === null) {
        return null;
      }
      return normalizedAuthStoreScope([
        ['providerId', normalizedProviderId],
        ['host', host],
        ...(githubAccount === null
          ? []
          : ([['account', githubAccount]] as const)),
      ]);
    }
  }

  const host = normalizeHost(scopeSnapshot.host);
  const org = normalizeNonEmpty(scopeSnapshot.org);
  return normalizedAuthStoreScope([
    ['providerId', normalizedProviderId],
    ...(host === undefined ? [] : ([['host', host]] as const)),
    ...(org === undefined ? [] : ([['org', org]] as const)),
    ...(account === undefined ? [] : ([['account', account]] as const)),
  ]);
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
  return [
    'auth',
    encodeAuthStoreKeySegment(providerId),
    ...parts.flatMap(([key, value]) => [key, encodeAuthStoreKeySegment(value)]),
  ].join(':') as ScopedSecretName;
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

const authIndexDocumentFields = Object.freeze([
  'version',
  'providerId',
  'scopes',
] as const);
const authIndexScopeFields = Object.freeze([
  'providerId',
  'host',
  'org',
  'account',
] as const);

function hasExactOwnDataFields(
  value: unknown,
  allowedFields: readonly string[],
  requiredFields: readonly string[]
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;

  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string')) return false;
  const stringKeys = keys as string[];
  if (stringKeys.some((key) => !allowedFields.includes(key))) return false;
  if (requiredFields.some((key) => !stringKeys.includes(key))) return false;
  return stringKeys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return (
      descriptor !== undefined &&
      Object.hasOwn(descriptor, 'value') &&
      descriptor.enumerable === true
    );
  });
}

function documentError(
  code: AuthIndexDocumentFailureCode,
  providerId: string
): AuthIndexDocumentError {
  return new AuthIndexDocumentError(code, providerId);
}

export function authIndexScopeName(
  scope: NormalizedAuthStoreScope
): ScopedSecretName {
  const name = scopedAuthSecretName(scope.providerId, scope);
  if (name === null) {
    throw documentError('invalid-scope', scope.providerId);
  }
  return name;
}

function compareAuthIndexScopes(
  left: NormalizedAuthStoreScope,
  right: NormalizedAuthStoreScope
): number {
  const leftName = authIndexScopeName(left);
  const rightName = authIndexScopeName(right);
  return leftName < rightName ? -1 : leftName > rightName ? 1 : 0;
}

export function makeAuthIndexDocument(
  providerId: string,
  scopes: readonly NormalizedAuthStoreScope[]
): AuthIndexDocument {
  return Object.freeze({
    version: AUTH_INDEX_VERSION,
    providerId,
    scopes: Object.freeze([...scopes].sort(compareAuthIndexScopes)),
  });
}

export function emptyAuthIndexDocument(providerId: string): AuthIndexDocument {
  return makeAuthIndexDocument(providerId, []);
}

export function serializeAuthIndexDocument(
  document: AuthIndexDocument
): string {
  return JSON.stringify({
    version: document.version,
    providerId: document.providerId,
    scopes: document.scopes,
  });
}

/** Decode hostile bytes without allowing a known document failure to defect. */
export function parseAuthIndexDocument(
  raw: string,
  expectedProviderId: string
): Effect.Effect<AuthIndexDocument, AuthIndexDocumentError> {
  return Effect.suspend(() => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return Effect.fail(documentError('malformed-json', expectedProviderId));
    }

    if (
      !hasExactOwnDataFields(
        parsed,
        authIndexDocumentFields,
        authIndexDocumentFields
      )
    ) {
      return Effect.fail(documentError('invalid-document', expectedProviderId));
    }
    if (parsed.version !== AUTH_INDEX_VERSION) {
      return Effect.fail(
        documentError('unsupported-version', expectedProviderId)
      );
    }
    if (parsed.providerId !== expectedProviderId) {
      return Effect.fail(
        documentError('provider-mismatch', expectedProviderId)
      );
    }
    if (!Array.isArray(parsed.scopes)) {
      return Effect.fail(documentError('invalid-document', expectedProviderId));
    }

    const names = new Set<string>();
    const scopes: NormalizedAuthStoreScope[] = [];
    for (const entry of parsed.scopes) {
      if (
        !hasExactOwnDataFields(entry, authIndexScopeFields, [
          'providerId',
          'host',
        ]) ||
        typeof entry.providerId !== 'string' ||
        typeof entry.host !== 'string' ||
        (entry.org !== undefined && typeof entry.org !== 'string') ||
        (entry.account !== undefined && typeof entry.account !== 'string')
      ) {
        return Effect.fail(documentError('invalid-scope', expectedProviderId));
      }
      if (entry.providerId !== expectedProviderId) {
        return Effect.fail(
          documentError('provider-mismatch', expectedProviderId)
        );
      }
      if (
        !isWellFormedUtf16(entry.host) ||
        (entry.org !== undefined && !isWellFormedUtf16(entry.org)) ||
        (entry.account !== undefined && !isWellFormedUtf16(entry.account))
      ) {
        return Effect.fail(documentError('invalid-scope', expectedProviderId));
      }

      const scopeInput: AuthStoreScope = {
        providerId: entry.providerId,
        host: entry.host,
        ...(entry.org === undefined ? {} : { org: entry.org }),
        ...(entry.account === undefined ? {} : { account: entry.account }),
      };
      const normalized = normalizeAuthStoreScope(
        expectedProviderId,
        scopeInput
      );
      if (normalized === null || normalized.host === undefined) {
        return Effect.fail(documentError('invalid-scope', expectedProviderId));
      }

      const normalizedKeys = Object.keys(normalized);
      const entryKeys = Object.keys(entry);
      if (
        normalizedKeys.length !== entryKeys.length ||
        normalizedKeys.some(
          (key) =>
            !entryKeys.includes(key) ||
            normalized[key as keyof NormalizedAuthStoreScope] !== entry[key]
        )
      ) {
        return Effect.fail(
          documentError('noncanonical-scope', expectedProviderId)
        );
      }

      const name = authIndexScopeName(normalized);
      if (names.has(name)) {
        return Effect.fail(
          documentError('duplicate-scope', expectedProviderId)
        );
      }
      names.add(name);
      scopes.push(normalized);
    }

    const document = makeAuthIndexDocument(expectedProviderId, scopes);
    if (raw !== serializeAuthIndexDocument(document)) {
      return Effect.fail(
        documentError('noncanonical-document', expectedProviderId)
      );
    }
    return Effect.succeed(document);
  });
}

export function upsertAuthIndexScope(
  document: AuthIndexDocument,
  scope: NormalizedAuthStoreScope
): AuthIndexDocument {
  const targetName = authIndexScopeName(scope);
  return makeAuthIndexDocument(document.providerId, [
    ...document.scopes.filter(
      (candidate) => authIndexScopeName(candidate) !== targetName
    ),
    scope,
  ]);
}

export function removeAuthIndexScope(
  document: AuthIndexDocument,
  scope: NormalizedAuthStoreScope
): AuthIndexDocument {
  const targetName = authIndexScopeName(scope);
  return makeAuthIndexDocument(
    document.providerId,
    document.scopes.filter(
      (candidate) => authIndexScopeName(candidate) !== targetName
    )
  );
}
