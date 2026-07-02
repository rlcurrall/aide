import type { CommandModule } from 'yargs';

import {
  eraseCommandDescriptor,
  type AideCommandDescriptor,
  type AnyAideCommandDescriptor,
  type HostAideCommandDescriptor,
  type ServiceFreeAideCommandDescriptor,
} from './command-descriptor.js';
import type {
  AideCommandExtensionPolicy,
  AidePluginAuthCapability,
  AidePluginCapabilities,
  AidePluginCommand,
  AidePluginDescriptor,
  AidePullRequestProviderCapability,
  AidePullRequestProviderOperations,
  AnyYargsCommandModule,
  AideAuthProviderCapability,
  AideAuthCommandNames,
  AideAuthEnvMigration,
  AideAuthInputChoice,
  AideAuthInputField,
  AideAuthLoginMetadata,
  AideAuthLogoutMetadata,
  AideAuthProviderOperations,
  AidePrimeContributionCapability,
  AidePrimeStatusContribution,
  AidePrimeStatusMessages,
} from './plugin-descriptor.js';
import {
  coreAuthProviderOwner,
  corePullRequestProviderOwner,
} from './plugin-descriptor.js';
import {
  AIDE_PLUGIN_API_VERSION,
  aidePluginCapabilityKinds,
  isReservedAidePluginId,
  isReservedAidePullRequestProviderId,
  type AidePluginCapabilityKind,
  type AidePluginManifest,
  type AidePublicPluginDescriptor,
} from '../plugin-api.js';
import { authInputFieldFlagName } from './auth-input-fields.js';

const defaultExtensionPolicy: AideCommandExtensionPolicy = Object.freeze({
  kind: 'same-plugin',
});
const authCommandTokenPattern = /^[a-z][a-z0-9-]*$/;
const reservedAuthLoginFlagNames = new Set([
  'from-env',
  'h',
  'help',
  'v',
  'version',
]);

function eraseCommandModule<TBase extends object, TArgs extends object>(
  module: CommandModule<TBase, TArgs>
): AnyYargsCommandModule {
  return Object.freeze({ ...module }) as unknown as AnyYargsCommandModule;
}

function snapshotExtensionPolicy(
  policy: AideCommandExtensionPolicy | undefined
): AideCommandExtensionPolicy | undefined {
  if (policy === undefined) return undefined;
  if (policy.kind !== 'allowlist') return Object.freeze({ ...policy });

  const pluginIds = policy.pluginIds.map((pluginId) => {
    assertId('Plugin', pluginId);
    return pluginId;
  });

  return Object.freeze({
    kind: 'allowlist',
    pluginIds: Object.freeze(pluginIds),
  });
}

function snapshotAcceptsChildren(
  pluginId: string,
  commandId: string,
  acceptsChildren: unknown
): boolean | undefined {
  if (acceptsChildren === undefined) return undefined;
  if (typeof acceptsChildren !== 'boolean') {
    throw new Error(
      `Plugin '${pluginId}' command '${commandId}' acceptsChildren must be a boolean`
    );
  }

  return acceptsChildren;
}

function snapshotCommandDescriptor<TArgs extends object, E = unknown>(
  descriptor: HostAideCommandDescriptor<TArgs, E>
): AnyAideCommandDescriptor {
  const erased = eraseCommandDescriptor(descriptor);
  return Object.freeze({
    ...erased,
    yargs:
      erased.yargs === undefined
        ? undefined
        : Object.freeze({ ...erased.yargs }),
  });
}

function freezeRouteKeys(keys: readonly string[]): readonly string[] {
  return Object.freeze([...keys]);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function assertFunction(
  pluginId: string,
  capability: string,
  field: string,
  value: unknown
): asserts value is (...args: never[]) => unknown {
  if (typeof value !== 'function') {
    throw new Error(
      `Plugin '${pluginId}' ${capability} capability field '${field}' must be a function`
    );
  }
}

function assertNonEmptyString(
  pluginId: string,
  capability: string,
  field: string,
  value: unknown
): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(
      `Plugin '${pluginId}' ${capability} capability field '${field}' must be a non-empty string`
    );
  }
}

function assertAuthCommandToken(
  pluginId: string,
  providerId: string,
  operation: 'login' | 'logout',
  field: string,
  value: string
): void {
  assertId('Auth provider', value);
  if (!authCommandTokenPattern.test(value)) {
    throw new Error(
      `Plugin '${pluginId}' auth provider '${providerId}' ${operation} command ${field} '${value}' must be lowercase kebab-case`
    );
  }
}

function snapshotAuthCommandNames(
  pluginId: string,
  providerId: string,
  operation: 'login' | 'logout',
  command: unknown
): AideAuthCommandNames | undefined {
  if (command === undefined) return undefined;
  if (!isRecord(command)) {
    throw new Error(
      `Plugin '${pluginId}' auth provider '${providerId}' ${operation} command metadata must be an object`
    );
  }

  const name = command.name;
  const aliases = command.aliases;
  if (name !== undefined) {
    if (typeof name !== 'string') {
      throw new Error(
        `Plugin '${pluginId}' auth provider '${providerId}' ${operation} command name must be a string`
      );
    }
    assertAuthCommandToken(pluginId, providerId, operation, 'name', name);
  }
  if (aliases !== undefined && !Array.isArray(aliases)) {
    throw new Error(
      `Plugin '${pluginId}' auth provider '${providerId}' ${operation} command aliases must be an array`
    );
  }

  const snapshotAliases =
    aliases === undefined
      ? undefined
      : Object.freeze(
          aliases.map((alias) => {
            if (typeof alias !== 'string') {
              throw new Error(
                `Plugin '${pluginId}' auth provider '${providerId}' ${operation} command aliases must contain strings`
              );
            }
            assertAuthCommandToken(
              pluginId,
              providerId,
              operation,
              'alias',
              alias
            );
            return alias;
          })
        );

  return Object.freeze({
    ...(name === undefined ? {} : { name: name as string }),
    ...(snapshotAliases === undefined ? {} : { aliases: snapshotAliases }),
  });
}

function snapshotAuthEnvMigration(
  pluginId: string,
  providerId: string,
  value: unknown
): AideAuthEnvMigration | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error(
      `Plugin '${pluginId}' auth provider '${providerId}' env migration metadata must be an object`
    );
  }

  assertNonEmptyString(
    pluginId,
    `auth provider '${providerId}' env migration`,
    'description',
    value.description
  );
  if (!Array.isArray(value.variables)) {
    throw new Error(
      `Plugin '${pluginId}' auth provider '${providerId}' env migration variables must be an array`
    );
  }

  return Object.freeze({
    description: value.description as string,
    variables: Object.freeze(
      value.variables.map((variable) => {
        if (typeof variable !== 'string' || variable.trim() === '') {
          throw new Error(
            `Plugin '${pluginId}' auth provider '${providerId}' env migration variables must contain non-empty strings`
          );
        }
        return variable;
      })
    ),
  });
}

function snapshotAuthInputChoice(
  pluginId: string,
  providerId: string,
  fieldKey: string,
  value: unknown
): AideAuthInputChoice {
  if (!isRecord(value)) {
    throw new Error(
      `Plugin '${pluginId}' auth provider '${providerId}' field '${fieldKey}' choices must contain objects`
    );
  }
  assertNonEmptyString(
    pluginId,
    `auth provider '${providerId}' field '${fieldKey}' choice`,
    'value',
    value.value
  );
  if (
    value.label !== undefined &&
    (typeof value.label !== 'string' || value.label.trim() === '')
  ) {
    throw new Error(
      `Plugin '${pluginId}' auth provider '${providerId}' field '${fieldKey}' choice label must be a non-empty string`
    );
  }

  return Object.freeze({
    value: value.value as string,
    ...(value.label === undefined ? {} : { label: value.label as string }),
  });
}

