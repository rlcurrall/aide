import { isProxy } from 'node:util/types';

import { Cause, Context, Data, Effect, Layer } from 'effect';

import {
  canonicalizeGitHubAuthAccount,
  canonicalizeGitHubAuthHost,
  githubCliEnvironment,
  type GitHubAuthEnvironment,
} from './github-auth.js';

const MAX_STDOUT_BYTES = 262_144;
const MAX_HOST_BUCKETS = 1_000;
const MAX_ACCOUNT_RECORDS = 1_000;
const MAX_HOST_CODE_UNITS = 253;
const MAX_LOGIN_CODE_UNITS = 256;
const MAX_STATE_CODE_UNITS = 64;
const MAX_ERROR_CODE_UNITS = 1_024;
const EXECUTION_TIMEOUT = '5 seconds';
/** Bounds producer work even when stdout makes no byte progress. */
const MAX_ZERO_PROGRESS_READS = 64;
/** Bounds total callback/Promise work independently of the stdout byte cap. */
const MAX_STDOUT_CHUNK_READS = 4_096;

const nodeInspectCustom = Symbol.for('nodejs.util.inspect.custom');
const objectDefineProperties = Object.defineProperties;
const objectFreeze = Object.freeze;
const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const objectGetPrototypeOf = Object.getPrototypeOf;
const objectHasOwn = Object.hasOwn;
const promiseConstructor = Promise;
const promisePrototype = promiseConstructor.prototype;
const promiseThen = promisePrototype.then;
const promisePrototypeConstructorDescriptor = objectGetOwnPropertyDescriptor(
  promisePrototype,
  'constructor'
);
const promisePrototypeThenDescriptor = objectGetOwnPropertyDescriptor(
  promisePrototype,
  'then'
);
const promiseConstructorSpeciesDescriptor = objectGetOwnPropertyDescriptor(
  promiseConstructor,
  Symbol.species
);
const reflectApply = Reflect.apply;
const reflectDeleteProperty = Reflect.deleteProperty;
const reflectOwnKeys = Reflect.ownKeys;

const DOCUMENT_ERROR_NAME = 'GitHubAuthCatalogDocumentError';
const DOCUMENT_ERROR_MESSAGE =
  'The GitHub CLI auth catalog document is invalid.';
const UNAVAILABLE_ERROR_NAME = 'GitHubAuthCatalogUnavailableError';
const UNAVAILABLE_ERROR_MESSAGE = 'The GitHub CLI auth catalog is unavailable.';

export type GitHubAuthCatalogDocumentReason =
  | 'invalid-document'
  | 'output-too-large';

interface GitHubAuthCatalogDocumentErrorFields {
  readonly classification: 'document';
  readonly reason: GitHubAuthCatalogDocumentReason;
}

/** A fixed frozen diagnostic that never retains bytes or producer values. */
export class GitHubAuthCatalogDocumentError
  extends Error
  implements GitHubAuthCatalogDocumentErrorFields
{
  declare readonly _tag: 'GitHubAuthCatalogDocumentError';
  declare readonly classification: 'document';
  declare readonly reason: GitHubAuthCatalogDocumentReason;

  constructor(reason: GitHubAuthCatalogDocumentReason = 'invalid-document') {
    super(DOCUMENT_ERROR_MESSAGE);
    const fixedReason =
      reason === 'invalid-document' || reason === 'output-too-large'
        ? reason
        : 'invalid-document';
    initializeFixedError(this, {
      name: DOCUMENT_ERROR_NAME,
      message: DOCUMENT_ERROR_MESSAGE,
      tag: DOCUMENT_ERROR_NAME,
      classification: 'document',
      reason: fixedReason,
    });
  }
}

export type GitHubAuthCatalogUnavailableReason =
  | 'spawn-failed'
  | 'command-failed'
  | 'timeout';

interface GitHubAuthCatalogUnavailableErrorFields {
  readonly classification: 'unavailable';
  readonly reason: GitHubAuthCatalogUnavailableReason;
}

/** A fixed frozen diagnostic that never retains subprocess or backend data. */
export class GitHubAuthCatalogUnavailableError
  extends Error
  implements GitHubAuthCatalogUnavailableErrorFields
{
  declare readonly _tag: 'GitHubAuthCatalogUnavailableError';
  declare readonly classification: 'unavailable';
  declare readonly reason: GitHubAuthCatalogUnavailableReason;

  constructor(reason: GitHubAuthCatalogUnavailableReason) {
    super(UNAVAILABLE_ERROR_MESSAGE);
    const fixedReason =
      reason === 'spawn-failed' ||
      reason === 'command-failed' ||
      reason === 'timeout'
        ? reason
        : 'spawn-failed';
    initializeFixedError(this, {
      name: UNAVAILABLE_ERROR_NAME,
      message: UNAVAILABLE_ERROR_MESSAGE,
      tag: UNAVAILABLE_ERROR_NAME,
      classification: 'unavailable',
      reason: fixedReason,
    });
  }
}

