import type { ArgumentsCamelCase, CommandModule } from 'yargs';
import { types as nodeUtilTypes } from 'node:util';

import {
  assertCommandDescriptorProvisioning,
  eraseCommandDescriptor,
  type AideCommandDescriptor,
  type AnyInternalHostAideCommandDescriptor,
  type AnyInternalHostAndKeyringAideCommandDescriptor,
  type AnyKeyringAideCommandDescriptor,
  type AnyPublicAideCommandDescriptor,
  type AnyServiceFreeAideCommandDescriptor,
  type CommandRoute,
  type PublicAideCommandDescriptor,
  type CommandProvisioning,
} from './command-descriptor.js';
import type {
  AideCommandExtensionPolicy,
  AidePluginAuthCapability,
  AideInternalPluginCapabilities,
  AideInternalPullRequestProviderCapability,
  AidePluginCommand,
  AidePluginDescriptor,
  AidePullRequestProviderCapability,
  AidePullRequestProviderOperations,
  AnyYargsCommandModule,
  AideAuthProviderCapability,
  AideInternalAuthProviderCapability,
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
  type AidePublicPluginCommand,
  type AidePublicPluginDescriptor,
} from '../plugin-api.js';
import { authInputFieldFlagName } from './auth-input-fields.js';
import type { AideHostServicesTag } from './runtime-context.js';
import { normalizeAuthProviderId } from '@lib/auth-store.js';
import type { KeyringService } from '@lib/auth-keyring.js';
import type { GitHubAuthCatalogService } from '@lib/github-auth-catalog.js';
import {
  hostOwnedBuiltinPullRequestDiagnostic,
  type HostOwnedPullRequestFailureDiagnostic,
} from './builtin-pull-request-diagnostics.js';
import {
  defineHostArrayIndex,
  ownArrayDataValue,
  ownArrayLength,
} from './host-owned-array.js';

const defaultExtensionPolicy: AideCommandExtensionPolicy = Object.freeze({
  kind: 'same-plugin',
});
const authCommandTokenPattern = /^[a-z][a-z0-9-]*$/;
const isNodeProxy = nodeUtilTypes.isProxy;
const hasOwn = Object.hasOwn;
const MAX_EXTERNAL_PLUGIN_ID_LENGTH = 64;
const MAX_EXTERNAL_METADATA_DEPTH = 12;
const MAX_EXTERNAL_METADATA_ARRAY_LENGTH = 1_000;
const MAX_EXTERNAL_METADATA_RECORD_FIELDS = 128;
const MAX_EXTERNAL_METADATA_VALUES = 20_000;
const MAX_EXTERNAL_METADATA_STRING_LENGTH = 65_536;
const MAX_EXTERNAL_METADATA_STRING_UNITS = 1_048_576;
const MAX_PRIME_STATUS_COUNT = 1_000;
const MAX_PRIME_LABEL_LENGTH = 128;
const MAX_PRIME_MESSAGE_LENGTH = 1_024;
const MAX_BUILTIN_PULL_REQUEST_DIAGNOSTIC_LENGTH = 16_384;
const hostOwnedArrayInvariantDiagnostic = 'Host-owned Array invariant failed';

function hostOwnedArrayInvariantFailed(): never {
  throw new TypeError(hostOwnedArrayInvariantDiagnostic);
}

function denseOwnArrayLength(source: object): number {
  const length = ownArrayLength(source);
  if (
    typeof length !== 'number' ||
    !Number.isSafeInteger(length) ||
    length < 0
  ) {
    hostOwnedArrayInvariantFailed();
  }
  return length;
}

function denseOwnArrayValue<T>(source: object, index: number): T {
  const entry = ownArrayDataValue<T>(source, index);
  if (!entry.found) hostOwnedArrayInvariantFailed();
  return entry.value;
}

function appendHostArray<T>(target: T[], value: T): void {
  defineHostArrayIndex(target, denseOwnArrayLength(target), value);
}

function copyHostArray<T>(source: readonly T[]): T[] {
  const snapshot: T[] = [];
  const length = denseOwnArrayLength(source);
  for (let index = 0; index < length; index += 1) {
    defineHostArrayIndex(snapshot, index, denseOwnArrayValue<T>(source, index));
  }
  return snapshot;
}

function hostArrayIncludes<T>(source: readonly T[], expected: T): boolean {
  const length = denseOwnArrayLength(source);
  for (let index = 0; index < length; index += 1) {
    if (denseOwnArrayValue<T>(source, index) === expected) return true;
  }
  return false;
}

function hostSetFromArray<T>(source: readonly T[]): Set<T> {
  const values = new Set<T>();
  const length = denseOwnArrayLength(source);
  for (let index = 0; index < length; index += 1) {
    values.add(denseOwnArrayValue<T>(source, index));
  }
  return values;
}

const dangerousIdentityIds = new Set<string>();
const objectPrototypeNames = Object.getOwnPropertyNames(Object.prototype);
const objectPrototypeNameCount = denseOwnArrayLength(objectPrototypeNames);
for (let index = 0; index < objectPrototypeNameCount; index += 1) {
  dangerousIdentityIds.add(
    denseOwnArrayValue<string>(objectPrototypeNames, index).toLowerCase()
  );
}
dangerousIdentityIds.add('prototype');

const reservedAuthLoginFlagNames = new Set<string>();
reservedAuthLoginFlagNames.add('from-env');
reservedAuthLoginFlagNames.add('h');
reservedAuthLoginFlagNames.add('help');
reservedAuthLoginFlagNames.add('v');
reservedAuthLoginFlagNames.add('version');

function snapshotCommandRoute(route: CommandRoute): CommandRoute;
function snapshotCommandRoute(
  route: CommandRoute | undefined
): CommandRoute | undefined;
function snapshotCommandRoute(
  route: CommandRoute | undefined
): CommandRoute | undefined {
  return Array.isArray(route) ? Object.freeze(copyHostArray(route)) : route;
}

function eraseCommandModule<TBase extends object, TArgs extends object>(
  module: CommandModule<TBase, TArgs>
): AnyYargsCommandModule {
  return Object.freeze({
    ...module,
    command: snapshotCommandRoute(module.command),
  }) as unknown as AnyYargsCommandModule;
}

function snapshotExtensionPolicy(
  policy: AideCommandExtensionPolicy | undefined
): AideCommandExtensionPolicy | undefined {
  if (policy === undefined) return undefined;
  if (policy.kind !== 'allowlist') return Object.freeze({ ...policy });

  const pluginIds: string[] = [];
  const pluginIdCount = denseOwnArrayLength(policy.pluginIds);
  for (let index = 0; index < pluginIdCount; index += 1) {
    const pluginId = denseOwnArrayValue<string>(policy.pluginIds, index);
    assertId('Plugin', pluginId);
    defineHostArrayIndex(pluginIds, index, pluginId);
  }

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

function snapshotCommandDescriptor<TArgs extends object, E, R>(
  descriptor: AideCommandDescriptor<TArgs, E, R>,
  provisioning: CommandProvisioning
): AideCommandDescriptor<object, E, R> {
  return eraseCommandDescriptor(descriptor, provisioning);
}

function snapshotPublicCommandDescriptor(
  descriptor: AnyPublicAideCommandDescriptor
): AnyPublicAideCommandDescriptor {
  return Object.freeze({
    ...descriptor,
    route: snapshotCommandRoute(descriptor.route),
  });
}

function freezeRouteKeys(keys: readonly string[]): readonly string[] {
  return Object.freeze(copyHostArray(keys));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

const externalMetadataCaptureDiagnostic =
  'External plugin metadata capture failed';

interface ExternalMetadataCaptureState {
  readonly active: WeakSet<object>;
  readonly accountedContents: WeakSet<object>;
  readonly snapshots: WeakMap<object, Map<string, unknown>>;
  accountingSuppressed: number;
  values: number;
  stringUnits: number;
}

function externalMetadataCaptureFailed(): never {
  throw new Error(externalMetadataCaptureDiagnostic);
}

function createExternalMetadataCaptureState(): ExternalMetadataCaptureState {
  return {
    active: new WeakSet<object>(),
    accountedContents: new WeakSet<object>(),
    snapshots: new WeakMap<object, Map<string, unknown>>(),
    accountingSuppressed: 0,
    values: 0,
    stringUnits: 0,
  };
}

function externalMetadataSnapshot(
  state: ExternalMetadataCaptureState,
  source: object,
  schema: string
): unknown {
  return state.snapshots.get(source)?.get(schema);
}

function setExternalMetadataSnapshot(
  state: ExternalMetadataCaptureState,
  source: object,
  schema: string,
  snapshot: unknown
): void {
  const existing = state.snapshots.get(source);
  if (existing !== undefined) {
    existing.set(schema, snapshot);
    return;
  }
  const snapshots = new Map<string, unknown>();
  snapshots.set(schema, snapshot);
  state.snapshots.set(source, snapshots);
}

function accountExternalMetadataValue(
  state: ExternalMetadataCaptureState,
  value: unknown,
  depth: number
): void {
  if (depth > MAX_EXTERNAL_METADATA_DEPTH) {
    externalMetadataCaptureFailed();
  }
  if (
    typeof value === 'string' &&
    value.length > MAX_EXTERNAL_METADATA_STRING_LENGTH
  ) {
    externalMetadataCaptureFailed();
  }
  if (state.accountingSuppressed > 0) return;

  state.values += 1;
  if (state.values > MAX_EXTERNAL_METADATA_VALUES) {
    externalMetadataCaptureFailed();
  }
  if (typeof value !== 'string') return;

  state.stringUnits += value.length;
  if (state.stringUnits > MAX_EXTERNAL_METADATA_STRING_UNITS) {
    externalMetadataCaptureFailed();
  }
}

function assertExternalMetadataPlainRecord(
  value: unknown
): asserts value is object {
  if (!isRecord(value)) externalMetadataCaptureFailed();
  try {
    if (isNodeProxy(value) || Array.isArray(value)) {
      externalMetadataCaptureFailed();
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      externalMetadataCaptureFailed();
    }
  } catch {
    externalMetadataCaptureFailed();
  }
}

function captureExternalMetadataArray<T>(
  value: unknown,
  state: ExternalMetadataCaptureState,
  depth: number,
  schema: string,
  captureEntry: (value: unknown, index: number) => T
): readonly T[] {
  accountExternalMetadataValue(state, value, depth);
  if (!isRecord(value)) externalMetadataCaptureFailed();

  let source: object;
  try {
    if (isNodeProxy(value) || !Array.isArray(value)) {
      externalMetadataCaptureFailed();
    }
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      externalMetadataCaptureFailed();
    }
    source = value;
  } catch {
    externalMetadataCaptureFailed();
  }

  if (state.active.has(source)) externalMetadataCaptureFailed();
  const existing = externalMetadataSnapshot(state, source, schema);
  if (existing !== undefined) {
    if (!Array.isArray(existing)) externalMetadataCaptureFailed();
    return existing as readonly T[];
  }

  state.active.add(source);
  const suppressContents = state.accountedContents.has(source);
  if (suppressContents) state.accountingSuppressed += 1;
  try {
    let descriptors: readonly PropertyDescriptor[];
    try {
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
      const length = lengthDescriptor?.value;
      if (
        typeof length !== 'number' ||
        !Number.isSafeInteger(length) ||
        length < 0 ||
        length > MAX_EXTERNAL_METADATA_ARRAY_LENGTH
      ) {
        externalMetadataCaptureFailed();
      }

      const capturedDescriptors: PropertyDescriptor[] = [];
      for (let index = 0; index < length; index += 1) {
        const key = String(index);
        accountExternalMetadataValue(state, key, depth + 1);
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor === undefined || !hasOwn(descriptor, 'value')) {
          externalMetadataCaptureFailed();
        }
        Object.defineProperty(capturedDescriptors, String(index), {
          configurable: false,
          enumerable: true,
          writable: false,
          value: descriptor,
        });
      }
      descriptors = capturedDescriptors;
    } catch {
      externalMetadataCaptureFailed();
    }

    const snapshot: T[] = [];
    const descriptorCount = denseOwnArrayLength(descriptors);
    for (let index = 0; index < descriptorCount; index += 1) {
      const descriptor = Reflect.getOwnPropertyDescriptor(
        descriptors,
        String(index)
      );
      if (descriptor === undefined || !hasOwn(descriptor, 'value')) {
        externalMetadataCaptureFailed();
      }
      const sourceDescriptor = descriptor.value as object;
      const valueDescriptor = Reflect.getOwnPropertyDescriptor(
        sourceDescriptor,
        'value'
      );
      if (valueDescriptor === undefined || !hasOwn(valueDescriptor, 'value')) {
        externalMetadataCaptureFailed();
      }
      Object.defineProperty(snapshot, String(index), {
        configurable: false,
        enumerable: true,
        writable: false,
        value: captureEntry(valueDescriptor.value, index),
      });
    }
    const frozen = Object.freeze(snapshot);
    setExternalMetadataSnapshot(state, source, schema, frozen);
    if (!suppressContents) state.accountedContents.add(source);
    return frozen;
  } finally {
    if (suppressContents) state.accountingSuppressed -= 1;
    state.active.delete(source);
  }
}

function captureExternalMetadataLeaf(
  value: unknown,
  state: ExternalMetadataCaptureState,
  depth: number
): unknown {
  accountExternalMetadataValue(state, value, depth);
  if (value === null || typeof value !== 'object') {
    if (typeof value !== 'function') return value;
  }

  try {
    if (isNodeProxy(value)) externalMetadataCaptureFailed();
  } catch {
    externalMetadataCaptureFailed();
  }
  if (typeof value === 'function') return value;
  externalMetadataCaptureFailed();
}

