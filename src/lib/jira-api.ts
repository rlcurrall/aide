import type { JiraConfig } from '../schemas/config.js';

/**
 * Resolve an endpoint argument to a full URL, enforcing security guards.
 *
 * - Relative path (with or without leading slash): prepend configured scheme+host.
 * - Absolute URL: must be HTTPS and must match the configured Jira host, else throw.
 *
 * The host check prevents credential exfiltration: the caller's Jira basic-auth
 * header is about to be attached, and we refuse to send it to any other origin.
 */
export function resolveEndpoint(
  config: JiraConfig,
  endpoint: string
): string {
  const base = new URL(config.url); // throws on malformed configured URL

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(endpoint)) {
    const target = new URL(endpoint);
    if (target.protocol !== 'https:') {
      throw new Error(
        `Refusing to send Jira credentials over non-HTTPS URL: ${endpoint}`
      );
    }
    if (target.host !== base.host) {
      throw new Error(
        `Refusing to send Jira credentials to host '${target.host}'; ` +
          `configured host is '${base.host}'. Pass a relative path or a URL on the configured host.`
      );
    }
    return target.toString();
  }

  const path = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  const baseOrigin = `${base.protocol}//${base.host}`;
  return `${baseOrigin}${path}`;
}