interface FixedErrorDefinition {
  readonly name: string;
  readonly message: string;
  readonly tag: string;
  readonly classification: string;
  readonly reason: string;
}

function initializeFixedError(
  error: Error,
  definition: FixedErrorDefinition
): void {
  for (const key of reflectOwnKeys(error)) reflectDeleteProperty(error, key);
  const rendered = `${definition.name}: ${definition.message}`;
  objectDefineProperties(error, {
    name: { value: definition.name },
    message: { value: definition.message },
    _tag: { enumerable: true, value: definition.tag },
    classification: { enumerable: true, value: definition.classification },
    reason: { enumerable: true, value: definition.reason },
    stack: { value: rendered },
  });
  objectFreeze(error);
}

function installFixedErrorClass(
  errorClass: { readonly prototype: object },
  definition: Omit<FixedErrorDefinition, 'reason'>,
  validReasons: ReadonlySet<string>,
  fallbackReason: string
): void {
  const rendered = `${definition.name}: ${definition.message}`;
  objectDefineProperties(errorClass.prototype, {
    toJSON: {
      value: function (this: object) {
        const candidate = ownDataProperty(this, 'reason');
        const reason =
          candidate.kind === 'data' &&
          typeof candidate.value === 'string' &&
          validReasons.has(candidate.value)
            ? candidate.value
            : fallbackReason;
        return objectFreeze({
          name: definition.name,
          message: definition.message,
          _tag: definition.tag,
          classification: definition.classification,
          reason,
        });
      },
    },
    [nodeInspectCustom]: { value: () => rendered },
    toString: { value: () => rendered },
    [Symbol.toPrimitive]: { value: () => rendered },
  });
  objectFreeze(errorClass.prototype);
  objectFreeze(errorClass);
}

installFixedErrorClass(
  GitHubAuthCatalogDocumentError,
  {
    name: DOCUMENT_ERROR_NAME,
    message: DOCUMENT_ERROR_MESSAGE,
    tag: DOCUMENT_ERROR_NAME,
    classification: 'document',
  },
  new Set<GitHubAuthCatalogDocumentReason>([
    'invalid-document',
    'output-too-large',
  ]),
  'invalid-document'
);
installFixedErrorClass(
  GitHubAuthCatalogUnavailableError,
  {
    name: UNAVAILABLE_ERROR_NAME,
    message: UNAVAILABLE_ERROR_MESSAGE,
    tag: UNAVAILABLE_ERROR_NAME,
    classification: 'unavailable',
  },
  new Set<GitHubAuthCatalogUnavailableReason>([
    'spawn-failed',
    'command-failed',
    'timeout',
  ]),
  'spawn-failed'
);

export interface GitHubAuthCatalogIdentity {
  readonly host: string;
  readonly account: string;
}

export interface GitHubAuthCatalogResult {
  readonly identities: readonly GitHubAuthCatalogIdentity[];
  readonly hasUnhealthyActiveIdentity: boolean;
}

export type GitHubAuthCatalogExecutionResult =
  | { readonly kind: 'absent' }
  | {
      readonly kind: 'completed';
      readonly exitCode: number;
      readonly stdout: Uint8Array;
    };

export type GitHubAuthCatalogFailure =
  | GitHubAuthCatalogDocumentError
  | GitHubAuthCatalogUnavailableError;

export type GitHubAuthCatalogExecutor = () => Effect.Effect<
  GitHubAuthCatalogExecutionResult,
  GitHubAuthCatalogFailure
>;

export interface GitHubAuthCatalogChild {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  readonly exitCode: number | null;
  readonly kill: () => void;
}

export interface GitHubAuthCatalogSpawnOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdin: 'ignore';
  readonly stdout: 'pipe';
  readonly stderr: 'ignore';
}

export type GitHubAuthCatalogSpawn = (
  argv: readonly string[],
  options: GitHubAuthCatalogSpawnOptions
) => GitHubAuthCatalogChild;

export interface GitHubAuthCatalogExecutorOptions {
  readonly spawn?: GitHubAuthCatalogSpawn;
  readonly environment?: GitHubAuthEnvironment;
}

type OwnDataProperty =
  | { readonly kind: 'absent' }
  | { readonly kind: 'data'; readonly value: unknown }
  | { readonly kind: 'invalid' };

