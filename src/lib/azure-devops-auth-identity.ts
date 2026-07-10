export const AZURE_DEVOPS_CANONICAL_AUTH_HOST = 'dev.azure.com';

export interface CanonicalAzureDevOpsAuthIdentity {
  readonly host: typeof AZURE_DEVOPS_CANONICAL_AUTH_HOST;
  readonly org: string;
}

export interface AzureDevOpsAuthIdentityInput {
  /** A hostname, host/path identity, or absolute organization URL. */
  readonly host: string;
  readonly org?: string;
}

function canonicalOrg(value: string | undefined): string | undefined {
  const normalized = value?.trim().normalize('NFC').toLowerCase();
  return normalized === undefined || normalized.length === 0
    ? undefined
    : normalized;
}

function decodePathSegment(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

/**
 * Canonicalize the two supported Azure DevOps cloud organization identities.
 * Arbitrary hosts and conflicting explicit/host-derived organizations fail.
 */
export function canonicalizeAzureDevOpsAuthIdentity(
  input: AzureDevOpsAuthIdentityInput
): CanonicalAzureDevOpsAuthIdentity | null {
  const rawHost = input.host.trim().normalize('NFC');
  if (rawHost.length === 0) return null;

  let url: URL;
  try {
    url = /^[a-z][a-z0-9+.-]*:\/\//i.test(rawHost)
      ? new URL(rawHost)
      : new URL(`https://${rawHost}`);
  } catch {
    return null;
  }

  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.port.length > 0
  ) {
    return null;
  }

  const hostname = url.hostname.toLowerCase();
  const explicitOrg = canonicalOrg(input.org);
  let derivedOrg: string | undefined;

  if (hostname === AZURE_DEVOPS_CANONICAL_AUTH_HOST) {
    derivedOrg = canonicalOrg(
      decodePathSegment(url.pathname.split('/').filter(Boolean)[0])
    );
  } else if (hostname.endsWith('.visualstudio.com')) {
    derivedOrg = canonicalOrg(hostname.slice(0, -'.visualstudio.com'.length));
  } else {
    return null;
  }

  if (
    explicitOrg !== undefined &&
    derivedOrg !== undefined &&
    explicitOrg !== derivedOrg
  ) {
    return null;
  }

  const org = explicitOrg ?? derivedOrg;
  if (org === undefined) return null;

  return {
    host: AZURE_DEVOPS_CANONICAL_AUTH_HOST,
    org,
  };
}
