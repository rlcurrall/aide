import { Data, Effect } from 'effect';
import { isProxy } from 'node:util/types';

import type { AidePrimeSection } from './plugin-descriptor.js';
import { invokePublicCapabilityEffect } from './public-capability-invocation.js';
import { defineHostArrayIndex, ownArrayLength } from './host-owned-array.js';

const arrayIsArray = Array.isArray;
const numberIsFinite = Number.isFinite;
const numberIsSafeInteger = Number.isSafeInteger;
const objectFreeze = Object.freeze;
const objectHasOwn = Object.hasOwn;
const reflectGetOwnPropertyDescriptor = Reflect.getOwnPropertyDescriptor;
const reflectOwnKeys = Reflect.ownKeys;

export type PrimeContributionFailureReason =
  | 'callback-threw'
  | 'non-effect-return'
  | 'effect-failed'
  | 'invalid-result';

export type PrimeContributionDiagnostic =
  | 'callback-must-return-effect'
  | 'effect-execution-invalid'
  | 'result-must-be-array'
  | 'result-length-unreadable'
  | 'result-too-large'
  | 'entry-missing'
  | 'entry-unreadable'
  | 'entry-must-be-object'
  | 'entry-id-invalid'
  | 'entry-body-invalid'
  | 'entry-order-invalid';

interface PrimeContributionErrorFields {
  readonly pluginId: string;
  readonly contribution: 'sections';
  readonly reason: PrimeContributionFailureReason;
  readonly diagnostic?: PrimeContributionDiagnostic;
  readonly entryIndex?: number;
}

const MAX_PRIME_SECTION_COUNT = 1_000;
const MAX_DIAGNOSTIC_PLUGIN_ID_LENGTH = 128;
const INVALID_DIAGNOSTIC_PLUGIN_ID = '<invalid-plugin>';

function isAsciiLetterOrDigit(codeUnit: number): boolean {
  return (
    (codeUnit >= 0x30 && codeUnit <= 0x39) ||
    (codeUnit >= 0x41 && codeUnit <= 0x5a) ||
    (codeUnit >= 0x61 && codeUnit <= 0x7a)
  );
}

function safePluginId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_DIAGNOSTIC_PLUGIN_ID_LENGTH
  ) {
    return INVALID_DIAGNOSTIC_PLUGIN_ID;
  }

  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    const isCanonicalCharacter =
      isAsciiLetterOrDigit(codeUnit) ||
      (index > 0 &&
        (codeUnit === 0x2d || codeUnit === 0x2e || codeUnit === 0x5f));
    if (!isCanonicalCharacter) return INVALID_DIAGNOSTIC_PLUGIN_ID;
  }
  return value;
}

function safeReason(value: unknown): PrimeContributionFailureReason {
  return value === 'callback-threw' ||
    value === 'non-effect-return' ||
    value === 'effect-failed' ||
    value === 'invalid-result'
    ? value
    : 'invalid-result';
}

function safeDiagnostic(
  value: unknown
): PrimeContributionDiagnostic | undefined {
  switch (value) {
    case 'callback-must-return-effect':
    case 'effect-execution-invalid':
    case 'result-must-be-array':
    case 'result-length-unreadable':
    case 'result-too-large':
    case 'entry-missing':
    case 'entry-unreadable':
    case 'entry-must-be-object':
    case 'entry-id-invalid':
    case 'entry-body-invalid':
    case 'entry-order-invalid':
      return value;
    default:
      return undefined;
  }
}

function safeEntryIndex(value: unknown): number | undefined {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value < MAX_PRIME_SECTION_COUNT
    ? value
    : undefined;
}

export class PrimeContributionError extends Data.TaggedError(
  'PrimeContributionError'
)<PrimeContributionErrorFields> {
  constructor(
    options: PrimeContributionErrorFields & {
      readonly detail?: unknown;
      readonly cause?: unknown;
    }
  ) {
    const diagnostic = safeDiagnostic(options.diagnostic);
    const entryIndex = safeEntryIndex(options.entryIndex);
    const fields: PrimeContributionErrorFields = {
      pluginId: safePluginId(options.pluginId),
      contribution: 'sections',
      reason: safeReason(options.reason),
      ...(diagnostic === undefined ? {} : { diagnostic }),
      ...(entryIndex === undefined ? {} : { entryIndex }),
    };
    super(fields);
    const diagnosticText =
      fields.diagnostic === undefined ? '' : `: ${fields.diagnostic}`;
    const entry =
      fields.entryIndex === undefined ? '' : ` at entry ${fields.entryIndex}`;
    Object.defineProperty(this, 'message', {
      configurable: true,
      value: `Prime sections contribution from plugin '${fields.pluginId}' failed (${fields.reason})${entry}${diagnosticText}`,
      writable: true,
    });
  }

  override get message(): string {
    const diagnostic =
      this.diagnostic === undefined ? '' : `: ${this.diagnostic}`;
    const entry =
      this.entryIndex === undefined ? '' : ` at entry ${this.entryIndex}`;
    return `Prime sections contribution from plugin '${this.pluginId}' failed (${this.reason})${entry}${diagnostic}`;
  }
}