function snapshotAuthInputField(
  pluginId: string,
  providerId: string,
  field: unknown
): AideAuthInputField {
  if (!isRecord(field)) {
    throw new Error(
      `Plugin '${pluginId}' auth provider '${providerId}' login fields must contain objects`
    );
  }

  if (
    field.kind !== 'text' &&
    field.kind !== 'secret' &&
    field.kind !== 'select'
  ) {
    throw new Error(
      `Plugin '${pluginId}' auth provider '${providerId}' login field kind must be 'text', 'secret', or 'select'`
    );
  }
  assertNonEmptyString(
    pluginId,
    `auth provider '${providerId}' login field`,
    'key',
    field.key
  );
  assertId('Auth input field', field.key as string);
  assertNonEmptyString(
    pluginId,
    `auth provider '${providerId}' login field '${field.key}'`,
    'label',
    field.label
  );

  if (
    field.description !== undefined &&
    (typeof field.description !== 'string' || field.description.trim() === '')
  ) {
    throw new Error(
      `Plugin '${pluginId}' auth provider '${providerId}' login field '${field.key}' description must be a non-empty string`
    );
  }
  if (field.required !== undefined && typeof field.required !== 'boolean') {
    throw new Error(
      `Plugin '${pluginId}' auth provider '${providerId}' login field '${field.key}' required must be a boolean`
    );
  }

  if (field.kind === 'select') {
    if (!Array.isArray(field.choices) || field.choices.length === 0) {
      throw new Error(
        `Plugin '${pluginId}' auth provider '${providerId}' login field '${field.key}' choices must be a non-empty array`
      );
    }

    const choices = Object.freeze(
      field.choices.map((choice) =>
        snapshotAuthInputChoice(
          pluginId,
          providerId,
          field.key as string,
          choice
        )
      )
    );
    if (
      field.default !== undefined &&
      (typeof field.default !== 'string' ||
        !choices.some((choice) => choice.value === field.default))
    ) {
      throw new Error(
        `Plugin '${pluginId}' auth provider '${providerId}' login field '${field.key}' default must match a choice value`
      );
    }

    return Object.freeze({
      kind: 'select',
      key: field.key as string,
      label: field.label as string,
      ...(field.description === undefined
        ? {}
        : { description: field.description as string }),
      ...(field.required === undefined
        ? {}
        : { required: field.required as boolean }),
      choices,
      ...(field.default === undefined ? {} : { default: field.default }),
    });
  }

  if (field.stdin !== undefined && typeof field.stdin !== 'boolean') {
    throw new Error(
      `Plugin '${pluginId}' auth provider '${providerId}' login field '${field.key}' stdin must be a boolean`
    );
  }
  if (field.validate !== undefined && typeof field.validate !== 'function') {
    throw new Error(
      `Plugin '${pluginId}' auth provider '${providerId}' login field '${field.key}' validate must be a function`
    );
  }

  return Object.freeze({
    kind: field.kind,
    key: field.key as string,
    label: field.label as string,
    ...(field.description === undefined
      ? {}
      : { description: field.description as string }),
    ...(field.required === undefined
      ? {}
      : { required: field.required as boolean }),
    ...(field.stdin === undefined ? {} : { stdin: field.stdin as boolean }),
    ...(field.validate === undefined
      ? {}
      : { validate: field.validate as (value: string) => string | null }),
  });
}

function snapshotAuthLoginMetadata(
  pluginId: string,
  providerId: string,
  metadata: unknown
): AideAuthLoginMetadata | undefined {
  if (metadata === undefined) return undefined;
  if (!isRecord(metadata)) {
    throw new Error(
      `Plugin '${pluginId}' auth provider '${providerId}' login metadata must be an object`
    );
  }

  if (
    metadata.summary !== undefined &&
    (typeof metadata.summary !== 'string' || metadata.summary.trim() === '')
  ) {
    throw new Error(
      `Plugin '${pluginId}' auth provider '${providerId}' login summary must be a non-empty string`
    );
  }
  if (metadata.fields !== undefined && !Array.isArray(metadata.fields)) {
    throw new Error(
      `Plugin '${pluginId}' auth provider '${providerId}' login fields must be an array`
    );
  }

  const fields =
    metadata.fields === undefined
      ? undefined
      : Object.freeze(
          metadata.fields.map((field) =>
            snapshotAuthInputField(pluginId, providerId, field)
          )
        );
  const fieldKeys = fields?.map((field) => field.key) ?? [];
  const duplicateKey = fieldKeys.find(
    (key, index) => fieldKeys.indexOf(key) !== index
  );
  if (duplicateKey !== undefined) {
    throw new Error(
      `Plugin '${pluginId}' auth provider '${providerId}' declares login field '${duplicateKey}' more than once`
    );
  }
  const flagOwners = new Map<string, string>();
  for (const field of fields ?? []) {
    const flagName = authInputFieldFlagName(field);
    if (!/^[a-z][a-z0-9-]*$/.test(flagName)) {
      throw new Error(
        `Plugin '${pluginId}' auth provider '${providerId}' login field '${field.key}' maps to invalid flag name '${flagName}'`
      );
    }
    if (reservedAuthLoginFlagNames.has(flagName)) {
      throw new Error(
        `Plugin '${pluginId}' auth provider '${providerId}' login field '${field.key}' maps to reserved flag '--${flagName}'`
      );
    }
    const existingField = flagOwners.get(flagName);
    if (existingField !== undefined) {
      throw new Error(
        `Plugin '${pluginId}' auth provider '${providerId}' declares login fields '${existingField}' and '${field.key}' that both map to flag '--${flagName}'`
      );
    }
    flagOwners.set(flagName, field.key);
  }

  return Object.freeze({
    command: snapshotAuthCommandNames(
      pluginId,
      providerId,
      'login',
      metadata.command
    ),
    ...(metadata.summary === undefined
      ? {}
      : { summary: metadata.summary as string }),
    ...(fields === undefined ? {} : { fields }),
    envMigration: snapshotAuthEnvMigration(
      pluginId,
      providerId,
      metadata.envMigration
    ),
  });
}

function snapshotAuthLogoutMetadata(
  pluginId: string,
  providerId: string,
  metadata: unknown
): AideAuthLogoutMetadata | undefined {
  if (metadata === undefined) return undefined;
  if (!isRecord(metadata)) {
    throw new Error(
      `Plugin '${pluginId}' auth provider '${providerId}' logout metadata must be an object`
    );
  }
  if (
    metadata.summary !== undefined &&
    (typeof metadata.summary !== 'string' || metadata.summary.trim() === '')
  ) {
    throw new Error(
      `Plugin '${pluginId}' auth provider '${providerId}' logout summary must be a non-empty string`
    );
  }

  return Object.freeze({
    command: snapshotAuthCommandNames(
      pluginId,
      providerId,
      'logout',
      metadata.command
    ),
    ...(metadata.summary === undefined
      ? {}
      : { summary: metadata.summary as string }),
  });
}

function snapshotAuthCapability(
  pluginId: string,
  capability: unknown
): AidePluginAuthCapability {
  if (!isRecord(capability)) {
    throw new Error(`Plugin '${pluginId}' auth capability must be an object`);
  }

  assertFunction(pluginId, 'auth', 'status', capability.status);

  return Object.freeze({
    status: capability.status as AidePluginAuthCapability['status'],
  });
}

function snapshotAuthProviderOperations(
  pluginId: string,
  providerId: string,
  operations: unknown
): AideAuthProviderOperations | undefined {
  if (operations === undefined) return undefined;
  if (!isRecord(operations)) {
    throw new Error(
      `Plugin '${pluginId}' auth provider '${providerId}' operations must be an object`
    );
  }

  const login = operations.login;
  const logout = operations.logout;
  if (login !== undefined && typeof login !== 'function') {
    throw new Error(
      `Plugin '${pluginId}' auth provider '${providerId}' operation 'login' must be a function`
    );
  }
  if (logout !== undefined && typeof logout !== 'function') {
    throw new Error(
      `Plugin '${pluginId}' auth provider '${providerId}' operation 'logout' must be a function`
    );
  }

  if (login === undefined && logout === undefined) {
    return Object.freeze({});
  }

  return Object.freeze({
    ...(login === undefined
      ? {}
      : { login: login as AideAuthProviderOperations['login'] }),
    ...(logout === undefined
      ? {}
      : { logout: logout as AideAuthProviderOperations['logout'] }),
  });
}