function ownDataProperty(value: object, key: PropertyKey): OwnDataProperty {
  try {
    const descriptor = objectGetOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) return { kind: 'absent' };
    return objectHasOwn(descriptor, 'value')
      ? { kind: 'data', value: descriptor.value }
      : { kind: 'invalid' };
  } catch {
    return { kind: 'invalid' };
  }
}

function isObject(value: unknown): value is object {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !isProxy(value)
  );
}

function isWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const trailing = value.charCodeAt(index + 1);
      if (trailing < 0xdc00 || trailing > 0xdfff) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

const unsafeFormatCodePoint = /\p{Format}/u;
const unsafeDefaultIgnorableCodePoint = /\p{Default_Ignorable_Code_Point}/u;
const unsafeNoncharacterCodePoint = /\p{Noncharacter_Code_Point}/u;

function hasUnsafeCodePoint(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint === undefined ||
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x2028 ||
      codePoint === 0x2029 ||
      unsafeFormatCodePoint.test(character) ||
      unsafeDefaultIgnorableCodePoint.test(character) ||
      unsafeNoncharacterCodePoint.test(character)
    ) {
      return true;
    }
  }
  return false;
}

function isSafeText(
  value: string,
  maximumCodeUnits: number,
  allowEmpty = true
): boolean {
  return (
    (allowEmpty || value.length > 0) &&
    value.length <= maximumCodeUnits &&
    isWellFormedUtf16(value) &&
    !hasUnsafeCodePoint(value)
  );
}

function identity(host: string, account: string): GitHubAuthCatalogIdentity {
  return objectFreeze({ host, account });
}

function result(
  identities: GitHubAuthCatalogIdentity[],
  hasUnhealthyActiveIdentity: boolean
): GitHubAuthCatalogResult {
  identities.sort((left, right) =>
    left.host < right.host
      ? -1
      : left.host > right.host
        ? 1
        : left.account < right.account
          ? -1
          : left.account > right.account
            ? 1
            : 0
  );
  return objectFreeze({
    identities: objectFreeze(identities),
    hasUnhealthyActiveIdentity,
  });
}

function invalidDocument(): never {
  throw new GitHubAuthCatalogDocumentError('invalid-document');
}

function requiredRecordField(record: object, key: string): unknown {
  const property = ownDataProperty(record, key);
  return property.kind === 'data' ? property.value : invalidDocument();
}

function validateGitHubAuthCatalogDocument(
  document: unknown
): GitHubAuthCatalogResult {
  if (!isObject(document)) return invalidDocument();
  const hostsProperty = ownDataProperty(document, 'hosts');
  if (hostsProperty.kind !== 'data' || !isObject(hostsProperty.value)) {
    return invalidDocument();
  }

  let hostKeys: readonly PropertyKey[];
  try {
    hostKeys = reflectOwnKeys(hostsProperty.value);
  } catch {
    return invalidDocument();
  }
  if (hostKeys.length > MAX_HOST_BUCKETS) return invalidDocument();

  let totalRecords = 0;
  let hasUnhealthyActiveIdentity = false;
  const identities: GitHubAuthCatalogIdentity[] = [];

  for (const hostKey of hostKeys) {
    if (
      typeof hostKey !== 'string' ||
      !isSafeText(hostKey, MAX_HOST_CODE_UNITS, false) ||
      canonicalizeGitHubAuthHost(hostKey) !== hostKey
    ) {
      return invalidDocument();
    }

    const bucketProperty = ownDataProperty(hostsProperty.value, hostKey);
    if (
      bucketProperty.kind !== 'data' ||
      !Array.isArray(bucketProperty.value) ||
      isProxy(bucketProperty.value)
    ) {
      return invalidDocument();
    }
    const bucket = bucketProperty.value;
    totalRecords += bucket.length;
    if (
      !Number.isSafeInteger(bucket.length) ||
      totalRecords > MAX_ACCOUNT_RECORDS
    ) {
      return invalidDocument();
    }

    let healthyActiveCount = 0;
    for (let index = 0; index < bucket.length; index += 1) {
      const recordProperty = ownDataProperty(bucket, String(index));
      if (recordProperty.kind !== 'data' || !isObject(recordProperty.value)) {
        return invalidDocument();
      }
      const accountRecord = recordProperty.value;
      const active = requiredRecordField(accountRecord, 'active');
      const recordHost = requiredRecordField(accountRecord, 'host');
      const rawLogin = requiredRecordField(accountRecord, 'login');
      const state = requiredRecordField(accountRecord, 'state');
      const errorProperty = ownDataProperty(accountRecord, 'error');
      if (
        typeof active !== 'boolean' ||
        typeof recordHost !== 'string' ||
        typeof rawLogin !== 'string' ||
        typeof state !== 'string' ||
        errorProperty.kind === 'invalid' ||
        (errorProperty.kind === 'data' &&
          typeof errorProperty.value !== 'string') ||
        recordHost !== hostKey ||
        !isSafeText(recordHost, MAX_HOST_CODE_UNITS, false) ||
        canonicalizeGitHubAuthHost(recordHost) !== recordHost ||
        !isSafeText(rawLogin, MAX_STDOUT_BYTES, false) ||
        !isSafeText(state, MAX_STATE_CODE_UNITS)
      ) {
        return invalidDocument();
      }
      const error: string | undefined =
        errorProperty.kind === 'data'
          ? (errorProperty.value as string)
          : undefined;
      if (
        error !== undefined &&
        !isSafeText(error as string, MAX_ERROR_CODE_UNITS)
      ) {
        return invalidDocument();
      }

      let account: string | null;
      try {
        account = canonicalizeGitHubAuthAccount(rawLogin);
      } catch {
        return invalidDocument();
      }
      if (
        account === null ||
        !isSafeText(account, MAX_LOGIN_CODE_UNITS, false)
      ) {
        return invalidDocument();
      }

      if (!active) continue;
      if (state === 'success' && (error === undefined || error.length === 0)) {
        healthyActiveCount += 1;
        if (healthyActiveCount > 1) return invalidDocument();
        identities.push(identity(hostKey, account));
      } else {
        hasUnhealthyActiveIdentity = true;
      }
    }
  }

  return result(identities, hasUnhealthyActiveIdentity);
}

