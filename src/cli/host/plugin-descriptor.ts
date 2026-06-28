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
  readonly extension?: AideCommandExtensionPolicy;
}

export type AidePluginCommand =
  | {
      readonly kind: 'module';
      readonly id: string;
      readonly parentId?: string;
      readonly extension?: AideCommandExtensionPolicy;
      readonly module: AnyYargsCommandModule;
    }
  | {
      readonly kind: 'descriptor';
      readonly id: string;
      readonly parentId?: string;
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

export type AidePullRequestProviderMatchSource =
  | 'git-remote'
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

export interface AidePullRequestUrlMatch extends AidePullRequestProviderMatchBase {
  readonly source: 'pull-request-url';
  readonly repository: AidePullRequestRepositoryRef;
  readonly pullRequest: AidePullRequestRef;
}

export type AidePullRequestProviderMatch =
  | AidePullRequestRemoteMatch
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
  readonly match: AidePullRequestRemoteMatch;
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

export interface AidePullRequestProviderOperations {
  readonly listPullRequests?: (
    request: AidePullRequestListRequest
  ) => Effect.Effect<AidePullRequestListResult, unknown, never>;
  readonly getPullRequest?: (
    request: AidePullRequestViewRequest
  ) => Effect.Effect<AidePullRequestViewResult, unknown, never>;
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
    extension: placement.extension,
    descriptor: eraseCommandDescriptor(
      descriptor as HostAideCommandDescriptor<TArgs>
    ),
  };
}
