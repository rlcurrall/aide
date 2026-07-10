import { isProxy } from 'node:util/types';

import { spawnSync } from 'bun';

import { resolveAuthSecretPromise, type AuthStoreScope } from './auth-store.js';
import {
  canonicalizeGitHubAuthAccount,
  canonicalizeGitHubAuthHost,
  githubCliEnvironment,
  githubEnvironmentCredential,
  snapshotGitHubAuthEnvironment,
  type CanonicalGitHubAuthRequest,
  type GitHubAuthRequestFailureCode,
  type GitHubCredentialFailureCode,
  type GitHubAuthEnvironment,
  type GitHubEnvironmentCredential,
  validateGitHubStoredCredential,
} from './github-auth.js';
import {
  probeGhCliAuth,
  type GitHubAuthProbe,
  type GitHubCliAuthProbe,
} from './gh-utils.js';
import { KeyringUnavailableError } from './secrets.js';

export interface GitHubCredentialResolverOptions {
  readonly ghAuthProbe?: GitHubAuthProbe;
  readonly spawn?: typeof spawnSync;
  readonly env?: GitHubAuthEnvironment;
}

export type GitHubCredentialResolution =
  | {
      readonly kind: 'gh-cli';
      readonly host: string;
      readonly account?: string;
    }
  | {
      readonly kind: 'env';
      readonly credential: GitHubEnvironmentCredential;
    }
  | {
      readonly kind: 'stored';
      readonly host: string;
      readonly account?: string;
      readonly token: string;
    }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unreachable' }
  | {
      readonly kind: 'failure';
      readonly code: GitHubAuthRequestFailureCode | GitHubCredentialFailureCode;
      readonly reason: string;
    };

type OwnDataPropertySnapshot =
  | { readonly kind: 'data'; readonly value: unknown }
  | { readonly kind: 'absent' }
  | { readonly kind: 'invalid' };

function snapshotOwnDataProperty(
  input: object,
  name: string
): OwnDataPropertySnapshot {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(input, name);
    if (descriptor === undefined) return { kind: 'absent' };
    return Object.hasOwn(descriptor, 'value')
      ? { kind: 'data', value: descriptor.value }
      : { kind: 'invalid' };
  } catch {
    return { kind: 'invalid' };
  }
}

/** Capture canonical fields without consulting or traversing a prototype. */
function snapshotCanonicalDataProperty(
  input: object,
  name: string
): OwnDataPropertySnapshot {
  return snapshotOwnDataProperty(input, name);
}

/** Reject inherited resolver dependencies without invoking prototype fields. */
function snapshotResolverOptionProperty(
  input: object,
  name: string
): OwnDataPropertySnapshot {
  const ownProperty = snapshotOwnDataProperty(input, name);
  if (ownProperty.kind !== 'absent') return ownProperty;

  try {
    let prototype = Object.getPrototypeOf(input);
    while (prototype !== null) {
      if (isProxy(prototype)) return { kind: 'invalid' };
      if (Object.getOwnPropertyDescriptor(prototype, name) !== undefined) {
        return { kind: 'invalid' };
      }
      prototype = Object.getPrototypeOf(prototype);
    }
    return { kind: 'absent' };
  } catch {
    return { kind: 'invalid' };
  }
}

function frozenNullSnapshot<T extends object>(
  fields: ReadonlyArray<readonly [string, unknown]>
): T {
  const result = Object.create(null) as Record<string, unknown>;
  for (const [name, value] of fields) result[name] = value;
  return Object.freeze(result) as T;
}

type FrozenRequestSnapshot =
  | { readonly ok: true; readonly request: CanonicalGitHubAuthRequest }
  | {
      readonly ok: false;
      readonly code: GitHubAuthRequestFailureCode;
      readonly reason: string;
    };

