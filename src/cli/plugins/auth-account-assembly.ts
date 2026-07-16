import type {
  AideAuthAccount,
  AideAuthMetadata,
  AideAuthSourceKind,
} from '@cli/host/plugin-descriptor.js';
import {
  authIndexScopeName,
  isWellFormedUtf16,
  normalizeAuthStoreScope,
  type NormalizedAuthStoreScope,
} from '@lib/auth-index-codec.js';

export type BuiltinAuthAccountStorageKind = 'legacy' | 'scoped';

type BuiltinEnvironmentSource = {
  readonly kind: 'env';
  readonly name: 'environment';
};

type BuiltinKeyringSource<
  TStorageKind extends BuiltinAuthAccountStorageKind =
    BuiltinAuthAccountStorageKind,
> = {
  readonly kind: 'keyring';
  readonly name: 'keyring';
  readonly storageKind: TStorageKind;
};

type BuiltinGitHubCliSource = {
  readonly kind: 'external';
  readonly name: 'gh-cli';
  readonly active: true;
};

export type BuiltinAuthAccountSource =
  | BuiltinEnvironmentSource
  | BuiltinKeyringSource
  | BuiltinGitHubCliSource;

type JiraAuthAccountScope = {
  readonly providerId: 'jira';
  readonly host: string;
  readonly account: string;
};

export type JiraAuthAccountCandidate = {
  readonly scope: JiraAuthAccountScope;
  readonly source: BuiltinEnvironmentSource | BuiltinKeyringSource;
  readonly defaultProject?: string;
};

type AzureDevOpsAuthAccountScope = {
  readonly providerId: 'azure-devops';
  readonly host: string;
  readonly org?: string;
};

export type AzureDevOpsAuthAccountCandidate = {
  readonly scope: AzureDevOpsAuthAccountScope;
  readonly source: BuiltinEnvironmentSource | BuiltinKeyringSource;
  readonly authMethod?: 'pat' | 'bearer';
  readonly defaultProject?: string;
};

type GitHubHostOnlyScope = {
  readonly providerId: 'github';
  readonly host: string;
  readonly account?: never;
};

type GitHubLegacyScope = GitHubHostOnlyScope & {
  readonly host: 'github.com';
};

type GitHubScopedScope = {
  readonly providerId: 'github';
  readonly host: string;
  readonly account?: string;
};

type GitHubAccountScope = {
  readonly providerId: 'github';
  readonly host: string;
  readonly account: string;
};

export type GitHubAuthAccountCandidate =
  | {
      readonly scope: GitHubHostOnlyScope;
      readonly source: BuiltinEnvironmentSource;
    }
  | {
      readonly scope: GitHubLegacyScope;
      readonly source: BuiltinKeyringSource<'legacy'>;
    }
  | {
      readonly scope: GitHubScopedScope;
      readonly source: BuiltinKeyringSource<'scoped'>;
    }
  | {
      readonly scope: GitHubAccountScope;
      readonly source: BuiltinGitHubCliSource;
    };

export type BuiltinAuthAccountCandidate =
  | JiraAuthAccountCandidate
  | AzureDevOpsAuthAccountCandidate
  | GitHubAuthAccountCandidate;

type BuiltinAuthAccountSourceName = BuiltinAuthAccountSource['name'];
type BuiltinAuthAccountSourceKind = BuiltinAuthAccountSource['kind'];

interface RankedMetadataValue<T extends string> {
  readonly rank: number;
  readonly value: T;
}

interface AssembledAuthAccountFields {
  readonly scope: NormalizedAuthStoreScope;
  readonly sourceKinds: Set<BuiltinAuthAccountSourceKind>;
  readonly sourceNames: Set<BuiltinAuthAccountSourceName>;
  readonly storageKinds: Set<BuiltinAuthAccountStorageKind>;
  readonly authMethods: RankedMetadataValue<'pat' | 'bearer'>[];
  readonly defaultProjects: RankedMetadataValue<string>[];
  primarySemanticRank: number | undefined;
  active: true | undefined;
}

