import type { AuthStoreScope } from './auth-store.js';
import {
  AZURE_DEVOPS_CANONICAL_AUTH_HOST,
  canonicalizeAzureDevOpsAuthIdentity,
} from './azure-devops-auth-identity.js';
import { normalizeGitHubHost } from './github-utils.js';

export function githubRepositoryAuthScope(host: string): AuthStoreScope {
  const normalizedHost = normalizeGitHubHost(host);
  if (normalizedHost === null) {
    throw new Error(`Unsupported GitHub authentication host '${host}'`);
  }
  return {
    providerId: 'github',
    host: normalizedHost,
  };
}

export function azureDevOpsRepositoryAuthScope(org: string): AuthStoreScope {
  const identity = canonicalizeAzureDevOpsAuthIdentity({
    host: AZURE_DEVOPS_CANONICAL_AUTH_HOST,
    org,
  });
  if (identity === null) {
    throw new Error(`Unsupported Azure DevOps authentication org '${org}'`);
  }
  return {
    providerId: 'azure-devops',
    host: identity.host,
    org: identity.org,
  };
}
