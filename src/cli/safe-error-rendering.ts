export const MAX_SAFE_CLI_DIAGNOSTIC_LENGTH = 16_384;
export const UNKNOWN_ERROR_DIAGNOSTIC = 'Unknown error occurred';

const nativeErrorIsError = Error.isError;
const getOwnPropertyDescriptor = Reflect.getOwnPropertyDescriptor;
const apply = Reflect.apply;
const stringSlice = String.prototype.slice;

export function boundedSafeCliDiagnostic(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value.length <= MAX_SAFE_CLI_DIAGNOSTIC_LENGTH
    ? value
    : `${apply(stringSlice, value, [
        0,
        MAX_SAFE_CLI_DIAGNOSTIC_LENGTH - 3,
      ])}...`;
}

/**
 * Read only a proxy-safe native Error brand followed by an own data message.
 * Error Proxies, forged prototypes/tags, accessors, and inherited messages are
 * rejected without invoking candidate-controlled code.
 */
export function safeNativeErrorMessage(error: unknown): string | undefined {
  if (!nativeErrorIsError(error)) return undefined;
  const message = getOwnPropertyDescriptor(error, 'message');
  if (message === undefined || !('value' in message)) return undefined;
  return boundedSafeCliDiagnostic(message.value);
}

/** Total bounded renderer policy after exact host diagnostic lookups miss. */
export function totalSafeErrorMessage(error: unknown): string {
  return (
    boundedSafeCliDiagnostic(error) ??
    safeNativeErrorMessage(error) ??
    UNKNOWN_ERROR_DIAGNOSTIC
  );
}
