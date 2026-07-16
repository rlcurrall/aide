import type { Argv } from 'yargs';

import { authSecretTarget, type AuthStoreScope } from '@lib/auth-store.js';
import { loadConfig } from '@lib/config.js';

function scopeValue(
  argv: Readonly<Record<string, unknown>>,
  dashed: string,
  camel: string
): { readonly present: boolean; readonly value?: string } {
  const values = [dashed, camel]
    .filter((key) => Object.prototype.hasOwnProperty.call(argv, key))
    .map((key) => argv[key]);

  if (values.length === 0) return { present: false };

  const normalized = values.map((value) =>
    typeof value === 'string' && value.trim().length > 0
      ? value.trim()
      : undefined
  );
  if (normalized.some((value) => value === undefined)) {
    return { present: true };
  }

  return { present: true, value: normalized[0] };
}

export function jiraAuthScopeFromArgs(
  argv: unknown
): AuthStoreScope | undefined {
  if (argv === null || typeof argv !== 'object') return undefined;
  const values = argv as Readonly<Record<string, unknown>>;
  const host = scopeValue(values, 'scope-host', 'scopeHost');
  const account = scopeValue(values, 'scope-account', 'scopeAccount');

  if (!host.present && !account.present) return undefined;
  if (
    (host.present && host.value === undefined) ||
    (account.present && account.value === undefined)
  ) {
    throw new Error(
      'Scoped Jira credential selection requires non-empty string values for explicitly provided --scope-host and --scope-account options.'
    );
  }
  if (host.value === undefined || account.value === undefined) {
    throw new Error(
      'Scoped Jira credential selection requires both --scope-host and --scope-account.'
    );
  }

  const target = authSecretTarget('jira', {
    providerId: 'jira',
    host: host.value,
    account: account.value,
  });
  if (target?.kind !== 'scoped' || target.scope === undefined) {
    throw new Error('Cannot build a scoped Jira credential identity.');
  }
  return target.scope;
}

export function loadJiraConfigForArgs(argv: unknown) {
  return loadConfig(jiraAuthScopeFromArgs(argv));
}

export function configureJiraAuthScopeOptions<T>(yargs: Argv<T>): Argv<T> {
  return yargs
    .option('scope-host', {
      type: 'string',
      describe: 'Select Jira credentials stored for this host',
    })
    .option('scope-account', {
      type: 'string',
      describe: 'Select Jira credentials stored for this account/email',
    });
}