export function parseGitHubAuthCatalogDocument(
  document: unknown
): Effect.Effect<GitHubAuthCatalogResult, GitHubAuthCatalogDocumentError> {
  return Effect.try({
    try: () => validateGitHubAuthCatalogDocument(document),
    catch: () => new GitHubAuthCatalogDocumentError('invalid-document'),
  });
}

export function parseGitHubAuthCatalogOutput(
  stdout: Uint8Array
): Effect.Effect<GitHubAuthCatalogResult, GitHubAuthCatalogDocumentError> {
  if (!(stdout instanceof Uint8Array) || stdout.byteLength > MAX_STDOUT_BYTES) {
    return Effect.fail(
      new GitHubAuthCatalogDocumentError(
        stdout instanceof Uint8Array && stdout.byteLength > MAX_STDOUT_BYTES
          ? 'output-too-large'
          : 'invalid-document'
      )
    );
  }
  return Effect.flatMap(
    Effect.try({
      try: () => {
        const decoded = new TextDecoder('utf-8', { fatal: true }).decode(
          stdout
        );
        return JSON.parse(decoded) as unknown;
      },
      catch: () => new GitHubAuthCatalogDocumentError('invalid-document'),
    }),
    parseGitHubAuthCatalogDocument
  );
}

function isEnoent(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || isProxy(error))
    return false;
  const code = ownDataProperty(error, 'code');
  return code.kind === 'data' && code.value === 'ENOENT';
}

function descriptorsMatch(
  current: PropertyDescriptor | undefined,
  captured: PropertyDescriptor | undefined
): boolean {
  if (current === undefined || captured === undefined) {
    return current === captured;
  }
  if (
    current.configurable !== captured.configurable ||
    current.enumerable !== captured.enumerable
  ) {
    return false;
  }
  const currentIsData = objectHasOwn(current, 'value');
  const capturedIsData = objectHasOwn(captured, 'value');
  if (currentIsData !== capturedIsData) return false;
  return currentIsData
    ? current.value === captured.value && current.writable === captured.writable
    : current.get === captured.get && current.set === captured.set;
}

function capturedPromiseIntrinsicsAreIntact(): boolean {
  try {
    return (
      descriptorsMatch(
        objectGetOwnPropertyDescriptor(promisePrototype, 'constructor'),
        promisePrototypeConstructorDescriptor
      ) &&
      descriptorsMatch(
        objectGetOwnPropertyDescriptor(promisePrototype, 'then'),
        promisePrototypeThenDescriptor
      ) &&
      descriptorsMatch(
        objectGetOwnPropertyDescriptor(promiseConstructor, Symbol.species),
        promiseConstructorSpeciesDescriptor
      )
    );
  } catch {
    return false;
  }
}

/** Accepts only Bun's exact unmodified same-realm native Promise contract. */
function isExactNativePromise(value: unknown): value is Promise<unknown> {
  if (typeof value !== 'object' || value === null || isProxy(value)) {
    return false;
  }
  try {
    if (
      objectGetPrototypeOf(value) !== promisePrototype ||
      !capturedPromiseIntrinsicsAreIntact()
    ) {
      return false;
    }
    // These descriptor reads never invoke a producer constructor or then.
    if (
      ownDataProperty(value, 'constructor').kind !== 'absent' ||
      ownDataProperty(value, 'then').kind !== 'absent'
    ) {
      return false;
    }
    return reflectOwnKeys(value).length === 0;
  } catch {
    return false;
  }
}