interface CandidateSnapshot {
  readonly scope: NormalizedAuthStoreScope;
  readonly source: BuiltinAuthAccountSource;
  readonly authMethod?: 'pat' | 'bearer';
  readonly defaultProject?: string;
}

const INVALID_CANDIDATE_MESSAGE = 'Invalid built-in auth account candidate.';

// These presentation limits are deliberately at or below the host result
// snapshot's 1,024-code-unit retained-string boundary. Identity fields use a
// smaller limit so their canonical, percent-encoded auth IDs can also remain
// within that boundary. Canonical DNS hosts retain the standard 253-unit cap.
const MAX_PRESENTATION_HOST_LENGTH = 253;
const MAX_PRESENTATION_IDENTITY_FIELD_LENGTH = 256;
const MAX_PRESENTATION_ID_LENGTH = 1_024;
const MAX_PRESENTATION_METADATA_STRING_LENGTH = 1_024;

const sourceKindPrecedence = Object.freeze([
  'external',
  'env',
  'keyring',
] as const satisfies readonly AideAuthSourceKind[]);

function invalidCandidate(): never {
  throw new TypeError(INVALID_CANDIDATE_MESSAGE);
}

function ownDataValue(object: unknown, name: string): unknown {
  if (typeof object !== 'object' || object === null || Array.isArray(object)) {
    return invalidCandidate();
  }
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Reflect.getOwnPropertyDescriptor(object, name);
  } catch {
    return invalidCandidate();
  }
  if (descriptor === undefined) return undefined;
  if (!Object.hasOwn(descriptor, 'value')) return invalidCandidate();
  return descriptor.value;
}

function snapshotSource(source: unknown): BuiltinAuthAccountSource {
  const kind = ownDataValue(source, 'kind');
  const name = ownDataValue(source, 'name');
  if (kind === 'env' && name === 'environment') {
    return { kind, name };
  }
  if (kind === 'keyring' && name === 'keyring') {
    const storageKind = ownDataValue(source, 'storageKind');
    if (storageKind !== 'legacy' && storageKind !== 'scoped') {
      return invalidCandidate();
    }
    return { kind, name, storageKind };
  }
  if (kind === 'external' && name === 'gh-cli') {
    const active = ownDataValue(source, 'active');
    if (active !== true) return invalidCandidate();
    return { kind, name, active };
  }
  return invalidCandidate();
}

/** Runtime backstop for adapters that erase or cast the closed candidate union. */
function assertProviderSourceScopeInvariant(
  scope: NormalizedAuthStoreScope,
  source: BuiltinAuthAccountSource
): void {
  switch (scope.providerId) {
    case 'jira':
    case 'azure-devops':
      if (source.kind === 'external') invalidCandidate();
      return;
    case 'github':
      switch (source.kind) {
        case 'env':
          if (scope.account !== undefined) invalidCandidate();
          return;
        case 'keyring':
          if (
            source.storageKind === 'legacy' &&
            (scope.host !== 'github.com' || scope.account !== undefined)
          ) {
            invalidCandidate();
          }
          return;
        case 'external':
          if (source.active !== true || scope.account === undefined) {
            invalidCandidate();
          }
          return;
      }
  }
  invalidCandidate();
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

function assertSafePresentationString(value: string, maximum: number): void {
  if (
    value.length === 0 ||
    value.length > maximum ||
    !isWellFormedUtf16(value) ||
    hasUnsafePresentationCodePoint(value)
  ) {
    invalidCandidate();
  }
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

function normalizedMetadataString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'string' ||
    !isWellFormedUtf16(value) ||
    hasUnsafePresentationCodePoint(value)
  ) {
    return invalidCandidate();
  }
  let normalized: string;
  try {
    normalized = value.trim().normalize('NFC');
  } catch {
    return invalidCandidate();
  }
  if (normalized.length === 0) return undefined;
  assertSafePresentationString(
    normalized,
    MAX_PRESENTATION_METADATA_STRING_LENGTH
  );
  if (looksCredentialShaped(normalized)) return invalidCandidate();
  return normalized;
}

