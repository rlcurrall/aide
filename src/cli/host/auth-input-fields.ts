import type { AideAuthInputField } from './plugin-descriptor.js';

export function authInputFieldFlagName(
  field: AideAuthInputField | string
): string {
  const key = typeof field === 'string' ? field : field.key;
  return key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
}