function invalidPrimeSections(
  pluginId: string,
  diagnostic: PrimeContributionDiagnostic,
  entryIndex?: number
): PrimeContributionError {
  return new PrimeContributionError({
    pluginId,
    contribution: 'sections',
    reason: 'invalid-result',
    diagnostic,
    entryIndex,
  });
}

type PrimeSnapshotResult<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: PrimeContributionError };

function validSnapshot<A>(value: A): PrimeSnapshotResult<A> {
  return { ok: true, value };
}

function invalidSnapshot(
  pluginId: string,
  diagnostic: PrimeContributionDiagnostic,
  entryIndex?: number
): PrimeSnapshotResult<never> {
  return {
    ok: false,
    error: invalidPrimeSections(pluginId, diagnostic, entryIndex),
  };
}

function snapshotPrimeSection(
  pluginId: string,
  section: unknown,
  index: number
): PrimeSnapshotResult<AidePrimeSection> {
  if (typeof section !== 'object' || section === null) {
    return invalidSnapshot(pluginId, 'entry-must-be-object', index);
  }
  if (isProxy(section)) {
    return invalidSnapshot(pluginId, 'entry-unreadable', index);
  }

  const readField = (
    name: 'id' | 'body' | 'order'
  ):
    | { readonly kind: 'absent' }
    | { readonly kind: 'data'; readonly value: unknown }
    | { readonly kind: 'invalid' } => {
    try {
      const descriptor = reflectGetOwnPropertyDescriptor(section, name);
      if (descriptor === undefined) return { kind: 'absent' };
      return objectHasOwn(descriptor, 'value')
        ? { kind: 'data', value: descriptor.value }
        : { kind: 'invalid' };
    } catch {
      return { kind: 'invalid' };
    }
  };
  const idProperty = readField('id');
  const bodyProperty = readField('body');
  const orderProperty = readField('order');
  if (
    idProperty.kind === 'invalid' ||
    bodyProperty.kind === 'invalid' ||
    orderProperty.kind === 'invalid'
  ) {
    return invalidSnapshot(pluginId, 'entry-unreadable', index);
  }
  const id = idProperty.kind === 'data' ? idProperty.value : undefined;
  const body = bodyProperty.kind === 'data' ? bodyProperty.value : undefined;
  const order = orderProperty.kind === 'data' ? orderProperty.value : undefined;
  if (typeof id !== 'string' || id.trim() === '') {
    return invalidSnapshot(pluginId, 'entry-id-invalid', index);
  }
  if (typeof body !== 'string') {
    return invalidSnapshot(pluginId, 'entry-body-invalid', index);
  }
  if (
    order !== undefined &&
    (typeof order !== 'number' || !numberIsFinite(order))
  ) {
    return invalidSnapshot(pluginId, 'entry-order-invalid', index);
  }

  return validSnapshot(
    objectFreeze({
      id,
      body,
      ...(order === undefined ? {} : { order }),
    })
  );
}

function primeSectionsLength(
  pluginId: string,
  sections: unknown
): PrimeSnapshotResult<{
  readonly sections: readonly unknown[];
  readonly length: number;
}> {
  let isArray: boolean;
  try {
    isArray = arrayIsArray(sections);
  } catch {
    return invalidSnapshot(pluginId, 'result-must-be-array');
  }
  if (!isArray) {
    return invalidSnapshot(pluginId, 'result-must-be-array');
  }
  if (isProxy(sections)) {
    return invalidSnapshot(pluginId, 'result-length-unreadable');
  }

  let lengthDescriptor: PropertyDescriptor | undefined;
  try {
    lengthDescriptor = reflectGetOwnPropertyDescriptor(
      sections as object,
      'length'
    );
  } catch {
    return invalidSnapshot(pluginId, 'result-length-unreadable');
  }
  if (
    lengthDescriptor === undefined ||
    !objectHasOwn(lengthDescriptor, 'value')
  ) {
    return invalidSnapshot(pluginId, 'result-length-unreadable');
  }
  const length = lengthDescriptor.value;
  if (
    typeof length !== 'number' ||
    !numberIsSafeInteger(length) ||
    length < 0 ||
    length > MAX_PRIME_SECTION_COUNT
  ) {
    return invalidSnapshot(pluginId, 'result-too-large');
  }

  let keys: readonly PropertyKey[];
  try {
    keys = reflectOwnKeys(sections as object);
  } catch {
    return invalidSnapshot(pluginId, 'result-length-unreadable');
  }
  const keyCount = ownArrayLength(keys);
  if (keyCount === undefined) {
    return invalidSnapshot(pluginId, 'result-length-unreadable');
  }
  let lengthKeys = 0;
  for (let keyIndex = 0; keyIndex < keyCount; keyIndex += 1) {
    const keyDescriptor = reflectGetOwnPropertyDescriptor(
      keys,
      String(keyIndex)
    );
    if (keyDescriptor === undefined || !objectHasOwn(keyDescriptor, 'value')) {
      return invalidSnapshot(pluginId, 'result-length-unreadable');
    }
    const key = keyDescriptor.value;
    if (key === 'length') {
      lengthKeys += 1;
      continue;
    }
    if (typeof key !== 'string') {
      return invalidSnapshot(pluginId, 'result-length-unreadable');
    }
    const keyIndexValue = Number(key);
    if (
      !numberIsSafeInteger(keyIndexValue) ||
      keyIndexValue < 0 ||
      keyIndexValue >= length ||
      String(keyIndexValue) !== key
    ) {
      return invalidSnapshot(pluginId, 'result-length-unreadable');
    }
  }
  if (lengthKeys !== 1) {
    return invalidSnapshot(pluginId, 'result-length-unreadable');
  }
  return validSnapshot({ sections: sections as readonly unknown[], length });
}