function snapshotCandidate(candidate: unknown): CandidateSnapshot {
  const scope = ownDataValue(candidate, 'scope');
  const source = snapshotSource(ownDataValue(candidate, 'source'));
  const providerId = ownDataValue(scope, 'providerId');
  if (
    providerId !== 'jira' &&
    providerId !== 'azure-devops' &&
    providerId !== 'github'
  ) {
    return invalidCandidate();
  }

  let normalizedScope: NormalizedAuthStoreScope | null;
  try {
    normalizedScope = normalizeAuthStoreScope(
      providerId,
      scope as Parameters<typeof normalizeAuthStoreScope>[1]
    );
  } catch {
    return invalidCandidate();
  }
  if (normalizedScope === null) return invalidCandidate();
  assertProviderSourceScopeInvariant(normalizedScope, source);
  assertCanonicalPresentation(normalizedScope);

  if (providerId === 'azure-devops') {
    const authMethod = ownDataValue(candidate, 'authMethod');
    if (
      authMethod !== undefined &&
      authMethod !== 'pat' &&
      authMethod !== 'bearer'
    ) {
      return invalidCandidate();
    }
    const defaultProject = normalizedMetadataString(
      ownDataValue(candidate, 'defaultProject')
    );
    return {
      scope: normalizedScope,
      source,
      ...(authMethod === undefined ? {} : { authMethod }),
      ...(defaultProject === undefined ? {} : { defaultProject }),
    };
  }
  if (providerId === 'jira') {
    const defaultProject = normalizedMetadataString(
      ownDataValue(candidate, 'defaultProject')
    );
    return {
      scope: normalizedScope,
      source,
      ...(defaultProject === undefined ? {} : { defaultProject }),
    };
  }
  return { scope: normalizedScope, source };
}

function assertCanonicalPresentation(scope: NormalizedAuthStoreScope): void {
  if (scope.host === undefined) return invalidCandidate();
  assertSafePresentationString(scope.host, MAX_PRESENTATION_HOST_LENGTH);
  switch (scope.providerId) {
    case 'jira':
      if (scope.account === undefined) return invalidCandidate();
      assertSafePresentationString(
        scope.account,
        MAX_PRESENTATION_IDENTITY_FIELD_LENGTH
      );
      break;
    case 'azure-devops':
      if (scope.org === undefined) return invalidCandidate();
      assertSafePresentationString(
        scope.org,
        MAX_PRESENTATION_IDENTITY_FIELD_LENGTH
      );
      break;
    case 'github':
      if (scope.account !== undefined) {
        assertSafePresentationString(
          scope.account,
          MAX_PRESENTATION_IDENTITY_FIELD_LENGTH
        );
      }
      break;
    default:
      return invalidCandidate();
  }
  assertSafePresentationString(
    authIndexScopeName(scope),
    MAX_PRESENTATION_ID_LENGTH
  );
}

function semanticRank(source: BuiltinAuthAccountSource): number {
  switch (source.kind) {
    case 'external':
      return 0;
    case 'env':
      return 1;
    case 'keyring':
      return source.storageKind === 'scoped' ? 2 : 3;
  }
}

function sourceKindFor(
  sourceKinds: ReadonlySet<BuiltinAuthAccountSourceKind>
): BuiltinAuthAccountSourceKind {
  const sourceKind = sourceKindPrecedence.find((kind) => sourceKinds.has(kind));
  return sourceKind ?? invalidCandidate();
}

function selectedRankedValue<T extends string>(
  values: readonly RankedMetadataValue<T>[],
  primarySemanticRank: number
): T | undefined {
  let selected: RankedMetadataValue<T> | undefined;
  for (const candidate of values) {
    if (candidate.rank !== primarySemanticRank) continue;
    if (selected === undefined || candidate.value < selected.value) {
      selected = candidate;
    }
  }
  return selected?.value;
}