function frozenRequestSnapshot(
  request: CanonicalGitHubAuthRequest
): FrozenRequestSnapshot {
  const invalid = (
    code: GitHubAuthRequestFailureCode,
    reason: string
  ): FrozenRequestSnapshot => ({ ok: false, code, reason });
  if (typeof request !== 'object' || request === null || isProxy(request)) {
    return invalid('invalid-host', 'Invalid canonical GitHub auth request.');
  }

  const okProperty = snapshotCanonicalDataProperty(request, 'ok');
  const hostProperty = snapshotCanonicalDataProperty(request, 'host');
  const accountProperty = snapshotCanonicalDataProperty(request, 'account');
  const scopeProperty = snapshotCanonicalDataProperty(request, 'keyringScope');
  if (
    okProperty.kind !== 'data' ||
    okProperty.value !== true ||
    hostProperty.kind !== 'data' ||
    typeof hostProperty.value !== 'string' ||
    scopeProperty.kind === 'invalid'
  ) {
    return invalid(
      'invalid-host',
      'Invalid canonical GitHub auth request. Required identity fields must be own data properties.'
    );
  }

  const host = canonicalizeGitHubAuthHost(hostProperty.value);
  if (host === null || host !== hostProperty.value) {
    return invalid(
      'invalid-host',
      'Invalid canonical GitHub auth request host.'
    );
  }
  if (
    accountProperty.kind === 'invalid' ||
    (accountProperty.kind === 'data' &&
      accountProperty.value !== undefined &&
      typeof accountProperty.value !== 'string')
  ) {
    return invalid(
      'invalid-account',
      'Invalid canonical GitHub auth request account.'
    );
  }
  const rawAccount =
    accountProperty.kind === 'data' && accountProperty.value !== undefined
      ? (accountProperty.value as string)
      : undefined;
  const account = canonicalizeGitHubAuthAccount(rawAccount);
  if (
    rawAccount !== undefined &&
    (account === null || account !== rawAccount)
  ) {
    return invalid(
      'invalid-account',
      'Invalid canonical GitHub auth request account.'
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
    return invalid(
      'scope-host-mismatch',
      'Invalid canonical GitHub auth request scope.'
    );
  }

  const scope = scopeValue as
    | NonNullable<CanonicalGitHubAuthRequest['keyringScope']>
    | undefined;
  if (scope === undefined && account !== null) {
    return invalid(
      'invalid-account',
      'An account-qualified GitHub auth request requires a scoped identity.'
    );
  }

  let scopeFields:
    | {
        readonly id: string | undefined;
        readonly providerId: string;
        readonly host: string;
        readonly org: string | undefined;
        readonly account: string | undefined;
      }
    | undefined;
  if (scope !== undefined) {
    const idProperty = snapshotCanonicalDataProperty(scope, 'id');
    const providerProperty = snapshotCanonicalDataProperty(scope, 'providerId');
    const scopeHostProperty = snapshotCanonicalDataProperty(scope, 'host');
    const orgProperty = snapshotCanonicalDataProperty(scope, 'org');
    const scopeAccountProperty = snapshotCanonicalDataProperty(
      scope,
      'account'
    );
    const optionalString = (property: OwnDataPropertySnapshot) =>
      property.kind === 'absent' ||
      (property.kind === 'data' &&
        (property.value === undefined || typeof property.value === 'string'));
    if (
      !optionalString(idProperty) ||
      providerProperty.kind !== 'data' ||
      typeof providerProperty.value !== 'string' ||
      scopeHostProperty.kind !== 'data' ||
      typeof scopeHostProperty.value !== 'string' ||
      !optionalString(orgProperty) ||
      !optionalString(scopeAccountProperty)
    ) {
      return invalid(
        'scope-host-mismatch',
        'Invalid canonical GitHub auth request scope. Identity fields must be own data properties.'
      );
    }
    const providerId = providerProperty.value.trim().toLowerCase();
    const canonicalScopeHost = canonicalizeGitHubAuthHost(
      scopeHostProperty.value
    );
    const rawScopeAccount =
      scopeAccountProperty.kind === 'data' &&
      scopeAccountProperty.value !== undefined
        ? (scopeAccountProperty.value as string)
        : undefined;
    const scopeAccount = canonicalizeGitHubAuthAccount(rawScopeAccount);
    if (
      providerId !== 'github' ||
      canonicalScopeHost !== host ||
      (rawScopeAccount !== undefined &&
        (scopeAccount === null || scopeAccount !== rawScopeAccount)) ||
      scopeAccount !== account
    ) {
      return invalid(
        'scope-host-mismatch',
        'Canonical GitHub auth request scope does not match its requested identity.'
      );
    }
    scopeFields = {
      id:
        idProperty.kind === 'data'
          ? (idProperty.value as string | undefined)
          : undefined,
      providerId,
      host,
      org:
        orgProperty.kind === 'data'
          ? (orgProperty.value as string | undefined)
          : undefined,
      account: account ?? undefined,
    };
  }

  const keyringScope =
    scopeFields === undefined
      ? undefined
      : frozenNullSnapshot<
          NonNullable<CanonicalGitHubAuthRequest['keyringScope']>
        >([
          ['id', scopeFields.id],
          ['providerId', scopeFields.providerId],
          ['host', scopeFields.host],
          ['org', scopeFields.org],
          ['account', scopeFields.account],
        ]);

  return {
    ok: true,
    request: frozenNullSnapshot<CanonicalGitHubAuthRequest>([
      ['ok', true],
      ['host', host],
      ['account', account ?? undefined],
      ['keyringScope', keyringScope],
    ]),
  };
}

function unavailableProbe(
  request: CanonicalGitHubAuthRequest,
  reason: string
): GitHubCliAuthProbe {
  return { kind: 'unavailable', host: request.host, reason };
}

type ProbePropertySnapshot =
  | { readonly kind: 'data'; readonly value: unknown }
  | { readonly kind: 'absent' }
  | { readonly kind: 'invalid' };

/** Read a probe field without invoking accessors or traversing a prototype. */
function snapshotProbeProperty(
  probe: object,
  name: string
): ProbePropertySnapshot {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(probe, name);
    if (descriptor === undefined) return { kind: 'absent' };
    return 'value' in descriptor
      ? { kind: 'data', value: descriptor.value }
      : { kind: 'invalid' };
  } catch {
    return { kind: 'invalid' };
  }
}