function snapshotAuthProviderCapability(
  pluginId: string,
  capability: unknown
): AideAuthProviderCapability {
  if (!isRecord(capability)) {
    throw new Error(
      `Plugin '${pluginId}' auth provider capability must be an object`
    );
  }

  if (typeof capability.providerId !== 'string') {
    throw new Error(`Plugin '${pluginId}' auth provider id must be a string`);
  }
  assertId('Auth provider', capability.providerId);
  assertNonEmptyString(pluginId, 'auth provider', 'label', capability.label);
  assertFunction(pluginId, 'auth provider', 'status', capability.status);
  if (
    capability.accounts !== undefined &&
    typeof capability.accounts !== 'function'
  ) {
    throw new Error(
      `Plugin '${pluginId}' auth provider capability field 'accounts' must be a function`
    );
  }

  return Object.freeze({
    providerId: capability.providerId,
    label: capability.label,
    login: snapshotAuthLoginMetadata(
      pluginId,
      capability.providerId,
      capability.login
    ),
    logout: snapshotAuthLogoutMetadata(
      pluginId,
      capability.providerId,
      capability.logout
    ),
    status: capability.status as AideAuthProviderCapability['status'],
    accounts:
      capability.accounts === undefined
        ? undefined
        : (capability.accounts as AideAuthProviderCapability['accounts']),
    operations: snapshotAuthProviderOperations(
      pluginId,
      capability.providerId,
      capability.operations
    ),
  });
}

function snapshotPrimeStatusContribution(
  pluginId: string,
  contribution: unknown
): AidePrimeStatusContribution {
  if (!isRecord(contribution)) {
    throw new Error(
      `Plugin '${pluginId}' prime contribution status entries must be objects`
    );
  }

  if (typeof contribution.groupId !== 'string') {
    throw new Error(
      `Plugin '${pluginId}' prime contribution status group id must be a string`
    );
  }
  assertId('Prime status group', contribution.groupId);
  assertNonEmptyString(
    pluginId,
    'prime contribution',
    'groupLabel',
    contribution.groupLabel
  );
  assertNonEmptyString(
    pluginId,
    'prime contribution',
    'label',
    contribution.label
  );
  assertFunction(pluginId, 'prime contribution', 'status', contribution.status);

  return Object.freeze({
    groupId: contribution.groupId,
    groupLabel: contribution.groupLabel,
    label: contribution.label,
    messages: snapshotPrimeStatusMessages(pluginId, contribution.messages),
    status: contribution.status as AidePrimeStatusContribution['status'],
  });
}

function snapshotPrimeStatusMessages(
  pluginId: string,
  messages: unknown
): AidePrimeStatusMessages | undefined {
  if (messages === undefined) return undefined;
  if (!isRecord(messages)) {
    throw new Error(
      `Plugin '${pluginId}' prime contribution messages must be an object`
    );
  }

  const snapshot: Record<string, string> = {};
  for (const key of ['configured', 'notConfigured', 'misconfigured'] as const) {
    const value = messages[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(
        `Plugin '${pluginId}' prime contribution message '${key}' must be a non-empty string`
      );
    }
    snapshot[key] = value;
  }

  return Object.freeze(snapshot);
}

function snapshotPrimeContributionCapability(
  pluginId: string,
  capability: unknown
): AidePrimeContributionCapability {
  if (!isRecord(capability)) {
    throw new Error(
      `Plugin '${pluginId}' prime contribution capability must be an object`
    );
  }

  if (capability.status === undefined && capability.sections === undefined) {
    throw new Error(
      `Plugin '${pluginId}' prime contribution capability must provide status or sections`
    );
  }

  if (capability.status !== undefined && !Array.isArray(capability.status)) {
    throw new Error(
      `Plugin '${pluginId}' prime contribution status must be an array`
    );
  }
  if (
    capability.sections !== undefined &&
    typeof capability.sections !== 'function'
  ) {
    throw new Error(
      `Plugin '${pluginId}' prime contribution capability field 'sections' must be a function`
    );
  }

  return Object.freeze({
    status:
      capability.status === undefined
        ? undefined
        : Object.freeze(
            capability.status.map((entry) =>
              snapshotPrimeStatusContribution(pluginId, entry)
            )
          ),
    sections:
      capability.sections === undefined
        ? undefined
        : (capability.sections as AidePrimeContributionCapability['sections']),
  });
}

function snapshotPullRequestProviderFeatures(
  pluginId: string,
  features: unknown
): AidePullRequestProviderCapability['features'] {
  if (!isRecord(features)) {
    throw new Error(
      `Plugin '${pluginId}' pull request provider features must be an object`
    );
  }

  const snapshot: Record<string, boolean> = {};
  for (const key of [
    'draftPullRequests',
    'reviewComments',
    'threadedComments',
    'enterpriseHosts',
  ] as const) {
    const value = features[key];
    if (value === undefined) continue;
    if (typeof value !== 'boolean') {
      throw new Error(
        `Plugin '${pluginId}' pull request provider feature '${key}' must be a boolean`
      );
    }
    snapshot[key] = value;
  }

  return Object.freeze(snapshot);
}

function snapshotPullRequestProviderOperations(
  pluginId: string,
  providerId: string,
  operations: unknown
): AidePullRequestProviderOperations | undefined {
  if (operations === undefined) return undefined;
  if (!isRecord(operations)) {
    throw new Error(
      `Plugin '${pluginId}' pull request provider '${providerId}' operations must be an object`
    );
  }

  const listPullRequests = operations.listPullRequests;
  const getPullRequest = operations.getPullRequest;
  const updatePullRequest = operations.updatePullRequest;
  const getPullRequestDiff = operations.getPullRequestDiff;
  const listPullRequestComments = operations.listPullRequestComments;
  const addPullRequestComment = operations.addPullRequestComment;
  const replyToPullRequestComment = operations.replyToPullRequestComment;
  const findPullRequestForBranch = operations.findPullRequestForBranch;
  if (
    listPullRequests !== undefined &&
    typeof listPullRequests !== 'function'
  ) {
    throw new Error(
      `Plugin '${pluginId}' pull request provider '${providerId}' operation 'listPullRequests' must be a function`
    );
  }
  if (getPullRequest !== undefined && typeof getPullRequest !== 'function') {
    throw new Error(
      `Plugin '${pluginId}' pull request provider '${providerId}' operation 'getPullRequest' must be a function`
    );
  }
  if (
    updatePullRequest !== undefined &&
    typeof updatePullRequest !== 'function'
  ) {
    throw new Error(
      `Plugin '${pluginId}' pull request provider '${providerId}' operation 'updatePullRequest' must be a function`
    );
  }
  if (
    getPullRequestDiff !== undefined &&
    typeof getPullRequestDiff !== 'function'
  ) {
    throw new Error(
      `Plugin '${pluginId}' pull request provider '${providerId}' operation 'getPullRequestDiff' must be a function`
    );
  }
  if (
    listPullRequestComments !== undefined &&
    typeof listPullRequestComments !== 'function'
  ) {
    throw new Error(
      `Plugin '${pluginId}' pull request provider '${providerId}' operation 'listPullRequestComments' must be a function`
    );
  }
  if (
    addPullRequestComment !== undefined &&
    typeof addPullRequestComment !== 'function'
  ) {
    throw new Error(
      `Plugin '${pluginId}' pull request provider '${providerId}' operation 'addPullRequestComment' must be a function`
    );
  }
  if (
    replyToPullRequestComment !== undefined &&
    typeof replyToPullRequestComment !== 'function'
  ) {
    throw new Error(
      `Plugin '${pluginId}' pull request provider '${providerId}' operation 'replyToPullRequestComment' must be a function`
    );
  }
  if (
    findPullRequestForBranch !== undefined &&
    typeof findPullRequestForBranch !== 'function'
  ) {
    throw new Error(
      `Plugin '${pluginId}' pull request provider '${providerId}' operation 'findPullRequestForBranch' must be a function`
    );
  }

  if (
    listPullRequests === undefined &&
    getPullRequest === undefined &&
    updatePullRequest === undefined &&
    getPullRequestDiff === undefined &&
    listPullRequestComments === undefined &&
    addPullRequestComment === undefined &&
    replyToPullRequestComment === undefined &&
    findPullRequestForBranch === undefined
  ) {
    return Object.freeze({});
  }

  return Object.freeze({
    ...(listPullRequests === undefined
      ? {}
      : {
          listPullRequests:
            listPullRequests as AidePullRequestProviderOperations['listPullRequests'],
        }),
    ...(getPullRequest === undefined
      ? {}
      : {
          getPullRequest:
            getPullRequest as AidePullRequestProviderOperations['getPullRequest'],
        }),
    ...(updatePullRequest === undefined
      ? {}
      : {
          updatePullRequest:
            updatePullRequest as AidePullRequestProviderOperations['updatePullRequest'],
        }),
    ...(getPullRequestDiff === undefined
      ? {}
      : {
          getPullRequestDiff:
            getPullRequestDiff as AidePullRequestProviderOperations['getPullRequestDiff'],
        }),
    ...(listPullRequestComments === undefined
      ? {}
      : {
          listPullRequestComments:
            listPullRequestComments as AidePullRequestProviderOperations['listPullRequestComments'],
        }),
    ...(addPullRequestComment === undefined
      ? {}
      : {
          addPullRequestComment:
            addPullRequestComment as AidePullRequestProviderOperations['addPullRequestComment'],
        }),
    ...(replyToPullRequestComment === undefined
      ? {}
      : {
          replyToPullRequestComment:
            replyToPullRequestComment as AidePullRequestProviderOperations['replyToPullRequestComment'],
        }),
    ...(findPullRequestForBranch === undefined
      ? {}
      : {
          findPullRequestForBranch:
            findPullRequestForBranch as AidePullRequestProviderOperations['findPullRequestForBranch'],
        }),
  });
}