function readOwnPrimeSection(
  pluginId: string,
  sections: readonly unknown[],
  index: number
): PrimeSnapshotResult<unknown> {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = reflectGetOwnPropertyDescriptor(sections, String(index));
  } catch {
    return invalidSnapshot(pluginId, 'entry-unreadable', index);
  }
  if (descriptor === undefined) {
    return invalidSnapshot(pluginId, 'entry-missing', index);
  }
  return objectHasOwn(descriptor, 'value')
    ? validSnapshot(descriptor.value)
    : invalidSnapshot(pluginId, 'entry-unreadable', index);
}

function snapshotPrimeSectionsResult(
  pluginId: string,
  sections: unknown
): PrimeSnapshotResult<readonly AidePrimeSection[]> {
  const input = primeSectionsLength(pluginId, sections);
  if (!input.ok) return input;
  const snapshots: AidePrimeSection[] = [];
  for (let index = 0; index < input.value.length; index += 1) {
    const section = readOwnPrimeSection(pluginId, input.value.sections, index);
    if (!section.ok) return section;
    const snapshot = snapshotPrimeSection(pluginId, section.value, index);
    if (!snapshot.ok) return snapshot;
    defineHostArrayIndex(snapshots, index, snapshot.value);
  }
  return validSnapshot(objectFreeze(snapshots));
}

export function snapshotPrimeSections(
  pluginId: string,
  sections: unknown
): readonly AidePrimeSection[] {
  const result = snapshotPrimeSectionsResult(pluginId, sections);
  if (!result.ok) throw result.error;
  return result.value;
}

/**
 * Prime command fallback policy: retain valid structural snapshots while
 * discarding malformed entries. Public host boundaries use the strict
 * snapshotPrimeSections contract instead.
 */
export function snapshotValidPrimeSections(
  pluginId: string,
  sections: unknown
): readonly AidePrimeSection[] {
  const input = primeSectionsLength(pluginId, sections);
  if (!input.ok) return objectFreeze([]);

  const snapshots: AidePrimeSection[] = [];
  for (let index = 0; index < input.value.length; index += 1) {
    const section = readOwnPrimeSection(pluginId, input.value.sections, index);
    if (!section.ok) continue;
    const snapshot = snapshotPrimeSection(pluginId, section.value, index);
    if (!snapshot.ok) continue;
    const snapshotIndex = ownArrayLength(snapshots);
    if (snapshotIndex === undefined) continue;
    defineHostArrayIndex(snapshots, snapshotIndex, snapshot.value);
  }
  return objectFreeze(snapshots);
}

export function invokePrimeSectionsCallback(
  pluginId: string,
  callback: () => Effect.Effect<readonly AidePrimeSection[], unknown, never>
): Effect.Effect<readonly AidePrimeSection[], PrimeContributionError, never> {
  return invokePublicCapabilityEffect<
    readonly AidePrimeSection[],
    unknown,
    readonly AidePrimeSection[],
    PrimeContributionError,
    PrimeContributionError
  >(
    callback,
    {
      onCallbackThrow: () =>
        new PrimeContributionError({
          pluginId,
          contribution: 'sections',
          reason: 'callback-threw',
        }),
      onInvalidReturn: () =>
        new PrimeContributionError({
          pluginId,
          contribution: 'sections',
          reason: 'non-effect-return',
          diagnostic: 'callback-must-return-effect',
        }),
      onCompositionFailure: () =>
        new PrimeContributionError({
          pluginId,
          contribution: 'sections',
          reason: 'non-effect-return',
          diagnostic: 'callback-must-return-effect',
        }),
      onLaunchFailure: () =>
        new PrimeContributionError({
          pluginId,
          contribution: 'sections',
          reason: 'invalid-result',
          diagnostic: 'effect-execution-invalid',
        }),
    },
    (effect) =>
      effect.pipe(
        Effect.mapError(
          () =>
            new PrimeContributionError({
              pluginId,
              contribution: 'sections',
              reason: 'effect-failed',
            })
        ),
        Effect.flatMap((sections) => {
          const snapshot = snapshotPrimeSectionsResult(pluginId, sections);
          return snapshot.ok
            ? Effect.succeed(snapshot.value)
            : Effect.fail(snapshot.error);
        })
      )
  );
}
