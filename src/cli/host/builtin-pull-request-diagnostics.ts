import { configErrorDiagnostic } from '@lib/config.js';
import { azureDevOpsPlugin } from '@cli/plugins/azure-devops/plugin.js';
import { githubPlugin } from '@cli/plugins/github/plugin.js';
import { githubPullRequestErrorDiagnostic } from '@cli/plugins/github/pull-request-client.js';

export type HostOwnedPullRequestFailureDiagnostic = (
  failure: unknown
) => string | undefined;

/**
 * This table is the built-in certificate. Membership is based only on the
 * exact module-owned descriptor objects; ids, properties, snapshots and
 * lookalike capabilities carry no authority.
 */
const hostOwnedBuiltinPullRequestDiagnostics = new WeakMap<
  object,
  HostOwnedPullRequestFailureDiagnostic
>([
  [githubPlugin, githubPullRequestErrorDiagnostic],
  [azureDevOpsPlugin, configErrorDiagnostic],
]);

export function hostOwnedBuiltinPullRequestDiagnostic(
  plugin: unknown
): HostOwnedPullRequestFailureDiagnostic | undefined {
  return (typeof plugin === 'object' && plugin !== null) ||
    typeof plugin === 'function'
    ? hostOwnedBuiltinPullRequestDiagnostics.get(plugin)
    : undefined;
}