function attachPromise<A>(
  promise: Promise<A>,
  onFulfilled: (value: A) => void,
  onRejected: (error: unknown) => void
): boolean {
  if (!isExactNativePromise(promise)) return false;
  try {
    reflectApply(promiseThen, promise, [onFulfilled, onRejected]);
    return true;
  } catch {
    return false;
  }
}

function transformPromise<A, B>(
  promise: Promise<A>,
  onFulfilled: (value: A) => B,
  onRejected: (error: unknown) => B
): Promise<B> {
  return reflectApply(promiseThen, promise, [
    onFulfilled,
    onRejected,
  ]) as Promise<B>;
}

function awaitPromise<A, E>(
  promise: Promise<A>,
  onReject: (error: unknown) => E
): Effect.Effect<A, E> {
  return Effect.async<A, E>((resume) => {
    let active = true;
    const attached = attachPromise(
      promise,
      (value) => {
        if (!active) return;
        active = false;
        resume(Effect.succeed(value));
      },
      (error) => {
        if (!active) return;
        active = false;
        resume(Effect.fail(onReject(error)));
      }
    );
    if (!attached) {
      active = false;
      resume(Effect.fail(onReject(undefined)));
      return;
    }
    return Effect.sync(() => {
      active = false;
    });
  });
}

function awaitPromiseIgnoringFailure(promise: unknown): Effect.Effect<void> {
  if (!isExactNativePromise(promise)) return Effect.void;
  return Effect.async<void>((resume) => {
    let active = true;
    const complete = () => {
      if (!active) return;
      active = false;
      resume(Effect.void);
    };
    if (!attachPromise(promise, complete, complete)) {
      active = false;
      resume(Effect.void);
      return;
    }
    return Effect.sync(() => {
      active = false;
    });
  });
}

type GitHubAuthCatalogReadResult =
  | { readonly done: false; readonly value: Uint8Array }
  | { readonly done: true; readonly value?: undefined };

interface GitHubAuthCatalogReader {
  readonly read: () => Promise<GitHubAuthCatalogReadResult>;
  readonly cancel: () => Promise<void>;
  readonly releaseLock: () => void;
}

interface ReaderState {
  readonly reader: GitHubAuthCatalogReader;
  readonly pendingReads: Set<Promise<GitHubAuthCatalogReadResult>>;
  done: boolean;
}

interface StdoutAccumulator {
  readonly bytes: Uint8Array;
  byteLength: number;
  chunkReads: number;
  zeroProgressReads: number;
}

function readFromReader(
  state: ReaderState
): Effect.Effect<
  GitHubAuthCatalogReadResult,
  GitHubAuthCatalogUnavailableError
> {
  return Effect.suspend(() => {
    let pending: Promise<GitHubAuthCatalogReadResult>;
    try {
      pending = state.reader.read();
      if (!isExactNativePromise(pending)) throw new Error();
    } catch {
      return Effect.fail(new GitHubAuthCatalogUnavailableError('spawn-failed'));
    }
    state.pendingReads.add(pending);
    if (
      !attachPromise(
        pending,
        () => state.pendingReads.delete(pending),
        () => state.pendingReads.delete(pending)
      )
    ) {
      state.pendingReads.delete(pending);
      return Effect.fail(new GitHubAuthCatalogUnavailableError('spawn-failed'));
    }
    return awaitPromise(
      pending,
      () => new GitHubAuthCatalogUnavailableError('spawn-failed')
    );
  });
}

function readAllStdout(
  state: ReaderState,
  accumulator: StdoutAccumulator = {
    bytes: new Uint8Array(MAX_STDOUT_BYTES),
    byteLength: 0,
    chunkReads: 0,
    zeroProgressReads: 0,
  }
): Effect.Effect<
  Uint8Array,
  GitHubAuthCatalogDocumentError | GitHubAuthCatalogUnavailableError
