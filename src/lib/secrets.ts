import { Effect } from 'effect';

import {
  KeyringLive,
  keyringDelete,
  keyringGet,
  keyringSet,
  type KeyringSecretName,
} from './auth-keyring.js';

export * from './auth-keyring.js';

async function runLive<A, E>(effect: Effect.Effect<A, E, never>): Promise<A> {
  const result = await Effect.runPromise(Effect.either(effect));
  if (result._tag === 'Left') throw result.left;
  return result.right;
}

/** @deprecated Live compatibility adapter. Use keyringGet with an injected layer. */
export async function getSecret(
  name: KeyringSecretName
): Promise<string | null> {
  return runLive(keyringGet(name).pipe(Effect.provide(KeyringLive)));
}

/** @deprecated Live compatibility adapter. Use keyringSet with an injected layer. */
export async function setSecret(
  name: KeyringSecretName,
  value: string
): Promise<void> {
  return runLive(keyringSet(name, value).pipe(Effect.provide(KeyringLive)));
}

/** @deprecated Live compatibility adapter. Use keyringDelete with an injected layer. */
export async function deleteSecret(name: KeyringSecretName): Promise<boolean> {
  return runLive(keyringDelete(name).pipe(Effect.provide(KeyringLive)));
}