function addCandidate(
  fields: AssembledAuthAccountFields,
  candidate: CandidateSnapshot
): void {
  fields.sourceKinds.add(candidate.source.kind);
  fields.sourceNames.add(candidate.source.name);
  if (candidate.source.kind === 'keyring') {
    fields.storageKinds.add(candidate.source.storageKind);
  }
  if (candidate.source.kind === 'external') fields.active = true;

  const rank = semanticRank(candidate.source);
  if (
    fields.primarySemanticRank === undefined ||
    rank < fields.primarySemanticRank
  ) {
    fields.primarySemanticRank = rank;
  }
  if (candidate.authMethod !== undefined) {
    fields.authMethods.push({ rank, value: candidate.authMethod });
  }
  if (candidate.defaultProject !== undefined) {
    fields.defaultProjects.push({ rank, value: candidate.defaultProject });
  }
}

function makeMetadata(fields: AssembledAuthAccountFields): AideAuthMetadata {
  const primarySemanticRank = fields.primarySemanticRank ?? invalidCandidate();
  const authMethod = selectedRankedValue(
    fields.authMethods,
    primarySemanticRank
  );
  const defaultProject = selectedRankedValue(
    fields.defaultProjects,
    primarySemanticRank
  );
  return Object.freeze({
    sources: [...fields.sourceNames].sort().join(','),
    ...(fields.storageKinds.size === 0
      ? {}
      : { storageKinds: [...fields.storageKinds].sort().join(',') }),
    ...(authMethod === undefined ? {} : { authMethod }),
    ...(defaultProject === undefined ? {} : { defaultProject }),
    ...(fields.active === undefined ? {} : { active: fields.active }),
  });
}

function requiredIdentityField(value: string | undefined): string {
  return value ?? invalidCandidate();
}

function accountLabel(scope: NormalizedAuthStoreScope): string {
  switch (scope.providerId) {
    case 'jira':
      return requiredIdentityField(scope.account);
    case 'azure-devops':
      return requiredIdentityField(scope.org);
    case 'github':
      return scope.account ?? requiredIdentityField(scope.host);
    default:
      return invalidCandidate();
  }
}

function makeAccount(fields: AssembledAuthAccountFields): AideAuthAccount {
  const id = authIndexScopeName(fields.scope);
  const label = accountLabel(fields.scope);
  const detail = requiredIdentityField(fields.scope.host);
  const sourceKind = sourceKindFor(fields.sourceKinds);
  const metadata = makeMetadata(fields);
  const scope = Object.freeze({
    id,
    providerId: fields.scope.providerId,
    host: detail,
    ...(fields.scope.org === undefined ? {} : { org: fields.scope.org }),
    ...(fields.scope.account === undefined
      ? {}
      : { account: fields.scope.account }),
    label,
    sourceKind,
    metadata,
  });
  return Object.freeze({
    id,
    providerId: fields.scope.providerId,
    label,
    detail,
    sourceKind,
    metadata,
    scope,
  });
}

export function assembleBuiltinAuthAccounts(
  candidates: readonly BuiltinAuthAccountCandidate[]
): readonly AideAuthAccount[] {
  if (!Array.isArray(candidates)) return invalidCandidate();
  const accountsById = new Map<string, AssembledAuthAccountFields>();
  for (const rawCandidate of candidates) {
    const candidate = snapshotCandidate(rawCandidate);
    const id = authIndexScopeName(candidate.scope);
    let fields = accountsById.get(id);
    if (fields === undefined) {
      fields = {
        scope: candidate.scope,
        sourceKinds: new Set(),
        sourceNames: new Set(),
        storageKinds: new Set(),
        authMethods: [],
        defaultProjects: [],
        primarySemanticRank: undefined,
        active: undefined,
      };
      accountsById.set(id, fields);
    }
    addCandidate(fields, candidate);
  }

  return Object.freeze(
    [...accountsById.values()]
      .map(makeAccount)
      .sort((left, right) =>
        left.id < right.id ? -1 : left.id > right.id ? 1 : 0
      )
  );
}
