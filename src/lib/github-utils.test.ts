import { describe, test, expect } from 'bun:test';
import { parseGitHubRemote } from './github-utils.js';

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
