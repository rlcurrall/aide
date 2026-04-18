/**
 * Thin wrapper around Bun.secrets with typed errors.
 *
 * The rest of the codebase imports from here so there's one place that
 * decides what "not found" vs "keyring unavailable" looks like. Every
 * secret aide stores lives under service="aide".
 */

export const AIDE_SERVICE = 'aide';

export type SecretName = 'jira' | 'ado' | 'github';

export class KeyringUnavailableError extends Error {
  override readonly cause: unknown;
  override readonly name = 'KeyringUnavailableError';

  constructor(cause: unknown) {
    super(
      "Couldn't access the system keyring. On Linux, this usually means " +
        "gnome-keyring or kwallet isn't running. You can install/start a " +
        'secret service, or set credentials via environment variables. ' +
        "Run 'aide login --help' for details."
    );
    this.cause = cause;
    Object.setPrototypeOf(this, KeyringUnavailableError.prototype);
  }
}

export async function getSecret(name: SecretName): Promise<string | null> {
  try {
    return await Bun.secrets.get({ service: AIDE_SERVICE, name });
  } catch (err) {
    throw new KeyringUnavailableError(err);
  }
}

export async function setSecret(
  name: SecretName,
  value: string
): Promise<void> {
  try {
    await Bun.secrets.set({ service: AIDE_SERVICE, name, value });
  } catch (err) {
    throw new KeyringUnavailableError(err);
  }
}

export async function deleteSecret(name: SecretName): Promise<boolean> {
  try {
    return await Bun.secrets.delete({ service: AIDE_SERVICE, name });
  } catch (err) {
    throw new KeyringUnavailableError(err);
  }
}
