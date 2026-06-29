import type { CommandResult, CommandRoute } from './host/command-descriptor.js';
import type { Effect } from 'effect';
import type {
  AideCommandExtensionPolicy,
  AidePluginCapabilities,
} from './host/plugin-descriptor.js';
import type { AideHostServicesTag } from './host/runtime-context.js';

export {
  emptyResult,
  textResult,
  type CommandResult,
  type CommandRoute,
} from './host/command-descriptor.js';
export {
  AideHostServicesTag,
  type AideHostServices,
} from './host/runtime-context.js';
export type {
  AideAuthAccount,
  AideAuthProviderCapability,
  AideAuthScope,
  AideAuthStatusRequest,
  AideCommandExtensionPolicy,
  AidePluginAuthCapability,
  AidePluginAuthState,
  AidePluginAuthStatus,
  AidePluginCapabilities,
  AidePrimeContributionCapability,
  AidePrimeSection,
  AidePrimeStatusMessages,
  AidePrimeStatusContribution,
  AidePullRequestAuthor,
  AidePullRequestBranchLookupRequest,
  AidePullRequestBranchLookupResult,
  AidePullRequestListFilterStatus,
  AidePullRequestListItem,
  AidePullRequestListItemStatus,
  AidePullRequestListRequest,
  AidePullRequestListResult,
  AidePullRequestProviderCapability,
  AidePullRequestProviderFeatures,
  AidePullRequestProviderMatch,
  AidePullRequestProviderMatchSource,
  AidePullRequestProviderOperations,
  AidePullRequestRef,
  AidePullRequestRemoteMatch,
  AidePullRequestRepositoryRef,
  AidePullRequestUrlMatch,
  AidePullRequestViewItem,
  AidePullRequestViewRequest,
  AidePullRequestViewResult,
} from './host/plugin-descriptor.js';

export const AIDE_PLUGIN_API_VERSION = 1 as const;
export type AidePluginApiVersion = typeof AIDE_PLUGIN_API_VERSION;

export const aidePluginTrustLevels = Object.freeze([
  'builtin',
  'trusted-local',
  'external',
] as const);
export type AidePluginTrustLevel = (typeof aidePluginTrustLevels)[number];

export const aidePluginCapabilityKinds = Object.freeze([
  'commands',
  'auth',
  'auth-provider',
  'prime-contribution',
  'pull-request-provider',
] as const);
export type AidePluginCapabilityKind =
  (typeof aidePluginCapabilityKinds)[number];

export const aidePluginConflictPolicies = Object.freeze(['reject'] as const);
export type AidePluginConflictPolicy =
  (typeof aidePluginConflictPolicies)[number];

export const aideReservedPluginIds = Object.freeze([
  'aide-core',
  'azure-devops',
  'claude-code',
  'github',
  'jira',
  'legacy-auth',
  'pull-requests',
] as const);

export const aideReservedPullRequestProviderIds = Object.freeze([
  'azure-devops',
  'github',
] as const);

export interface AidePluginManifest {
  readonly id: string;
  readonly version: string;
  readonly aidePluginApiVersion: AidePluginApiVersion;
  readonly main?: string;
  readonly summary?: string;
  readonly trust?: Exclude<AidePluginTrustLevel, 'builtin'>;
  readonly capabilities?: readonly AidePluginCapabilityKind[];
  readonly loading?: {
    readonly order?: number;
    readonly after?: readonly string[];
    readonly before?: readonly string[];
  };
  readonly conflicts?: {
    readonly commands?: AidePluginConflictPolicy;
    readonly authProviders?: AidePluginConflictPolicy;
    readonly pullRequestProviders?: AidePluginConflictPolicy;
  };
}

export interface AidePublicPluginCommandPlacement {
  readonly parentId?: string;
  readonly acceptsChildren?: boolean;
  readonly extension?: AideCommandExtensionPolicy;
}

export interface AideCommandInvocationArgs {
  readonly _: readonly (string | number)[];
  readonly $0: string;
}

export interface AidePluginCommandDescriptor<
  TArgs extends object = object,
  E = unknown,
  R = AideHostServicesTag,
> {
  readonly id: string;
  readonly route: CommandRoute;
  readonly summary: string;
  readonly run: (
    args: Readonly<TArgs> & AideCommandInvocationArgs
  ) => Effect.Effect<CommandResult, E, R>;
}

export type HostAidePluginCommandDescriptor<
  TArgs extends object = object,
  E = unknown,
> = AidePluginCommandDescriptor<TArgs, E, AideHostServicesTag>;

export type ServiceFreeAidePluginCommandDescriptor<
  TArgs extends object = object,
  E = unknown,
> = AidePluginCommandDescriptor<TArgs, E, never>;

export interface AidePublicPluginCommand {
  readonly kind: 'descriptor';
  readonly id: string;
  readonly parentId?: string;
  readonly acceptsChildren?: boolean;
  readonly extension?: AideCommandExtensionPolicy;
  readonly descriptor: AidePluginCommandDescriptor<object, unknown, unknown>;
}

export interface AidePublicPluginDescriptor {
  readonly id: string;
  readonly summary: string;
  readonly commands: readonly AidePublicPluginCommand[];
  readonly capabilities?: AidePluginCapabilities;
}

export function defineAidePlugin(
  plugin: AidePublicPluginDescriptor
): AidePublicPluginDescriptor {
  return plugin;
}

export function defineAideCommand<TArgs extends object, E = unknown>(
  descriptor: ServiceFreeAidePluginCommandDescriptor<TArgs, E>
): ServiceFreeAidePluginCommandDescriptor<TArgs, E>;
export function defineAideCommand<TArgs extends object, E = unknown>(
  descriptor: HostAidePluginCommandDescriptor<TArgs, E>
): HostAidePluginCommandDescriptor<TArgs, E>;
export function defineAideCommand<TArgs extends object>(
  descriptor: AidePluginCommandDescriptor<TArgs, unknown, unknown>
): AidePluginCommandDescriptor<TArgs, unknown, unknown> {
  return descriptor;
}

export function pluginCommandDescriptor<TArgs extends object, E = unknown>(
  descriptor: ServiceFreeAidePluginCommandDescriptor<TArgs, E>,
  placement?: AidePublicPluginCommandPlacement
): AidePublicPluginCommand;
export function pluginCommandDescriptor<TArgs extends object, E = unknown>(
  descriptor: HostAidePluginCommandDescriptor<TArgs, E>,
  placement?: AidePublicPluginCommandPlacement
): AidePublicPluginCommand;
export function pluginCommandDescriptor<TArgs extends object>(
  descriptor: AidePluginCommandDescriptor<TArgs, unknown, unknown>,
  placement: AidePublicPluginCommandPlacement = {}
): AidePublicPluginCommand {
  return {
    kind: 'descriptor',
    id: descriptor.id,
    parentId: placement.parentId,
    acceptsChildren: placement.acceptsChildren,
    extension: placement.extension,
    descriptor: descriptor as AidePluginCommandDescriptor<
      object,
      unknown,
      unknown
    >,
  };
}

export function isReservedAidePluginId(id: string): boolean {
  return aideReservedPluginIds.includes(
    id as (typeof aideReservedPluginIds)[number]
  );
}

export function isReservedAidePullRequestProviderId(id: string): boolean {
  return aideReservedPullRequestProviderIds.includes(
    id as (typeof aideReservedPullRequestProviderIds)[number]
  );
}
