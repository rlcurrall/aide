import { describe, expect, test } from 'bun:test';

import type { AidePullRequestDiffResult } from '@cli/host/plugin-descriptor.js';
import {
  formatPullRequestDiffJsonOutput,
  formatPullRequestDiffMarkdownOutput,
} from './diff.js';

const githubDiffResult: AidePullRequestDiffResult = {
  repository: {
    kind: 'github',
    host: 'github.com',
    owner: 'acme',
    repo: 'widgets',
  },
  repositoryLabel: 'github.com/acme/widgets',
  pullRequest: {
    id: 7,
    title: 'Provider diff',
    status: 'active',
    createdAt: '2026-01-01T00:00:00Z',
    author: { displayName: 'Ada Lovelace' },
    sourceBranch: 'feature/provider-diff',
    targetBranch: 'main',
  },
  files: [
    {
      path: 'src/index.ts',
      status: 'modified',
      providerStatus: 'modified',
      additions: 2,
      deletions: 1,
      changes: 3,
      patch: '@@ -1 +1 @@',
    },
  ],
};

describe('formatPullRequestDiffJsonOutput', () => {
  test('preserves GitHub-compatible API fallback file fields', () => {
    const output = JSON.parse(
      formatPullRequestDiffJsonOutput(
        githubDiffResult,
        {
          source: 'api-fallback',
          warning: 'Not in a git repository. Showing file list from API.',
          localBranchStatus: {
            available: false,
            reason: 'not-git-repo',
          },
          files: githubDiffResult.files,
        },
        'full'
      )
    );

    expect(output).toMatchObject({
      prId: 7,
      title: 'Provider diff',
      sourceBranch: 'feature/provider-diff',
      targetBranch: 'main',
      source: 'api-fallback',
      mode: 'full',
      files: [
        {
          filename: 'src/index.ts',
          status: 'modified',
          additions: 2,
          deletions: 1,
          changes: 3,
          patch: '@@ -1 +1 @@',
        },
      ],
    });
  });
});

describe('formatPullRequestDiffMarkdownOutput', () => {
  test('renders an empty markdown file list for an empty git diff', () => {
    expect(
      formatPullRequestDiffMarkdownOutput(
        githubDiffResult,
        {
          source: 'git-cli',
          output: '',
          localBranchStatus: { available: true },
        },
        'files'
      )
    ).toBe('');
  });
});