function snapshotPullRequestProviderCapability(
  pluginId: string,
  capability: unknown
): AidePullRequestProviderCapability {
  if (!isRecord(capability)) {
    throw new Error(
      `Plugin '${pluginId}' pull request provider capability must be an object`
    );
  }

  if (typeof capability.providerId !== 'string') {
    throw new Error(
      `Plugin '${pluginId}' pull request provider id must be a string`
    );
  }
  assertId('Pull request provider', capability.providerId);

  if (!isFiniteNumber(capability.priority)) {
    throw new Error(
      `Plugin '${pluginId}' pull request provider '${capability.providerId}' priority must be a finite number`
    );
  }

  assertFunction(
    pluginId,
    'pull request provider',
    'matchRemote',
    capability.matchRemote
  );
  assertFunction(
    pluginId,
    'pull request provider',
    'matchPullRequestUrl',
    capability.matchPullRequestUrl
  );
  assertFunction(
    pluginId,
    'pull request provider',
    'authStatus',
    capability.authStatus
  );

  return Object.freeze({
    providerId: capability.providerId,
    priority: capability.priority,
    features: snapshotPullRequestProviderFeatures(
      pluginId,
      capability.features
    ),
    operations: snapshotPullRequestProviderOperations(
      pluginId,
      capability.providerId,
      capability.operations
    ),
    matchRemote:
      capability.matchRemote as AidePullRequestProviderCapability['matchRemote'],
    matchPullRequestUrl:
      capability.matchPullRequestUrl as AidePullRequestProviderCapability['matchPullRequestUrl'],
    authStatus:
      capability.authStatus as AidePullRequestProviderCapability['authStatus'],
  });
}

function snapshotPluginCapabilities(
  pluginId: string,
  capabilities: AidePluginCapabilities | undefined
): AidePluginCapabilities | undefined {
  if (capabilities === undefined) return undefined;
  if (!isRecord(capabilities)) {
    throw new Error(`Plugin '${pluginId}' capabilities must be an object`);
  }

  return Object.freeze({
    auth:
      capabilities.auth === undefined
        ? undefined
        : snapshotAuthCapability(pluginId, capabilities.auth),
    authProvider:
      capabilities.authProvider === undefined
        ? undefined
        : snapshotAuthProviderCapability(pluginId, capabilities.authProvider),
    primeContribution:
      capabilities.primeContribution === undefined
        ? undefined
        : snapshotPrimeContributionCapability(
            pluginId,
            capabilities.primeContribution
          ),
    pullRequestProvider:
      capabilities.pullRequestProvider === undefined
        ? undefined
        : snapshotPullRequestProviderCapability(
            pluginId,
            capabilities.pullRequestProvider
          ),
  });
}

function assertId(
  kind:
    | 'Auth provider'
    | 'Auth input field'
    | 'Command'
    | 'Plugin'
    | 'Prime status group'
    | 'Pull request provider',
  id: string
): void {
  if (id.trim() === '') {
    throw new Error(`${kind} id must not be empty`);
  }
  if (/\s/.test(id)) {
    throw new Error(`${kind} id '${id}' must not contain whitespace`);
  }
}

function routeKeys(route: string | readonly string[] | undefined): string[] {
  const routes = Array.isArray(route) ? route : [route];
  const keys = routes.flatMap((value) => {
    const key = value?.trim().split(/\s+/)[0];
    return key === undefined || key === '' ? [] : [key];
  });

  return Array.from(new Set(keys));
}

function routeAcceptsChildCommands(
  route: string | readonly string[] | undefined
): boolean {
  const routes = Array.isArray(route) ? route : [route];
  return routes.some((value) => {
    const parts = value?.trim().split(/\s+/) ?? [];
    return parts.some((part: string, index: number) => {
      if (index === 0) return false;
      return part === '<command>' || part === '[command]';
    });
  });
}

function commandAcceptsChildCommands(
  acceptsChildren: boolean | undefined,
  route: string | readonly string[] | undefined
): boolean {
  return acceptsChildren ?? routeAcceptsChildCommands(route);
}

function assertRouteKeys(id: string, keys: readonly string[]): void {
  if (keys.length === 0) {
    throw new Error(`Command '${id}' must declare a route`);
  }
}

function snapshotPlugin(plugin: AidePluginDescriptor): AidePluginDescriptor {
  const commands = plugin.commands.map((command): AidePluginCommand => {
    if (command.kind === 'module') {
      return Object.freeze({
        kind: 'module',
        id: command.id,
        parentId: command.parentId,
        acceptsChildren: snapshotAcceptsChildren(
          plugin.id,
          command.id,
          command.acceptsChildren
        ),
        extension: snapshotExtensionPolicy(command.extension),
        module: eraseCommandModule(command.module),
      });
    }

    return Object.freeze({
      kind: 'descriptor',
      id: command.id,
      parentId: command.parentId,
      acceptsChildren: snapshotAcceptsChildren(
        plugin.id,
        command.id,
        command.acceptsChildren
      ),
      extension: snapshotExtensionPolicy(command.extension),
      descriptor: snapshotCommandDescriptor(command.descriptor),
    });
  });

  return Object.freeze({
    id: plugin.id,
    summary: plugin.summary,
    commands: Object.freeze(commands),
    capabilities: snapshotPluginCapabilities(plugin.id, plugin.capabilities),
  });
}

export type RegisteredCommand =
  | {
      readonly kind: 'module';
      readonly id: string;
      readonly pluginId?: string;
      readonly parentId?: string;
      readonly acceptsChildren: boolean;
      readonly extension?: AideCommandExtensionPolicy;
      readonly routeKeys: readonly string[];
      readonly module: AnyYargsCommandModule;
    }
  | {
      readonly kind: 'descriptor';
      readonly id: string;
      readonly pluginId?: string;
      readonly parentId?: string;
      readonly acceptsChildren: boolean;
      readonly extension?: AideCommandExtensionPolicy;
      readonly routeKeys: readonly string[];
      readonly descriptor: AnyAideCommandDescriptor;
    };

export interface RegisterCommandOptions {
  readonly parentId?: string;
  readonly acceptsChildren?: boolean;
  readonly extension?: AideCommandExtensionPolicy;
}

