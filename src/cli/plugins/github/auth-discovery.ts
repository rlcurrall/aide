import { Effect } from 'effect';

import type {
  AideAuthAccount,
  AidePluginAuthStatus,
} from '@cli/host/plugin-descriptor.js';
import { AuthIndexLockError } from '@lib/auth-index-lock.js';
import {
  AuthIndexConsistencyError,
  AuthIndexDocumentError,
  captureAuthProviderCatalogEffect,
  type AuthIndexReadError,
  type AuthStoreScope,
} from '@lib/auth-store.js';
import {
  KeyringUnavailableError,
  type KeyringService,
} from '@lib/auth-keyring.js';
import {
  GitHubAuthCatalogDocumentError,
  GitHubAuthCatalogService,
  GitHubAuthCatalogUnavailableError,
  githubAuthCatalog,
  type GitHubAuthCatalogFailure,
  type GitHubAuthCatalogResult,
} from '@lib/github-auth-catalog.js';
import {
  DEFAULT_GITHUB_HOST,
  canonicalizeGitHubAuthHost,
  githubEnvironmentCredential,
  resolveGitHubAuthRequest,
  snapshotGitHubAuthEnvironment,
  validateGitHubStoredCredential,
  type GitHubAuthEnvironment,
} from '@lib/github-auth.js';
import {
  assembleBuiltinAuthAccounts,
  type GitHubAuthAccountCandidate,
} from '../auth-account-assembly.js';

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
const githubCliSource = Object.freeze({
  kind: 'external',
  name: 'gh-cli',
  active: true,
} as const);

const configuredViaEnvironment = Object.freeze({
  state: 'configured',
  detail: 'configured via environment token',
} as const satisfies AidePluginAuthStatus);
const configuredViaGitHubCli = Object.freeze({
  state: 'configured',
  detail: 'authenticated via gh CLI',
} as const satisfies AidePluginAuthStatus);
const configuredViaKeyring = Object.freeze({
  state: 'configured',
  detail: 'configured via keyring token',
} as const satisfies AidePluginAuthStatus);
const misconfigured = Object.freeze({
  state: 'misconfigured',
  detail:
    "GitHub authentication is misconfigured. Re-run 'aide login github' to reconfigure.",
} as const satisfies AidePluginAuthStatus);
const unavailable = Object.freeze({
  state: 'unavailable',
  detail: 'GitHub authentication sources are unavailable.',
} as const satisfies AidePluginAuthStatus);
const notConfigured = Object.freeze({
  state: 'not-configured',
  detail: "run 'aide login github' or authenticate with gh CLI",
} as const satisfies AidePluginAuthStatus);

type StoredCandidateState =
  | {
      readonly kind: 'usable';
      readonly candidate: GitHubAuthAccountCandidate;
    }
  | { readonly kind: 'missing' | 'malformed' };

interface EnvironmentDiscovery {
  readonly candidates: readonly GitHubAuthAccountCandidate[];
  readonly malformed: boolean;
}

interface StoredDiscovery {
  readonly candidates: readonly GitHubAuthAccountCandidate[];
  readonly malformed: boolean;
}

type AssemblyResult =
  | { readonly ok: true; readonly accounts: readonly AideAuthAccount[] }
  | { readonly ok: false };

function environmentCandidate(host: string): GitHubAuthAccountCandidate {
  return Object.freeze({
    scope: Object.freeze({ providerId: 'github', host }),
    source: environmentSource,
  });
}

function legacyCandidate(): GitHubAuthAccountCandidate {
  return Object.freeze({
    scope: Object.freeze({
      providerId: 'github',
      host: DEFAULT_GITHUB_HOST,
    }),
    source: legacySource,
  });
}

function scopedCandidate(
  host: string,
  account?: string
): GitHubAuthAccountCandidate {
  return Object.freeze({
    scope: Object.freeze({
      providerId: 'github',
      host,
      ...(account === undefined ? {} : { account }),
    }),
    source: scopedSource,
  });
}

function githubCliCandidate(
  host: string,
  account: string
): GitHubAuthAccountCandidate {
  return Object.freeze({
    scope: Object.freeze({ providerId: 'github', host, account }),
    source: githubCliSource,
  });
}

function discoverEnvironmentFromSnapshot(
  snapshot: GitHubAuthEnvironment | null
): EnvironmentDiscovery {
  if (snapshot === null) {
    return Object.freeze({ candidates: Object.freeze([]), malformed: true });
  }

  const candidates: GitHubAuthAccountCandidate[] = [];
  const publicCredential = githubEnvironmentCredential(
    DEFAULT_GITHUB_HOST,
    snapshot
  );
  if (publicCredential !== null) {
    candidates.push(environmentCandidate(publicCredential.host));
  }

  const hasEnterpriseToken = Boolean(
    snapshot.GH_ENTERPRISE_TOKEN || snapshot.GITHUB_ENTERPRISE_TOKEN
  );
  let malformed = false;
  if (hasEnterpriseToken) {
    const enterpriseHost = canonicalizeGitHubAuthHost(snapshot.GH_HOST);
    const enterpriseCredential =
      enterpriseHost === null || enterpriseHost === DEFAULT_GITHUB_HOST
        ? null
        : githubEnvironmentCredential(enterpriseHost, snapshot);
    if (enterpriseCredential === null) {
      malformed = true;
    } else {
      candidates.push(environmentCandidate(enterpriseCredential.host));
    }
  }

  return Object.freeze({
    candidates: Object.freeze(candidates),
    malformed,
  });
}