/**
 * Validate an injected or production probe result without trusting it to
 * prove the identity from the request itself. Unknown fields are tolerated,
 * but every identity-bearing field and discriminator is checked explicitly.
 */
export function validateGitHubAuthProbeResult(
  request: CanonicalGitHubAuthRequest,
  result: unknown
): GitHubCliAuthProbe {
  const invalid = (detail: string) =>
    unavailableProbe(
      request,
      `GitHub CLI auth probe returned an invalid result: ${detail}`
    );
  if (typeof result !== 'object' || result === null) {
    return invalid('expected a structured result.');
  }
  if (isProxy(result)) {
    return invalid('proxy results are not allowed.');
  }
  try {
    if (Array.isArray(result)) {
      return invalid('expected a structured result.');
    }
  } catch {
    return invalid('expected a structured result.');
  }

  const kindProperty = snapshotProbeProperty(result, 'kind');
  if (kindProperty.kind !== 'data') {
    return invalid('kind must be an own data property.');
  }

  const hostProperty = snapshotProbeProperty(result, 'host');
  if (hostProperty.kind !== 'data' || typeof hostProperty.value !== 'string') {
    return invalid('host must be a string.');
  }
  if (canonicalizeGitHubAuthHost(hostProperty.value) !== request.host) {
    return invalid('host does not match the canonical request host.');
  }

  switch (kindProperty.value) {
    case 'authenticated': {
      const accountProperty = snapshotProbeProperty(result, 'account');
      if (accountProperty.kind === 'invalid') {
        return invalid('authenticated account must be an own data property.');
      }
      const hasAccount =
        accountProperty.kind === 'data' && accountProperty.value !== undefined;
      const account =
        hasAccount && typeof accountProperty.value === 'string'
          ? canonicalizeGitHubAuthAccount(accountProperty.value)
          : null;
      if (hasAccount && account === null) {
        return invalid('authenticated account must be a non-empty string.');
      }
      if (request.account !== undefined) {
        if (account === null) {
          return invalid(
            'a host-only authenticated result cannot satisfy an account-qualified request.'
          );
        }
        if (account !== request.account) {
          return {
            kind: 'account-mismatch',
            code: 'account-mismatch',
            host: request.host,
            requestedAccount: request.account,
            activeAccount: account,
            reason:
              `Active gh account '${account}' does not match requested ` +
              `GitHub account '${request.account}' for '${request.host}'.`,
          };
        }
      }
      return {
        kind: 'authenticated',
        host: request.host,
        ...(account === null ? {} : { account }),
      };
    }
    case 'account-mismatch': {
      const codeProperty = snapshotProbeProperty(result, 'code');
      const requestedAccountProperty = snapshotProbeProperty(
        result,
        'requestedAccount'
      );
      const activeAccountProperty = snapshotProbeProperty(
        result,
        'activeAccount'
      );
      const reasonProperty = snapshotProbeProperty(result, 'reason');
      const requestedAccount =
        requestedAccountProperty.kind === 'data' &&
        typeof requestedAccountProperty.value === 'string'
          ? canonicalizeGitHubAuthAccount(requestedAccountProperty.value)
          : null;
      const activeAccount =
        activeAccountProperty.kind === 'data' &&
        typeof activeAccountProperty.value === 'string'
          ? canonicalizeGitHubAuthAccount(activeAccountProperty.value)
          : null;
      if (
        request.account === undefined ||
        codeProperty.kind !== 'data' ||
        codeProperty.value !== 'account-mismatch' ||
        requestedAccount !== request.account ||
        activeAccount === null ||
        activeAccount === request.account ||
        reasonProperty.kind !== 'data' ||
        typeof reasonProperty.value !== 'string'
      ) {
        return invalid('account-mismatch result is malformed.');
      }
      return {
        kind: 'account-mismatch',
        code: 'account-mismatch',
        host: request.host,
        requestedAccount: request.account,
        activeAccount,
        reason: reasonProperty.value,
      };
    }
    case 'unavailable': {
      const reasonProperty = snapshotProbeProperty(result, 'reason');
      if (reasonProperty.kind === 'invalid') {
        return invalid('unavailable reason must be an own data property.');
      }
      const hasReason =
        reasonProperty.kind === 'data' && reasonProperty.value !== undefined;
      if (hasReason && typeof reasonProperty.value !== 'string') {
        return invalid('unavailable reason must be a string when present.');
      }
      return {
        kind: 'unavailable',
        host: request.host,
        ...(hasReason ? { reason: reasonProperty.value as string } : {}),
      };
    }
    default:
      return invalid('discriminator is not allowed.');
  }
}