export interface RegisterExternalPluginOptions {
  readonly manifest: AidePluginManifest;
}

export interface OwnedPluginCapability<TCapability> {
  readonly pluginId: string;
  readonly capability: TCapability;
}

function ownedPluginCapability<TCapability>(
  pluginId: string,
  capability: TCapability
): OwnedPluginCapability<TCapability> {
  return Object.freeze({ pluginId, capability });
}

function authProviderCommandNames(
  provider: AideAuthProviderCapability,
  operation: 'login' | 'logout'
): readonly string[] {
  const metadata = operation === 'login' ? provider.login : provider.logout;
  return [
    metadata?.command?.name,
    ...(metadata?.command?.aliases ?? []),
  ].filter((name): name is string => name !== undefined);
}

function authProviderAddressableNames(
  provider: AideAuthProviderCapability
): readonly string[] {
  return Array.from(
    new Set([
      provider.providerId,
      ...authProviderCommandNames(provider, 'login'),
      ...authProviderCommandNames(provider, 'logout'),
    ])
  );
}

function assertPluginCommandParentGraphAcyclic(
  pluginId: string,
  commands: readonly AidePluginCommand[]
): void {
  const commandById = new Map(commands.map((command) => [command.id, command]));
  const visited = new Set<string>();
  const path: string[] = [];

  const visit = (id: string): void => {
    if (visited.has(id)) return;

    const cycleStart = path.indexOf(id);
    if (cycleStart !== -1) {
      const cycle = [...path.slice(cycleStart), id].join(' -> ');
      throw new Error(
        `Plugin '${pluginId}' declares a command parent cycle: ${cycle}`
      );
    }

    const command = commandById.get(id);
    if (command === undefined) return;

    path.push(id);
    const parentId = command.parentId;
    if (parentId !== undefined && commandById.has(parentId)) {
      visit(parentId);
    }
    path.pop();
    visited.add(id);
  };

  for (const command of commands) {
    visit(command.id);
  }
}

function pluginCommandDepths(
  commands: readonly AidePluginCommand[]
): ReadonlyMap<string, number> {
  const commandById = new Map(commands.map((command) => [command.id, command]));
  const depths = new Map<string, number>();

  const depth = (id: string): number => {
    const existing = depths.get(id);
    if (existing !== undefined) return existing;

    const command = commandById.get(id);
    if (command === undefined) return 0;

    const parentId = command.parentId;
    const value =
      parentId !== undefined && commandById.has(parentId)
        ? depth(parentId) + 1
        : 0;
    depths.set(id, value);
    return value;
  };

  for (const command of commands) {
    depth(command.id);
  }

  return depths;
}

function pluginCommandRoute(
  command: AidePluginCommand
): string | readonly string[] | undefined {
  return command.kind === 'module'
    ? command.module.command
    : command.descriptor.route;
}

function pluginCommandAcceptsChildCommands(
  command: AidePluginCommand
): boolean {
  return commandAcceptsChildCommands(
    command.acceptsChildren,
    pluginCommandRoute(command)
  );
}

function externalPluginCapabilityKinds(
  plugin: AidePublicPluginDescriptor
): readonly AidePluginCapabilityKind[] {
  const capabilities: AidePluginCapabilityKind[] = [];
  if (plugin.commands.length > 0) capabilities.push('commands');
  if (plugin.capabilities?.auth !== undefined) capabilities.push('auth');
  if (plugin.capabilities?.authProvider !== undefined) {
    capabilities.push('auth-provider');
  }
  if (plugin.capabilities?.primeContribution !== undefined) {
    capabilities.push('prime-contribution');
  }
  if (plugin.capabilities?.pullRequestProvider !== undefined) {
    capabilities.push('pull-request-provider');
  }

  return capabilities;
}

function isKnownPluginCapabilityKind(
  value: unknown
): value is AidePluginCapabilityKind {
  return (
    typeof value === 'string' &&
    aidePluginCapabilityKinds.includes(value as AidePluginCapabilityKind)
  );
}

function publicPluginToTrustedDescriptor(
  plugin: AidePublicPluginDescriptor
): AidePluginDescriptor {
  return {
    id: plugin.id,
    summary: plugin.summary,
    commands: plugin.commands.map((command) => ({
      kind: 'descriptor',
      id: command.id,
      parentId: command.parentId,
      acceptsChildren: command.acceptsChildren,
      extension: command.extension,
      descriptor: command.descriptor as unknown as AnyAideCommandDescriptor,
    })),
    capabilities: plugin.capabilities,
  };
}

function assertOptionalManifestString(
  pluginId: string,
  field: string,
  value: unknown
): void {
  if (value === undefined) return;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(
      `Plugin '${pluginId}' manifest ${field} must be a non-empty string`
    );
  }
}

function assertManifestDependencyList(
  pluginId: string,
  manifest: string,
  field: string,
  value: unknown
): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    throw new Error(
      `Plugin '${pluginId}' manifest ${manifest}.${field} must be an array of plugin ids`
    );
  }

  for (const pluginIdValue of value) {
    if (typeof pluginIdValue !== 'string') {
      throw new Error(
        `Plugin '${pluginId}' manifest ${manifest}.${field} entries must be plugin ids`
      );
    }
    assertId('Plugin', pluginIdValue);
  }
}

function assertExternalPluginManifest(
  plugin: AidePublicPluginDescriptor,
  manifest: AidePluginManifest
): void {
  if (!isRecord(manifest)) {
    throw new Error(`Plugin '${plugin.id}' manifest must be an object`);
  }
  if (manifest.id !== plugin.id) {
    throw new Error(
      `Plugin '${plugin.id}' manifest id '${String(manifest.id)}' does not match descriptor id`
    );
  }
  if (manifest.aidePluginApiVersion !== AIDE_PLUGIN_API_VERSION) {
    throw new Error(
      `Plugin '${plugin.id}' manifest aidePluginApiVersion must be ${AIDE_PLUGIN_API_VERSION}`
    );
  }
  if (typeof manifest.version !== 'string' || manifest.version.trim() === '') {
    throw new Error(
      `Plugin '${plugin.id}' manifest version must be a non-empty string`
    );
  }
  if (
    manifest.trust !== undefined &&
    manifest.trust !== 'external' &&
    manifest.trust !== 'trusted-local'
  ) {
    throw new Error(
      `Plugin '${plugin.id}' manifest trust must be 'external' or 'trusted-local'`
    );
  }

  assertOptionalManifestString(plugin.id, 'main', manifest.main);
  assertOptionalManifestString(plugin.id, 'summary', manifest.summary);

  const declaredCapabilities = new Set<AidePluginCapabilityKind>();
  if (manifest.capabilities !== undefined) {
    if (!Array.isArray(manifest.capabilities)) {
      throw new Error(
        `Plugin '${plugin.id}' manifest capabilities must be an array`
      );
    }
    for (const capability of manifest.capabilities) {
      if (!isKnownPluginCapabilityKind(capability)) {
        throw new Error(
          `Plugin '${plugin.id}' manifest declares unknown capability '${String(capability)}'`
        );
      }
      if (declaredCapabilities.has(capability)) {
        throw new Error(
          `Plugin '${plugin.id}' manifest declares capability '${capability}' more than once`
        );
      }
      declaredCapabilities.add(capability);
    }
  }

  const providedCapabilities = new Set(externalPluginCapabilityKinds(plugin));
  for (const capability of providedCapabilities) {
    if (!declaredCapabilities.has(capability)) {
      throw new Error(
        `Plugin '${plugin.id}' manifest does not declare provided capability '${capability}'`
      );
    }
  }
  for (const capability of declaredCapabilities) {
    if (!providedCapabilities.has(capability)) {
      throw new Error(
        `Plugin '${plugin.id}' manifest declares capability '${capability}' but descriptor does not provide it`
      );
    }
  }

  if (manifest.loading !== undefined) {
    if (!isRecord(manifest.loading)) {
      throw new Error(
        `Plugin '${plugin.id}' manifest loading must be an object`
      );
    }
    if (
      manifest.loading.order !== undefined &&
      !isFiniteNumber(manifest.loading.order)
    ) {
      throw new Error(
        `Plugin '${plugin.id}' manifest loading.order must be a finite number`
      );
    }
    assertManifestDependencyList(
      plugin.id,
      'loading',
      'after',
      manifest.loading.after
    );
    assertManifestDependencyList(
      plugin.id,
      'loading',
      'before',
      manifest.loading.before
    );
  }

  if (manifest.conflicts !== undefined) {
    if (!isRecord(manifest.conflicts)) {
      throw new Error(
        `Plugin '${plugin.id}' manifest conflicts must be an object`
      );
    }
    for (const field of [
      'authProviders',
      'commands',
      'pullRequestProviders',
    ] as const) {
      const policy = manifest.conflicts[field];
      if (policy !== undefined && policy !== 'reject') {
        throw new Error(
          `Plugin '${plugin.id}' manifest conflicts.${field} must be 'reject'`
        );
      }
    }
  }
}

