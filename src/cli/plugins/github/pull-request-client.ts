import { isProxy } from 'node:util/types';

import type { AideAuthScope } from '@cli/host/plugin-descriptor.js';
import {
  authIndexScopeName,
  isWellFormedUtf16,
  normalizeAuthStoreScope,
  type AuthStoreScope,
} from '@lib/auth-index-codec.js';
import {
  createGitHubClient,
  githubAuthErrorDiagnostic,
  type GitHubClient,
} from '@lib/github-client.js';
import { canonicalizeGitHubAuthAccount } from '@lib/github-auth.js';
import { normalizeGitHubHost } from '@lib/github-utils.js';
import {
  encodeAuthDiagnosticIdentity,
  renderAuthDiagnosticArgv,
} from '../auth-diagnostic-rendering.js';

const MAX_PRESENTATION_HOST_LENGTH = 253;
const MAX_PRESENTATION_IDENTITY_FIELD_LENGTH = 256;
const MAX_PRESENTATION_ID_LENGTH = 1_024;
const INVALID_SCOPE_MESSAGE =
  'Invalid GitHub pull request authentication scope.';
const UNSUPPORTED_HOST_MESSAGE = 'Unsupported GitHub pull request host.';

const arrayIsArray = Array.isArray;
const objectCreate = Object.create;
const objectFreeze = Object.freeze;
const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const objectGetPrototypeOf = Object.getPrototypeOf;
const objectHasOwn = Object.hasOwn;
const ordinaryObjectPrototype = Object.prototype;

type GitHubPullRequestClientFactory<T> = (options: {
  readonly host: string;
  readonly scope: AuthStoreScope;
}) => Promise<T>;

type IdentityField = 'id' | 'providerId' | 'host' | 'org' | 'account';

type IdentitySnapshot = Readonly<Record<IdentityField, string | undefined>>;

const selectedGitHubPullRequestAuthDiagnostics = new WeakMap<object, string>();

export class SelectedGitHubPullRequestAuthError extends Error {
  constructor() {
    super('GitHub pull request authentication failed.');
    this.name = 'SelectedGitHubPullRequestAuthError';
  }
}

function invalidScope(): never {
  throw new TypeError(INVALID_SCOPE_MESSAGE);
}

function unsupportedHost(): never {
  throw new TypeError(UNSUPPORTED_HOST_MESSAGE);
}

function snapshotIdentityField(
  scope: object,
  name: IdentityField
): string | undefined {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = objectGetOwnPropertyDescriptor(scope, name);
  } catch {
    return invalidScope();
  }
  if (descriptor === undefined) return undefined;
  if (
    !objectHasOwn(descriptor, 'value') ||
    (descriptor.value !== undefined && typeof descriptor.value !== 'string')
  ) {
    return invalidScope();
  }
  return descriptor.value as string | undefined;
}

function snapshotIdentity(scope: AideAuthScope): IdentitySnapshot {
  if (
    typeof scope !== 'object' ||
    scope === null ||
    isProxy(scope) ||
    arrayIsArray(scope)
  ) {
    return invalidScope();
  }

  let prototype: object | null;
  try {
    prototype = objectGetPrototypeOf(scope);
  } catch {
    return invalidScope();
  }
  if (prototype !== ordinaryObjectPrototype && prototype !== null) {
    return invalidScope();
  }

  const snapshot = objectCreate(null) as Record<
    IdentityField,
    string | undefined
  >;
  for (const name of ['id', 'providerId', 'host', 'org', 'account'] as const) {
    snapshot[name] = snapshotIdentityField(scope, name);
  }
  return objectFreeze(snapshot);
}

function hasUnsafePresentationCodePoint(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) return true;
    if (codePoint > 0xffff) index += 1;
    if (
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x061c ||
      codePoint === 0x200e ||
      codePoint === 0x200f ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      codePoint === 0x2028 ||
      codePoint === 0x2029 ||
      (codePoint >= 0x2066 && codePoint <= 0x2069) ||
      codePoint === 0xfeff
    ) {
      return true;
    }
  }
  return false;
}