function discoverEnvironment(
  environment: GitHubAuthEnvironment
): EnvironmentDiscovery {
  try {
    return discoverEnvironmentFromSnapshot(
      snapshotGitHubAuthEnvironment(environment)
    );
  } catch {
    return Object.freeze({ candidates: Object.freeze([]), malformed: true });
  }
}

function parseCapturedStoredCredential(
  raw: string | null,
  scope?: AuthStoreScope
): StoredCandidateState {
  if (raw === null) return Object.freeze({ kind: 'missing' });

  const request = resolveGitHubAuthRequest(
    scope === undefined ? {} : { scope }
  );
  if (!request.ok) return Object.freeze({ kind: 'malformed' });

  const storageKind = scope === undefined ? 'legacy' : 'scoped';
  const validated = validateGitHubStoredCredential(request, storageKind, raw);
  if (!validated.ok) return Object.freeze({ kind: 'malformed' });

  return Object.freeze({
    kind: 'usable',
    candidate:
      storageKind === 'legacy'
        ? legacyCandidate()
        : scopedCandidate(validated.host, validated.account),
  });
}

function discoverStoredCatalog(): Effect.Effect<
  StoredDiscovery,
  AuthIndexReadError,
  KeyringService
> {
  return Effect.map(captureAuthProviderCatalogEffect('github'), (snapshot) => {
    const parsed = snapshot.parse(parseCapturedStoredCredential);
    const states = [parsed.legacy, ...parsed.indexed];
    return Object.freeze({
      candidates: Object.freeze(
        states.flatMap((state) =>
          state.kind === 'usable' ? [state.candidate] : []
        )
      ),
      malformed: states.some((state) => state.kind === 'malformed'),
    });
  });
}

function catalogCandidates(
  catalog: GitHubAuthCatalogResult
): readonly GitHubAuthAccountCandidate[] {
  return Object.freeze(
    catalog.identities.map((identity) =>
      githubCliCandidate(identity.host, identity.account)
    )
  );
}

function assembleCandidates(
  candidates: readonly GitHubAuthAccountCandidate[]
): AssemblyResult {
  try {
    return Object.freeze({
      ok: true,
      accounts: assembleBuiltinAuthAccounts(candidates),
    });
  } catch {
    return Object.freeze({ ok: false });
  }
}

function storedFailureStatus(error: AuthIndexReadError): AidePluginAuthStatus {
  if (error instanceof AuthIndexDocumentError) return misconfigured;
  if (
    error instanceof KeyringUnavailableError ||
    error instanceof AuthIndexConsistencyError ||
    error instanceof AuthIndexLockError
  ) {
    return unavailable;
  }
  return misconfigured;
}

function catalogFailureStatus(
  error: GitHubAuthCatalogFailure
): AidePluginAuthStatus {
  if (error instanceof GitHubAuthCatalogDocumentError) return misconfigured;
  if (error instanceof GitHubAuthCatalogUnavailableError) return unavailable;
  return unavailable;
}

/** Complete fail-closed discovery for only the production omitted-scope path. */
export function discoverGitHubAuthAccountsEffect(): Effect.Effect<
  readonly AideAuthAccount[],
  AuthIndexReadError | GitHubAuthCatalogFailure | TypeError,
  KeyringService | GitHubAuthCatalogService
> {
  return Effect.gen(function* () {
    const environment = yield* Effect.sync(() => discoverEnvironment(Bun.env));
    const stored = yield* discoverStoredCatalog();
    const catalog = yield* githubAuthCatalog;
    const candidates = [
      ...environment.candidates,
      ...stored.candidates,
      ...catalogCandidates(catalog),
    ];
    return yield* Effect.try({
      try: () => assembleBuiltinAuthAccounts(candidates),
      catch: () => new TypeError('Invalid GitHub authentication identity.'),
    });
  });
}

/** Priority-ordered aggregate status for only the production omitted path. */
export function discoverGitHubAuthStatusEffect(): Effect.Effect<
  AidePluginAuthStatus,
  never,
  KeyringService | GitHubAuthCatalogService
> {
  return Effect.gen(function* () {
    const environment = yield* Effect.sync(() => discoverEnvironment(Bun.env));
    const environmentAssembly = assembleCandidates(environment.candidates);
    if (environmentAssembly.ok && environmentAssembly.accounts.length > 0) {
      return configuredViaEnvironment;
    }

    const storedResult = yield* Effect.either(discoverStoredCatalog());
    if (storedResult._tag === 'Left') {
      return storedFailureStatus(storedResult.left);
    }

    const catalogResult = yield* Effect.either(githubAuthCatalog);
    if (catalogResult._tag === 'Left') {
      return catalogFailureStatus(catalogResult.left);
    }

    const externalCandidates = catalogCandidates(catalogResult.right);
    const assembly = assembleCandidates([
      ...storedResult.right.candidates,
      ...externalCandidates,
    ]);
    if (!assembly.ok) return misconfigured;
    if (assembly.accounts.length > 0) {
      return externalCandidates.length > 0
        ? configuredViaGitHubCli
        : configuredViaKeyring;
    }
    if (
      environment.malformed ||
      !environmentAssembly.ok ||
      storedResult.right.malformed ||
      catalogResult.right.hasUnhealthyActiveIdentity
    ) {
      return misconfigured;
    }
    return notConfigured;
  });
}
