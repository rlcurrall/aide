import type { CommandModule } from 'yargs';
import type { Effect } from 'effect';

import {
  eraseCommandDescriptor,
  type AideCommandDescriptor,
  type AnyAideCommandDescriptor,
  type HostAideCommandDescriptor,
  type ServiceFreeAideCommandDescriptor,
} from './command-descriptor.js';

export type AnyYargsCommandModule = CommandModule<object, object>;

export type AideCommandExtensionPolicy =
  | {
      readonly kind: 'same-plugin';
    }
  | {
      readonly kind: 'open';
    }
  | {
      readonly kind: 'allowlist';
      readonly pluginIds: readonly string[];
    };

export interface AidePluginCommandPlacement {
  readonly parentId?: string;
  readonly acceptsChildren?: boolean;
  readonly extension?: AideCommandExtensionPolicy;
}

export interface AideDiscoveredCapability<TCapability> {
  readonly pluginId: string;
  readonly capability: TCapability;
}

export type AidePluginCommand =
  | {
      readonly kind: 'module';
      readonly id: string;
      readonly parentId?: string;
      readonly acceptsChildren?: boolean;
      readonly extension?: AideCommandExtensionPolicy;
      readonly module: AnyYargsCommandModule;
    }
  | {
      readonly kind: 'descriptor';
      readonly id: string;
      readonly parentId?: string;
      readonly acceptsChildren?: boolean;
      readonly extension?: AideCommandExtensionPolicy;
      readonly descriptor: AnyAideCommandDescriptor;
    };

export type AidePluginAuthState =
  | 'configured'
  | 'not-configured'
  | 'misconfigured'
  | 'unavailable';

export interface AidePluginAuthStatus {
  readonly state: AidePluginAuthState;
  readonly detail?: string;
}

export interface AidePluginAuthCapability {
  readonly status: () => Effect.Effect<AidePluginAuthStatus, unknown, never>;
}

