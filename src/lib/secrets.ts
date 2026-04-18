/**
 * Thin wrapper around Bun.secrets with typed errors.
 *
 * The rest of the codebase imports from here so there's one place that
 * decides what "not found" vs "keyring unavailable" looks like. Every
 * secret aide stores lives under service="aide" by default.
 *
 * Tests can override the service name by setting AIDE_SECRET_SERVICE_OVERRIDE
 * so they use the real OS keyring without colliding with production entries.
 */

const AIDE_SERVICE_DEFAULT = 'aide';

/**
 * Resolve the active keyring service name. Honors
 * AIDE_SECRET_SERVICE_OVERRIDE so tests can scope to a unique service
 * without colliding with production entries.
 */
function activeService(): string {
  return Bun.env.AIDE_SECRET_SERVICE_OVERRIDE ?? AIDE_SERVICE_DEFAULT;
}

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
    return await Bun.secrets.get({ service: activeService(), name });
  } catch (err) {
    throw new KeyringUnavailableError(err);
  }
}

export async function setSecret(
  name: SecretName,
  value: string
): Promise<void> {
  try {
    await Bun.secrets.set({ service: activeService(), name, value });
  } catch (err) {
    throw new KeyringUnavailableError(err);
  }
}

export async function deleteSecret(name: SecretName): Promise<boolean> {
  try {
    return await Bun.secrets.delete({ service: activeService(), name });
  } catch (err) {
    throw new KeyringUnavailableError(err);
  }
}
