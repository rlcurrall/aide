import { describe, test, expect } from 'bun:test';
import { parseGitHubRemote, parseGitHubPRUrl, buildGitHubPrUrl } from './github-utils.js';

const known = ['github.com', 'acme.ghe.com'];

describe('parseGitHubRemote', () => {
  test('parses github.com SSH remote', () => {
    expect(
      parseGitHubRemote('git@github.com:owner/repo.git', known)
    ).toEqual({ host: 'github.com', owner: 'owner', repo: 'repo' });
  });

  test('parses github.com HTTPS remote', () => {
    expect(
      parseGitHubRemote('https://github.com/owner/repo.git', known)
    ).toEqual({ host: 'github.com', owner: 'owner', repo: 'repo' });
  });

  test('parses enterprise SSH remote', () => {
    expect(
      parseGitHubRemote('git@acme.ghe.com:owner/repo.git', known)
    ).toEqual({ host: 'acme.ghe.com', owner: 'owner', repo: 'repo' });
  });

  test('parses enterprise HTTPS remote without .git', () => {
    expect(
      parseGitHubRemote('https://acme.ghe.com/owner/repo', known)
    ).toEqual({ host: 'acme.ghe.com', owner: 'owner', repo: 'repo' });
  });

  test('returns null for a host not in the known set', () => {
    expect(parseGitHubRemote('git@gitlab.com:owner/repo.git', known)).toBeNull();
  });
});

describe('parseGitHubPRUrl', () => {
  test('parses github.com PR URL', () => {
    expect(
      parseGitHubPRUrl('https://github.com/owner/repo/pull/42', known)
    ).toEqual({ host: 'github.com', owner: 'owner', repo: 'repo', number: 42 });
  });

  test('parses enterprise PR URL with query/hash stripped', () => {
    expect(
      parseGitHubPRUrl('https://acme.ghe.com/o/r/pull/7?foo=1#x', known)
    ).toEqual({ host: 'acme.ghe.com', owner: 'o', repo: 'r', number: 7 });
  });

  test('returns null for unknown host', () => {
    expect(
      parseGitHubPRUrl('https://gitlab.com/o/r/pull/7', known)
    ).toBeNull();
  });
});

describe('buildGitHubPrUrl', () => {
  test('builds github.com URL', () => {
    expect(buildGitHubPrUrl('github.com', 'o', 'r', 5)).toBe(
      'https://github.com/o/r/pull/5'
    );
  });
  test('builds enterprise URL', () => {
    expect(buildGitHubPrUrl('acme.ghe.com', 'o', 'r', 5)).toBe(
      'https://acme.ghe.com/o/r/pull/5'
    );
  });
});
