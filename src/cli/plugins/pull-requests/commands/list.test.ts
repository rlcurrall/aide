import { describe, expect, test } from 'bun:test';

import type { AidePullRequestListResult } from '@cli/host/plugin-descriptor.js';
import { formatPullRequestListOutput } from './list.js';

describe('formatPullRequestListOutput', () => {
  test('renders provider-neutral text output with repository label', () => {
    const output = formatPullRequestListOutput(pullRequestListResult(), 'text');

    expect(output).toContain('Pull Requests - github.com/acme/widgets');
    expect(output).toContain('[PR #10] Feature');
    expect(output).toContain('Status: active');
    expect(output).toContain('Created:');
    expect(output).toContain('by Ada');
  });

  test('renders pull request list items as json', () => {
    const output = formatPullRequestListOutput(pullRequestListResult(), 'json');

    expect(JSON.parse(output)).toEqual([
      {
        id: 10,
        title: 'Feature',
        status: 'active',
        createdAt: '2026-01-01T00:00:00Z',
        author: { displayName: 'Ada' },
      },
    ]);
  });
});

function pullRequestListResult(): AidePullRequestListResult {
  return {
    repository: {
      kind: 'github',
      host: 'github.com',
      owner: 'acme',
      repo: 'widgets',
    },
    repositoryLabel: 'github.com/acme/widgets',
    pullRequests: [
      {
        id: 10,
        title: 'Feature',
        status: 'active',
        createdAt: '2026-01-01T00:00:00Z',
        author: { displayName: 'Ada' },
      },
    ],
  };
}
