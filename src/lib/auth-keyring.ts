import { Context, Data, Effect, Layer } from 'effect';

const AIDE_SERVICE_DEFAULT = 'aide';

export type LegacySecretName = 'jira' | 'ado' | 'github';
export type ScopedSecretName = `auth:${string}`;
export type AuthIndexSecretName = `auth-index:v1:provider:${string}`;
export type SecretName = LegacySecretName;
export type StoredSecretName = LegacySecretName | ScopedSecretName;
export type KeyringSecretName = StoredSecretName | AuthIndexSecretName;

export type KeyringOperation = 'get' | 'set' | 'delete';
export type KeyringDiagnosticOperation = KeyringOperation | 'unknown';
export type KeyringFailureClassification = 'unavailable';

interface KeyringUnavailableFields {
  readonly operation: KeyringDiagnosticOperation;
  readonly classification: KeyringFailureClassification;
}

/** A bounded diagnostic that never retains the keyring backend rejection. */
export class KeyringUnavailableError extends Data.TaggedError(
  'KeyringUnavailableError'
)<KeyringUnavailableFields> {
  constructor(operationOrDiscardedCause: unknown) {
    super({
      operation:
        operationOrDiscardedCause === 'get' ||
        operationOrDiscardedCause === 'set' ||
        operationOrDiscardedCause === 'delete'
          ? operationOrDiscardedCause
          : 'unknown',
      classification: 'unavailable',
    });
    Object.defineProperty(this, 'message', {
      configurable: true,
      value:
        "Couldn't access the system keyring. On Linux, this usually means " +
        "gnome-keyring or kwallet isn't running. You can install/start a " +
        'secret service, or set credentials via environment variables. ' +
        "Run 'aide login --help' for details.",
      writable: true,
    });
  }

  override get message(): string {
    return (
      "Couldn't access the system keyring. On Linux, this usually means " +
      "gnome-keyring or kwallet isn't running. You can install/start a " +
      'secret service, or set credentials via environment variables. ' +
      "Run 'aide login --help' for details."
    );
  }
}

export interface KeyringServiceShape {
  readonly get: (
    name: KeyringSecretName
  ) => Effect.Effect<string | null, KeyringUnavailableError>;
  readonly set: (
    name: KeyringSecretName,
    value: string
  ) => Effect.Effect<void, KeyringUnavailableError>;
  readonly delete: (
    name: KeyringSecretName
  ) => Effect.Effect<boolean, KeyringUnavailableError>;
}

function activeService(): string {
  return Bun.env.AIDE_SECRET_SERVICE_OVERRIDE ?? AIDE_SERVICE_DEFAULT;
}

function makeLiveKeyringService(): KeyringServiceShape {
  return {
    get: (name) =>
      Effect.tryPromise({
        try: () => Bun.secrets.get({ service: activeService(), name }),
        catch: () => new KeyringUnavailableError('get'),
      }),
    set: (name, value) =>
      Effect.tryPromise({
        try: () => Bun.secrets.set({ service: activeService(), name, value }),
        catch: () => new KeyringUnavailableError('set'),
      }),
    delete: (name) =>
      Effect.tryPromise({
        try: () => Bun.secrets.delete({ service: activeService(), name }),
        catch: () => new KeyringUnavailableError('delete'),
      }),
  } satisfies KeyringServiceShape;
}

/**
 * The auth-store keyring capability. Its methods are already Effects, so
 * transaction code never crosses through Promise or Bun APIs.
 */
export class KeyringService extends Context.Tag('aide/KeyringService')<
  KeyringService,
  KeyringServiceShape
>() {}

/** The explicit production adapter; hosts provide it at the outer boundary. */
export const KeyringLive: Layer.Layer<KeyringService> = Layer.sync(
  KeyringService,
  makeLiveKeyringService
);

export function keyringGet(
  name: KeyringSecretName
): Effect.Effect<string | null, KeyringUnavailableError, KeyringService> {
  return Effect.flatMap(KeyringService, (keyring) => keyring.get(name));
}

export function keyringSet(
  name: KeyringSecretName,
  value: string
): Effect.Effect<void, KeyringUnavailableError, KeyringService> {
  return Effect.flatMap(KeyringService, (keyring) => keyring.set(name, value));
}

export function keyringDelete(
  name: KeyringSecretName
): Effect.Effect<boolean, KeyringUnavailableError, KeyringService> {
  return Effect.flatMap(KeyringService, (keyring) => keyring.delete(name));
}