function assertExternalPluginCommandIdNamespace(
  pluginId: string,
  commandId: string
): void {
  if (commandId === pluginId || commandId.startsWith(`${pluginId}:`)) return;

  throw new Error(
    `External plugin '${pluginId}' command '${commandId}' must use the plugin id namespace`
  );
}

function assertExternalPluginBoundary(
  plugin: AidePublicPluginDescriptor,
  manifest: AidePluginManifest | undefined
): void {
  if (!isRecord(plugin)) {
    throw new Error('External plugin descriptor must be an object');
  }
  if (typeof plugin.id !== 'string') {
    throw new Error('External plugin id must be a string');
  }

  assertId('Plugin', plugin.id);
  if (isReservedAidePluginId(plugin.id)) {
    throw new Error(
      `External plugin '${plugin.id}' cannot use a reserved aide plugin id`
    );
  }
  if (typeof plugin.summary !== 'string' || plugin.summary.trim() === '') {
    throw new Error(
      `External plugin '${plugin.id}' summary must be a non-empty string`
    );
  }
  if (!Array.isArray(plugin.commands)) {
    throw new Error(`External plugin '${plugin.id}' commands must be an array`);
  }

  for (const command of plugin.commands) {
    if (!isRecord(command)) {
      throw new Error(
        `External plugin '${plugin.id}' commands must be descriptor objects`
      );
    }
    if (command.kind !== 'descriptor') {
      const commandId =
        typeof command.id === 'string' ? command.id : '<unknown>';
      throw new Error(
        `External plugin '${plugin.id}' command '${commandId}' must be descriptor-backed; raw yargs modules are trusted internal only`
      );
    }
    if (typeof command.id !== 'string') {
      throw new Error(
        `External plugin '${plugin.id}' command id must be a string`
      );
    }

    assertId('Command', command.id);
    assertExternalPluginCommandIdNamespace(plugin.id, command.id);
    if (!isRecord(command.descriptor)) {
      throw new Error(
        `External plugin '${plugin.id}' command '${command.id}' descriptor must be an object`
      );
    }

    const yargs = command.descriptor.yargs;
    if (isRecord(yargs) && yargs.builder !== undefined) {
      throw new Error(
        `External plugin '${plugin.id}' command '${command.id}' cannot use yargs builders yet`
      );
    }
  }

  const providerId = plugin.capabilities?.pullRequestProvider?.providerId;
  if (
    typeof providerId === 'string' &&
    isReservedAidePullRequestProviderId(providerId)
  ) {
    throw new Error(
      `External plugin '${plugin.id}' cannot declare reserved pull request provider '${providerId}'`
    );
  }

  if (manifest === undefined) {
    throw new Error(`External plugin '${plugin.id}' requires a manifest`);
  }
  assertExternalPluginManifest(plugin, manifest);
}

export class CommandRegistry {
  readonly #commands: RegisteredCommand[] = [];
  readonly #childCommands = new Map<string, RegisteredCommand[]>();
  readonly #plugins: AidePluginDescriptor[] = [];
  readonly #ids = new Set<string>();
  readonly #pluginIds = new Set<string>();
  readonly #routeOwners = new Map<string, string>();
  readonly #childRouteOwners = new Map<string, Map<string, string>>();
  readonly #commandGroupIds = new Set<string>();
  readonly #commandExtensionPolicies = new Map<
    string,
    AideCommandExtensionPolicy
  >();
  readonly #commandOwners = new Map<string, string>();
  readonly #authProviderOwners = new Map<string, string>();
  readonly #pullRequestProviderOwners = new Map<string, string>();

