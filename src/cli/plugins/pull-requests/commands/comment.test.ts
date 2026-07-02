import { describe, expect, test } from 'bun:test';

import type { AidePullRequestCommentMutationResult } from '@cli/host/plugin-descriptor.js';
import {
  formatPullRequestCommentMutationOutput,
  validatePullRequestCommentLocation,
} from './comment.js';

const mutationResult: AidePullRequestCommentMutationResult = {
  repository: {
    kind: 'github',
    host: 'github.com',
    owner: 'acme',
    repo: 'widgets',
  },
  repositoryLabel: 'github.com/acme/widgets',
  pullRequest: { number: 7 },
  comment: {
    id: 22,
    kind: 'review',
    author: { displayName: 'Ada Lovelace', username: 'ada' },
    body: 'Use const here',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    url: 'https://github.com/acme/widgets/pull/7#discussion_r22',
    filePath: 'src/index.ts',
    lineNumber: 12,
  },
  thread: {
    id: 22,
    filePath: 'src/index.ts',
    lineNumber: 12,
    rootComment: {
      id: 22,
      kind: 'review',
      author: { displayName: 'Ada Lovelace', username: 'ada' },
      body: 'Use const here',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      url: 'https://github.com/acme/widgets/pull/7#discussion_r22',
      filePath: 'src/index.ts',
      lineNumber: 12,
    },
    replies: [],
  },
};

describe('formatPullRequestCommentMutationOutput', () => {
  test('renders provider-neutral json for created comments', () => {
    const output = JSON.parse(
      formatPullRequestCommentMutationOutput(mutationResult, 'json', {
        action: 'comment',
      })
    );

    expect(output).toMatchObject({
      success: true,
      action: 'comment',
      prId: 7,
      repositoryLabel: 'github.com/acme/widgets',
      comment: {
        id: 22,
        kind: 'review',
        body: 'Use const here',
        filePath: 'src/index.ts',
        lineNumber: 12,
      },
      thread: {
        id: 22,
        rootComment: { id: 22 },
      },
    });
  });

  test('renders reply target metadata in markdown', () => {
    const output = formatPullRequestCommentMutationOutput(
      {
        ...mutationResult,
        comment: {
          ...mutationResult.comment,
          id: 23,
          kind: 'reply',
          parentId: 22,
        },
      },
      'markdown',
      {
        action: 'reply',
        targetId: 22,
      }
    );

    expect(output).toContain('# Reply Posted Successfully');
    expect(output).toContain('- **In Reply To:** 22');
    expect(output).toContain('- **Comment ID:** 23');
    expect(output).toContain('Use const here');
  });
});

describe('validatePullRequestCommentLocation', () => {
  test('accepts general comments and valid file ranges', () => {
    expect(() => validatePullRequestCommentLocation({})).not.toThrow();
    expect(() =>
      validatePullRequestCommentLocation({
        file: 'src/index.ts',
        line: 10,
        endLine: 12,
      })
    ).not.toThrow();
  });

  test('requires file and line together', () => {
    expect(() =>
      validatePullRequestCommentLocation({ file: 'src/index.ts' })
    ).toThrow('--line is required when --file is specified');
    expect(() => validatePullRequestCommentLocation({ line: 10 })).toThrow(
      '--file is required when --line is specified'
    );
  });

  test('rejects empty files and inverted ranges', () => {
    expect(() => validatePullRequestCommentLocation({ file: '   ' })).toThrow(
      '--file cannot be empty'
    );
    expect(() =>
      validatePullRequestCommentLocation({
        file: 'src/index.ts',
        line: 12,
        endLine: 10,
      })
    ).toThrow('--end-line must be greater than or equal to --line');
  });
});