export interface AideAuthScope {
  readonly id: string;
  readonly label?: string;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

export interface AideAuthStatusRequest {
  readonly scope?: AideAuthScope;
}

export interface AideAuthAccount {
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
  readonly scope?: AideAuthScope;
}

export interface AideAuthCommandNames {
  readonly name?: string;
  readonly aliases?: readonly string[];
}

export interface AideAuthEnvMigration {
  readonly description: string;
  readonly variables: readonly string[];
}

export interface AideAuthInputChoice {
  readonly value: string;
  readonly label?: string;
}

export type AideAuthInputField =
  | {
      readonly kind: 'text' | 'secret';
      readonly key: string;
      readonly label: string;
      readonly description?: string;
      readonly required?: boolean;
      readonly stdin?: boolean;
      readonly validate?: (value: string) => string | null;
    }
  | {
      readonly kind: 'select';
      readonly key: string;
      readonly label: string;
      readonly description?: string;
      readonly required?: boolean;
      readonly choices: readonly AideAuthInputChoice[];
      readonly default?: string;
    };

export interface AideAuthLoginMetadata {
  readonly command?: AideAuthCommandNames;
  readonly summary?: string;
  readonly fields?: readonly AideAuthInputField[];
  readonly envMigration?: AideAuthEnvMigration;
}

export interface AideAuthLogoutMetadata {
  readonly command?: AideAuthCommandNames;
  readonly summary?: string;
}

export interface AideAuthPromptTextRequest {
  readonly label: string;
  readonly secret?: boolean;
  readonly validate?: (value: string) => string | null;
}

export interface AideAuthPrompt {
  readonly text: (
    request: AideAuthPromptTextRequest
  ) => Effect.Effect<string, unknown, never>;
}

export type AideAuthInputValue = string | boolean | undefined;

export interface AideAuthLoginRequest {
  readonly fromEnv?: boolean;
  readonly values?: Readonly<Record<string, AideAuthInputValue>>;
  readonly prompt?: AideAuthPrompt;
}

export interface AideAuthLoginResult {
  readonly status: 'stored' | 'external' | 'unchanged';
  readonly messages?: readonly string[];
}

export interface AideAuthLogoutResult {
  readonly status: 'removed' | 'not-found';
  readonly messages?: readonly string[];
}

export interface AideAuthProviderOperations {
  readonly login?: (
    request: AideAuthLoginRequest
  ) => Effect.Effect<AideAuthLoginResult, unknown, never>;
  readonly logout?: () => Effect.Effect<AideAuthLogoutResult, unknown, never>;
}

export interface AideAuthProviderCapability {
  readonly providerId: string;
  readonly label: string;
  readonly login?: AideAuthLoginMetadata;
  readonly logout?: AideAuthLogoutMetadata;
  readonly status: (
    request?: AideAuthStatusRequest
  ) => Effect.Effect<AidePluginAuthStatus, unknown, never>;
  readonly accounts?: () => Effect.Effect<
    readonly AideAuthAccount[],
    unknown,
    never
  >;
  readonly operations?: AideAuthProviderOperations;
}

export interface AidePrimeStatusMessages {
  readonly configured?: string;
  readonly notConfigured?: string;
  readonly misconfigured?: string;
}

export interface AidePrimeStatusContribution {
  readonly groupId: string;
  readonly groupLabel: string;
  readonly label: string;
  readonly messages?: AidePrimeStatusMessages;
  readonly status: () => Effect.Effect<AidePluginAuthStatus, unknown, never>;
}

export interface AidePrimeSection {
  readonly id: string;
  readonly order?: number;
  readonly body: string;
}

export interface AidePrimeContributionCapability {
  readonly status?: readonly AidePrimeStatusContribution[];
  readonly sections?: () => Effect.Effect<
    readonly AidePrimeSection[],
    unknown,
    never
  >;
}

export type AidePullRequestProviderMatchSource =
  | 'git-remote'
  | 'repository-ref'
  | 'pull-request-url';

export type AidePullRequestRepositoryRef =
  | {
      readonly kind: 'github';
      readonly host: string;
      readonly owner: string;
      readonly repo: string;
    }
  | {
      readonly kind: 'azure-devops';
      readonly org: string;
      readonly project: string;
      readonly repo: string;
    }
  | {
      readonly kind: 'external';
      readonly providerId: string;
      readonly displayName: string;
      readonly metadata?: Readonly<Record<string, string | number | boolean>>;
    };

export interface AidePullRequestRef {
  readonly number: number;
}

interface AidePullRequestProviderMatchBase {
  readonly priority?: number;
  readonly detail?: string;
}

export interface AidePullRequestRemoteMatch extends AidePullRequestProviderMatchBase {
  readonly source: 'git-remote';
  readonly repository: AidePullRequestRepositoryRef;
  readonly pullRequest?: never;
}

export interface AidePullRequestRepositoryMatch extends AidePullRequestProviderMatchBase {
  readonly source: 'repository-ref';
  readonly repository: AidePullRequestRepositoryRef;
  readonly pullRequest?: never;
}

export interface AidePullRequestUrlMatch extends AidePullRequestProviderMatchBase {
  readonly source: 'pull-request-url';
  readonly repository: AidePullRequestRepositoryRef;
  readonly pullRequest: AidePullRequestRef;
}

export type AidePullRequestProviderMatch =
  | AidePullRequestRemoteMatch
  | AidePullRequestRepositoryMatch
  | AidePullRequestUrlMatch;

export interface AidePullRequestProviderFeatures {
  readonly draftPullRequests?: boolean;
  readonly reviewComments?: boolean;
  readonly threadedComments?: boolean;
  readonly enterpriseHosts?: boolean;
}

export type AidePullRequestListFilterStatus =
  | 'active'
  | 'completed'
  | 'abandoned'
  | 'all';

export type AidePullRequestListItemStatus =
  | 'active'
  | 'completed'
  | 'abandoned'
  | 'draft';

export interface AidePullRequestListRequest {
  readonly match: AidePullRequestRemoteMatch | AidePullRequestRepositoryMatch;
  readonly status?: AidePullRequestListFilterStatus;
  readonly limit?: number;
  readonly createdBy?: string;
}

export interface AidePullRequestAuthor {
  readonly displayName: string;
  readonly username?: string;
  readonly email?: string;
}

export interface AidePullRequestListItem {
  readonly id: number;
  readonly title: string;
  readonly status: AidePullRequestListItemStatus;
  readonly createdAt: string;
  readonly author: AidePullRequestAuthor;
  readonly description?: string;
  readonly url?: string;
  readonly draft?: boolean;
}

export interface AidePullRequestListResult {
  readonly repository: AidePullRequestRepositoryRef;
  readonly repositoryLabel?: string;
  readonly pullRequests: readonly AidePullRequestListItem[];
}

export interface AidePullRequestViewRequest {
  readonly match: AidePullRequestProviderMatch;
  readonly pullRequest: AidePullRequestRef;
}

export interface AidePullRequestViewItem extends AidePullRequestListItem {
  readonly sourceBranch?: string;
  readonly targetBranch?: string;
  readonly labels?: readonly string[];
}

export interface AidePullRequestViewResult {
  readonly repository: AidePullRequestRepositoryRef;
  readonly repositoryLabel?: string;
  readonly pullRequest: AidePullRequestViewItem;
}

export type AidePullRequestDiffFileStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'unchanged'
  | 'unknown';

export interface AidePullRequestDiffFile {
  readonly path: string;
  readonly status: AidePullRequestDiffFileStatus;
  readonly providerStatus?: string;
  readonly previousPath?: string;
  readonly additions?: number;
  readonly deletions?: number;
  readonly changes?: number;
  readonly patch?: string;
}

export interface AidePullRequestDiffRequest {
  readonly match: AidePullRequestProviderMatch;
  readonly pullRequest: AidePullRequestRef;
}

export interface AidePullRequestDiffResult extends AidePullRequestViewResult {
  readonly files: readonly AidePullRequestDiffFile[];
}

export type AidePullRequestCommentKind =
  | 'issue'
  | 'review'
  | 'reply'
  | 'system'
  | 'unknown';

export interface AidePullRequestCommentAuthor {
  readonly displayName: string;
  readonly username?: string;
  readonly email?: string;
}

export interface AidePullRequestComment {
  readonly id: number;
  readonly kind: AidePullRequestCommentKind;
  readonly author: AidePullRequestCommentAuthor;
  readonly body: string;
  readonly createdAt: string;
  readonly updatedAt?: string;
  readonly url?: string;
  readonly filePath?: string;
  readonly lineNumber?: number;
  readonly parentId?: number;
  readonly providerType?: string;
}

export interface AidePullRequestCommentThread {
  readonly id: number | string;
  readonly status?: string;
  readonly filePath?: string;
  readonly lineNumber?: number;
  readonly rootComment?: AidePullRequestComment;
  readonly replies: readonly AidePullRequestComment[];
}

export interface AidePullRequestCommentsRequest {
  readonly match: AidePullRequestProviderMatch;
  readonly pullRequest: AidePullRequestRef;
}

export interface AidePullRequestCommentsResult {
  readonly repository: AidePullRequestRepositoryRef;
  readonly repositoryLabel?: string;
  readonly pullRequest: AidePullRequestRef;
  readonly threads: readonly AidePullRequestCommentThread[];
}

export interface AidePullRequestCommentPosition {
  readonly filePath: string;
  readonly lineNumber: number;
  readonly endLineNumber?: number;
}

export interface AidePullRequestAddCommentRequest {
  readonly match: AidePullRequestProviderMatch;
  readonly pullRequest: AidePullRequestRef;
  readonly body: string;
  readonly position?: AidePullRequestCommentPosition;
}

export interface AidePullRequestReplyCommentRequest {
  readonly match: AidePullRequestProviderMatch;
  readonly pullRequest: AidePullRequestRef;
  readonly threadId: number;
  readonly body: string;
  readonly parentCommentId?: number;
}

export interface AidePullRequestCommentMutationResult {
  readonly repository: AidePullRequestRepositoryRef;
  readonly repositoryLabel?: string;
  readonly pullRequest: AidePullRequestRef;
  readonly comment: AidePullRequestComment;
  readonly thread?: AidePullRequestCommentThread;
}

export interface AidePullRequestBranchLookupRequest {
  readonly match: AidePullRequestRemoteMatch | AidePullRequestRepositoryMatch;
  readonly branch: string;
}

export interface AidePullRequestBranchLookupResult extends AidePullRequestViewResult {
  readonly branch: string;
}

export interface AidePullRequestProviderOperations {
  readonly listPullRequests?: (
    request: AidePullRequestListRequest
  ) => Effect.Effect<AidePullRequestListResult, unknown, never>;
  readonly getPullRequest?: (
    request: AidePullRequestViewRequest
  ) => Effect.Effect<AidePullRequestViewResult, unknown, never>;
  readonly getPullRequestDiff?: (
    request: AidePullRequestDiffRequest
  ) => Effect.Effect<AidePullRequestDiffResult, unknown, never>;
  readonly listPullRequestComments?: (
    request: AidePullRequestCommentsRequest
  ) => Effect.Effect<AidePullRequestCommentsResult, unknown, never>;
  readonly addPullRequestComment?: (
    request: AidePullRequestAddCommentRequest
  ) => Effect.Effect<AidePullRequestCommentMutationResult, unknown, never>;
  readonly replyToPullRequestComment?: (
    request: AidePullRequestReplyCommentRequest
  ) => Effect.Effect<AidePullRequestCommentMutationResult, unknown, never>;
  readonly findPullRequestForBranch?: (
    request: AidePullRequestBranchLookupRequest
  ) => Effect.Effect<AidePullRequestBranchLookupResult, unknown, never>;
}

export interface AidePullRequestProviderCapability {
  readonly providerId: string;
  readonly priority: number;
  readonly features: AidePullRequestProviderFeatures;
  readonly matchRemote: (
    remoteUrl: string
  ) => AidePullRequestRemoteMatch | null;
  readonly matchPullRequestUrl: (url: string) => AidePullRequestUrlMatch | null;
  readonly operations?: AidePullRequestProviderOperations;
  readonly authStatus: () => Effect.Effect<
    AidePluginAuthStatus,
    unknown,
    never
  >;
}

export const corePullRequestProviderOwners = Object.freeze({
  github: 'github',
  'azure-devops': 'azure-devops',
} as const);

export const coreAuthProviderOwners = Object.freeze({
  ado: 'azure-devops',
  'azure-devops': 'azure-devops',
  github: 'github',
  jira: 'jira',
} as const);

export function coreAuthProviderOwner(providerId: string): string | undefined {
  if (
    !Object.prototype.hasOwnProperty.call(coreAuthProviderOwners, providerId)
  ) {
    return undefined;
  }

  return coreAuthProviderOwners[
    providerId as keyof typeof coreAuthProviderOwners
  ];
}

export function corePullRequestProviderOwner(
  providerId: string
): string | undefined {
  if (
    !Object.prototype.hasOwnProperty.call(
      corePullRequestProviderOwners,
      providerId
    )
  ) {
    return undefined;
  }

  return corePullRequestProviderOwners[
    providerId as keyof typeof corePullRequestProviderOwners
  ];
}

export interface AidePluginCapabilities {
  readonly auth?: AidePluginAuthCapability;
  readonly authProvider?: AideAuthProviderCapability;
  readonly primeContribution?: AidePrimeContributionCapability;
  readonly pullRequestProvider?: AidePullRequestProviderCapability;
}

export interface AidePluginDescriptor {
  readonly id: string;
  readonly summary: string;
  readonly commands: readonly AidePluginCommand[];
  readonly capabilities?: AidePluginCapabilities;
}

export function defineAidePlugin(
  plugin: AidePluginDescriptor
): AidePluginDescriptor {
  return plugin;
}

export function pluginCommandModule<TBase extends object, TArgs extends object>(
  id: string,
  module: CommandModule<TBase, TArgs>,
  placement: AidePluginCommandPlacement = {}
): AidePluginCommand {
  return {
    kind: 'module',
    id,
    parentId: placement.parentId,
    acceptsChildren: placement.acceptsChildren,
    extension: placement.extension,
    module: module as unknown as AnyYargsCommandModule,
  };
}

export function pluginCommandDescriptor<TArgs extends object, E = unknown>(
  descriptor: ServiceFreeAideCommandDescriptor<TArgs, E>,
  placement?: AidePluginCommandPlacement
): AidePluginCommand;
export function pluginCommandDescriptor<TArgs extends object, E = unknown>(
  descriptor: HostAideCommandDescriptor<TArgs, E>,
  placement?: AidePluginCommandPlacement
): AidePluginCommand;
export function pluginCommandDescriptor<TArgs extends object>(
  descriptor: AideCommandDescriptor<TArgs, unknown, unknown>,
  placement: AidePluginCommandPlacement = {}
): AidePluginCommand {
  return {
    kind: 'descriptor',
    id: descriptor.id,
    parentId: placement.parentId,
    acceptsChildren: placement.acceptsChildren,
    extension: placement.extension,
    descriptor: eraseCommandDescriptor(
      descriptor as HostAideCommandDescriptor<TArgs>
    ),
  };
}
