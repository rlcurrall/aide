import { describe, test, expect } from 'bun:test';
import {
  getGhKnownHosts,
  isKnownGitHubHost,
  githubApiBase,
  githubGraphqlUrl,
  githubWebBase,
  ghHostArgs,
} from './github-host.js';
import type { spawnSync } from 'bun';

type Spawn = typeof spawnSync;

function fakeSpawn(stdout: string, stderr = '', exitCode = 0): Spawn {
  return (() => ({
    exitCode,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
  })) as unknown as Spawn;
}

describe('getGhKnownHosts', () => {
  test('always includes github.com even with no extra hosts', () => {
    const hosts = getGhKnownHosts(
      fakeSpawn('github.com\n  ✓ Logged in to github.com account u (keyring)\n')
    );
    expect(hosts).toContain('github.com');
  });

  test('parses an enterprise data-residency host', () => {
    const out =
      'acme.ghe.com\n  ✓ Logged in to acme.ghe.com account u (keyring)\n';
    const hosts = getGhKnownHosts(fakeSpawn(out));
    expect(hosts).toContain('acme.ghe.com');
    expect(hosts).toContain('github.com');
  });

  test('parses multiple hosts', () => {
    const out =
      '✓ Logged in to github.com as u\n✓ Logged in to acme.ghe.com as u\n';
    const hosts = getGhKnownHosts(fakeSpawn(out));
    expect(hosts).toContain('github.com');
    expect(hosts).toContain('acme.ghe.com');
  });

  test('reads hosts from stderr too (older gh prints there)', () => {
    const hosts = getGhKnownHosts(
      fakeSpawn('', '✓ Logged in to acme.ghe.com as u\n', 0)
    );
    expect(hosts).toContain('acme.ghe.com');
  });

  test('degrades to [github.com] on non-zero exit', () => {
    expect(getGhKnownHosts(fakeSpawn('', 'not logged in', 1))).toEqual([
      'github.com',
    ]);
  });

  test('degrades to [github.com] when spawn throws', () => {
    const throwing = (() => {
      throw new Error('ENOENT');
    }) as unknown as Spawn;
    expect(getGhKnownHosts(throwing)).toEqual(['github.com']);
  });

  test('degrades to [github.com] on unparseable output', () => {
    expect(getGhKnownHosts(fakeSpawn('garbage with no host lines'))).toEqual([
      'github.com',
    ]);
  });
});

describe('isKnownGitHubHost', () => {
  test('matches case-insensitively', () => {
    expect(isKnownGitHubHost('ACME.ghe.com', ['acme.ghe.com'])).toBe(true);
  });
  test('rejects unknown hosts', () => {
    expect(isKnownGitHubHost('gitlab.com', ['github.com'])).toBe(false);
  });
});

describe('URL builders', () => {
  test('githubApiBase for github.com', () => {
    expect(githubApiBase('github.com')).toBe('https://api.github.com');
  });
  test('githubApiBase for data-residency host', () => {
    expect(githubApiBase('acme.ghe.com')).toBe('https://api.acme.ghe.com');
  });
  test('githubGraphqlUrl appends /graphql', () => {
    expect(githubGraphqlUrl('acme.ghe.com')).toBe(
      'https://api.acme.ghe.com/graphql'
    );
  });
  test('githubWebBase', () => {
    expect(githubWebBase('acme.ghe.com')).toBe('https://acme.ghe.com');
  });
});

describe('ghHostArgs', () => {
  test('returns empty array for github.com', () => {
    expect(ghHostArgs('github.com')).toEqual([]);
  });
  test('returns --hostname for enterprise host', () => {
    expect(ghHostArgs('acme.ghe.com')).toEqual(['--hostname', 'acme.ghe.com']);
  });
});
