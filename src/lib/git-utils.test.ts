/**
 * Tests for git-utils.ts
 *
 * Tests are organized into two categories:
 * 1. Pure functions that don't depend on git commands (no mocking needed)
 * 2. Functions that require git - tested with actual git commands where safe
 */

import { describe, test, expect } from 'bun:test';

import {
  extractBranchName,
  ensureRefPrefix,
  getGitRemoteUrl,
  getCurrentBranch,
  isGitRepository,
  remoteRefExists,
  parseGitStat,
} from './git-utils.js';

// ============================================================================
// Pure Functions (no git dependency)
// ============================================================================

describe('extractBranchName', () => {
  test('extracts branch name from refs/heads/ prefix', () => {
    expect(extractBranchName('refs/heads/main')).toBe('main');
    expect(extractBranchName('refs/heads/feature/my-feature')).toBe(
      'feature/my-feature'
    );
  });

  test('returns branch name unchanged if no prefix', () => {
    expect(extractBranchName('main')).toBe('main');
    expect(extractBranchName('feature/test')).toBe('feature/test');
  });

  test('returns "unknown" for undefined/empty input', () => {
    expect(extractBranchName(undefined)).toBe('unknown');
    expect(extractBranchName('')).toBe('unknown');
  });
});

describe('ensureRefPrefix', () => {
  test('adds refs/heads/ prefix when missing', () => {
    expect(ensureRefPrefix('main')).toBe('refs/heads/main');
    expect(ensureRefPrefix('feature/test')).toBe('refs/heads/feature/test');
  });

  test('returns unchanged if prefix already present', () => {
    expect(ensureRefPrefix('refs/heads/main')).toBe('refs/heads/main');
    expect(ensureRefPrefix('refs/heads/feature/test')).toBe(
      'refs/heads/feature/test'
    );
  });
});

describe('parseGitStat', () => {
  test('parses file changes with additions and deletions', () => {
    const output = ` src/foo.ts | 15 ++++++++-------
 src/bar.ts |  3 +++
 2 files changed, 11 insertions(+), 7 deletions(-)`;

    const result = parseGitStat(output);

    expect(result.files).toHaveLength(2);
    expect(result.files[0]).toEqual({
      path: 'src/foo.ts',
      additions: 8,
      deletions: 7,
    });
    expect(result.files[1]).toEqual({
      path: 'src/bar.ts',
      additions: 3,
      deletions: 0,
    });
    expect(result.summary).toEqual({
      filesChanged: 2,
      additions: 11,
      deletions: 7,
    });
  });

  test('parses binary file changes', () => {
    const output = ` image.png | Bin 0 -> 1234 bytes
 1 file changed, 0 insertions(+), 0 deletions(-)`;

    const result = parseGitStat(output);

    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toEqual({
      path: 'image.png',
      additions: 0,
      deletions: 0,
    });
  });

  test('handles empty output', () => {
    const result = parseGitStat('');

    expect(result.files).toHaveLength(0);
    expect(result.summary).toEqual({
      filesChanged: 0,
      additions: 0,
      deletions: 0,
    });
  });

  test('parses insertions only summary', () => {
    const output = ` src/new.ts | 10 ++++++++++
 1 file changed, 10 insertions(+)`;

    const result = parseGitStat(output);

    expect(result.summary).toEqual({
      filesChanged: 1,
      additions: 10,
      deletions: 0,
    });
  });

  test('parses deletions only summary', () => {
    const output = ` src/old.ts | 5 -----
 1 file changed, 5 deletions(-)`;

    const result = parseGitStat(output);

    expect(result.summary).toEqual({
      filesChanged: 1,
      additions: 0,
      deletions: 5,
    });
  });
});

// ============================================================================
// Git Repository Helpers (integration tests - run against actual git)
// These tests verify behavior in the current repository context
// ============================================================================

describe('isGitRepository', () => {
  test('returns true when run from within a git repository', () => {
    // This test file is in a git repository, so this should return true
    expect(isGitRepository()).toBe(true);
  });
});

describe('getGitRemoteUrl', () => {
  test('returns a remote URL when in a git repository with origin', () => {
    const url = getGitRemoteUrl();
    // We're in the aide repo, so there should be a remote URL
    expect(url).not.toBeNull();
    expect(typeof url).toBe('string');
    // Should contain 'aide' since that's the repo name
    expect(url).toContain('aide');
  });
});

describe('getCurrentBranch', () => {
  test('returns a branch name when in a git repository', () => {
    const branch = getCurrentBranch();
    // Should return a string (branch name) or null (detached HEAD)
    // In normal circumstances during development, we're on a branch
    if (branch !== null) {
      expect(typeof branch).toBe('string');
      expect(branch.length).toBeGreaterThan(0);
    }
  });
});

describe('remoteRefExists', () => {
  test('returns true for origin/main (common default branch)', () => {
    // Most repos have origin/main or origin/master
    const hasMain = remoteRefExists('origin/main');
    const hasMaster = remoteRefExists('origin/master');
    // At least one should exist
    expect(hasMain || hasMaster).toBe(true);
  });

  test('returns false for non-existent ref', () => {
    const exists = remoteRefExists(
      'origin/this-branch-definitely-does-not-exist-12345'
    );
    expect(exists).toBe(false);
  });
});
