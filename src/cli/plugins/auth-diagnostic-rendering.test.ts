import { describe, expect, test } from 'bun:test';

import {
  encodeAuthDiagnosticIdentity,
  renderAuthDiagnosticArgv,
} from './auth-diagnostic-rendering.js';

describe('auth diagnostic rendering', () => {
  test('encodes already-validated identities as exact JSON string literals', () => {
    const maximumIdentity = `${'a'.repeat(254)}😀`;
    const values = [
      'plain',
      '"quoted"',
      ' surrounding whitespace ',
      'interior whitespace',
      'comma,value',
      '`backtick`',
      '$(substitution)',
      'semi;colon',
      'pipe|value',
      'back\\slash',
      'astral-😀',
      maximumIdentity,
    ] as const;

    for (const value of values) {
      expect(encodeAuthDiagnosticIdentity(value)).toBe(JSON.stringify(value));
    }
  });

  test('renders compact exact JSON argv without shell-command text', () => {
    const values = [
      'aide',
      'login',
      'github',
      '--scope-host',
      'acme.ghe.com',
      '--scope-account',
      'ali" ce,`$();|\\😀',
    ] as const;
    const expected =
      '["aide","login","github","--scope-host","acme.ghe.com","--scope-account","ali\\" ce,`$();|\\\\😀"]';

    expect(renderAuthDiagnosticArgv(values)).toBe(expected);
    expect(renderAuthDiagnosticArgv(values)).toBe(JSON.stringify(values));
    expect(renderAuthDiagnosticArgv(values)).not.toContain('aide login');
    expect(renderAuthDiagnosticArgv(values)).not.toContain('\n');
  });

  test('is deterministic and cannot acquire unrelated sentinel material', () => {
    const sentinels = [
      'RAW_CAUSE_SENTINEL_147',
      'LABEL_SENTINEL_147',
      'TOKEN_SENTINEL_147',
      'PAT_SENTINEL_147',
    ] as const;
    const identity = 'deterministic-account';
    const argv = ['aide', 'login', 'github', '--scope-account', identity];

    const first = `${encodeAuthDiagnosticIdentity(identity)} ${renderAuthDiagnosticArgv(argv)}`;
    const second = `${encodeAuthDiagnosticIdentity(identity)} ${renderAuthDiagnosticArgv(argv)}`;
    expect(first).toBe(second);
    for (const sentinel of sentinels) expect(first).not.toContain(sentinel);
  });
});