> {
  return Effect.flatMap(readFromReader(state), (read) => {
    if (read.done) {
      state.done = true;
      const output = new Uint8Array(accumulator.byteLength);
      output.set(accumulator.bytes.subarray(0, accumulator.byteLength));
      return Effect.succeed(output);
    }
    if (isProxy(read.value) || !(read.value instanceof Uint8Array)) {
      return Effect.fail(new GitHubAuthCatalogUnavailableError('spawn-failed'));
    }
    accumulator.chunkReads += 1;
    if (accumulator.chunkReads > MAX_STDOUT_CHUNK_READS) {
      return Effect.fail(
        new GitHubAuthCatalogDocumentError('invalid-document')
      );
    }
    if (read.value.byteLength === 0) {
      accumulator.zeroProgressReads += 1;
      if (accumulator.zeroProgressReads > MAX_ZERO_PROGRESS_READS) {
        return Effect.fail(
          new GitHubAuthCatalogDocumentError('invalid-document')
        );
      }
    }
    const nextByteLength = accumulator.byteLength + read.value.byteLength;
    if (nextByteLength > MAX_STDOUT_BYTES) {
      return Effect.fail(
        new GitHubAuthCatalogDocumentError('output-too-large')
      );
    }
    accumulator.bytes.set(read.value, accumulator.byteLength);
    accumulator.byteLength = nextByteLength;
    return readAllStdout(state, accumulator);
  });
}

function releaseReader(state: ReaderState): Effect.Effect<void> {
  return Effect.suspend(() => {
    let cancellation: Promise<unknown> | undefined;
    if (!state.done) {
      try {
        cancellation = state.reader.cancel();
      } catch {
        cancellation = undefined;
      }
    }
    const pending = Array.from(state.pendingReads);
    const joinCancellation =
      cancellation === undefined
        ? Effect.void
        : awaitPromiseIgnoringFailure(cancellation);
    return Effect.zipRight(
      joinCancellation,
      Effect.forEach(pending, awaitPromiseIgnoringFailure, {
        concurrency: 1,
        discard: true,
      })
    ).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          try {
            state.reader.releaseLock();
          } catch {
            // A failed lock release has no safe producer diagnostic to retain.
          }
        })
      )
    );
  });
}

function readStdout(
  stdout: ReadableStream<Uint8Array>
): Effect.Effect<
  Uint8Array,
  GitHubAuthCatalogDocumentError | GitHubAuthCatalogUnavailableError
> {
  return Effect.acquireUseRelease(
    Effect.try({
      try: (): ReaderState => ({
        reader: stdout.getReader() as unknown as GitHubAuthCatalogReader,
        pendingReads: new Set(),
        done: false,
      }),
      catch: () => new GitHubAuthCatalogUnavailableError('spawn-failed'),
    }),
    (state) => readAllStdout(state),
    releaseReader
  );
}

type ChildSettlement =
  | { readonly kind: 'exited'; readonly exitCode: number }
  | { readonly kind: 'missing' }
  | { readonly kind: 'failed' };

interface ChildState {
  readonly child: GitHubAuthCatalogChild;
  settlement: Promise<unknown> | undefined;
  settled: boolean;
  killAttempted: boolean;
}

type AcquiredProcess =
  | { readonly kind: 'missing' }
  | { readonly kind: 'child'; readonly state: ChildState };

class ExecutableMissingSignal extends Data.TaggedError(
  'ExecutableMissingSignal'
)<{}> {}

function acquiredChild(child: GitHubAuthCatalogChild): AcquiredProcess {
  return {
    kind: 'child',
    state: {
      child,
      settlement: undefined,
      settled: false,
      killAttempted: false,
    },
  };
}

function acquireProcess(
  spawn: GitHubAuthCatalogSpawn,
  environment: GitHubAuthEnvironment
): Effect.Effect<AcquiredProcess, GitHubAuthCatalogUnavailableError> {
  return Effect.try({
    try: () => {
      try {
        const child = spawn(
          ['gh', 'auth', 'status', '--json', 'hosts'],
          objectFreeze({
            env: githubCliEnvironment(environment),
            stdin: 'ignore' as const,
            stdout: 'pipe' as const,
            stderr: 'ignore' as const,
          })
        );
        // No child property is observed until acquireUseRelease owns this state.
        return acquiredChild(child);
      } catch (error) {
        if (isEnoent(error)) return { kind: 'missing' as const };
        throw error;
      }
    },
    catch: () => new GitHubAuthCatalogUnavailableError('spawn-failed'),
  });
}

interface InitializedChild {
  readonly state: ChildState;
  readonly settlement: Promise<ChildSettlement>;
  readonly stdout: ReadableStream<Uint8Array>;
}

function initializeChild(
  state: ChildState
): Effect.Effect<InitializedChild, GitHubAuthCatalogUnavailableError> {
  return Effect.try({
    try: () => {
      const exited = state.child.exited;
      if (!isExactNativePromise(exited)) throw new Error();
      // Install the original join handle before registration or stdout access.
      state.settlement = exited;
      const settlement = transformPromise<number, ChildSettlement>(
        exited,
        (exitCode) => {
          state.settled = true;
          return Number.isSafeInteger(exitCode) && exitCode >= 0
            ? { kind: 'exited', exitCode }
            : { kind: 'failed' };
        },
        (error) => {
          state.settled = true;
          return isEnoent(error) ? { kind: 'missing' } : { kind: 'failed' };
        }
      );
      if (!isExactNativePromise(settlement)) throw new Error();
      const stdout = state.child.stdout;
      return { state, settlement, stdout };
    },
    catch: () => new GitHubAuthCatalogUnavailableError('spawn-failed'),
  });
}

