/**
 * Tests for github-utils.ts pure URL/host helpers.
 *
 * Focuses on host-aware parsing so GitHub Enterprise Cloud (ghe.com)
 * data-residency hosts are detected alongside public github.com.
 */

import { describe, test, expect } from 'bun:test';

import {
  normalizeGitHubHost,
  githubApiBase,
  buildGitHubPrUrl,
  parseGitHubRemote,
  parseGitHubPRUrl,
} from './github-utils.js';

describe('normalizeGitHubHost', () => {
  test('accepts github.com and strips ssh. prefix', () => {
    expect(normalizeGitHubHost('github.com')).toBe('github.com');
    expect(normalizeGitHubHost('ssh.github.com')).toBe('github.com');
    expect(normalizeGitHubHost('GitHub.com')).toBe('github.com');
  });

  test('accepts *.ghe.com data-residency hosts', () => {
    expect(normalizeGitHubHost('acme.ghe.com')).toBe('acme.ghe.com');
    expect(normalizeGitHubHost('ssh.acme.ghe.com')).toBe('acme.ghe.com');
  });

  test('rejects non-GitHub hosts', () => {
    expect(normalizeGitHubHost('dev.azure.com')).toBeNull();
    expect(normalizeGitHubHost('gitlab.com')).toBeNull();
    expect(normalizeGitHubHost('ghe.com')).toBeNull();
    expect(normalizeGitHubHost('evil-github.com')).toBeNull();
  });
});

describe('githubApiBase', () => {
  test('derives api host for github.com and ghe.com', () => {
    expect(githubApiBase('github.com')).toBe('https://api.github.com');
    expect(githubApiBase('acme.ghe.com')).toBe('https://api.acme.ghe.com');
  });
});

describe('buildGitHubPrUrl', () => {
  test('defaults to github.com', () => {
    expect(buildGitHubPrUrl('acme', 'widgets', 42)).toBe(
      'https://github.com/acme/widgets/pull/42'
    );
  });

  test('uses the provided host', () => {
    expect(buildGitHubPrUrl('acme', 'widgets', 42, 'acme.ghe.com')).toBe(
      'https://acme.ghe.com/acme/widgets/pull/42'
    );
  });
});

describe('parseGitHubRemote', () => {
  test('parses github.com SSH and HTTPS remotes', () => {
    expect(parseGitHubRemote('git@github.com:acme/widgets.git')).toEqual({
      owner: 'acme',
      repo: 'widgets',
      host: 'github.com',
    });
    expect(parseGitHubRemote('https://github.com/acme/widgets.git')).toEqual({
      owner: 'acme',
      repo: 'widgets',
      host: 'github.com',
    });
  });

  test('parses ghe.com SSH (with and without ssh. prefix) and HTTPS', () => {
    expect(parseGitHubRemote('git@acme.ghe.com:acme/widgets.git')).toEqual({
      owner: 'acme',
      repo: 'widgets',
      host: 'acme.ghe.com',
    });
    expect(parseGitHubRemote('git@ssh.acme.ghe.com:acme/widgets.git')).toEqual({
      owner: 'acme',
      repo: 'widgets',
      host: 'acme.ghe.com',
    });
    expect(parseGitHubRemote('https://acme.ghe.com/acme/widgets.git')).toEqual({
      owner: 'acme',
      repo: 'widgets',
      host: 'acme.ghe.com',
    });
  });

  test('parses SSH remotes with a custom (non-git) user', () => {
    // GHE Cloud orgs commonly use a custom SSH user, e.g. acme@acme.ghe.com.
    expect(parseGitHubRemote('acme@acme.ghe.com:acme/widgets.git')).toEqual({
      owner: 'acme',
      repo: 'widgets',
      host: 'acme.ghe.com',
    });
    // Bare scp-style remote with no user at all.
    expect(parseGitHubRemote('github.com:acme/widgets.git')).toEqual({
      owner: 'acme',
      repo: 'widgets',
      host: 'github.com',
    });
  });

  test('returns null for Azure DevOps remotes', () => {
    expect(
      parseGitHubRemote('git@ssh.dev.azure.com:v3/org/proj/repo')
    ).toBeNull();
    expect(
      parseGitHubRemote('https://dev.azure.com/org/proj/_git/repo')
    ).toBeNull();
  });
});

describe('parseGitHubPRUrl', () => {
  test('parses github.com and ghe.com PR URLs, ignoring query/fragment', () => {
    expect(parseGitHubPRUrl('https://github.com/acme/widgets/pull/42')).toEqual(
      { owner: 'acme', repo: 'widgets', number: 42, host: 'github.com' }
    );
    expect(
      parseGitHubPRUrl('https://acme.ghe.com/acme/widgets/pull/42?foo=1')
    ).toEqual({ owner: 'acme', repo: 'widgets', number: 42, host: 'acme.ghe.com' });
  });

  test('returns null for non-GitHub PR URLs', () => {
    expect(
      parseGitHubPRUrl('https://dev.azure.com/o/p/_git/r/pullrequest/42')
    ).toBeNull();
  });
});