function isSafePresentationString(value: string, maximum: number): boolean {
  return (
    value.length > 0 &&
    value.length <= maximum &&
    isWellFormedUtf16(value) &&
    !hasUnsafePresentationCodePoint(value)
  );
}

function looksCredentialShaped(value: string): boolean {
  if (/-----BEGIN(?: [A-Z]+)* PRIVATE KEY-----/iu.test(value)) return true;
  if (/^(?:basic|bearer)\s+\S+$/iu.test(value)) return true;
  if (
    /(?:^|[\s?&#;,])(?:access[_-]?token|api[_-]?(?:key|token)|authorization|client[_-]?secret|password|pat|private[_-]?key|secret|token)\s*[:=]\s*\S+/iu.test(
      value
    )
  ) {
    return true;
  }
  if (/(?:^|[^a-z0-9])(?:gh[pousr]_|github_pat_)[a-z0-9_]{16,}/iu.test(value)) {
    return true;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(value)) {
    try {
      const url = new URL(value);
      return (
        url.username.length > 0 ||
        url.password.length > 0 ||
        url.search.length > 0 ||
        url.hash.length > 0
      );
    } catch {
      return false;
    }
  }
  return false;
}

function frozenAuthStoreScope(host: string, account?: string): AuthStoreScope {
  const scope = objectCreate(null) as {
    providerId: string;
    host: string;
    account?: string;
  };
  scope.providerId = 'github';
  scope.host = host;
  if (account !== undefined) scope.account = account;
  return objectFreeze(scope);
}

function canonicalRepositoryHost(repositoryHost: string): string {
  if (typeof repositoryHost !== 'string') return unsupportedHost();
  const host = normalizeGitHubHost(repositoryHost);
  if (
    host === null ||
    host !== repositoryHost ||
    !isSafePresentationString(host, MAX_PRESENTATION_HOST_LENGTH)
  ) {
    return unsupportedHost();
  }
  return host;
}

function selectedAuthStoreScope(
  repositoryHost: string,
  authScope: AideAuthScope | undefined
): AuthStoreScope {
  const host = canonicalRepositoryHost(repositoryHost);
  if (authScope === undefined) return frozenAuthStoreScope(host);

  const identity = snapshotIdentity(authScope);
  if (
    identity.id === undefined ||
    identity.providerId !== 'github' ||
    identity.host !== host ||
    identity.org !== undefined ||
    !isSafePresentationString(identity.host, MAX_PRESENTATION_HOST_LENGTH)
  ) {
    return invalidScope();
  }

  const account = identity.account;
  if (
    account !== undefined &&
    (!isSafePresentationString(
      account,
      MAX_PRESENTATION_IDENTITY_FIELD_LENGTH
    ) ||
      looksCredentialShaped(account) ||
      canonicalizeGitHubAuthAccount(account) !== account)
  ) {
    return invalidScope();
  }

  const normalized = normalizeAuthStoreScope('github', {
    providerId: identity.providerId,
    host: identity.host,
    ...(account === undefined ? {} : { account }),
  });
  if (
    normalized === null ||
    normalized.host !== host ||
    normalized.account !== account
  ) {
    return invalidScope();
  }

  let canonicalId: string;
  try {
    canonicalId = authIndexScopeName(normalized);
  } catch {
    return invalidScope();
  }
  if (
    identity.id !== canonicalId ||
    !isSafePresentationString(canonicalId, MAX_PRESENTATION_ID_LENGTH)
  ) {
    return invalidScope();
  }
  return frozenAuthStoreScope(host, account);
}

function selectedAuthDiagnostic(host: string, account: string): string {
  return (
    `GitHub PR authentication is unavailable for account ${encodeAuthDiagnosticIdentity(account)} on host ${encodeAuthDiagnosticIdentity(host)}. ` +
    'Remedy 1: In gh, switch to or sign in as that account for that host. ' +
    `Remedy 2 (JSON argv): ${renderAuthDiagnosticArgv([
      'aide',
      'login',
      'github',
      '--scope-host',
      host,
      '--scope-account',
      account,
    ])}`
  );
}

function selectedAuthError(host: string, account: string): Error {
  const error = new SelectedGitHubPullRequestAuthError();
  selectedGitHubPullRequestAuthDiagnostics.set(
    error,
    selectedAuthDiagnostic(host, account)
  );
  return error;
}

function authenticSelectedGitHubAuthErrorCode(
  failure: unknown,
  selectedHost: string,
  selectedAccount: string
): string | undefined {
  if (githubAuthErrorDiagnostic(failure) === undefined) return undefined;
  if (
    (typeof failure !== 'object' || failure === null) &&
    typeof failure !== 'function'
  ) {
    return undefined;
  }
  try {
    const codeDescriptor = objectGetOwnPropertyDescriptor(failure, 'code');
    const hostDescriptor = objectGetOwnPropertyDescriptor(failure, 'host');
    const accountDescriptor = objectGetOwnPropertyDescriptor(
      failure,
      'account'
    );
    if (
      codeDescriptor === undefined ||
      hostDescriptor === undefined ||
      accountDescriptor === undefined ||
      !objectHasOwn(codeDescriptor, 'value') ||
      !objectHasOwn(hostDescriptor, 'value') ||
      !objectHasOwn(accountDescriptor, 'value') ||
      typeof codeDescriptor.value !== 'string' ||
      typeof hostDescriptor.value !== 'string' ||
      typeof accountDescriptor.value !== 'string' ||
      hostDescriptor.value !== selectedHost ||
      accountDescriptor.value !== selectedAccount ||
      normalizeGitHubHost(hostDescriptor.value) !== hostDescriptor.value ||
      canonicalizeGitHubAuthAccount(accountDescriptor.value) !==
        accountDescriptor.value
    ) {
      return undefined;
    }
    return codeDescriptor.value;
  } catch {
    return undefined;
  }
}

export function githubPullRequestErrorDiagnostic(
  failure: unknown
): string | undefined {
  if (
    (typeof failure === 'object' && failure !== null) ||
    typeof failure === 'function'
  ) {
    const selected = selectedGitHubPullRequestAuthDiagnostics.get(failure);
    if (selected !== undefined) return selected;
  }
  return githubAuthErrorDiagnostic(failure);
}

/**
 * Validate and reduce a scope before forwarding it to an injected client
 * factory. This public path never catches, inspects, translates, or certifies a
 * factory failure.
 */
export async function createSelectedGitHubPullRequestClient<T>(
  repositoryHost: string,
  authScope: AideAuthScope | undefined,
  createClient: GitHubPullRequestClientFactory<T>
): Promise<T> {
  const scope = selectedAuthStoreScope(repositoryHost, authScope);
  const host = scope.host;
  if (host === undefined) return invalidScope();

  return createClient({ host, scope });
}

/**
 * Construct the real production GitHub client. This path owns both the client
 * factory and selected-auth translation; callers cannot provide either.
 */
export async function createProductionGitHubPullRequestClient(
  repositoryHost: string,
  authScope: AideAuthScope | undefined
): Promise<GitHubClient> {
  const scope = selectedAuthStoreScope(repositoryHost, authScope);
  const host = scope.host;
  if (host === undefined) return invalidScope();

  try {
    return await createGitHubClient({ host, scope });
  } catch (failure) {
    const account = scope.account;
    if (account !== undefined) {
      const code = authenticSelectedGitHubAuthErrorCode(failure, host, account);
      if (code === 'not-configured' || code === 'account-mismatch') {
        throw selectedAuthError(host, account);
      }
    }
    throw failure;
  }
}