function captureExternalMetadataRecord(
  value: unknown,
  state: ExternalMetadataCaptureState,
  depth: number,
  schema: string,
  allowedFields: readonly string[],
  requiredFields: readonly string[],
  captureField: (field: string, value: unknown, depth: number) => unknown,
  identityFields: readonly string[] = [],
  sourceOccurrenceAlreadyAccounted = false
): Readonly<Record<string, unknown>> {
  if (!sourceOccurrenceAlreadyAccounted) {
    accountExternalMetadataValue(state, value, depth);
  }
  assertExternalMetadataPlainRecord(value);
  const source = value as object;
  if (state.active.has(source)) externalMetadataCaptureFailed();
  const existing = externalMetadataSnapshot(state, source, schema);
  if (existing !== undefined) {
    if (!isRecord(existing)) externalMetadataCaptureFailed();
    return existing as Readonly<Record<string, unknown>>;
  }

  state.active.add(source);
  const suppressContents = state.accountedContents.has(source);
  if (suppressContents) state.accountingSuppressed += 1;
  try {
    const allowed = hostSetFromArray(allowedFields);
    let keys: readonly string[];
    const descriptors = new Map<string, PropertyDescriptor>();
    try {
      const ownKeys = Reflect.ownKeys(source);
      const ownKeyCount = denseOwnArrayLength(ownKeys);
      if (ownKeyCount > MAX_EXTERNAL_METADATA_RECORD_FIELDS) {
        externalMetadataCaptureFailed();
      }
      const stringKeys: string[] = [];
      for (let index = 0; index < ownKeyCount; index += 1) {
        const key = denseOwnArrayValue<PropertyKey>(ownKeys, index);
        if (typeof key !== 'string') externalMetadataCaptureFailed();
        accountExternalMetadataValue(state, key, depth + 1);
        if (!allowed.has(key)) externalMetadataCaptureFailed();
        appendHostArray(stringKeys, key);
      }
      const stringKeyCount = denseOwnArrayLength(stringKeys);
      for (let index = 0; index < stringKeyCount; index += 1) {
        const key = denseOwnArrayValue<string>(stringKeys, index);
        const descriptor = Object.getOwnPropertyDescriptor(source, key);
        if (descriptor === undefined || !hasOwn(descriptor, 'value')) {
          if (hostArrayIncludes(identityFields, key)) {
            // The detached semantic phase reports identity defects after the
            // remaining structure has been captured.
            continue;
          }
          externalMetadataCaptureFailed();
        }
        descriptors.set(key, descriptor);
      }
      const requiredFieldCount = denseOwnArrayLength(requiredFields);
      for (let index = 0; index < requiredFieldCount; index += 1) {
        const required = denseOwnArrayValue<string>(requiredFields, index);
        if (
          !hostArrayIncludes(stringKeys, required) &&
          !hostArrayIncludes(identityFields, required)
        ) {
          externalMetadataCaptureFailed();
        }
      }
      const capturedKeys: string[] = [];
      for (let index = 0; index < stringKeyCount; index += 1) {
        const key = denseOwnArrayValue<string>(stringKeys, index);
        if (descriptors.has(key)) appendHostArray(capturedKeys, key);
      }
      keys = capturedKeys;
    } catch {
      externalMetadataCaptureFailed();
    }

    const snapshot = Object.create(null) as Record<string, unknown>;
    const keyCount = denseOwnArrayLength(keys);
    for (let index = 0; index < keyCount; index += 1) {
      const key = denseOwnArrayValue<string>(keys, index);
      Object.defineProperty(snapshot, key, {
        configurable: false,
        enumerable: true,
        writable: false,
        value: captureField(key, descriptors.get(key)!.value, depth + 1),
      });
    }
    const frozen = Object.freeze(snapshot);
    setExternalMetadataSnapshot(state, source, schema, frozen);
    if (!suppressContents) state.accountedContents.add(source);
    return frozen;
  } finally {
    if (suppressContents) state.accountingSuppressed -= 1;
    state.active.delete(source);
  }
}

function captureExternalLeafArray(
  value: unknown,
  state: ExternalMetadataCaptureState,
  depth: number,
  schema: string
): readonly unknown[] {
  return captureExternalMetadataArray(value, state, depth, schema, (entry) =>
    captureExternalMetadataLeaf(entry, state, depth + 1)
  );
}

function captureExternalAuthCommandNames(
  value: unknown,
  state: ExternalMetadataCaptureState,
  depth: number
): Readonly<Record<string, unknown>> {
  return captureExternalMetadataRecord(
    value,
    state,
    depth,
    'auth-command-names',
    ['name', 'aliases'],
    [],
    (field, fieldValue, fieldDepth) =>
      field === 'aliases' && fieldValue !== undefined
        ? captureExternalLeafArray(
            fieldValue,
            state,
            fieldDepth,
            'auth-command-aliases'
          )
        : captureExternalMetadataLeaf(fieldValue, state, fieldDepth)
  );
}

function captureExternalAuthInputChoice(
  value: unknown,
  state: ExternalMetadataCaptureState,
  depth: number
): Readonly<Record<string, unknown>> {
  return captureExternalMetadataRecord(
    value,
    state,
    depth,
    'auth-input-choice',
    ['value', 'label'],
    ['value'],
    (_field, fieldValue, fieldDepth) =>
      captureExternalMetadataLeaf(fieldValue, state, fieldDepth)
  );
}

function hasOwnExternalMetadataField(
  snapshot: Readonly<Record<string, unknown>>,
  field: string
): boolean {
  return hasOwn(snapshot, field);
}