function awaitSettlement(
  settlement: Promise<ChildSettlement>
): Effect.Effect<
  number,
  ExecutableMissingSignal | GitHubAuthCatalogUnavailableError
> {
  return Effect.flatMap(
    awaitPromise(
      settlement,
      () => new GitHubAuthCatalogUnavailableError('spawn-failed')
    ),
    (
      settlement
    ): Effect.Effect<
      number,
      ExecutableMissingSignal | GitHubAuthCatalogUnavailableError
    > => {
      switch (settlement.kind) {
        case 'exited':
          return Effect.succeed(settlement.exitCode);
        case 'missing':
          return Effect.fail(new ExecutableMissingSignal());
        case 'failed':
          return Effect.fail(
            new GitHubAuthCatalogUnavailableError('spawn-failed')
          );
      }
    }
  );
}

function releaseProcess(state: ChildState): Effect.Effect<void> {
  return Effect.suspend(() => {
    let alreadyExited = state.settled;
    if (!alreadyExited && state.settlement !== undefined) {
      try {
        const exitCode = state.child.exitCode;
        alreadyExited =
          typeof exitCode === 'number' &&
          Number.isSafeInteger(exitCode) &&
          exitCode >= 0;
      } catch {
        alreadyExited = false;
      }
    }
    if (!alreadyExited && !state.killAttempted) {
      state.killAttempted = true;
      try {
        const kill = state.child.kill;
        if (typeof kill === 'function') reflectApply(kill, state.child, []);
      } catch {
        // The fixed result remains unavailable; no child diagnostic is retained.
      }
    }
    return state.settlement === undefined
      ? Effect.void
      : awaitPromiseIgnoringFailure(state.settlement);
  });
}

function executeAcquiredProcess(
  acquired: AcquiredProcess
): Effect.Effect<
  GitHubAuthCatalogExecutionResult,
  | ExecutableMissingSignal
  | GitHubAuthCatalogDocumentError
  | GitHubAuthCatalogUnavailableError
> {
  if (acquired.kind === 'missing') {
    return Effect.succeed(objectFreeze({ kind: 'absent' as const }));
  }
  const state = acquired.state;
  return Effect.flatMap(initializeChild(state), (initialized) =>
    Effect.map(
      Effect.all(
        [
          readStdout(initialized.stdout),
          awaitSettlement(initialized.settlement),
        ],
        {
          concurrency: 2,
        }
      ),
      ([stdout, exitCode]) =>
        objectFreeze({ kind: 'completed' as const, exitCode, stdout })
    )
  );
}

function defaultSpawn(
  argv: readonly string[],
  options: GitHubAuthCatalogSpawnOptions
): GitHubAuthCatalogChild {
  return Bun.spawn([...argv], {
    env: options.env,
    stdin: options.stdin,
    stdout: options.stdout,
    stderr: options.stderr,
  }) as unknown as GitHubAuthCatalogChild;
}

export function makeGitHubAuthCatalogExecutor(
  options: GitHubAuthCatalogExecutorOptions = {}
): GitHubAuthCatalogExecutor {
  const spawn = options.spawn ?? defaultSpawn;
  const environment = options.environment ?? Bun.env;
  return () =>
    Effect.acquireUseRelease(
      acquireProcess(spawn, environment),
      executeAcquiredProcess,
      (acquired) =>
        acquired.kind === 'child' ? releaseProcess(acquired.state) : Effect.void
    ).pipe(
      Effect.catchTag('ExecutableMissingSignal', () =>
        Effect.succeed(objectFreeze({ kind: 'absent' as const }))
      ),
      Effect.timeoutFail({
        duration: EXECUTION_TIMEOUT,
        onTimeout: () => new GitHubAuthCatalogUnavailableError('timeout'),
      })
    );
}

function snapshotExecutionResult(
  execution: GitHubAuthCatalogExecutionResult
): Effect.Effect<
  GitHubAuthCatalogExecutionResult,
  GitHubAuthCatalogUnavailableError
