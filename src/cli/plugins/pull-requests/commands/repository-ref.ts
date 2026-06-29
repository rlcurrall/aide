import type { AidePullRequestRepositoryRef } from '@cli/host/plugin-descriptor.js';
import { MissingRepoContextError, resolveRepoContext } from '@lib/ado-utils.js';
import { loadAzureDevOpsConfig } from '@lib/config.js';

export interface ResolvedPullRequestRepositoryRef {
  readonly repository: AidePullRequestRepositoryRef;
  readonly autoDiscovered: boolean;
}

export async function resolveExplicitPullRequestRepositoryRef(
  project: string | undefined,
  repo: string | undefined
): Promise<ResolvedPullRequestRepositoryRef> {
  const context = resolveRepoContext(project, repo);
  const org = context.org ?? (await configuredAzureDevOpsOrg());
  if (org === null) {
    throw new MissingRepoContextError(
      'Could not determine Azure DevOps organization. Run this command from an Azure DevOps git repository or configure AZURE_DEVOPS_ORG_URL via `aide login ado`.'
    );
  }

  return {
    repository: {
      kind: 'azure-devops',
      org,
      project: context.project,
      repo: context.repo,
    },
    autoDiscovered: context.autoDiscovered,
  };
}

async function configuredAzureDevOpsOrg(): Promise<string | null> {
  const { config } = await loadAzureDevOpsConfig();
  return azureDevOpsOrgFromUrl(config.orgUrl);
}

function azureDevOpsOrgFromUrl(orgUrl: string): string | null {
  try {
    const url = new URL(orgUrl);
    if (url.hostname === 'dev.azure.com') {
      return url.pathname.split('/').filter(Boolean)[0] ?? null;
    }
    if (url.hostname.endsWith('.visualstudio.com')) {
      return url.hostname.replace(/\.visualstudio\.com$/, '');
    }
    return null;
  } catch {
    return null;
  }
}
