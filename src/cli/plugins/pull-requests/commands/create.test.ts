import { describe, expect, test } from 'bun:test';

import type { AidePullRequestCreateResult } from '@cli/host/plugin-descriptor.js';
import {
  buildPullRequestCreateOperationRequest,
  formatPullRequestCreateOutput,
  resolvePullRequestCreateBranches,
  selectPullRequestCreateTarget,
} from './create.js';

const createResult: AidePullRequestCreateResult = {
  repository: {
    kind: 'github',
    host: 'github.com',
    owner: 'acme',
    repo: 'widgets',
  },
  repositoryLabel: 'github.com/acme/widgets',
  pullRequest: {
    id: 17,
    title: 'New PR',
    status: 'active',
    createdAt: '2026-01-01T00:00:00Z',
    author: { displayName: 'Ada Lovelace', username: 'ada' },
    description: 'New body',
    sourceBranch: 'feature/new-pr',
    targetBranch: 'main',
    labels: ['ready'],
    url: 'https://github.com/acme/widgets/pull/17',
  },
  warnings: ['Failed to add labels: denied'],
};

describe('resolvePullRequestCreateBranches', () => {
  test('uses explicit head/base branches', () => {
    expect(
      resolvePullRequestCreateBranches(
        { head: 'feature', base: 'develop' },
        'current'
      )
    ).toEqual({
      sourceBranch: 'feature',
      targetBranch: 'develop',
      autoDetectedSource: false,
      defaultedTarget: false,
    });
  });

  test('uses aliases and defaults target branch to main', () => {
    expect(
      resolvePullRequestCreateBranches(
        { source: 'alias-source', target: undefined },
        'current'
      )
    ).toEqual({
      sourceBranch: 'alias-source',
      targetBranch: 'main',
      autoDetectedSource: false,
      defaultedTarget: true,
    });
  });

  test('uses current branch when source is omitted', () => {
    expect(resolvePullRequestCreateBranches({}, 'current-branch')).toEqual({
      sourceBranch: 'current-branch',
      targetBranch: 'main',
      autoDetectedSource: true,
      defaultedTarget: true,
    });
  });

  test('treats empty branch arguments as omitted', () => {
    expect(
      resolvePullRequestCreateBranches(
        { head: '', base: '', source: undefined, target: undefined },
        'current-branch'
      )
    ).toEqual({
      sourceBranch: 'current-branch',
      targetBranch: 'main',
      autoDetectedSource: true,
      defaultedTarget: true,
    });
  });

  test('rejects missing source when current branch cannot be detected', () => {
    expect(() => resolvePullRequestCreateBranches({}, null)).toThrow(
      'Could not detect current branch'
    );
  });
});

describe('buildPullRequestCreateOperationRequest', () => {
  test('maps CLI arguments into provider-neutral create intent', () => {
    expect(
      buildPullRequestCreateOperationRequest(
        {
          title: 'New PR',
          draft: true,
          tag: ['ready'],
          format: 'text',
        },
        'New body',
        {
          sourceBranch: 'feature/new-pr',
          targetBranch: 'main',
        }
      )
    ).toEqual({
      title: 'New PR',
      description: 'New body',
      sourceBranch: 'feature/new-pr',
      targetBranch: 'main',
      draft: true,
      labels: ['ready'],
    });
  });

  test('uses an empty description when body input is omitted', () => {
    expect(
      buildPullRequestCreateOperationRequest(
        { title: 'New PR', draft: false, tag: [], format: 'text' },
        undefined,
        {
          sourceBranch: 'feature/new-pr',
          targetBranch: 'main',
        }
      )
    ).toEqual({
      title: 'New PR',
      description: '',
      sourceBranch: 'feature/new-pr',
      targetBranch: 'main',
      draft: false,
    });
  });
});

describe('selectPullRequestCreateTarget', () => {
  test('prefers GitHub remote discovery even when explicit repo flags are present', () => {
    expect(
      selectPullRequestCreateTarget(
        { project: 'Platform', repo: 'widgets' },
        'git@github.com:acme/widgets.git'
      )
    ).toEqual({
      kind: 'remote',
      remoteUrl: 'git@github.com:acme/widgets.git',
    });
  });

  test('uses explicit repository flags for non-GitHub remotes', () => {
    expect(
      selectPullRequestCreateTarget(
        { project: 'Platform', repo: 'widgets' },
        'git@ssh.dev.azure.com:v3/acme/Other/other'
      )
    ).toEqual({ kind: 'repository' });
  });

  test('falls back to remote discovery when no explicit repository flags are present', () => {
    expect(
      selectPullRequestCreateTarget(
        {},
        'git@ssh.dev.azure.com:v3/acme/Platform/widgets'
      )
    ).toEqual({
      kind: 'remote',
      remoteUrl: 'git@ssh.dev.azure.com:v3/acme/Platform/widgets',
    });
  });

  test('reports missing context when neither remote nor explicit repository flags exist', () => {
    expect(selectPullRequestCreateTarget({}, null)).toEqual({
      kind: 'missing',
    });
  });
});

describe('formatPullRequestCreateOutput', () => {
  test('renders provider-neutral json for created pull requests', () => {
    const output = JSON.parse(
      formatPullRequestCreateOutput(createResult, 'json')
    );

    expect(output).toMatchObject({
      success: true,
      repositoryLabel: 'github.com/acme/widgets',
      pullRequest: {
        id: 17,
        title: 'New PR',
        sourceBranch: 'feature/new-pr',
        targetBranch: 'main',
        labels: ['ready'],
      },
      warnings: ['Failed to add labels: denied'],
    });
  });

  test('renders text output with created PR details', () => {
    const output = formatPullRequestCreateOutput(createResult, 'text');

    expect(output).toContain('Pull Request Created Successfully!');
    expect(output).toContain('PR #17: New PR');
    expect(output).toContain('Repository: github.com/acme/widgets');
    expect(output).toContain('Labels: ready');
  });
});
