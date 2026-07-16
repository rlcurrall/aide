import { describe, expect, test } from 'bun:test';

import type { AidePullRequestUpdateResult } from '@cli/host/plugin-descriptor.js';
import {
  buildPullRequestUpdateOperationRequest,
  formatPullRequestUpdateOutput,
  validatePullRequestUpdateFlags,
} from './update.js';

const updateResult: AidePullRequestUpdateResult = {
  repository: {
    kind: 'github',
    host: 'github.com',
    owner: 'acme',
    repo: 'widgets',
  },
  repositoryLabel: 'github.com/acme/widgets',
  pullRequest: {
    id: 7,
    title: 'Updated PR',
    status: 'active',
    createdAt: '2026-01-01T00:00:00Z',
    author: { displayName: 'Ada Lovelace', username: 'ada' },
    description: 'Updated body',
    sourceBranch: 'feature/update',
    targetBranch: 'main',
    labels: ['ready'],
    url: 'https://github.com/acme/widgets/pull/7',
  },
  warnings: ['Failed to add labels: denied'],
};

describe('buildPullRequestUpdateOperationRequest', () => {
  test('maps CLI flags into provider-neutral update intent', () => {
    expect(
      buildPullRequestUpdateOperationRequest(
        {
          format: 'text',
          title: 'Updated title',
          target: 'develop',
          publish: true,
          activate: true,
          tag: ['ready'],
          removeTag: ['wip'],
        },
        'Updated body'
      )
    ).toEqual({
      title: 'Updated title',
      description: 'Updated body',
      targetBranch: 'develop',
      draft: false,
      status: 'active',
      labelsToAdd: ['ready'],
      labelsToRemove: ['wip'],
    });
  });

  test('uses dashed remove-tag alias when camelCase value is empty', () => {
    expect(
      buildPullRequestUpdateOperationRequest(
        {
          format: 'text',
          tag: [],
          removeTag: [],
          'remove-tag': ['legacy'],
        },
        undefined
      )
    ).toEqual({ labelsToRemove: ['legacy'] });
  });

  test('rejects conflicting lifecycle flags', () => {
    expect(() =>
      validatePullRequestUpdateFlags({ draft: true, publish: true })
    ).toThrow('Cannot use both --draft and --publish flags');
    expect(() =>
      validatePullRequestUpdateFlags({ abandon: true, activate: true })
    ).toThrow('Cannot use both --abandon and --activate flags');
  });

  test('rejects empty updates before provider resolution', () => {
    expect(() =>
      buildPullRequestUpdateOperationRequest(
        { format: 'text', tag: [], removeTag: [] },
        undefined
      )
    ).toThrow('No updates specified');
  });
});

describe('formatPullRequestUpdateOutput', () => {
  test('renders provider-neutral json for updated pull requests', () => {
    const output = JSON.parse(
      formatPullRequestUpdateOutput(updateResult, 'json')
    );

    expect(output).toMatchObject({
      success: true,
      repositoryLabel: 'github.com/acme/widgets',
      pullRequest: {
        id: 7,
        title: 'Updated PR',
        targetBranch: 'main',
        labels: ['ready'],
      },
      warnings: ['Failed to add labels: denied'],
    });
  });

  test('renders text output with updated PR details', () => {
    const output = formatPullRequestUpdateOutput(updateResult, 'text');

    expect(output).toContain('PR #7 Updated');
    expect(output).toContain('Title: Updated PR');
    expect(output).toContain('Created: 2026-01-01 by Ada Lovelace');
    expect(output).toContain('Repository: github.com/acme/widgets');
    expect(output).toContain('Labels: ready');
  });
});
