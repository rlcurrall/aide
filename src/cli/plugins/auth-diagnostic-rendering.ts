export function encodeAuthDiagnosticIdentity(value: string): string {
  return JSON.stringify(value);
}

export function renderAuthDiagnosticArgv(values: readonly string[]): string {
  return `[${values.map(encodeAuthDiagnosticIdentity).join(',')}]`;
}
