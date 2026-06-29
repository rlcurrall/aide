import { Effect } from 'effect';

import type {
  AideAuthLoginRequest,
  AideAuthPromptTextRequest,
} from '@cli/host/plugin-descriptor.js';
import type { MigrationError } from '@lib/config.js';

export function authInputString(
  request: AideAuthLoginRequest,
  key: string
): string | undefined {
  const value = request.values?.[key];
  return typeof value === 'string' ? value : undefined;
}

export function promptAuthString(
  request: AideAuthLoginRequest,
  key: string,
  prompt: AideAuthPromptTextRequest
): Effect.Effect<string, unknown, never> {
  const value = authInputString(request, key);
  if (value !== undefined) return Effect.succeed(value);
  if (request.prompt === undefined) {
    return Effect.fail(new Error(`Missing auth input '${key}'.`));
  }
  return request.prompt.text(prompt);
}

export function validateUrl(value: string): string | null {
  try {
    new URL(value);
    return null;
  } catch {
    return 'must be a valid URL';
  }
}

export function validateNonEmpty(value: string): string | null {
  return value.length === 0 ? 'required' : null;
}

export function formatMigrationError(
  service: string,
  err: MigrationError
): string {
  if (err.kind === 'missing') {
    return `Cannot migrate ${service} from env: missing ${err.missingVars.join(', ')}.`;
  }
  return `Cannot migrate ${service} from env: ${err.reason}.`;
}

export function formatUnsetHint(varsUsed: readonly string[]): string | null {
  if (varsUsed.length === 0) return null;
  if (varsUsed.length === 1) {
    return `Note: ${varsUsed[0]} is still set and takes precedence over the keyring. Unset it to use the keyring.`;
  }
  const list =
    varsUsed.slice(0, -1).join(', ') + ', and ' + varsUsed[varsUsed.length - 1];
  return `Note: ${list} are still set and take precedence over the keyring. Unset them to use the keyring.`;
}

export function messages(
  ...values: readonly (string | null | undefined)[]
): readonly string[] {
  return values.filter((value): value is string => Boolean(value));
}