  readonly capabilities = {
    auth: (): readonly OwnedPluginCapability<AidePluginAuthCapability>[] =>
      Object.freeze(
        this.#plugins.flatMap((plugin) => {
          const capability = plugin.capabilities?.auth;
          return capability === undefined
            ? []
            : [ownedPluginCapability(plugin.id, capability)];
        })
      ),
    authProviders:
      (): readonly OwnedPluginCapability<AideAuthProviderCapability>[] =>
        Object.freeze(
          this.#plugins.flatMap((plugin) => {
            const capability = plugin.capabilities?.authProvider;
            return capability === undefined
              ? []
              : [ownedPluginCapability(plugin.id, capability)];
          })
        ),
    primeContributions:
      (): readonly OwnedPluginCapability<AidePrimeContributionCapability>[] =>
        Object.freeze(
          this.#plugins.flatMap((plugin) => {
            const capability = plugin.capabilities?.primeContribution;
            return capability === undefined
              ? []
              : [ownedPluginCapability(plugin.id, capability)];
          })
        ),
    pullRequestProviders:
      (): readonly OwnedPluginCapability<AidePullRequestProviderCapability>[] =>
        Object.freeze(
          this.#plugins.flatMap((plugin) => {
            const capability = plugin.capabilities?.pullRequestProvider;
            return capability === undefined
              ? []
              : [ownedPluginCapability(plugin.id, capability)];
          })
        ),
  };

  registerModule<TBase extends object, TArgs extends object>(
    id: string,
    module: CommandModule<TBase, TArgs>,
    options: RegisterCommandOptions = {}
  ): this {
    assertId('Command', id);
    this.#assertAvailable(id);
    const keys = routeKeys(module.command);
    assertRouteKeys(id, keys);
    const acceptsChildren = commandAcceptsChildCommands(
      options.acceptsChildren,
      module.command
    );
    const entry = Object.freeze({
      kind: 'module' as const,
      id,
      parentId: options.parentId,
      acceptsChildren,
      extension: snapshotExtensionPolicy(options.extension),
      routeKeys: freezeRouteKeys(keys),
      module: eraseCommandModule(module),
    });

    if (!acceptsChildren && entry.extension !== undefined) {
      this.#assertExtensionOnlyOnCommandGroup(id);
    }

    if (options.parentId === undefined) {
      this.#assertRoutesAvailable(id, keys);
      this.#commands.push(entry);
      this.#claimRoutes(id, keys);
    } else {
      this.#assertParentAcceptsChildren(id, options.parentId, undefined, keys);
      this.#assertChildRoutesAvailable(id, options.parentId, keys);
      this.#addChildCommand(options.parentId, entry);
      this.#claimChildRoutes(id, options.parentId, keys);
    }

    this.#ids.add(id);
    if (acceptsChildren) {
      this.#claimCommandGroup(id, entry.extension);
    }
    return this;
  }

  registerDescriptor<TArgs extends object, E = unknown>(
    descriptor: ServiceFreeAideCommandDescriptor<TArgs, E>,
    options?: RegisterCommandOptions
  ): this;
  registerDescriptor<TArgs extends object, E = unknown>(
    descriptor: HostAideCommandDescriptor<TArgs, E>,
    options?: RegisterCommandOptions
  ): this;
  registerDescriptor<TArgs extends object>(
    descriptor: AideCommandDescriptor<TArgs, unknown, unknown>,
    options: RegisterCommandOptions = {}
  ): this {
    assertId('Command', descriptor.id);
    this.#assertAvailable(descriptor.id);
    const keys = routeKeys(descriptor.route);
    assertRouteKeys(descriptor.id, keys);
    const acceptsChildren = commandAcceptsChildCommands(
      options.acceptsChildren,
      descriptor.route
    );
    const entry = Object.freeze({
      kind: 'descriptor' as const,
      id: descriptor.id,
      parentId: options.parentId,
      acceptsChildren,
      extension: snapshotExtensionPolicy(options.extension),
      routeKeys: freezeRouteKeys(keys),
      descriptor: snapshotCommandDescriptor(
        descriptor as HostAideCommandDescriptor<TArgs>
      ),
    });

    if (!acceptsChildren && entry.extension !== undefined) {
      this.#assertExtensionOnlyOnCommandGroup(descriptor.id);
    }

    if (options.parentId === undefined) {
      this.#assertRoutesAvailable(descriptor.id, keys);
      this.#commands.push(entry);
      this.#claimRoutes(descriptor.id, keys);
    } else {
      this.#assertParentAcceptsChildren(
        descriptor.id,
        options.parentId,
        undefined,
        keys
      );
      this.#assertChildRoutesAvailable(descriptor.id, options.parentId, keys);
      this.#addChildCommand(options.parentId, entry);
      this.#claimChildRoutes(descriptor.id, options.parentId, keys);
    }

    this.#ids.add(descriptor.id);
    if (acceptsChildren) {
      this.#claimCommandGroup(descriptor.id, entry.extension);
    }
    return this;
  }

  registerExternalPlugin(
    plugin: AidePublicPluginDescriptor,
    options?: RegisterExternalPluginOptions
  ): this {
    assertExternalPluginBoundary(plugin, options?.manifest);
    return this.registerPlugin(publicPluginToTrustedDescriptor(plugin));
  }

  /** Trusted in-process registration for built-in and local internal plugins. */
  registerPlugin(plugin: AidePluginDescriptor): this {
    assertId('Plugin', plugin.id);
    const snapshot = snapshotPlugin(plugin);
    this.#assertPluginAvailable(snapshot.id);
    const authProvider = snapshot.capabilities?.authProvider;
    if (authProvider !== undefined) {
      this.#assertAuthProviderAvailable(snapshot.id, authProvider);
    }
    const pullRequestProvider = snapshot.capabilities?.pullRequestProvider;
    if (pullRequestProvider !== undefined) {
      this.#assertPullRequestProviderAvailable(
        snapshot.id,
        pullRequestProvider.providerId
      );
    }

    const commandIds = snapshot.commands.map((command) => {
      assertId('Command', command.id);
      return command.id;
    });
    const duplicateCommandId = commandIds.find(
      (id, index) => commandIds.indexOf(id) !== index
    );
    if (duplicateCommandId !== undefined) {
      throw new Error(
        `Plugin '${snapshot.id}' declares command '${duplicateCommandId}' more than once`
      );
    }

    for (const id of commandIds) {
      this.#assertAvailable(id);
    }

    const pluginCommandIds = new Set(commandIds);
    assertPluginCommandParentGraphAcyclic(snapshot.id, snapshot.commands);
    const pluginCommandDepthById = pluginCommandDepths(snapshot.commands);
    const pluginCommandIndexById = new Map(
      snapshot.commands.map((command, index) => [command.id, index])
    );
    const pluginGroupIds = new Set<string>();
    const pluginExtensionPolicies = new Map<
      string,
      AideCommandExtensionPolicy
    >();
    const commandRouteKeys = new Map<string, readonly string[]>();

    for (const command of snapshot.commands) {
      const keys = routeKeys(pluginCommandRoute(command));
      assertRouteKeys(command.id, keys);
      commandRouteKeys.set(command.id, freezeRouteKeys(keys));

      const acceptsChildren = pluginCommandAcceptsChildCommands(command);
      if (acceptsChildren) {
        pluginGroupIds.add(command.id);
        pluginExtensionPolicies.set(
          command.id,
          command.extension ?? defaultExtensionPolicy
        );
      } else if (command.extension !== undefined) {
        this.#assertExtensionOnlyOnCommandGroup(command.id);
      }
    }

    const pluginRouteOwners = new Map<string, string>();
    const pluginChildRouteOwners = new Map<string, Map<string, string>>();

    for (const command of snapshot.commands) {
      const keys = commandRouteKeys.get(command.id) ?? [];

      if (command.parentId === undefined) {
        for (const key of keys) {
          const existingCommand = pluginRouteOwners.get(key);
          if (existingCommand !== undefined) {
            throw new Error(
              `Plugin '${snapshot.id}' declares route '${key}' for commands '${existingCommand}' and '${command.id}'`
            );
          }
          pluginRouteOwners.set(key, command.id);
        }
        this.#assertRoutesAvailable(command.id, keys);
        continue;
      }

      const parentInSamePlugin = pluginCommandIds.has(command.parentId);
      const existingParent = this.#ids.has(command.parentId);
      if (!parentInSamePlugin && !existingParent) {
        throw new Error(
          `Command '${command.id}' parent '${command.parentId}' is not registered`
        );
      }

      const parentAcceptsChildren =
        this.#commandGroupIds.has(command.parentId) ||
        pluginGroupIds.has(command.parentId);
      if (!parentAcceptsChildren) {
        throw new Error(
          `Command '${command.id}' parent '${command.parentId}' does not accept subcommands`
        );
      }
      if (!parentInSamePlugin) {
        this.#assertParentExtensionPermits(
          command.id,
          command.parentId,
          snapshot.id,
          keys
        );
      }

      let routeOwners = pluginChildRouteOwners.get(command.parentId);
      if (routeOwners === undefined) {
        routeOwners = new Map<string, string>();
        pluginChildRouteOwners.set(command.parentId, routeOwners);
      }
      for (const key of keys) {
        const existingCommand = routeOwners.get(key);
        if (existingCommand !== undefined) {
          throw new Error(
            `Plugin '${snapshot.id}' declares route '${key}' under '${command.parentId}' for commands '${existingCommand}' and '${command.id}'`
          );
        }
        routeOwners.set(key, command.id);
      }
      this.#assertChildRoutesAvailable(command.id, command.parentId, keys);
    }

    const topLevelCommands = snapshot.commands.filter(
      (command) => command.parentId === undefined
    );
    const childCommands = snapshot.commands
      .filter((command) => command.parentId !== undefined)
      .sort((left, right) => {
        const leftDepth = pluginCommandDepthById.get(left.id) ?? 0;
        const rightDepth = pluginCommandDepthById.get(right.id) ?? 0;
        if (leftDepth !== rightDepth) return leftDepth - rightDepth;

        return (
          (pluginCommandIndexById.get(left.id) ?? 0) -
          (pluginCommandIndexById.get(right.id) ?? 0)
        );
      });

    this.#plugins.push(snapshot);

    for (const command of topLevelCommands) {
      const resolvedKeys = commandRouteKeys.get(command.id) ?? [];
      const acceptsChildren = pluginGroupIds.has(command.id);
      const entry =
        command.kind === 'module'
          ? Object.freeze({
              kind: 'module' as const,
              id: command.id,
              pluginId: snapshot.id,
              acceptsChildren,
              extension: command.extension,
              routeKeys: freezeRouteKeys(resolvedKeys),
              module: command.module,
            })
          : Object.freeze({
              kind: 'descriptor' as const,
              id: command.id,
              pluginId: snapshot.id,
              acceptsChildren,
              extension: command.extension,
              routeKeys: freezeRouteKeys(resolvedKeys),
              descriptor: command.descriptor,
            });
      this.#commands.push(entry);
      this.#ids.add(command.id);
      this.#commandOwners.set(command.id, snapshot.id);
      this.#claimRoutes(command.id, resolvedKeys);
      if (pluginGroupIds.has(command.id)) {
        this.#claimCommandGroup(
          command.id,
          pluginExtensionPolicies.get(command.id)
        );
      }
    }

    for (const command of childCommands) {
      const parentId = command.parentId;
      if (parentId === undefined) continue;

      const resolvedKeys = commandRouteKeys.get(command.id) ?? [];
      const acceptsChildren = pluginGroupIds.has(command.id);
      const entry =
        command.kind === 'module'
          ? Object.freeze({
              kind: 'module' as const,
              id: command.id,
              pluginId: snapshot.id,
              parentId,
              acceptsChildren,
              extension: command.extension,
              routeKeys: freezeRouteKeys(resolvedKeys),
              module: command.module,
            })
          : Object.freeze({
              kind: 'descriptor' as const,
              id: command.id,
              pluginId: snapshot.id,
              parentId,
              acceptsChildren,
              extension: command.extension,
              routeKeys: freezeRouteKeys(resolvedKeys),
              descriptor: command.descriptor,
            });
      this.#addChildCommand(parentId, entry);
      this.#ids.add(command.id);
      this.#commandOwners.set(command.id, snapshot.id);
      this.#claimChildRoutes(command.id, parentId, resolvedKeys);
      if (acceptsChildren) {
        this.#claimCommandGroup(
          command.id,
          pluginExtensionPolicies.get(command.id)
        );
      }
    }

    this.#pluginIds.add(snapshot.id);
    if (authProvider !== undefined) {
      for (const name of authProviderAddressableNames(authProvider)) {
        this.#authProviderOwners.set(name, snapshot.id);
      }
    }
    if (pullRequestProvider !== undefined) {
      this.#pullRequestProviderOwners.set(
        pullRequestProvider.providerId,
        snapshot.id
      );
    }
    return this;
  }

  commands(): readonly RegisteredCommand[] {
    return [...this.#commands];
  }

  childCommands(parentId: string): readonly RegisteredCommand[] {
    return [...(this.#childCommands.get(parentId) ?? [])];
  }

  childCommandIds(parentId: string): readonly string[] {
    return this.childCommands(parentId).map((entry) => entry.id);
  }

  entries(): readonly RegisteredCommand[] {
    return [
      ...this.#commands,
      ...Array.from(this.#childCommands.values()).flat(),
    ];
  }

  commandIds(): readonly string[] {
    return this.#commands.map((entry) => entry.id);
  }

  allCommandIds(): readonly string[] {
    return this.entries().map((entry) => entry.id);
  }

  ids(): readonly string[] {
    return this.commandIds();
  }

  plugins(): readonly AidePluginDescriptor[] {
    return [...this.#plugins];
  }

  pluginIds(): readonly string[] {
    return this.#plugins.map((plugin) => plugin.id);
  }

  commandOwner(commandId: string): string | null {
    return this.#commandOwners.get(commandId) ?? null;
  }

  demandMessage(): string {
    return `Please specify a command (${this.ids().join(', ')})`;
  }

  #assertAvailable(id: string): void {
    if (this.#ids.has(id)) {
      throw new Error(`Command '${id}' is already registered`);
    }
  }

  #assertPluginAvailable(id: string): void {
    if (this.#pluginIds.has(id)) {
      throw new Error(`Plugin '${id}' is already registered`);
    }
  }

  #assertAuthProviderAvailable(
    pluginId: string,
    provider: AideAuthProviderCapability
  ): void {
    for (const name of authProviderAddressableNames(provider)) {
      assertId('Auth provider', name);

      const reservedOwner = coreAuthProviderOwner(name);
      if (reservedOwner !== undefined && reservedOwner !== pluginId) {
        throw new Error(
          `Plugin '${pluginId}' cannot declare reserved auth provider '${name}' (reserved for plugin '${reservedOwner}')`
        );
      }

      const existingOwner = this.#authProviderOwners.get(name);
      if (existingOwner !== undefined) {
        throw new Error(
          `Auth provider '${name}' is already registered by plugin '${existingOwner}'`
        );
      }
    }
  }

  #assertPullRequestProviderAvailable(
    pluginId: string,
    providerId: string
  ): void {
    assertId('Pull request provider', providerId);

    const reservedOwner = corePullRequestProviderOwner(providerId);
    if (reservedOwner !== undefined && reservedOwner !== pluginId) {
      throw new Error(
        `Plugin '${pluginId}' cannot declare reserved pull request provider '${providerId}' (reserved for plugin '${reservedOwner}')`
      );
    }

    const existingOwner = this.#pullRequestProviderOwners.get(providerId);
    if (existingOwner !== undefined) {
      throw new Error(
        `Pull request provider '${providerId}' is already registered by plugin '${existingOwner}'`
      );
    }
  }

  #assertRoutesAvailable(commandId: string, keys: readonly string[]): void {
    for (const key of keys) {
      const owner = this.#routeOwners.get(key);
      if (owner !== undefined) {
        throw new Error(
          `Command '${commandId}' route '${key}' conflicts with command '${owner}'`
        );
      }
    }
  }

  #assertExtensionOnlyOnCommandGroup(commandId: string): never {
    throw new Error(
      `Command '${commandId}' declares an extension policy but does not accept subcommands`
    );
  }

  #assertParentAcceptsChildren(
    commandId: string,
    parentId: string,
    childPluginId: string | undefined,
    routeKeys: readonly string[]
  ): void {
    if (!this.#ids.has(parentId)) {
      throw new Error(
        `Command '${commandId}' parent '${parentId}' is not registered`
      );
    }
    if (!this.#commandGroupIds.has(parentId)) {
      throw new Error(
        `Command '${commandId}' parent '${parentId}' does not accept subcommands`
      );
    }
    this.#assertParentExtensionPermits(
      commandId,
      parentId,
      childPluginId,
      routeKeys
    );
  }

  #assertParentExtensionPermits(
    commandId: string,
    parentId: string,
    childPluginId: string | undefined,
    routeKeys: readonly string[]
  ): void {
    const parentPluginId = this.#commandOwners.get(parentId);
    if (parentPluginId === childPluginId) return;

    const policy =
      this.#commandExtensionPolicies.get(parentId) ?? defaultExtensionPolicy;
    if (policy.kind === 'open') return;
    if (
      policy.kind === 'allowlist' &&
      childPluginId !== undefined &&
      policy.pluginIds.includes(childPluginId)
    ) {
      return;
    }

    const routeKey = routeKeys[0] ?? '<unknown>';
    const childOwner =
      childPluginId === undefined
        ? 'direct registry registration'
        : `plugin '${childPluginId}'`;
    const parentOwner =
      parentPluginId === undefined
        ? 'no plugin owner'
        : `plugin '${parentPluginId}'`;
    throw new Error(
      `Command '${commandId}' from ${childOwner} cannot extend parent '${parentId}' owned by ${parentOwner} at route '${routeKey}'`
    );
  }

  #assertChildRoutesAvailable(
    commandId: string,
    parentId: string,
    keys: readonly string[]
  ): void {
    const routeOwners = this.#childRouteOwners.get(parentId);
    if (routeOwners === undefined) return;
    for (const key of keys) {
      const owner = routeOwners.get(key);
      if (owner !== undefined) {
        throw new Error(
          `Command '${commandId}' route '${key}' conflicts with command '${owner}' under '${parentId}'`
        );
      }
    }
  }

  #addChildCommand(parentId: string, entry: RegisteredCommand): void {
    const commands = this.#childCommands.get(parentId) ?? [];
    commands.push(entry);
    this.#childCommands.set(parentId, commands);
  }

  #claimRoutes(commandId: string, keys: readonly string[]): void {
    for (const key of keys) {
      this.#routeOwners.set(key, commandId);
    }
  }

  #claimCommandGroup(
    commandId: string,
    policy: AideCommandExtensionPolicy | undefined
  ): void {
    this.#commandGroupIds.add(commandId);
    this.#commandExtensionPolicies.set(
      commandId,
      policy ?? defaultExtensionPolicy
    );
  }

  #claimChildRoutes(
    commandId: string,
    parentId: string,
    keys: readonly string[]
  ): void {
    let routeOwners = this.#childRouteOwners.get(parentId);
    if (routeOwners === undefined) {
      routeOwners = new Map<string, string>();
      this.#childRouteOwners.set(parentId, routeOwners);
    }
    for (const key of keys) {
      routeOwners.set(key, commandId);
    }
  }
}

export function createCommandRegistry(): CommandRegistry {
  return new CommandRegistry();
}