> {
  if (
    typeof execution !== 'object' ||
    execution === null ||
    isProxy(execution)
  ) {
    return Effect.fail(new GitHubAuthCatalogUnavailableError('spawn-failed'));
  }
  const kind = ownDataProperty(execution, 'kind');
  if (kind.kind !== 'data') {
    return Effect.fail(new GitHubAuthCatalogUnavailableError('spawn-failed'));
  }
  if (kind.value === 'absent') {
    return Effect.succeed(objectFreeze({ kind: 'absent' as const }));
  }
  const exitCode = ownDataProperty(execution, 'exitCode');
  const stdout = ownDataProperty(execution, 'stdout');
  if (
    kind.value !== 'completed' ||
    exitCode.kind !== 'data' ||
    typeof exitCode.value !== 'number' ||
    !Number.isSafeInteger(exitCode.value) ||
    exitCode.value < 0 ||
    stdout.kind !== 'data' ||
    !(stdout.value instanceof Uint8Array)
  ) {
    return Effect.fail(new GitHubAuthCatalogUnavailableError('spawn-failed'));
  }
  return Effect.succeed({
    kind: 'completed',
    exitCode: exitCode.value,
    stdout: stdout.value,
  });
}

function knownCatalogFailure(
  cause: Cause.Cause<unknown>
): GitHubAuthCatalogFailure | undefined {
  const failures = Array.from(Cause.failures(cause));
  if (failures.length !== 1 || Cause.defects(cause).length > 0)
    return undefined;
  const failure = failures[0];
  if (typeof failure !== 'object' || failure === null || isProxy(failure)) {
    return undefined;
  }
  const tag = ownDataProperty(failure, '_tag');
  const classification = ownDataProperty(failure, 'classification');
  const reason = ownDataProperty(failure, 'reason');
  if (
    tag.kind !== 'data' ||
    classification.kind !== 'data' ||
    reason.kind !== 'data'
  ) {
    return undefined;
  }
  if (tag.value === DOCUMENT_ERROR_NAME) {
    if (
      classification.value === 'document' &&
      (reason.value === 'invalid-document' ||
        reason.value === 'output-too-large')
    ) {
      return new GitHubAuthCatalogDocumentError(reason.value);
    }
    return undefined;
  }
  if (tag.value === UNAVAILABLE_ERROR_NAME) {
    if (
      classification.value === 'unavailable' &&
      (reason.value === 'spawn-failed' ||
        reason.value === 'command-failed' ||
        reason.value === 'timeout')
    ) {
      return new GitHubAuthCatalogUnavailableError(reason.value);
    }
  }
  return undefined;
}

export function discoverGitHubAuthCatalog(
  executor: GitHubAuthCatalogExecutor
): Effect.Effect<GitHubAuthCatalogResult, GitHubAuthCatalogFailure> {
  const discovery = Effect.flatMap(
    Effect.suspend(executor),
    snapshotExecutionResult
  ).pipe(
    Effect.flatMap((execution) => {
      if (execution.kind === 'absent') return Effect.succeed(result([], false));
      return Effect.flatMap(
        parseGitHubAuthCatalogOutput(execution.stdout),
        (catalog) =>
          execution.exitCode === 0
            ? Effect.succeed(catalog)
            : Effect.fail(
                new GitHubAuthCatalogUnavailableError('command-failed')
              )
      );
    })
  );

  return Effect.catchAllCause(discovery, (cause) => {
    const known = knownCatalogFailure(cause);
    if (known !== undefined) return Effect.fail(known);
    if (Cause.isInterruptedOnly(cause)) return Effect.interrupt;
    return Effect.fail(new GitHubAuthCatalogUnavailableError('spawn-failed'));
  });
}

export interface GitHubAuthCatalogServiceShape {
  readonly discover: Effect.Effect<
    GitHubAuthCatalogResult,
    GitHubAuthCatalogFailure
  >;
}

/** Trusted fixed-operation catalog discovery; it is not a command service. */
export class GitHubAuthCatalogService extends Context.Tag(
  'aide/GitHubAuthCatalogService'
)<GitHubAuthCatalogService, GitHubAuthCatalogServiceShape>() {}

export function makeGitHubAuthCatalogService(
  executor: GitHubAuthCatalogExecutor
): GitHubAuthCatalogServiceShape {
  return objectFreeze({ discover: discoverGitHubAuthCatalog(executor) });
}

/** The Effect consumed by trusted catalog clients. */
export const githubAuthCatalog: Effect.Effect<
  GitHubAuthCatalogResult,
  GitHubAuthCatalogFailure,
  GitHubAuthCatalogService
> = Effect.flatMap(GitHubAuthCatalogService, (service) => service.discover);

/** Explicit production layer; no consumer constructs or hides it. */
export const GitHubAuthCatalogLive: Layer.Layer<GitHubAuthCatalogService> =
  Layer.sync(GitHubAuthCatalogService, () =>
    makeGitHubAuthCatalogService(makeGitHubAuthCatalogExecutor())
  );
