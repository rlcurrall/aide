/**
 * GitHub host resolution and host-aware URL construction.
 *
 * Single source of truth for "which hosts are GitHub" (per the gh CLI's
 * authenticated hosts) and how to build API/web URLs for a host. Supports
 * github.com and GHE Cloud data-residency hosts (e.g. acme.ghe.com), which
 * share the same `api.<host>` subdomain scheme.
 */

import { spawnSync } from 'bun';

type SpawnSyncFn = typeof spawnSync;

export const DEFAULT_GITHUB_HOST = 'github.com';

/**
 * Return the set of hosts the gh CLI is authenticated to, always including
 * github.com. Parses `gh auth status` output (which, across gh versions, may
 * land on stdout or stderr). Never throws: any failure degrades to
 * [github.com] so github.com behavior is never broken. No caching — gh login
 * state can change mid-session and the probe is cheap (mirrors isGhCliAvailable).
 */
export function getGhKnownHosts(spawn: SpawnSyncFn = spawnSync): string[] {
  const hosts = new Set<string>([DEFAULT_GITHUB_HOST]);
  try {
    const result = spawn(['gh', 'auth', 'status'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (result.exitCode !== 0) return [...hosts];
    const text = result.stdout.toString() + '\n' + result.stderr.toString();
    // Require the captured token to look like a hostname (contains a dot) so
    // a future gh format change can't capture a bare prose word as a "host".
    const re = /Logged in to ([\w.-]+\.[\w-]+)/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      if (match[1]) hosts.add(match[1].toLowerCase());
    }
  } catch {
    return [DEFAULT_GITHUB_HOST];
  }
  return [...hosts];
}

/**
 * Case-insensitive membership test against the known-host set.
 */
export function isKnownGitHubHost(
  host: string,
  knownHosts: string[] = getGhKnownHosts()
): boolean {
  const lower = host.toLowerCase();
  return knownHosts.some((h) => h.toLowerCase() === lower);
}

/** REST API base for a host: github.com -> https://api.github.com. */
export function githubApiBase(host: string): string {
  return `https://api.${host}`;
}

/** GraphQL endpoint for a host. */
export function githubGraphqlUrl(host: string): string {
  return `${githubApiBase(host)}/graphql`;
}

/** Web (browser) base for a host: https://<host>. */
export function githubWebBase(host: string): string {
  return `https://${host}`;
}

/**
 * Extra `gh api` args to target a host. Empty for github.com (the gh default),
 * otherwise `--hostname <host>` since `gh api` does not infer the host from the
 * git remote.
 */
export function ghHostArgs(host: string): string[] {
  return host === DEFAULT_GITHUB_HOST ? [] : ['--hostname', host];
}