function canonicalizeExternalAuthInputFieldVariant(
  snapshot: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> {
  const kind = snapshot.kind;
  if (kind === 'text' || kind === 'secret') {
    if (
      hasOwnExternalMetadataField(snapshot, 'choices') ||
      hasOwnExternalMetadataField(snapshot, 'default')
    ) {
      externalMetadataCaptureFailed();
    }
    return snapshot;
  }

  if (kind === 'select') {
    if (
      !hasOwnExternalMetadataField(snapshot, 'choices') ||
      !Array.isArray(snapshot.choices) ||
      hasOwnExternalMetadataField(snapshot, 'stdin') ||
      hasOwnExternalMetadataField(snapshot, 'validate')
    ) {
      externalMetadataCaptureFailed();
    }
    return snapshot;
  }

  externalMetadataCaptureFailed();
}

function captureExternalAuthInputField(
  value: unknown,
  state: ExternalMetadataCaptureState,
  depth: number
): Readonly<Record<string, unknown>> {
  const snapshot = captureExternalMetadataRecord(
    value,
    state,
    depth,
    'auth-input-field',
    [
      'kind',
      'key',
      'label',
      'description',
      'required',
      'stdin',
      'validate',
      'choices',
      'default',
    ],
    ['kind', 'key', 'label'],
    (field, fieldValue, fieldDepth) =>
      field === 'choices'
        ? captureExternalMetadataArray(
            fieldValue,
            state,
            fieldDepth,
            'auth-input-choices',
            (entry) =>
              captureExternalAuthInputChoice(entry, state, fieldDepth + 1)
          )
        : captureExternalMetadataLeaf(fieldValue, state, fieldDepth)
  );
  return canonicalizeExternalAuthInputFieldVariant(snapshot);
}

function captureExternalAuthEnvMigration(
  value: unknown,
  state: ExternalMetadataCaptureState,
  depth: number
): Readonly<Record<string, unknown>> {
  return captureExternalMetadataRecord(
    value,
    state,
    depth,
    'auth-env-migration',
    ['description', 'variables'],
    ['description', 'variables'],
    (field, fieldValue, fieldDepth) =>
      field === 'variables'
        ? captureExternalLeafArray(
            fieldValue,
            state,
            fieldDepth,
            'auth-env-variables'
          )
        : captureExternalMetadataLeaf(fieldValue, state, fieldDepth)
  );
}

function captureExternalAuthLoginMetadata(
  value: unknown,
  state: ExternalMetadataCaptureState,
  depth: number
): Readonly<Record<string, unknown>> {
  return captureExternalMetadataRecord(
    value,
    state,
    depth,
    'auth-login-metadata',
    ['command', 'summary', 'fields', 'envMigration'],
    [],
    (field, fieldValue, fieldDepth) => {
      switch (field) {
        case 'command':
          return fieldValue === undefined
            ? captureExternalMetadataLeaf(fieldValue, state, fieldDepth)
            : captureExternalAuthCommandNames(fieldValue, state, fieldDepth);
        case 'fields':
          return fieldValue === undefined
            ? captureExternalMetadataLeaf(fieldValue, state, fieldDepth)
            : captureExternalMetadataArray(
                fieldValue,
                state,
                fieldDepth,
                'auth-input-fields',
                (entry) =>
                  captureExternalAuthInputField(entry, state, fieldDepth + 1)
              );
        case 'envMigration':
          return fieldValue === undefined
            ? captureExternalMetadataLeaf(fieldValue, state, fieldDepth)
            : captureExternalAuthEnvMigration(fieldValue, state, fieldDepth);
        default:
          return captureExternalMetadataLeaf(fieldValue, state, fieldDepth);
      }
    }
  );
}

function captureExternalAuthLogoutMetadata(
  value: unknown,
  state: ExternalMetadataCaptureState,
  depth: number
): Readonly<Record<string, unknown>> {
  return captureExternalMetadataRecord(
    value,
    state,
    depth,
    'auth-logout-metadata',
    ['command', 'summary'],
    [],
    (field, fieldValue, fieldDepth) =>
      field === 'command' && fieldValue !== undefined
        ? captureExternalAuthCommandNames(fieldValue, state, fieldDepth)
        : captureExternalMetadataLeaf(fieldValue, state, fieldDepth)
  );
}

function captureExternalAuthProviderOperations(
  value: unknown,
  state: ExternalMetadataCaptureState,
  depth: number
): Readonly<Record<string, unknown>> {
  return captureExternalMetadataRecord(
    value,
    state,
    depth,
    'auth-provider-operations',
    ['login', 'logout'],
    [],
    (_field, fieldValue, fieldDepth) =>
      captureExternalMetadataLeaf(fieldValue, state, fieldDepth)
  );
}

function captureExternalAuthProviderCapability(
  value: unknown,
  state: ExternalMetadataCaptureState,
  depth: number
): Readonly<Record<string, unknown>> {
  return captureExternalMetadataRecord(
    value,
    state,
    depth,
    'auth-provider-capability',
    [
      'providerId',
      'label',
      'login',
      'logout',
      'status',
      'accounts',
      'operations',
    ],
    ['providerId', 'label', 'status'],
    (field, fieldValue, fieldDepth) => {
      switch (field) {
        case 'login':
          return fieldValue === undefined
            ? captureExternalMetadataLeaf(fieldValue, state, fieldDepth)
            : captureExternalAuthLoginMetadata(fieldValue, state, fieldDepth);
        case 'logout':
          return fieldValue === undefined
            ? captureExternalMetadataLeaf(fieldValue, state, fieldDepth)
            : captureExternalAuthLogoutMetadata(fieldValue, state, fieldDepth);
        case 'operations':
          return fieldValue === undefined
            ? captureExternalMetadataLeaf(fieldValue, state, fieldDepth)
            : captureExternalAuthProviderOperations(
                fieldValue,
                state,
                fieldDepth
              );
        default:
          return captureExternalMetadataLeaf(fieldValue, state, fieldDepth);
      }
    }
  );
}

function captureExternalPrimeStatusMessages(
  value: unknown,
  state: ExternalMetadataCaptureState,
  depth: number
): Readonly<Record<string, unknown>> {
  return captureExternalMetadataRecord(
    value,
    state,
    depth,
    'prime-status-messages',
    ['configured', 'notConfigured', 'misconfigured'],
    [],
    (_field, fieldValue, fieldDepth) =>
      captureExternalMetadataLeaf(fieldValue, state, fieldDepth)
  );
}

function captureExternalPrimeStatusContribution(
  value: unknown,
  state: ExternalMetadataCaptureState,
  depth: number
): Readonly<Record<string, unknown>> {
  return captureExternalMetadataRecord(
    value,
    state,
    depth,
    'prime-status-contribution',
    ['groupId', 'groupLabel', 'label', 'messages', 'status'],
    ['groupId', 'groupLabel', 'label', 'status'],
    (field, fieldValue, fieldDepth) =>
      field === 'messages' && fieldValue !== undefined
        ? captureExternalPrimeStatusMessages(fieldValue, state, fieldDepth)
        : captureExternalMetadataLeaf(fieldValue, state, fieldDepth)
  );
}

function captureExternalPrimeContributionCapability(
  value: unknown,
  state: ExternalMetadataCaptureState,
  depth: number
): Readonly<Record<string, unknown>> {
  return captureExternalMetadataRecord(
    value,
    state,
    depth,
    'prime-contribution-capability',
    ['status', 'sections'],
    [],
    (field, fieldValue, fieldDepth) =>
      field === 'status' && fieldValue !== undefined
        ? captureExternalMetadataArray(
            fieldValue,
            state,
            fieldDepth,
            'prime-status-contributions',
            (entry) =>
              captureExternalPrimeStatusContribution(
                entry,
                state,
                fieldDepth + 1
              )
          )
        : captureExternalMetadataLeaf(fieldValue, state, fieldDepth)
  );
}

function captureExternalPullRequestFeatures(
  value: unknown,
  state: ExternalMetadataCaptureState,
  depth: number
): Readonly<Record<string, unknown>> {
  return captureExternalMetadataRecord(
    value,
    state,
    depth,
    'pull-request-features',
    [
      'draftPullRequests',
      'reviewComments',
      'threadedComments',
      'enterpriseHosts',
    ],
    [],
    (_field, fieldValue, fieldDepth) => {
      const captured = captureExternalMetadataLeaf(
        fieldValue,
        state,
        fieldDepth
      );
      if (captured !== undefined && typeof captured !== 'boolean') {
        externalMetadataCaptureFailed();
      }
      return captured;
    }
  );
}

function captureExternalPullRequestOperations(
  value: unknown,
  state: ExternalMetadataCaptureState,
  depth: number
): Readonly<Record<string, unknown>> {
  return captureExternalMetadataRecord(
    value,
    state,
    depth,
    'pull-request-operations',
    [
      'listPullRequests',
      'getPullRequest',
      'createPullRequest',
      'updatePullRequest',
      'getPullRequestDiff',
      'listPullRequestComments',
      'addPullRequestComment',
      'replyToPullRequestComment',
      'findPullRequestForBranch',
    ],
    [],
    (_field, fieldValue, fieldDepth) =>
      captureExternalMetadataLeaf(fieldValue, state, fieldDepth)
  );
}

function captureExternalPullRequestProviderCapability(
  value: unknown,
  state: ExternalMetadataCaptureState,
  depth: number
): Readonly<Record<string, unknown>> {
  return captureExternalMetadataRecord(
    value,
    state,
    depth,
    'pull-request-provider-capability',
    [
      'providerId',
      'priority',
      'features',
      'matchRemote',
      'matchRepository',
      'matchPullRequestUrl',
      'operations',
      'authStatus',
    ],
    [
      'providerId',
      'priority',
      'features',
      'matchRemote',
      'matchPullRequestUrl',
      'authStatus',
    ],
    (field, fieldValue, fieldDepth) => {
      switch (field) {
        case 'features':
          return captureExternalPullRequestFeatures(
            fieldValue,
            state,
            fieldDepth
          );
        case 'operations':
          return fieldValue === undefined
            ? captureExternalMetadataLeaf(fieldValue, state, fieldDepth)
            : captureExternalPullRequestOperations(
                fieldValue,
                state,
                fieldDepth
              );
        default:
          return captureExternalMetadataLeaf(fieldValue, state, fieldDepth);
      }
    }
  );
}

function captureExternalPluginCapabilities(
  value: unknown,
  state: ExternalMetadataCaptureState,
  depth: number
): Readonly<Record<string, unknown>> {
  return captureExternalMetadataRecord(
    value,
    state,
    depth,
    'plugin-capabilities',
    ['auth', 'authProvider', 'primeContribution', 'pullRequestProvider'],
    [],
    (field, fieldValue, fieldDepth) => {
      switch (field) {
        case 'auth':
          return fieldValue === undefined
            ? captureExternalMetadataLeaf(fieldValue, state, fieldDepth)
            : captureExternalMetadataRecord(
                fieldValue,
                state,
                fieldDepth,
                'auth-capability',
                ['status'],
                ['status'],
                (_nestedField, nestedValue, nestedDepth) =>
                  captureExternalMetadataLeaf(nestedValue, state, nestedDepth)
              );
        case 'authProvider':
          return fieldValue === undefined
            ? captureExternalMetadataLeaf(fieldValue, state, fieldDepth)
            : captureExternalAuthProviderCapability(
                fieldValue,
                state,
                fieldDepth
              );
        case 'primeContribution':
          return fieldValue === undefined
            ? captureExternalMetadataLeaf(fieldValue, state, fieldDepth)
            : captureExternalPrimeContributionCapability(
                fieldValue,
                state,
                fieldDepth
              );
        case 'pullRequestProvider':
          return fieldValue === undefined
            ? captureExternalMetadataLeaf(fieldValue, state, fieldDepth)
            : captureExternalPullRequestProviderCapability(
                fieldValue,
                state,
                fieldDepth
              );
        default:
          return externalMetadataCaptureFailed();
      }
    }
  );
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

function isLowerAsciiLetterOrDigit(codeUnit: number): boolean {
  return (
    (codeUnit >= 0x30 && codeUnit <= 0x39) ||
    (codeUnit >= 0x61 && codeUnit <= 0x7a)
  );
}

function assertCanonicalIdentity(
  kind: 'External plugin' | 'Prime status group',
  id: string
): void {
  if (id.length === 0 || id.length > MAX_EXTERNAL_PLUGIN_ID_LENGTH) {
    throw new Error(
      `${kind} id must contain 1-${MAX_EXTERNAL_PLUGIN_ID_LENGTH} characters`
    );
  }
  if (
    dangerousIdentityIds.has(id.toLowerCase()) ||
    !isLowerAsciiLetterOrDigit(id.charCodeAt(0)) ||
    !isLowerAsciiLetterOrDigit(id.charCodeAt(id.length - 1))
  ) {
    throw new Error(`${kind} id is not canonical`);
  }
  for (let index = 1; index < id.length - 1; index += 1) {
    const codeUnit = id.charCodeAt(index);
    if (
      !isLowerAsciiLetterOrDigit(codeUnit) &&
      codeUnit !== 0x2d &&
      codeUnit !== 0x2e &&
      codeUnit !== 0x5f
    ) {
      throw new Error(`${kind} id is not canonical`);
    }
  }
}

const unsafeTextFormatCodePoint = /\p{Format}/u;
const unsafeTextDefaultIgnorableCodePoint = /\p{Default_Ignorable_Code_Point}/u;
const unsafeTextNoncharacterCodePoint = /\p{Noncharacter_Code_Point}/u;

function isUnsafeTextCodePoint(codePoint: number): boolean {
  const character = String.fromCodePoint(codePoint);
  return (
    codePoint <= 0x1f ||
    codePoint === 0x7f ||
    (codePoint >= 0x80 && codePoint <= 0x9f) ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
    codePoint === 0x2028 ||
    codePoint === 0x2029 ||
    unsafeTextFormatCodePoint.test(character) ||
    unsafeTextDefaultIgnorableCodePoint.test(character) ||
    unsafeTextNoncharacterCodePoint.test(character)
  );
}

function snapshotPrimeText(
  pluginId: string,
  field: string,
  value: unknown,
  maximumLength: number
): string {
  if (typeof value !== 'string') {
    throw new Error(
      `Plugin '${pluginId}' prime contribution field '${field}' is invalid`
    );
  }

  const normalizedValue = value.normalize('NFC');
  if (
    normalizedValue.length === 0 ||
    normalizedValue.length > maximumLength ||
    normalizedValue.trim() !== normalizedValue
  ) {
    throw new Error(
      `Plugin '${pluginId}' prime contribution field '${field}' is invalid`
    );
  }

  for (const segment of normalizedValue) {
    const codePoint = segment.codePointAt(0);
    if (codePoint === undefined || isUnsafeTextCodePoint(codePoint)) {
      throw new Error(
        `Plugin '${pluginId}' prime contribution field '${field}' is invalid`
      );
    }
  }

  return normalizedValue;
}

function assertManifestId(
  plugin: AidePublicPluginDescriptor,
  manifest: AidePluginManifest
): void {
  const manifestId = manifest.id;
  if (typeof manifestId !== 'string') {
    throw new Error(`Plugin '${plugin.id}' manifest id is invalid`);
  }

  if (manifestId !== plugin.id) {
    throw new Error(
      `Plugin '${plugin.id}' manifest id does not match descriptor id`
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

  let snapshotAliases: readonly string[] | undefined;
  if (aliases !== undefined) {
    const aliasSnapshot: string[] = [];
    const aliasCount = denseOwnArrayLength(aliases);
    for (let index = 0; index < aliasCount; index += 1) {
      const alias = denseOwnArrayValue<unknown>(aliases, index);
      if (typeof alias !== 'string') {
        throw new Error(
          `Plugin '${pluginId}' auth provider '${providerId}' ${operation} command aliases must contain strings`
        );
      }
      assertAuthCommandToken(pluginId, providerId, operation, 'alias', alias);
      defineHostArrayIndex(aliasSnapshot, index, alias);
    }
    snapshotAliases = Object.freeze(aliasSnapshot);
  }

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

  const variables: string[] = [];
  const variableCount = denseOwnArrayLength(value.variables);
  for (let index = 0; index < variableCount; index += 1) {
    const variable = denseOwnArrayValue<unknown>(value.variables, index);
    if (typeof variable !== 'string' || variable.trim() === '') {
      throw new Error(
        `Plugin '${pluginId}' auth provider '${providerId}' env migration variables must contain non-empty strings`
      );
    }
    defineHostArrayIndex(variables, index, variable);
  }

  return Object.freeze({
    description: value.description as string,
    variables: Object.freeze(variables),
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
    if (
      !Array.isArray(field.choices) ||
      denseOwnArrayLength(field.choices) === 0
    ) {
      throw new Error(
        `Plugin '${pluginId}' auth provider '${providerId}' login field '${field.key}' choices must be a non-empty array`
      );
    }

    const choiceSnapshot: AideAuthInputChoice[] = [];
    const choiceCount = denseOwnArrayLength(field.choices);
    for (let index = 0; index < choiceCount; index += 1) {
      defineHostArrayIndex(
        choiceSnapshot,
        index,
        snapshotAuthInputChoice(
          pluginId,
          providerId,
          field.key as string,
          denseOwnArrayValue<unknown>(field.choices, index)
        )
      );
    }
    const choices = Object.freeze(choiceSnapshot);
    let defaultMatches = field.default === undefined;
    if (typeof field.default === 'string') {
      for (let index = 0; index < choiceCount; index += 1) {
        if (
          denseOwnArrayValue<AideAuthInputChoice>(choices, index).value ===
          field.default
        ) {
          defaultMatches = true;
          break;
        }
      }
    }
    if (
      field.default !== undefined &&
      (typeof field.default !== 'string' || !defaultMatches)
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

  let fields: readonly AideAuthInputField[] | undefined;
  if (metadata.fields !== undefined) {
    const fieldSnapshot: AideAuthInputField[] = [];
    const fieldCount = denseOwnArrayLength(metadata.fields);
    for (let index = 0; index < fieldCount; index += 1) {
      defineHostArrayIndex(
        fieldSnapshot,
        index,
        snapshotAuthInputField(
          pluginId,
          providerId,
          denseOwnArrayValue<unknown>(metadata.fields, index)
        )
      );
    }
    fields = Object.freeze(fieldSnapshot);
  }
  const fieldKeys = new Set<string>();
  let duplicateKey: string | undefined;
  const fieldCount = fields === undefined ? 0 : denseOwnArrayLength(fields);
  for (let index = 0; index < fieldCount; index += 1) {
    const key = denseOwnArrayValue<AideAuthInputField>(fields!, index).key;
    if (fieldKeys.has(key)) {
      duplicateKey = key;
      break;
    }
    fieldKeys.add(key);
  }
  if (duplicateKey !== undefined) {
    throw new Error(
      `Plugin '${pluginId}' auth provider '${providerId}' declares login field '${duplicateKey}' more than once`
    );
  }
  const flagOwners = new Map<string, string>();
  for (let index = 0; index < fieldCount; index += 1) {
    const field = denseOwnArrayValue<AideAuthInputField>(fields!, index);
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

function snapshotAuthCapability<R>(
  pluginId: string,
  capability: unknown
): AidePluginAuthCapability<R> {
  if (!isRecord(capability)) {
    throw new Error(`Plugin '${pluginId}' auth capability must be an object`);
  }

  assertFunction(pluginId, 'auth', 'status', capability.status);

  return Object.freeze({
    status: capability.status as AidePluginAuthCapability<R>['status'],
  });
}

function snapshotAuthProviderOperations<RLogin, RLogout>(
  pluginId: string,
  providerId: string,
  operations: unknown
): AideAuthProviderOperations<RLogin, RLogout> | undefined {
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
      : {
          login: login as AideAuthProviderOperations<RLogin, RLogout>['login'],
        }),
    ...(logout === undefined
      ? {}
      : {
          logout: logout as AideAuthProviderOperations<
            RLogin,
            RLogout
          >['logout'],
        }),
  });
}

function snapshotAuthProviderCapability<RStatus, RAccounts, RLogin, RLogout>(
  pluginId: string,
  capability: unknown
): AideAuthProviderCapability<RStatus, RAccounts, RLogin, RLogout> {
  if (!isRecord(capability)) {
    throw new Error(
      `Plugin '${pluginId}' auth provider capability must be an object`
    );
  }

  if (typeof capability.providerId !== 'string') {
    throw new Error(`Plugin '${pluginId}' auth provider id must be a string`);
  }
  assertId('Auth provider', capability.providerId);
  if (
    normalizeAuthProviderId(capability.providerId) !== capability.providerId
  ) {
    throw new Error(
      `Plugin '${pluginId}' auth provider id '${capability.providerId}' must be a canonical provider id`
    );
  }
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
    status: capability.status as AideAuthProviderCapability<
      RStatus,
      RAccounts,
      RLogin,
      RLogout
    >['status'],
    accounts:
      capability.accounts === undefined
        ? undefined
        : (capability.accounts as AideAuthProviderCapability<
            RStatus,
            RAccounts,
            RLogin,
            RLogout
          >['accounts']),
    operations: snapshotAuthProviderOperations<RLogin, RLogout>(
      pluginId,
      capability.providerId,
      capability.operations
    ),
  });
}

function snapshotPrimeStatusContribution<R>(
  pluginId: string,
  contribution: unknown
): AidePrimeStatusContribution<R> {
  if (!isRecord(contribution) || isNodeProxy(contribution)) {
    throw new Error(
      `Plugin '${pluginId}' prime contribution status entries must be objects`
    );
  }

  let groupId: unknown;
  let groupLabel: unknown;
  let label: unknown;
  let messages: unknown;
  let status: unknown;
  try {
    groupId = contribution.groupId;
    groupLabel = contribution.groupLabel;
    label = contribution.label;
    messages = contribution.messages;
    status = contribution.status;
  } catch {
    throw new Error(
      `Plugin '${pluginId}' prime contribution status entry is unreadable`
    );
  }

  if (typeof groupId !== 'string') {
    throw new Error(
      `Plugin '${pluginId}' prime contribution status group id must be a string`
    );
  }
  assertCanonicalIdentity('Prime status group', groupId);
  const snapshotGroupLabel = snapshotPrimeText(
    pluginId,
    'groupLabel',
    groupLabel,
    MAX_PRIME_LABEL_LENGTH
  );
  const snapshotLabel = snapshotPrimeText(
    pluginId,
    'label',
    label,
    MAX_PRIME_LABEL_LENGTH
  );
  assertFunction(pluginId, 'prime contribution', 'status', status);

  return Object.freeze({
    groupId,
    groupLabel: snapshotGroupLabel,
    label: snapshotLabel,
    messages: snapshotPrimeStatusMessages(pluginId, messages),
    status: status as AidePrimeStatusContribution<R>['status'],
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

  const snapshot = Object.create(null) as Record<string, string>;
  const snapshotMessage = (
    key: 'configured' | 'notConfigured' | 'misconfigured'
  ): void => {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Reflect.getOwnPropertyDescriptor(messages, key);
    } catch {
      throw new Error(
        `Plugin '${pluginId}' prime contribution message '${key}' must be an own data property`
      );
    }
    if (descriptor === undefined) return;
    if (!hasOwn(descriptor, 'value')) {
      throw new Error(
        `Plugin '${pluginId}' prime contribution message '${key}' must be an own data property`
      );
    }
    const value = descriptor.value;
    if (value === undefined) return;
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(
        `Plugin '${pluginId}' prime contribution message '${key}' must be a non-empty string`
      );
    }
    Object.defineProperty(snapshot, key, {
      configurable: false,
      enumerable: true,
      value: snapshotPrimeText(
        pluginId,
        `messages.${key}`,
        value,
        MAX_PRIME_MESSAGE_LENGTH
      ),
      writable: false,
    });
  };
  snapshotMessage('configured');
  snapshotMessage('notConfigured');
  snapshotMessage('misconfigured');

  return Object.freeze(snapshot);
}

function snapshotPrimeContributionCapability<R>(
  pluginId: string,
  capability: unknown
): AidePrimeContributionCapability<R> {
  if (!isRecord(capability)) {
    throw new Error(
      `Plugin '${pluginId}' prime contribution capability must be an object`
    );
  }

  let status: unknown;
  let sections: unknown;
  try {
    status = capability.status;
    sections = capability.sections;
  } catch {
    throw new Error(
      `Plugin '${pluginId}' prime contribution capability is unreadable`
    );
  }

  if (status === undefined && sections === undefined) {
    throw new Error(
      `Plugin '${pluginId}' prime contribution capability must provide status or sections`
    );
  }

  const snapshotStatus = snapshotPrimeStatusArray<R>(pluginId, status);
  if (sections !== undefined && typeof sections !== 'function') {
    throw new Error(
      `Plugin '${pluginId}' prime contribution capability field 'sections' must be a function`
    );
  }

  return Object.freeze({
    status: snapshotStatus,
    sections:
      sections === undefined
        ? undefined
        : (sections as AidePrimeContributionCapability<R>['sections']),
  });
}

function snapshotPrimeStatusArray<R>(
  pluginId: string,
  status: unknown
): readonly AidePrimeStatusContribution<R>[] | undefined {
  if (status === undefined) return undefined;
  if (isNodeProxy(status)) {
    throw new Error(
      `Plugin '${pluginId}' prime contribution status must be a host-readable array`
    );
  }
  let isArray = false;
  try {
    isArray = Array.isArray(status);
  } catch {
    // A revoked Proxy is already rejected above; retain fail-closed behavior.
  }
  if (!isArray) {
    throw new Error(
      `Plugin '${pluginId}' prime contribution status must be an array`
    );
  }
  const statusArray = status as object;

  const lengthDescriptor = Reflect.getOwnPropertyDescriptor(
    statusArray,
    'length'
  );
  const length = lengthDescriptor?.value;
  if (
    typeof length !== 'number' ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > MAX_PRIME_STATUS_COUNT
  ) {
    throw new Error(
      `Plugin '${pluginId}' prime contribution status length must be between 0 and ${MAX_PRIME_STATUS_COUNT}`
    );
  }

  const snapshot: AidePrimeStatusContribution<R>[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Reflect.getOwnPropertyDescriptor(
      statusArray,
      String(index)
    );
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new Error(
        `Plugin '${pluginId}' prime contribution status entry ${index} must be a dense data property`
      );
    }
    Object.defineProperty(snapshot, String(index), {
      configurable: false,
      enumerable: true,
      writable: false,
      value: snapshotPrimeStatusContribution<R>(pluginId, descriptor.value),
    });
  }
  return Object.freeze(snapshot);
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

  const snapshot = Object.create(null) as Record<string, boolean>;
  const featureKeys = [
    'draftPullRequests',
    'reviewComments',
    'threadedComments',
    'enterpriseHosts',
  ] as const;
  const featureKeyCount = denseOwnArrayLength(featureKeys);
  for (let index = 0; index < featureKeyCount; index += 1) {
    const keyDescriptor = Reflect.getOwnPropertyDescriptor(
      featureKeys,
      String(index)
    );
    if (
      keyDescriptor === undefined ||
      !hasOwn(keyDescriptor, 'value') ||
      typeof keyDescriptor.value !== 'string'
    ) {
      throw new Error(
        `Plugin '${pluginId}' pull request provider feature schema is invalid`
      );
    }
    const key = keyDescriptor.value;
    const descriptor = Reflect.getOwnPropertyDescriptor(features, key);
    if (descriptor === undefined) continue;
    if (!hasOwn(descriptor, 'value')) {
      throw new Error(
        `Plugin '${pluginId}' pull request provider feature '${key}' must be an own data property`
      );
    }
    const value = descriptor.value;
    if (value === undefined) continue;
    if (typeof value !== 'boolean') {
      throw new Error(
        `Plugin '${pluginId}' pull request provider feature '${key}' must be a boolean`
      );
    }
    Object.defineProperty(snapshot, key, {
      configurable: false,
      enumerable: true,
      writable: false,
      value,
    });
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
  const createPullRequest = operations.createPullRequest;
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
    createPullRequest !== undefined &&
    typeof createPullRequest !== 'function'
  ) {
    throw new Error(
      `Plugin '${pluginId}' pull request provider '${providerId}' operation 'createPullRequest' must be a function`
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
    createPullRequest === undefined &&
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
    ...(createPullRequest === undefined
      ? {}
      : {
          createPullRequest:
            createPullRequest as AidePullRequestProviderOperations['createPullRequest'],
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

function snapshotPullRequestProviderCapability<R>(
  pluginId: string,
  capability: unknown
): AideInternalPullRequestProviderCapability<R> {
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
  if (
    capability.matchRepository !== undefined &&
    typeof capability.matchRepository !== 'function'
  ) {
    throw new Error(
      `Plugin '${pluginId}' pull request provider '${capability.providerId}' field 'matchRepository' must be a function`
    );
  }
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
      capability.matchRemote as AidePullRequestProviderCapability<R>['matchRemote'],
    ...(capability.matchRepository === undefined
      ? {}
      : {
          matchRepository:
            capability.matchRepository as AidePullRequestProviderCapability<R>['matchRepository'],
        }),
    matchPullRequestUrl:
      capability.matchPullRequestUrl as AidePullRequestProviderCapability<R>['matchPullRequestUrl'],
    authStatus:
      capability.authStatus as AidePullRequestProviderCapability<R>['authStatus'],
  });
}

function snapshotPluginCapabilities<
  RAuth,
  RAuthStatus,
  RAuthAccounts,
  RAuthLogin,
  RAuthLogout,
  RPrimeStatus,
  RPullRequestAuthStatus,
>(
  pluginId: string,
  capabilities:
    | AideInternalPluginCapabilities<
        RAuth,
        RAuthStatus,
        RAuthAccounts,
        RAuthLogin,
        RAuthLogout,
        RPrimeStatus,
        RPullRequestAuthStatus
      >
    | undefined
):
  | AideInternalPluginCapabilities<
      RAuth,
      RAuthStatus,
      RAuthAccounts,
      RAuthLogin,
      RAuthLogout,
      RPrimeStatus,
      RPullRequestAuthStatus
    >
  | undefined {
  if (capabilities === undefined) return undefined;
  if (!isRecord(capabilities)) {
    throw new Error(`Plugin '${pluginId}' capabilities must be an object`);
  }

  return Object.freeze({
    auth:
      capabilities.auth === undefined
        ? undefined
        : snapshotAuthCapability<RAuth>(pluginId, capabilities.auth),
    authProvider:
      capabilities.authProvider === undefined
        ? undefined
        : snapshotAuthProviderCapability<
            RAuthStatus,
            RAuthAccounts,
            RAuthLogin,
            RAuthLogout
          >(pluginId, capabilities.authProvider),
    primeContribution:
      capabilities.primeContribution === undefined
        ? undefined
        : snapshotPrimeContributionCapability<RPrimeStatus>(
            pluginId,
            capabilities.primeContribution
          ),
    pullRequestProvider:
      capabilities.pullRequestProvider === undefined
        ? undefined
        : snapshotPullRequestProviderCapability<RPullRequestAuthStatus>(
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
  const keys: string[] = [];
  const seen = new Set<string>();
  const routeCount = Array.isArray(route) ? denseOwnArrayLength(route) : 1;
  for (let index = 0; index < routeCount; index += 1) {
    const value = Array.isArray(route)
      ? denseOwnArrayValue<string | undefined>(route, index)
      : (route as string | undefined);
    const parts = value?.trim().split(/\s+/);
    const key =
      parts === undefined || denseOwnArrayLength(parts) === 0
        ? undefined
        : denseOwnArrayValue<string>(parts, 0);
    if (key === undefined || key === '' || seen.has(key)) continue;
    seen.add(key);
    appendHostArray(keys, key);
  }
  return keys;
}

function routeAcceptsChildCommands(
  route: string | readonly string[] | undefined
): boolean {
  const routeCount = Array.isArray(route) ? denseOwnArrayLength(route) : 1;
  for (let routeIndex = 0; routeIndex < routeCount; routeIndex += 1) {
    const value = Array.isArray(route)
      ? denseOwnArrayValue<string | undefined>(route, routeIndex)
      : (route as string | undefined);
    const parts = value?.trim().split(/\s+/) ?? [];
    const partCount = denseOwnArrayLength(parts);
    for (let partIndex = 1; partIndex < partCount; partIndex += 1) {
      const part = denseOwnArrayValue<string>(parts, partIndex);
      if (part === '<command>' || part === '[command]') return true;
    }
  }
  return false;
}

function commandAcceptsChildCommands(
  acceptsChildren: boolean | undefined,
  route: string | readonly string[] | undefined
): boolean {
  return acceptsChildren ?? routeAcceptsChildCommands(route);
}

function assertRouteKeys(id: string, keys: readonly string[]): void {
  if (denseOwnArrayLength(keys) === 0) {
    throw new Error(`Command '${id}' must declare a route`);
  }
}

function snapshotPlugin<
  RAuth,
  RAuthStatus,
  RAuthAccounts,
  RAuthLogin,
  RAuthLogout,
  RPrimeStatus,
  RPullRequestAuthStatus,
>(
  plugin: AidePluginDescriptor<
    RAuth,
    RAuthStatus,
    RAuthAccounts,
    RAuthLogin,
    RAuthLogout,
    RPrimeStatus,
    RPullRequestAuthStatus
  >
): AidePluginDescriptor<
  RAuth,
  RAuthStatus,
  RAuthAccounts,
  RAuthLogin,
  RAuthLogout,
  RPrimeStatus,
  RPullRequestAuthStatus
> {
  const snapshotCommand = (command: AidePluginCommand): AidePluginCommand => {
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

    const common = {
      kind: 'descriptor' as const,
      id: command.id,
      parentId: command.parentId,
      acceptsChildren: snapshotAcceptsChildren(
        plugin.id,
        command.id,
        command.acceptsChildren
      ),
      extension: snapshotExtensionPolicy(command.extension),
    };
    if (command.execution === 'public') {
      return Object.freeze({
        ...common,
        execution: 'public' as const,
        descriptor: snapshotPublicCommandDescriptor(command.descriptor),
      });
    }

    switch (command.provisioning) {
      case 'none':
        return Object.freeze({
          ...common,
          execution: 'trusted' as const,
          provisioning: 'none' as const,
          descriptor: snapshotCommandDescriptor(command.descriptor, 'none'),
        });
      case 'internal-host':
        return Object.freeze({
          ...common,
          execution: 'trusted' as const,
          provisioning: 'internal-host' as const,
          descriptor: snapshotCommandDescriptor(
            command.descriptor,
            'internal-host'
          ),
        });
      case 'keyring':
        return Object.freeze({
          ...common,
          execution: 'trusted' as const,
          provisioning: 'keyring' as const,
          descriptor: snapshotCommandDescriptor(command.descriptor, 'keyring'),
        });
      case 'internal-host+keyring':
        return Object.freeze({
          ...common,
          execution: 'trusted' as const,
          provisioning: 'internal-host+keyring' as const,
          descriptor: snapshotCommandDescriptor(
            command.descriptor,
            'internal-host+keyring'
          ),
        });
    }
  };

  const commands: AidePluginCommand[] = [];
  const commandCount = denseOwnArrayLength(plugin.commands);
  for (let index = 0; index < commandCount; index += 1) {
    defineHostArrayIndex(
      commands,
      index,
      snapshotCommand(denseOwnArrayValue(plugin.commands, index))
    );
  }

  return Object.freeze({
    id: plugin.id,
    summary: plugin.summary,
    commands: Object.freeze(commands),
    capabilities: snapshotPluginCapabilities(plugin.id, plugin.capabilities),
  });
}

declare const registryOwnedPluginSnapshotBrand: unique symbol;

export type TrustedPluginRegistrationSnapshot<
  RAuth = never,
  RAuthStatus = never,
  RAuthAccounts = never,
  RAuthLogin = never,
  RAuthLogout = never,
  RPrimeStatus = never,
  RPullRequestAuthStatus = never,
> = Readonly<
  AidePluginDescriptor<
    RAuth,
    RAuthStatus,
    RAuthAccounts,
    RAuthLogin,
    RAuthLogout,
    RPrimeStatus,
    RPullRequestAuthStatus
  > & {
    readonly provenance: 'trusted';
    readonly [registryOwnedPluginSnapshotBrand]: true;
  }
>;

export type ExternalPluginRegistrationSnapshot = Readonly<
  AidePluginDescriptor & {
    readonly provenance: 'external';
    readonly [registryOwnedPluginSnapshotBrand]: true;
  }
>;

export type PluginRegistrationSnapshot<
  RAuth = never,
  RAuthStatus = never,
  RAuthAccounts = never,
  RAuthLogin = never,
  RAuthLogout = never,
  RPrimeStatus = never,
  RPullRequestAuthStatus = never,
> =
  | TrustedPluginRegistrationSnapshot<
      RAuth,
      RAuthStatus,
      RAuthAccounts,
      RAuthLogin,
      RAuthLogout,
      RPrimeStatus,
      RPullRequestAuthStatus
    >
  | ExternalPluginRegistrationSnapshot;

const registryOwnedPluginSnapshots = new WeakSet<object>();

function registryOwnedPluginSnapshot<
  RAuth,
  RAuthStatus,
  RAuthAccounts,
  RAuthLogin,
  RAuthLogout,
  RPrimeStatus,
  RPullRequestAuthStatus,
>(
  plugin: AidePluginDescriptor<
    RAuth,
    RAuthStatus,
    RAuthAccounts,
    RAuthLogin,
    RAuthLogout,
    RPrimeStatus,
    RPullRequestAuthStatus
  >,
  provenance: 'trusted'
): TrustedPluginRegistrationSnapshot<
  RAuth,
  RAuthStatus,
  RAuthAccounts,
  RAuthLogin,
  RAuthLogout,
  RPrimeStatus,
  RPullRequestAuthStatus
>;
function registryOwnedPluginSnapshot(
  plugin: AidePluginDescriptor,
  provenance: 'external'
): ExternalPluginRegistrationSnapshot;
function registryOwnedPluginSnapshot(
  plugin: AidePluginDescriptor<
    unknown,
    unknown,
    unknown,
    unknown,
    unknown,
    unknown,
    unknown
  >,
  provenance: PluginRegistrationProvenance
): PluginRegistrationSnapshot<
  unknown,
  unknown,
  unknown,
  unknown,
  unknown,
  unknown,
  unknown
> {
  const snapshot = Object.freeze({ ...snapshotPlugin(plugin), provenance });
  registryOwnedPluginSnapshots.add(snapshot);
  return snapshot as PluginRegistrationSnapshot<
    unknown,
    unknown,
    unknown,
    unknown,
    unknown,
    unknown,
    unknown
  >;
}

function isRegistryOwnedPluginSnapshot(
  plugin: object
): plugin is PluginRegistrationSnapshot<
  unknown,
  unknown,
  unknown,
  unknown,
  unknown,
  unknown,
  unknown
> {
  return registryOwnedPluginSnapshots.has(plugin);
}

type RegisteredCommandCommon = {
  readonly kind: 'descriptor';
  readonly id: string;
  readonly pluginId?: string;
  readonly parentId?: string;
  readonly acceptsChildren: boolean;
  readonly extension?: AideCommandExtensionPolicy;
  readonly routeKeys: readonly string[];
  readonly execution: 'trusted';
};

export type RegisteredTrustedCommand =
  | (RegisteredCommandCommon & {
      readonly provisioning: 'none';
      readonly descriptor: AnyServiceFreeAideCommandDescriptor;
    })
  | (RegisteredCommandCommon & {
      readonly provisioning: 'internal-host';
      readonly descriptor: AnyInternalHostAideCommandDescriptor;
    })
  | (RegisteredCommandCommon & {
      readonly provisioning: 'keyring';
      readonly descriptor: AnyKeyringAideCommandDescriptor;
    })
  | (RegisteredCommandCommon & {
      readonly provisioning: 'internal-host+keyring';
      readonly descriptor: AnyInternalHostAndKeyringAideCommandDescriptor;
    });

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
  | RegisteredTrustedCommand
  | {
      readonly kind: 'descriptor';
      readonly id: string;
      readonly pluginId?: string;
      readonly parentId?: string;
      readonly acceptsChildren: boolean;
      readonly extension?: AideCommandExtensionPolicy;
      readonly routeKeys: readonly string[];
      readonly execution: 'public';
      readonly descriptor: AnyPublicAideCommandDescriptor;
    };

function registeredTrustedCommand(
  command: Extract<AidePluginCommand, { readonly execution: 'trusted' }>,
  common: Omit<RegisteredCommandCommon, 'kind' | 'execution'> & {
    readonly kind: 'descriptor';
  }
): RegisteredTrustedCommand {
  assertCommandDescriptorProvisioning(command.descriptor, command.provisioning);

  switch (command.provisioning) {
    case 'none':
      return Object.freeze({
        ...common,
        execution: 'trusted' as const,
        provisioning: 'none' as const,
        descriptor: command.descriptor,
      });
    case 'internal-host':
      return Object.freeze({
        ...common,
        execution: 'trusted' as const,
        provisioning: 'internal-host' as const,
        descriptor: command.descriptor,
      });
    case 'keyring':
      return Object.freeze({
        ...common,
        execution: 'trusted' as const,
        provisioning: 'keyring' as const,
        descriptor: command.descriptor,
      });
    case 'internal-host+keyring':
      return Object.freeze({
        ...common,
        execution: 'trusted' as const,
        provisioning: 'internal-host+keyring' as const,
        descriptor: command.descriptor,
      });
  }
}

export interface RegisterCommandOptions {
  readonly parentId?: string;
  readonly acceptsChildren?: boolean;
  readonly extension?: AideCommandExtensionPolicy;
}

export interface RegisterExternalPluginOptions {
  readonly manifest: AidePluginManifest;
}

export interface PluginCapability<TCapability> {
  readonly pluginId: string;
  readonly capability: TCapability;
}

export interface TrustedOwnedPluginCapability<
  TCapability,
> extends PluginCapability<TCapability> {
  readonly provenance: 'trusted';
}

export interface ExternalOwnedPluginCapability<
  TCapability,
> extends PluginCapability<TCapability> {
  readonly provenance: 'external';
}

export type OwnedPluginCapability<
  TTrustedCapability,
  TExternalCapability = TTrustedCapability,
> =
  | TrustedOwnedPluginCapability<TTrustedCapability>
  | ExternalOwnedPluginCapability<TExternalCapability>;

export type PluginRegistrationProvenance = 'trusted' | 'external';

function ownedPluginCapability<TCapability>(
  pluginId: string,
  provenance: 'trusted',
  capability: TCapability
): TrustedOwnedPluginCapability<TCapability>;
function ownedPluginCapability<TCapability>(
  pluginId: string,
  provenance: 'external',
  capability: TCapability
): ExternalOwnedPluginCapability<TCapability>;
function ownedPluginCapability<TCapability>(
  pluginId: string,
  provenance: PluginRegistrationProvenance,
  capability: TCapability
): OwnedPluginCapability<TCapability> {
  const entry = Object.freeze({ pluginId, provenance, capability });
  registryOwnedPluginCapabilities.set(entry, provenance);
  return entry;
}

const registryOwnedPluginCapabilities = new WeakMap<
  object,
  PluginRegistrationProvenance
>();
const certifiedBuiltinPullRequestProviderCapabilities = new WeakMap<
  object,
  HostOwnedPullRequestFailureDiagnostic
>();
const certifiedBuiltinPullRequestProviderEntries = new WeakMap<
  object,
  HostOwnedPullRequestFailureDiagnostic
>();

export function isRegistryOwnedTrustedPluginCapability<TCapability>(
  entry: PluginCapability<TCapability>
): entry is TrustedOwnedPluginCapability<TCapability> {
  return registryOwnedPluginCapabilities.get(entry) === 'trusted';
}

/**
 * Resolve diagnostic text only for an exact capability entry emitted for an
 * exact certified built-in registration. The lookup performs no property or
 * prototype inspection on either argument.
 */
export function certifiedBuiltinPullRequestProviderDiagnostic(
  entry: PluginCapability<unknown>,
  failure: unknown
): string | undefined {
  const diagnostic = certifiedBuiltinPullRequestProviderEntries.get(entry);
  if (diagnostic === undefined) return undefined;
  try {
    const message = diagnostic(failure);
    return typeof message === 'string' &&
      message.length > 0 &&
      message.length <= MAX_BUILTIN_PULL_REQUEST_DIAGNOSTIC_LENGTH
      ? message
      : undefined;
  } catch {
    return undefined;
  }
}

function certifyBuiltinPullRequestProviderEntry<
  TEntry extends PluginCapability<TCapability>,
  TCapability,
>(entry: TEntry, capability: TCapability): TEntry {
  if (
    (typeof capability === 'object' && capability !== null) ||
    typeof capability === 'function'
  ) {
    const diagnostic =
      certifiedBuiltinPullRequestProviderCapabilities.get(capability);
    if (diagnostic !== undefined) {
      certifiedBuiltinPullRequestProviderEntries.set(entry, diagnostic);
    }
  }
  return entry;
}

function isTrustedOwnedPluginCapability<TTrusted, TExternal>(
  entry: OwnedPluginCapability<TTrusted, TExternal>
): entry is TrustedOwnedPluginCapability<TTrusted> {
  return entry.provenance === 'trusted';
}

function authProviderCommandNames<RStatus, RAccounts, RLogin, RLogout>(
  provider: AideAuthProviderCapability<RStatus, RAccounts, RLogin, RLogout>,
  operation: 'login' | 'logout'
): readonly string[] {
  const metadata = operation === 'login' ? provider.login : provider.logout;
  const names: string[] = [];
  const name = metadata?.command?.name;
  if (name !== undefined) appendHostArray(names, name);
  const aliases = metadata?.command?.aliases;
  if (aliases !== undefined) {
    const aliasCount = denseOwnArrayLength(aliases);
    for (let index = 0; index < aliasCount; index += 1) {
      appendHostArray(names, denseOwnArrayValue<string>(aliases, index));
    }
  }
  return names;
}

function authProviderAddressableNames<RStatus, RAccounts, RLogin, RLogout>(
  provider: AideAuthProviderCapability<RStatus, RAccounts, RLogin, RLogout>
): readonly string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const add = (name: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    appendHostArray(names, name);
  };
  add(provider.providerId);
  const loginNames = authProviderCommandNames(provider, 'login');
  const loginNameCount = denseOwnArrayLength(loginNames);
  for (let index = 0; index < loginNameCount; index += 1) {
    add(denseOwnArrayValue<string>(loginNames, index));
  }
  const logoutNames = authProviderCommandNames(provider, 'logout');
  const logoutNameCount = denseOwnArrayLength(logoutNames);
  for (let index = 0; index < logoutNameCount; index += 1) {
    add(denseOwnArrayValue<string>(logoutNames, index));
  }
  return names;
}

function assertPluginCommandParentGraphAcyclic(
  pluginId: string,
  commands: readonly AidePluginCommand[]
): void {
  const commandById = new Map<string, AidePluginCommand>();
  const commandCount = denseOwnArrayLength(commands);
  for (let index = 0; index < commandCount; index += 1) {
    const command = denseOwnArrayValue<AidePluginCommand>(commands, index);
    commandById.set(command.id, command);
  }
  const visited = new Set<string>();
  const path: string[] = [];
  const pathIndexes = new Map<string, number>();
  let pathLength = 0;

  const visit = (id: string): void => {
    if (visited.has(id)) return;

    const cycleStart = pathIndexes.get(id);
    if (cycleStart !== undefined) {
      let cycle = '';
      for (let index = cycleStart; index < pathLength; index += 1) {
        if (cycle !== '') cycle += ' -> ';
        cycle += denseOwnArrayValue<string>(path, index);
      }
      cycle += `${cycle === '' ? '' : ' -> '}${id}`;
      throw new Error(
        `Plugin '${pluginId}' declares a command parent cycle: ${cycle}`
      );
    }

    const command = commandById.get(id);
    if (command === undefined) return;

    defineHostArrayIndex(path, pathLength, id);
    pathIndexes.set(id, pathLength);
    pathLength += 1;
    const parentId = command.parentId;
    if (parentId !== undefined && commandById.has(parentId)) {
      visit(parentId);
    }
    pathLength -= 1;
    pathIndexes.delete(id);
    visited.add(id);
  };

  for (let index = 0; index < commandCount; index += 1) {
    visit(denseOwnArrayValue<AidePluginCommand>(commands, index).id);
  }
}

function pluginCommandDepths(
  commands: readonly AidePluginCommand[]
): ReadonlyMap<string, number> {
  const commandById = new Map<string, AidePluginCommand>();
  const commandCount = denseOwnArrayLength(commands);
  for (let index = 0; index < commandCount; index += 1) {
    const command = denseOwnArrayValue<AidePluginCommand>(commands, index);
    commandById.set(command.id, command);
  }
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

  for (let index = 0; index < commandCount; index += 1) {
    depth(denseOwnArrayValue<AidePluginCommand>(commands, index).id);
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
  if (denseOwnArrayLength(plugin.commands) > 0) {
    appendHostArray(capabilities, 'commands');
  }
  if (plugin.capabilities?.auth !== undefined) {
    appendHostArray(capabilities, 'auth');
  }
  if (plugin.capabilities?.authProvider !== undefined) {
    appendHostArray(capabilities, 'auth-provider');
  }
  if (plugin.capabilities?.primeContribution !== undefined) {
    appendHostArray(capabilities, 'prime-contribution');
  }
  if (plugin.capabilities?.pullRequestProvider !== undefined) {
    appendHostArray(capabilities, 'pull-request-provider');
  }

  return capabilities;
}

const externalCommandIdentityInvalidDiagnostic =
  'External plugin command identity must use valid own string data properties';
const externalCommandIdentityMismatchDiagnostic =
  'External plugin command placement id must match descriptor id';
const externalCommandKindInvalidDiagnostic =
  'External plugin commands must be descriptor-backed; raw yargs modules are trusted internal only';
const externalCommandIdentityInvalidSentinel = Symbol(
  'external-command-identity-invalid'
);

function externalCommandIdentityInvalid(): Error {
  return new Error(externalCommandIdentityInvalidDiagnostic);
}

function assertExternalCommandIdentityValue(
  value: unknown
): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '' || /\s/.test(value)) {
    throw externalCommandIdentityInvalid();
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || isUnsafeTextCodePoint(codePoint)) {
      throw externalCommandIdentityInvalid();
    }
  }
}

function isKnownPluginCapabilityKind(
  value: unknown
): value is AidePluginCapabilityKind {
  if (typeof value !== 'string') return false;
  const kindCount = denseOwnArrayLength(aidePluginCapabilityKinds);
  for (let index = 0; index < kindCount; index += 1) {
    if (
      denseOwnArrayValue<AidePluginCapabilityKind>(
        aidePluginCapabilityKinds,
        index
      ) === value
    ) {
      return true;
    }
  }
  return false;
}

function publicPluginToTrustedDescriptor(
  plugin: AidePublicPluginDescriptor
): AidePluginDescriptor {
  const commands: AidePluginCommand[] = [];
  const commandCount = denseOwnArrayLength(plugin.commands);
  for (let index = 0; index < commandCount; index += 1) {
    const command = denseOwnArrayValue<AidePublicPluginCommand>(
      plugin.commands,
      index
    );
    const descriptor = command.descriptor as AnyPublicAideCommandDescriptor;
    const run = descriptor.run;
    defineHostArrayIndex(commands, index, {
      kind: 'descriptor' as const,
      id: command.id,
      parentId: command.parentId,
      acceptsChildren: command.acceptsChildren,
      extension: command.extension,
      execution: 'public' as const,
      descriptor: {
        id: command.id,
        route: descriptor.route,
        summary: descriptor.summary,
        ...(descriptor.yargs === undefined ? {} : { yargs: descriptor.yargs }),
        run: (args: ArgumentsCamelCase<object>) => run(args),
      },
    });
  }
  return {
    id: plugin.id,
    summary: plugin.summary,
    commands,
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

  const pluginIdCount = denseOwnArrayLength(value);
  for (let index = 0; index < pluginIdCount; index += 1) {
    const pluginIdValue = denseOwnArrayValue<unknown>(value, index);
    if (typeof pluginIdValue !== 'string') {
      throw new Error(
        `Plugin '${pluginId}' manifest ${manifest}.${field} entries must be plugin ids`
      );
    }
    assertCanonicalIdentity('External plugin', pluginIdValue);
  }
}

function assertExternalPluginManifest(
  plugin: AidePublicPluginDescriptor,
  manifest: AidePluginManifest
): void {
  if (!isRecord(manifest)) {
    throw new Error(`Plugin '${plugin.id}' manifest must be an object`);
  }
  assertManifestId(plugin, manifest);
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
    const capabilityCount = denseOwnArrayLength(manifest.capabilities);
    for (let index = 0; index < capabilityCount; index += 1) {
      const capability = denseOwnArrayValue<unknown>(
        manifest.capabilities,
        index
      );
      if (!isKnownPluginCapabilityKind(capability)) {
        throw new Error(
          `Plugin '${plugin.id}' manifest declares unknown capability`
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

  const providedCapabilities = hostSetFromArray(
    externalPluginCapabilityKinds(plugin)
  );
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
    const assertConflictPolicy = (
      field: 'authProviders' | 'commands' | 'pullRequestProviders'
    ): void => {
      const conflicts = manifest.conflicts;
      if (conflicts === undefined) return;
      const policy = conflicts[field];
      if (policy !== undefined && policy !== 'reject') {
        throw new Error(
          `Plugin '${plugin.id}' manifest conflicts.${field} must be 'reject'`
        );
      }
    };
    assertConflictPolicy('authProviders');
    assertConflictPolicy('commands');
    assertConflictPolicy('pullRequestProviders');
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

function captureExternalCommandDescriptorMetadata(
  value: unknown,
  state: ExternalMetadataCaptureState,
  depth: number
): unknown {
  if (!isRecord(value)) return externalCommandIdentityInvalidSentinel;
  try {
    if (isNodeProxy(value)) return externalCommandIdentityInvalidSentinel;
  } catch {
    return externalCommandIdentityInvalidSentinel;
  }

  const source = value as object;
  if (state.active.has(source)) externalMetadataCaptureFailed();
  const existing = externalMetadataSnapshot(
    state,
    source,
    'command-descriptor'
  );
  if (existing !== undefined) {
    if (!isRecord(existing)) externalMetadataCaptureFailed();
    return existing;
  }

  const allowedFields = new Set<string>();
  allowedFields.add('id');
  allowedFields.add('route');
  allowedFields.add('summary');
  allowedFields.add('run');
  allowedFields.add('yargs');
  const requiredFields = ['route', 'summary', 'run'];
  const descriptors = new Map<string, PropertyDescriptor>();
  let keys: readonly string[];
  let identityInvalid = false;
  let invalidPrototype = false;
  try {
    const prototype = Object.getPrototypeOf(source);
    invalidPrototype = prototype !== Object.prototype && prototype !== null;
    const ownKeys = Reflect.ownKeys(source);
    const ownKeyCount = denseOwnArrayLength(ownKeys);
    if (ownKeyCount > MAX_EXTERNAL_METADATA_RECORD_FIELDS) {
      externalMetadataCaptureFailed();
    }
    const stringKeys: string[] = [];
    for (let index = 0; index < ownKeyCount; index += 1) {
      const key = denseOwnArrayValue<PropertyKey>(ownKeys, index);
      if (typeof key !== 'string') externalMetadataCaptureFailed();
      accountExternalMetadataValue(state, key, depth + 1);
      if (!allowedFields.has(key)) externalMetadataCaptureFailed();
      appendHostArray(stringKeys, key);
    }
    const stringKeyCount = denseOwnArrayLength(stringKeys);
    for (let index = 0; index < stringKeyCount; index += 1) {
      const key = denseOwnArrayValue<string>(stringKeys, index);
      const descriptor = Object.getOwnPropertyDescriptor(source, key);
      if (descriptor === undefined || !hasOwn(descriptor, 'value')) {
        if (key === 'id') {
          identityInvalid = true;
          continue;
        }
        externalMetadataCaptureFailed();
      }
      descriptors.set(key, descriptor);
    }
    if (!hostArrayIncludes(stringKeys, 'id')) identityInvalid = true;
    const requiredFieldCount = denseOwnArrayLength(requiredFields);
    for (let index = 0; index < requiredFieldCount; index += 1) {
      const required = denseOwnArrayValue<string>(requiredFields, index);
      if (!hostArrayIncludes(stringKeys, required)) {
        externalMetadataCaptureFailed();
      }
    }
    const capturedKeys: string[] = [];
    for (let index = 0; index < stringKeyCount; index += 1) {
      const key = denseOwnArrayValue<string>(stringKeys, index);
      if (descriptors.has(key)) appendHostArray(capturedKeys, key);
    }
    keys = capturedKeys;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === externalMetadataCaptureDiagnostic
    ) {
      throw error;
    }
    externalMetadataCaptureFailed();
  }

  state.active.add(source);
  try {
    const snapshot = Object.create(null) as Record<string, unknown>;
    if (identityInvalid) {
      Object.defineProperty(snapshot, 'id', {
        configurable: false,
        enumerable: true,
        writable: false,
        value: externalCommandIdentityInvalidSentinel,
      });
    }
    const keyCount = denseOwnArrayLength(keys);
    for (let index = 0; index < keyCount; index += 1) {
      const key = denseOwnArrayValue<string>(keys, index);
      const fieldValue = descriptors.get(key)!.value;
      let captured: unknown;
      if (key === 'route') {
        let isArray: boolean;
        try {
          isArray = Array.isArray(fieldValue);
        } catch {
          return externalMetadataCaptureFailed();
        }
        captured = isArray
          ? captureExternalLeafArray(
              fieldValue,
              state,
              depth + 1,
              'command-route'
            )
          : captureExternalMetadataLeaf(fieldValue, state, depth + 1);
      } else if (key === 'yargs') {
        captured =
          fieldValue === undefined
            ? captureExternalMetadataLeaf(fieldValue, state, depth + 1)
            : captureExternalMetadataRecord(
                fieldValue,
                state,
                depth + 1,
                'command-yargs',
                ['builder'],
                [],
                (_nestedField, nestedValue, nestedDepth) =>
                  captureExternalMetadataLeaf(nestedValue, state, nestedDepth)
              );
      } else {
        captured = captureExternalMetadataLeaf(fieldValue, state, depth + 1);
      }
      Object.defineProperty(snapshot, key, {
        configurable: false,
        enumerable: true,
        writable: false,
        value: captured,
      });
    }
    if (invalidPrototype && !identityInvalid) {
      externalMetadataCaptureFailed();
    }
    const frozen = Object.freeze(snapshot);
    setExternalMetadataSnapshot(state, source, 'command-descriptor', frozen);
    state.accountedContents.add(source);
    return frozen;
  } finally {
    state.active.delete(source);
  }
}

function canonicalizeExternalExtensionPolicyVariant(
  snapshot: Readonly<Record<string, unknown>>
): AideCommandExtensionPolicy {
  const kind = snapshot.kind;
  const hasPluginIds = hasOwnExternalMetadataField(snapshot, 'pluginIds');
  if (kind === 'same-plugin' || kind === 'open') {
    if (hasPluginIds) externalMetadataCaptureFailed();
    return Object.freeze({ kind });
  }

  if (kind !== 'allowlist' || !hasPluginIds) {
    externalMetadataCaptureFailed();
  }
  const pluginIds = snapshot.pluginIds;
  if (!Array.isArray(pluginIds)) {
    externalMetadataCaptureFailed();
  }
  const pluginIdCount = denseOwnArrayLength(pluginIds);
  for (let index = 0; index < pluginIdCount; index += 1) {
    if (typeof denseOwnArrayValue<unknown>(pluginIds, index) !== 'string') {
      externalMetadataCaptureFailed();
    }
  }
  return Object.freeze({
    kind: 'allowlist',
    pluginIds: Object.freeze(copyHostArray(pluginIds as readonly string[])),
  });
}

function captureExternalExtensionPolicy(
  value: unknown,
  state: ExternalMetadataCaptureState,
  depth: number
): AideCommandExtensionPolicy {
  const snapshot = captureExternalMetadataRecord(
    value,
    state,
    depth,
    'command-extension',
    ['kind', 'pluginIds'],
    ['kind'],
    (field, fieldValue, fieldDepth) =>
      field === 'pluginIds' && fieldValue !== undefined
        ? captureExternalLeafArray(
            fieldValue,
            state,
            fieldDepth,
            'command-extension-plugin-ids'
          )
        : captureExternalMetadataLeaf(fieldValue, state, fieldDepth)
  );
  return canonicalizeExternalExtensionPolicyVariant(snapshot);
}

function assertExternalCommandPlacementVariant(
  snapshot: Readonly<Record<string, unknown>>
): void {
  if (
    snapshot.kind !== 'descriptor' ||
    hasOwnExternalMetadataField(snapshot, 'module')
  ) {
    externalMetadataCaptureFailed();
  }
}

function captureExternalCommandMetadata(
  command: unknown,
  state: ExternalMetadataCaptureState
): AidePublicPluginCommand {
  accountExternalMetadataValue(state, command, 2);
  if (!isRecord(command)) throw externalCommandIdentityInvalid();
  try {
    if (isNodeProxy(command)) throw externalCommandIdentityInvalid();
  } catch {
    throw externalCommandIdentityInvalid();
  }
  const commandRecord = command as object;
  if (state.active.has(commandRecord)) externalMetadataCaptureFailed();
  const existing = externalMetadataSnapshot(
    state,
    commandRecord,
    'command-placement'
  );
  if (existing !== undefined) {
    if (!isRecord(existing)) externalMetadataCaptureFailed();
    return existing as unknown as AidePublicPluginCommand;
  }

  const allowedFields = new Set<string>();
  allowedFields.add('kind');
  allowedFields.add('id');
  allowedFields.add('parentId');
  allowedFields.add('acceptsChildren');
  allowedFields.add('extension');
  allowedFields.add('descriptor');
  allowedFields.add('module');
  let keys: readonly string[];
  let invalidCommandPrototype = false;
  const descriptors = new Map<string, PropertyDescriptor>();
  try {
    const ownKeys = Reflect.ownKeys(commandRecord);
    const ownKeyCount = denseOwnArrayLength(ownKeys);
    if (ownKeyCount > MAX_EXTERNAL_METADATA_RECORD_FIELDS) {
      externalMetadataCaptureFailed();
    }
    const stringKeys: string[] = [];
    for (let index = 0; index < ownKeyCount; index += 1) {
      const key = denseOwnArrayValue<PropertyKey>(ownKeys, index);
      if (typeof key !== 'string') externalMetadataCaptureFailed();
      accountExternalMetadataValue(state, key, 3);
      if (!allowedFields.has(key)) externalMetadataCaptureFailed();
      appendHostArray(stringKeys, key);
    }
    if (!hostArrayIncludes(stringKeys, 'kind')) {
      externalMetadataCaptureFailed();
    }

    const kindDescriptor = Object.getOwnPropertyDescriptor(
      commandRecord,
      'kind'
    );
    if (kindDescriptor === undefined || !hasOwn(kindDescriptor, 'value')) {
      externalMetadataCaptureFailed();
    }
    const commandKind = captureExternalMetadataLeaf(
      kindDescriptor.value,
      state,
      3
    );
    if (commandKind !== 'descriptor') {
      throw new Error(externalCommandKindInvalidDiagnostic);
    }
    const commandPrototype = Object.getPrototypeOf(commandRecord);
    invalidCommandPrototype =
      commandPrototype !== Object.prototype && commandPrototype !== null;
    const stringKeyCount = denseOwnArrayLength(stringKeys);
    for (let index = 0; index < stringKeyCount; index += 1) {
      const key = denseOwnArrayValue<string>(stringKeys, index);
      if (key === 'kind') {
        descriptors.set(key, kindDescriptor);
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(commandRecord, key);
      if (descriptor === undefined || !hasOwn(descriptor, 'value')) {
        if (key === 'id' || key === 'descriptor') {
          continue;
        }
        externalMetadataCaptureFailed();
      }
      descriptors.set(key, descriptor);
    }
    if (invalidCommandPrototype && hostArrayIncludes(stringKeys, 'id')) {
      externalMetadataCaptureFailed();
    }
    const capturedKeys: string[] = [];
    for (let index = 0; index < stringKeyCount; index += 1) {
      const key = denseOwnArrayValue<string>(stringKeys, index);
      if (descriptors.has(key)) appendHostArray(capturedKeys, key);
    }
    keys = capturedKeys;
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message === externalCommandKindInvalidDiagnostic ||
        error.message === externalCommandIdentityInvalidDiagnostic)
    ) {
      throw error;
    }
    externalMetadataCaptureFailed();
  }

  state.active.add(commandRecord);
  try {
    const snapshot = Object.create(null) as Record<string, unknown>;
    const keyCount = denseOwnArrayLength(keys);
    for (let index = 0; index < keyCount; index += 1) {
      const key = denseOwnArrayValue<string>(keys, index);
      const fieldValue = descriptors.get(key)!.value;
      let captured: unknown;
      switch (key) {
        case 'kind':
          captured = fieldValue;
          break;
        case 'extension':
          captured =
            fieldValue === undefined
              ? captureExternalMetadataLeaf(fieldValue, state, 3)
              : captureExternalExtensionPolicy(fieldValue, state, 3);
          break;
        case 'descriptor':
          accountExternalMetadataValue(state, fieldValue, 3);
          captured = captureExternalCommandDescriptorMetadata(
            fieldValue,
            state,
            3
          );
          break;
        default:
          captured = captureExternalMetadataLeaf(fieldValue, state, 3);
      }
      Object.defineProperty(snapshot, key, {
        configurable: false,
        enumerable: true,
        writable: false,
        value: captured,
      });
    }

    const frozen = Object.freeze(
      snapshot
    ) as unknown as AidePublicPluginCommand;
    assertExternalCommandPlacementVariant(
      frozen as unknown as Readonly<Record<string, unknown>>
    );
    setExternalMetadataSnapshot(
      state,
      commandRecord,
      'command-placement',
      frozen
    );
    state.accountedContents.add(commandRecord);
    return frozen;
  } finally {
    state.active.delete(commandRecord);
  }
}

function captureExternalPluginMetadata(
  plugin: AidePublicPluginDescriptor,
  state: ExternalMetadataCaptureState
): AidePublicPluginDescriptor {
  return captureExternalMetadataRecord(
    plugin,
    state,
    0,
    'plugin',
    ['id', 'summary', 'commands', 'capabilities'],
    ['id', 'summary', 'commands'],
    (field, value, depth) => {
      switch (field) {
        case 'commands':
          return captureExternalMetadataArray(
            value,
            state,
            depth,
            'plugin-commands',
            (entry) => captureExternalCommandMetadata(entry, state)
          );
        case 'capabilities':
          return value === undefined
            ? captureExternalMetadataLeaf(value, state, depth)
            : captureExternalPluginCapabilities(value, state, depth);
        default:
          return captureExternalMetadataLeaf(value, state, depth);
      }
    }
  ) as unknown as AidePublicPluginDescriptor;
}

function captureExternalManifestMetadata(
  options: RegisterExternalPluginOptions | undefined,
  state: ExternalMetadataCaptureState
): AidePluginManifest | undefined {
  if (options === undefined) {
    captureExternalMetadataLeaf(options, state, 0);
    return undefined;
  }
  const snapshot = captureExternalMetadataRecord(
    options,
    state,
    0,
    'registration-options',
    ['manifest'],
    ['manifest'],
    (_field, manifestValue, depth) =>
      captureExternalMetadataRecord(
        manifestValue,
        state,
        depth,
        'manifest',
        [
          'id',
          'version',
          'aidePluginApiVersion',
          'main',
          'summary',
          'trust',
          'capabilities',
          'loading',
          'conflicts',
        ],
        ['id', 'version', 'aidePluginApiVersion'],
        (field, value, fieldDepth) => {
          switch (field) {
            case 'capabilities':
              return value === undefined
                ? captureExternalMetadataLeaf(value, state, fieldDepth)
                : captureExternalLeafArray(
                    value,
                    state,
                    fieldDepth,
                    'manifest-capabilities'
                  );
            case 'loading':
              return value === undefined
                ? captureExternalMetadataLeaf(value, state, fieldDepth)
                : captureExternalMetadataRecord(
                    value,
                    state,
                    fieldDepth,
                    'manifest-loading',
                    ['order', 'after', 'before'],
                    [],
                    (nestedField, nestedValue, nestedDepth) =>
                      (nestedField === 'after' || nestedField === 'before') &&
                      nestedValue !== undefined
                        ? captureExternalLeafArray(
                            nestedValue,
                            state,
                            nestedDepth,
                            'manifest-dependencies'
                          )
                        : captureExternalMetadataLeaf(
                            nestedValue,
                            state,
                            nestedDepth
                          )
                  );
            case 'conflicts':
              return value === undefined
                ? captureExternalMetadataLeaf(value, state, fieldDepth)
                : captureExternalMetadataRecord(
                    value,
                    state,
                    fieldDepth,
                    'manifest-conflicts',
                    ['commands', 'authProviders', 'pullRequestProviders'],
                    [],
                    (_nestedField, nestedValue, nestedDepth) =>
                      captureExternalMetadataLeaf(
                        nestedValue,
                        state,
                        nestedDepth
                      )
                  );
            default:
              return captureExternalMetadataLeaf(value, state, fieldDepth);
          }
        }
      )
  );
  return snapshot.manifest as unknown as AidePluginManifest;
}

function validateAndCanonicalizeExternalPlugin(
  snapshot: AidePublicPluginDescriptor
): AidePublicPluginDescriptor {
  if (typeof snapshot.id !== 'string') {
    throw new Error('External plugin id must be a string');
  }
  assertCanonicalIdentity('External plugin', snapshot.id);
  if (isReservedAidePluginId(snapshot.id)) {
    throw new Error(
      `External plugin '${snapshot.id}' cannot use a reserved aide plugin id`
    );
  }

  const commands: AidePublicPluginCommand[] = [];
  const commandCount = denseOwnArrayLength(snapshot.commands);
  for (let index = 0; index < commandCount; index += 1) {
    const command = denseOwnArrayValue<AidePublicPluginCommand>(
      snapshot.commands,
      index
    );
    assertExternalCommandIdentityValue(command.id);
    const descriptorValue = command.descriptor as unknown;
    if (!isRecord(descriptorValue)) {
      throw externalCommandIdentityInvalid();
    }
    const descriptor =
      descriptorValue as unknown as AnyPublicAideCommandDescriptor;
    assertExternalCommandIdentityValue(descriptor.id);
    if (command.id !== descriptor.id) {
      throw new Error(externalCommandIdentityMismatchDiagnostic);
    }
    assertExternalPluginCommandIdNamespace(snapshot.id, command.id);
    if (descriptor.yargs?.builder !== undefined) {
      throw new Error(
        `External plugin '${snapshot.id}' command '${command.id}' cannot use yargs builders yet`
      );
    }

    defineHostArrayIndex(
      commands,
      index,
      Object.freeze({
        ...command,
        id: command.id,
        descriptor: Object.freeze({ ...descriptor, id: command.id }),
      }) as AidePublicPluginCommand
    );
  }

  return Object.freeze({
    ...snapshot,
    commands: Object.freeze(commands),
  }) as unknown as AidePublicPluginDescriptor;
}

function assertExternalPluginBoundary(
  plugin: AidePublicPluginDescriptor,
  options: RegisterExternalPluginOptions | undefined
): AidePublicPluginDescriptor {
  const state = createExternalMetadataCaptureState();
  const manifest = captureExternalManifestMetadata(options, state);
  const capturedPlugin = captureExternalPluginMetadata(plugin, state);
  const snapshot = validateAndCanonicalizeExternalPlugin(capturedPlugin);

  if (typeof snapshot.summary !== 'string' || snapshot.summary.trim() === '') {
    throw new Error(
      `External plugin '${snapshot.id}' summary must be a non-empty string`
    );
  }

  const providerId = snapshot.capabilities?.pullRequestProvider?.providerId;
  if (
    typeof providerId === 'string' &&
    isReservedAidePullRequestProviderId(providerId)
  ) {
    throw new Error(
      `External plugin '${snapshot.id}' cannot declare reserved pull request provider '${providerId}'`
    );
  }

  if (manifest === undefined) {
    throw new Error(`External plugin '${snapshot.id}' requires a manifest`);
  }
  assertExternalPluginManifest(snapshot, manifest);
  return snapshot;
}

export class CommandRegistry<
  RAuth = never,
  RAuthStatus = never,
  RAuthAccounts = never,
  RAuthLogin = never,
  RAuthLogout = never,
  RPrimeStatus = never,
  RPullRequestAuthStatus = never,
> {
  readonly #commands: RegisteredCommand[] = [];
  readonly #childCommands = new Map<string, RegisteredCommand[]>();
  readonly #plugins: PluginRegistrationSnapshot<
    RAuth,
    RAuthStatus,
    RAuthAccounts,
    RAuthLogin,
    RAuthLogout,
    RPrimeStatus,
    RPullRequestAuthStatus
  >[] = [];
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
    auth: (): readonly OwnedPluginCapability<
      AidePluginAuthCapability<RAuth>,
      AidePluginAuthCapability
    >[] => {
      const entries: OwnedPluginCapability<
        AidePluginAuthCapability<RAuth>,
        AidePluginAuthCapability
      >[] = [];
      const pluginCount = denseOwnArrayLength(this.#plugins);
      for (let index = 0; index < pluginCount; index += 1) {
        const plugin = denseOwnArrayValue<
          PluginRegistrationSnapshot<
            RAuth,
            RAuthStatus,
            RAuthAccounts,
            RAuthLogin,
            RAuthLogout,
            RPrimeStatus,
            RPullRequestAuthStatus
          >
        >(this.#plugins, index);
        const capability = plugin.capabilities?.auth;
        if (capability === undefined) continue;
        appendHostArray(
          entries,
          plugin.provenance === 'trusted'
            ? ownedPluginCapability(plugin.id, 'trusted', capability)
            : ownedPluginCapability(plugin.id, 'external', capability)
        );
      }
      return Object.freeze(entries);
    },
    authProviders: (): readonly OwnedPluginCapability<
      AideInternalAuthProviderCapability<
        RAuthStatus,
        RAuthAccounts,
        RAuthLogin,
        RAuthLogout
      >,
      AideAuthProviderCapability
    >[] => {
      const entries: OwnedPluginCapability<
        AideInternalAuthProviderCapability<
          RAuthStatus,
          RAuthAccounts,
          RAuthLogin,
          RAuthLogout
        >,
        AideAuthProviderCapability
      >[] = [];
      const pluginCount = denseOwnArrayLength(this.#plugins);
      for (let index = 0; index < pluginCount; index += 1) {
        const plugin = denseOwnArrayValue<
          PluginRegistrationSnapshot<
            RAuth,
            RAuthStatus,
            RAuthAccounts,
            RAuthLogin,
            RAuthLogout,
            RPrimeStatus,
            RPullRequestAuthStatus
          >
        >(this.#plugins, index);
        const capability = plugin.capabilities?.authProvider;
        if (capability === undefined) continue;
        appendHostArray(
          entries,
          plugin.provenance === 'trusted'
            ? ownedPluginCapability(plugin.id, 'trusted', capability)
            : ownedPluginCapability(plugin.id, 'external', capability)
        );
      }
      return Object.freeze(entries);
    },
    trustedAuthProviders: (): readonly TrustedOwnedPluginCapability<
      AideInternalAuthProviderCapability<
        RAuthStatus,
        RAuthAccounts,
        RAuthLogin,
        RAuthLogout
      >
    >[] => {
      const providers = this.capabilities.authProviders();
      const trusted: TrustedOwnedPluginCapability<
        AideInternalAuthProviderCapability<
          RAuthStatus,
          RAuthAccounts,
          RAuthLogin,
          RAuthLogout
        >
      >[] = [];
      const providerCount = denseOwnArrayLength(providers);
      for (let index = 0; index < providerCount; index += 1) {
        const provider = denseOwnArrayValue<
          OwnedPluginCapability<
            AideInternalAuthProviderCapability<
              RAuthStatus,
              RAuthAccounts,
              RAuthLogin,
              RAuthLogout
            >,
            AideAuthProviderCapability
          >
        >(providers, index);
        if (isTrustedOwnedPluginCapability(provider)) {
          appendHostArray(trusted, provider);
        }
      }
      return Object.freeze(trusted);
    },
    primeContributions: (): readonly OwnedPluginCapability<
      AidePrimeContributionCapability<RPrimeStatus>,
      AidePrimeContributionCapability
    >[] => {
      const entries: OwnedPluginCapability<
        AidePrimeContributionCapability<RPrimeStatus>,
        AidePrimeContributionCapability
      >[] = [];
      const pluginCount = denseOwnArrayLength(this.#plugins);
      for (let index = 0; index < pluginCount; index += 1) {
        const plugin = denseOwnArrayValue<
          PluginRegistrationSnapshot<
            RAuth,
            RAuthStatus,
            RAuthAccounts,
            RAuthLogin,
            RAuthLogout,
            RPrimeStatus,
            RPullRequestAuthStatus
          >
        >(this.#plugins, index);
        const capability = plugin.capabilities?.primeContribution;
        if (capability === undefined) continue;
        appendHostArray(
          entries,
          plugin.provenance === 'trusted'
            ? ownedPluginCapability(plugin.id, 'trusted', capability)
            : ownedPluginCapability(plugin.id, 'external', capability)
        );
      }
      return Object.freeze(entries);
    },
    trustedPrimeContributions: (): readonly TrustedOwnedPluginCapability<
      AidePrimeContributionCapability<RPrimeStatus>
    >[] => {
      const contributions = this.capabilities.primeContributions();
      const trusted: TrustedOwnedPluginCapability<
        AidePrimeContributionCapability<RPrimeStatus>
      >[] = [];
      const contributionCount = denseOwnArrayLength(contributions);
      for (let index = 0; index < contributionCount; index += 1) {
        const contribution = denseOwnArrayValue<
          OwnedPluginCapability<
            AidePrimeContributionCapability<RPrimeStatus>,
            AidePrimeContributionCapability
          >
        >(contributions, index);
        if (isTrustedOwnedPluginCapability(contribution)) {
          appendHostArray(trusted, contribution);
        }
      }
      return Object.freeze(trusted);
    },
    pullRequestProviders: (): readonly OwnedPluginCapability<
      AidePullRequestProviderCapability<RPullRequestAuthStatus>,
      AidePullRequestProviderCapability
    >[] => {
      const entries: OwnedPluginCapability<
        AidePullRequestProviderCapability<RPullRequestAuthStatus>,
        AidePullRequestProviderCapability
      >[] = [];
      const pluginCount = denseOwnArrayLength(this.#plugins);
      for (let index = 0; index < pluginCount; index += 1) {
        const plugin = denseOwnArrayValue<
          PluginRegistrationSnapshot<
            RAuth,
            RAuthStatus,
            RAuthAccounts,
            RAuthLogin,
            RAuthLogout,
            RPrimeStatus,
            RPullRequestAuthStatus
          >
        >(this.#plugins, index);
        const capability = plugin.capabilities?.pullRequestProvider;
        if (capability === undefined) continue;
        appendHostArray(
          entries,
          plugin.provenance === 'trusted'
            ? certifyBuiltinPullRequestProviderEntry(
                ownedPluginCapability(plugin.id, 'trusted', capability),
                capability
              )
            : ownedPluginCapability(plugin.id, 'external', capability)
        );
      }
      return Object.freeze(entries);
    },
  };

  registerModule<TBase extends object, TArgs extends object>(
    id: string,
    module: CommandModule<TBase, TArgs>,
    options: RegisterCommandOptions = {}
  ): this {
    assertId('Command', id);
    this.#assertAvailable(id);
    const retainedModule = eraseCommandModule(module);
    const keys = routeKeys(retainedModule.command);
    assertRouteKeys(id, keys);
    const acceptsChildren = commandAcceptsChildCommands(
      options.acceptsChildren,
      retainedModule.command
    );
    const entry = Object.freeze({
      kind: 'module' as const,
      id,
      parentId: options.parentId,
      acceptsChildren,
      extension: snapshotExtensionPolicy(options.extension),
      routeKeys: freezeRouteKeys(keys),
      module: retainedModule,
    });

    if (!acceptsChildren && entry.extension !== undefined) {
      this.#assertExtensionOnlyOnCommandGroup(id);
    }

    if (options.parentId === undefined) {
      this.#assertRoutesAvailable(id, keys);
      appendHostArray(this.#commands, entry);
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
    descriptor: PublicAideCommandDescriptor<TArgs, E, never>,
    options?: RegisterCommandOptions
  ): this;
  registerDescriptor<TArgs extends object, E = unknown>(
    descriptor: PublicAideCommandDescriptor<TArgs, E, AideHostServicesTag>,
    options?: RegisterCommandOptions
  ): this;
  registerDescriptor<TArgs extends object>(
    descriptor:
      | PublicAideCommandDescriptor<TArgs, unknown, never>
      | PublicAideCommandDescriptor<TArgs, unknown, AideHostServicesTag>,
    options: RegisterCommandOptions = {}
  ): this {
    assertId('Command', descriptor.id);
    this.#assertAvailable(descriptor.id);
    const retainedDescriptor = Object.freeze({
      id: descriptor.id,
      route: snapshotCommandRoute(descriptor.route),
      summary: descriptor.summary,
      yargs: descriptor.yargs,
      run: (args: ArgumentsCamelCase<object>) =>
        descriptor.run(args as ArgumentsCamelCase<TArgs>),
    });
    const keys = routeKeys(retainedDescriptor.route);
    assertRouteKeys(descriptor.id, keys);
    const acceptsChildren = commandAcceptsChildCommands(
      options.acceptsChildren,
      retainedDescriptor.route
    );
    const entry = Object.freeze({
      kind: 'descriptor' as const,
      id: descriptor.id,
      parentId: options.parentId,
      acceptsChildren,
      extension: snapshotExtensionPolicy(options.extension),
      routeKeys: freezeRouteKeys(keys),
      execution: 'public' as const,
      descriptor: retainedDescriptor,
    });

    if (!acceptsChildren && entry.extension !== undefined) {
      this.#assertExtensionOnlyOnCommandGroup(descriptor.id);
    }

    if (options.parentId === undefined) {
      this.#assertRoutesAvailable(descriptor.id, keys);
      appendHostArray(this.#commands, entry);
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
    const snapshot = assertExternalPluginBoundary(plugin, options);
    return this.#registerPlugin(
      publicPluginToTrustedDescriptor(snapshot),
      'external'
    );
  }

  /** Trusted in-process registration for built-in and local internal plugins. */
  registerPlugin(
    plugin:
      | AidePluginDescriptor<
          RAuth,
          RAuthStatus,
          RAuthAccounts,
          RAuthLogin,
          RAuthLogout,
          RPrimeStatus,
          RPullRequestAuthStatus
        >
      | PluginRegistrationSnapshot<
          RAuth,
          RAuthStatus,
          RAuthAccounts,
          RAuthLogin,
          RAuthLogout,
          RPrimeStatus,
          RPullRequestAuthStatus
        >
  ): this {
    if (isRegistryOwnedPluginSnapshot(plugin)) {
      return this.#registerPlugin(plugin, plugin.provenance);
    }
    if (isRecord(plugin) && 'provenance' in plugin) {
      throw new Error(
        'Plugin provenance is only accepted from a registry-owned plugin snapshot'
      );
    }
    return this.#registerPlugin(plugin, 'trusted');
  }

  #registerPlugin(
    plugin: AidePluginDescriptor<
      RAuth,
      RAuthStatus,
      RAuthAccounts,
      RAuthLogin,
      RAuthLogout,
      RPrimeStatus,
      RPullRequestAuthStatus
    >,
    provenance: PluginRegistrationProvenance
  ): this {
    const builtinPullRequestDiagnostic =
      provenance === 'trusted'
        ? hostOwnedBuiltinPullRequestDiagnostic(plugin)
        : undefined;
    assertId('Plugin', plugin.id);
    const snapshot =
      provenance === 'trusted'
        ? registryOwnedPluginSnapshot(plugin, 'trusted')
        : registryOwnedPluginSnapshot(
            plugin as AidePluginDescriptor,
            'external'
          );
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

    const commandIds: string[] = [];
    const seenCommandIds = new Set<string>();
    let duplicateCommandId: string | undefined;
    const commandCount = denseOwnArrayLength(snapshot.commands);
    for (let index = 0; index < commandCount; index += 1) {
      const command = denseOwnArrayValue<AidePluginCommand>(
        snapshot.commands,
        index
      );
      assertId('Command', command.id);
      defineHostArrayIndex(commandIds, index, command.id);
      if (seenCommandIds.has(command.id) && duplicateCommandId === undefined) {
        duplicateCommandId = command.id;
      }
      seenCommandIds.add(command.id);
    }
    if (duplicateCommandId !== undefined) {
      throw new Error(
        `Plugin '${snapshot.id}' declares command '${duplicateCommandId}' more than once`
      );
    }

    for (let index = 0; index < commandCount; index += 1) {
      this.#assertAvailable(denseOwnArrayValue<string>(commandIds, index));
    }

    const pluginCommandIds = hostSetFromArray(commandIds);
    assertPluginCommandParentGraphAcyclic(snapshot.id, snapshot.commands);
    const pluginCommandDepthById = pluginCommandDepths(snapshot.commands);
    const pluginGroupIds = new Set<string>();
    const pluginExtensionPolicies = new Map<
      string,
      AideCommandExtensionPolicy
    >();
    const commandRouteKeys = new Map<string, readonly string[]>();

    for (let index = 0; index < commandCount; index += 1) {
      const command = denseOwnArrayValue<AidePluginCommand>(
        snapshot.commands,
        index
      );
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

    for (let index = 0; index < commandCount; index += 1) {
      const command = denseOwnArrayValue<AidePluginCommand>(
        snapshot.commands,
        index
      );
      const keys = commandRouteKeys.get(command.id) ?? [];
      const keyCount = denseOwnArrayLength(keys);

      if (command.parentId === undefined) {
        for (let keyIndex = 0; keyIndex < keyCount; keyIndex += 1) {
          const key = denseOwnArrayValue<string>(keys, keyIndex);
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
      for (let keyIndex = 0; keyIndex < keyCount; keyIndex += 1) {
        const key = denseOwnArrayValue<string>(keys, keyIndex);
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

    const topLevelCommands: AidePluginCommand[] = [];
    const childCommands: AidePluginCommand[] = [];
    for (let index = 0; index < commandCount; index += 1) {
      const command = denseOwnArrayValue<AidePluginCommand>(
        snapshot.commands,
        index
      );
      if (command.parentId === undefined) {
        appendHostArray(topLevelCommands, command);
      }
    }
    for (let depth = 0; depth <= commandCount; depth += 1) {
      for (let index = 0; index < commandCount; index += 1) {
        const command = denseOwnArrayValue<AidePluginCommand>(
          snapshot.commands,
          index
        );
        if (
          command.parentId !== undefined &&
          (pluginCommandDepthById.get(command.id) ?? 0) === depth
        ) {
          appendHostArray(childCommands, command);
        }
      }
    }

    if (
      builtinPullRequestDiagnostic !== undefined &&
      pullRequestProvider !== undefined
    ) {
      certifiedBuiltinPullRequestProviderCapabilities.set(
        pullRequestProvider,
        builtinPullRequestDiagnostic
      );
    }
    appendHostArray(this.#plugins, snapshot);

    const topLevelCommandCount = denseOwnArrayLength(topLevelCommands);
    for (let index = 0; index < topLevelCommandCount; index += 1) {
      const command = denseOwnArrayValue<AidePluginCommand>(
        topLevelCommands,
        index
      );
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
          : command.execution === 'trusted'
            ? registeredTrustedCommand(command, {
                kind: 'descriptor' as const,
                id: command.id,
                pluginId: snapshot.id,
                acceptsChildren,
                extension: command.extension,
                routeKeys: freezeRouteKeys(resolvedKeys),
              })
            : Object.freeze({
                kind: 'descriptor' as const,
                id: command.id,
                pluginId: snapshot.id,
                acceptsChildren,
                extension: command.extension,
                routeKeys: freezeRouteKeys(resolvedKeys),
                execution: 'public' as const,
                descriptor: command.descriptor,
              });
      appendHostArray(this.#commands, entry);
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

    const childCommandCount = denseOwnArrayLength(childCommands);
    for (let index = 0; index < childCommandCount; index += 1) {
      const command = denseOwnArrayValue<AidePluginCommand>(
        childCommands,
        index
      );
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
          : command.execution === 'trusted'
            ? registeredTrustedCommand(command, {
                kind: 'descriptor' as const,
                id: command.id,
                pluginId: snapshot.id,
                parentId,
                acceptsChildren,
                extension: command.extension,
                routeKeys: freezeRouteKeys(resolvedKeys),
              })
            : Object.freeze({
                kind: 'descriptor' as const,
                id: command.id,
                pluginId: snapshot.id,
                parentId,
                acceptsChildren,
                extension: command.extension,
                routeKeys: freezeRouteKeys(resolvedKeys),
                execution: 'public' as const,
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
      const addressableNames = authProviderAddressableNames(authProvider);
      const addressableNameCount = denseOwnArrayLength(addressableNames);
      for (let index = 0; index < addressableNameCount; index += 1) {
        const name = denseOwnArrayValue<string>(addressableNames, index);
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
    return copyHostArray(this.#commands);
  }

  childCommands(parentId: string): readonly RegisteredCommand[] {
    return copyHostArray(this.#childCommands.get(parentId) ?? []);
  }

  childCommandIds(parentId: string): readonly string[] {
    const commands = this.childCommands(parentId);
    const ids: string[] = [];
    const commandCount = denseOwnArrayLength(commands);
    for (let index = 0; index < commandCount; index += 1) {
      defineHostArrayIndex(
        ids,
        index,
        denseOwnArrayValue<RegisteredCommand>(commands, index).id
      );
    }
    return ids;
  }

  entries(): readonly RegisteredCommand[] {
    const entries = copyHostArray(this.#commands);
    for (const commands of this.#childCommands.values()) {
      const commandCount = denseOwnArrayLength(commands);
      for (let index = 0; index < commandCount; index += 1) {
        appendHostArray(
          entries,
          denseOwnArrayValue<RegisteredCommand>(commands, index)
        );
      }
    }
    return entries;
  }

  commandIds(): readonly string[] {
    const ids: string[] = [];
    const commandCount = denseOwnArrayLength(this.#commands);
    for (let index = 0; index < commandCount; index += 1) {
      defineHostArrayIndex(
        ids,
        index,
        denseOwnArrayValue<RegisteredCommand>(this.#commands, index).id
      );
    }
    return ids;
  }

  allCommandIds(): readonly string[] {
    const entries = this.entries();
    const ids: string[] = [];
    const entryCount = denseOwnArrayLength(entries);
    for (let index = 0; index < entryCount; index += 1) {
      defineHostArrayIndex(
        ids,
        index,
        denseOwnArrayValue<RegisteredCommand>(entries, index).id
      );
    }
    return ids;
  }

  ids(): readonly string[] {
    return this.commandIds();
  }

  plugins(): readonly PluginRegistrationSnapshot<
    RAuth,
    RAuthStatus,
    RAuthAccounts,
    RAuthLogin,
    RAuthLogout,
    RPrimeStatus,
    RPullRequestAuthStatus
  >[] {
    return copyHostArray(this.#plugins);
  }

  pluginIds(): readonly string[] {
    const ids: string[] = [];
    const pluginCount = denseOwnArrayLength(this.#plugins);
    for (let index = 0; index < pluginCount; index += 1) {
      defineHostArrayIndex(
        ids,
        index,
        denseOwnArrayValue<
          PluginRegistrationSnapshot<
            RAuth,
            RAuthStatus,
            RAuthAccounts,
            RAuthLogin,
            RAuthLogout,
            RPrimeStatus,
            RPullRequestAuthStatus
          >
        >(this.#plugins, index).id
      );
    }
    return ids;
  }

  commandOwner(commandId: string): string | null {
    return this.#commandOwners.get(commandId) ?? null;
  }

  demandMessage(): string {
    const ids = this.ids();
    let joined = '';
    const idCount = denseOwnArrayLength(ids);
    for (let index = 0; index < idCount; index += 1) {
      if (index > 0) joined += ', ';
      joined += denseOwnArrayValue<string>(ids, index);
    }
    return `Please specify a command (${joined})`;
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
    provider: AideInternalAuthProviderCapability<
      RAuthStatus,
      RAuthAccounts,
      RAuthLogin,
      RAuthLogout
    >
  ): void {
    const names = authProviderAddressableNames(provider);
    const nameCount = denseOwnArrayLength(names);
    for (let index = 0; index < nameCount; index += 1) {
      const name = denseOwnArrayValue<string>(names, index);
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
    const keyCount = denseOwnArrayLength(keys);
    for (let index = 0; index < keyCount; index += 1) {
      const key = denseOwnArrayValue<string>(keys, index);
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
      hostArrayIncludes(policy.pluginIds, childPluginId)
    ) {
      return;
    }

    const routeKey =
      denseOwnArrayLength(routeKeys) === 0
        ? '<unknown>'
        : denseOwnArrayValue<string>(routeKeys, 0);
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
    const keyCount = denseOwnArrayLength(keys);
    for (let index = 0; index < keyCount; index += 1) {
      const key = denseOwnArrayValue<string>(keys, index);
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
    appendHostArray(commands, entry);
    this.#childCommands.set(parentId, commands);
  }

  #claimRoutes(commandId: string, keys: readonly string[]): void {
    const keyCount = denseOwnArrayLength(keys);
    for (let index = 0; index < keyCount; index += 1) {
      const key = denseOwnArrayValue<string>(keys, index);
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
    const keyCount = denseOwnArrayLength(keys);
    for (let index = 0; index < keyCount; index += 1) {
      const key = denseOwnArrayValue<string>(keys, index);
      routeOwners.set(key, commandId);
    }
  }
}

/** Trusted-only environment for built-in auth status/account discovery. */
export type TrustedAuthDiscoveryServices =
  | KeyringService
  | GitHubAuthCatalogService;

export type KeyringCommandRegistry = CommandRegistry<
  KeyringService,
  TrustedAuthDiscoveryServices,
  TrustedAuthDiscoveryServices,
  KeyringService,
  KeyringService,
  KeyringService,
  KeyringService
>;

export function createKeyringCommandRegistry(): KeyringCommandRegistry {
  return new CommandRegistry<
    KeyringService,
    TrustedAuthDiscoveryServices,
    TrustedAuthDiscoveryServices,
    KeyringService,
    KeyringService,
    KeyringService,
    KeyringService
  >();
}

export function createCommandRegistry<
  RAuth = never,
  RAuthStatus = never,
  RAuthAccounts = never,
  RAuthLogin = never,
  RAuthLogout = never,
  RPrimeStatus = never,
  RPullRequestAuthStatus = never,
>(): CommandRegistry<
  RAuth,
  RAuthStatus,
  RAuthAccounts,
  RAuthLogin,
  RAuthLogout,
  RPrimeStatus,
  RPullRequestAuthStatus
> {
  return new CommandRegistry<
    RAuth,
    RAuthStatus,
    RAuthAccounts,
    RAuthLogin,
    RAuthLogout,
    RPrimeStatus,
    RPullRequestAuthStatus
  >();
}