function runGhProbe(
  privateRequest: CanonicalGitHubAuthRequest,
  probeRequest: CanonicalGitHubAuthRequest,
  ghAuthProbe: GitHubAuthProbe | undefined,
  spawn: typeof spawnSync,
  env: GitHubAuthEnvironment
): GitHubCliAuthProbe {
  const result =
    ghAuthProbe === undefined
      ? probeGhCliAuth(probeRequest, spawn, env)
      : ghAuthProbe(probeRequest);
  return validateGitHubAuthProbeResult(privateRequest, result);
}

/**
 * Shared source precedence for config probes and the API client.
 *
 * Host-only: exact-host gh, eligible host-bound env, exact selected key.
 * Account-qualified: matching active gh account, exact account key. Standard
 * env tokens are never candidates because they carry no provable account.
 */
export async function resolveGitHubCredential(
  request: CanonicalGitHubAuthRequest,
  options: GitHubCredentialResolverOptions = {}
): Promise<GitHubCredentialResolution> {
  const requestSnapshot = frozenRequestSnapshot(request);
  if (!requestSnapshot.ok) {
    return {
      kind: 'failure',
      code: requestSnapshot.code,
      reason: requestSnapshot.reason,
    };
  }
  const privateRequest = requestSnapshot.request;
  const probeRequestSnapshot = frozenRequestSnapshot(privateRequest);
  if (!probeRequestSnapshot.ok) {
    return {
      kind: 'failure',
      code: probeRequestSnapshot.code,
      reason: probeRequestSnapshot.reason,
    };
  }
  const probeRequest = probeRequestSnapshot.request;

  if (
    typeof options !== 'object' ||
    options === null ||
    isProxy(options) ||
    Array.isArray(options)
  ) {
    return {
      kind: 'failure',
      code: 'malformed-credential',
      reason: 'Invalid GitHub credential resolver options.',
    };
  }

  const envProperty = snapshotResolverOptionProperty(options, 'env');
  const probeProperty = snapshotResolverOptionProperty(options, 'ghAuthProbe');
  const spawnProperty = snapshotResolverOptionProperty(options, 'spawn');
  if (
    envProperty.kind === 'invalid' ||
    probeProperty.kind === 'invalid' ||
    spawnProperty.kind === 'invalid' ||
    (probeProperty.kind === 'data' &&
      probeProperty.value !== undefined &&
      typeof probeProperty.value !== 'function') ||
    (spawnProperty.kind === 'data' &&
      spawnProperty.value !== undefined &&
      typeof spawnProperty.value !== 'function')
  ) {
    return {
      kind: 'failure',
      code: 'malformed-credential',
      reason: 'Invalid GitHub credential resolver options.',
    };
  }
  const envSource =
    envProperty.kind === 'data' && envProperty.value !== undefined
      ? envProperty.value
      : Bun.env;
  if (typeof envSource !== 'object' || envSource === null) {
    return {
      kind: 'failure',
      code: 'malformed-credential',
      reason: 'Invalid GitHub authentication environment.',
    };
  }
  const privateEnvironment = snapshotGitHubAuthEnvironment(
    envSource as GitHubAuthEnvironment
  );
  if (privateEnvironment === null) {
    return {
      kind: 'failure',
      code: 'malformed-credential',
      reason: 'Invalid GitHub authentication environment.',
    };
  }
  const environment = githubEnvironmentCredential(
    privateRequest.host,
    privateEnvironment,
    privateRequest.account
  );
  const ghEnvironment = githubCliEnvironment(
    envSource as GitHubAuthEnvironment
  );
  const ghAuthProbe =
    probeProperty.kind === 'data'
      ? (probeProperty.value as GitHubAuthProbe | undefined)
      : undefined;
  const selectedSpawn =
    spawnProperty.kind === 'data' && spawnProperty.value !== undefined
      ? (spawnProperty.value as typeof spawnSync)
      : spawnSync;

  const gh = runGhProbe(
    privateRequest,
    probeRequest,
    ghAuthProbe,
    selectedSpawn,
    ghEnvironment
  );
  if (gh.kind === 'authenticated') {
    return {
      kind: 'gh-cli',
      host: privateRequest.host,
      account: privateRequest.account,
    };
  }

  if (environment !== null) {
    return { kind: 'env', credential: environment };
  }

  let resolved;
  try {
    resolved = await resolveAuthSecretPromise(
      'github',
      privateRequest.keyringScope as AuthStoreScope | undefined
    );
  } catch (error) {
    if (error instanceof KeyringUnavailableError) {
      return { kind: 'unreachable' };
    }
    throw error;
  }

  if (resolved === null) {
    return gh.kind === 'account-mismatch'
      ? { kind: 'failure', code: gh.code, reason: gh.reason }
      : { kind: 'missing' };
  }

  let stored;
  try {
    stored = validateGitHubStoredCredential(
      privateRequest,
      resolved.kind,
      resolved.value
    );
  } catch {
    return {
      kind: 'failure',
      code: 'malformed-credential',
      reason:
        "Stored GitHub credentials are malformed. Re-run 'aide login github' to reconfigure.",
    };
  }
  if (!stored.ok) {
    return { kind: 'failure', code: stored.code, reason: stored.reason };
  }
  return {
    kind: 'stored',
    host: stored.host,
    token: stored.token,
    account: privateRequest.account,
  };
}
