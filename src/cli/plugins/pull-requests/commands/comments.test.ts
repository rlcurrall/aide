import { describe, expect, test } from 'bun:test';

import type { AidePullRequestCommentsResult } from '@cli/host/plugin-descriptor.js';
import {
  filterPullRequestCommentThreads,
  formatPullRequestCommentsOutput,
} from './comments.js';

const commentsResult: AidePullRequestCommentsResult = {
  repository: {
    kind: 'github',
    host: 'github.com',
    owner: 'acme',
    repo: 'widgets',
  },
  repositoryLabel: 'github.com/acme/widgets',
  pullRequest: { number: 7 },
  threads: [
    {
      id: 10,
      status: 'active',
      filePath: 'src/index.ts',
      lineNumber: 12,
      rootComment: {
        id: 1,
        kind: 'review',
        author: { displayName: 'Ada Lovelace', email: 'ada@example.com' },
        body: 'Please change this',
        createdAt: '2026-01-01T00:00:00Z',
        filePath: 'src/index.ts',
        lineNumber: 12,
      },
      replies: [
        {
          id: 2,
          kind: 'reply',
          author: { displayName: 'Grace Hopper' },
          body: 'Done',
          createdAt: '2026-01-02T00:00:00Z',
          parentId: 1,
        },
        {
          id: 3,
          kind: 'system',
          author: { displayName: 'Build Service' },
          body: 'Status changed',
          createdAt: '2026-01-03T00:00:00Z',
          parentId: 1,
          providerType: 'system',
        },
      ],
    },
    {
      id: 'issue-20',
      rootComment: {
        id: 20,
        kind: 'issue',
        author: { displayName: 'Linus Torvalds' },
        body: 'General comment',
        createdAt: '2026-01-04T00:00:00Z',
      },
      replies: [],
    },
  ],
};

describe('filterPullRequestCommentThreads', () => {
  test('filters system comments by default and matches authors across replies', () => {
    const threads = filterPullRequestCommentThreads(commentsResult.threads, {
      author: 'grace',
    });

    expect(threads).toEqual([
      {
        id: 10,
        status: 'active',
        filePath: 'src/index.ts',
        lineNumber: 12,
        replies: [
          {
            id: 2,
            kind: 'reply',
            author: { displayName: 'Grace Hopper' },
            body: 'Done',
            createdAt: '2026-01-02T00:00:00Z',
            parentId: 1,
          },
        ],
      },
    ]);
  });

  test('keeps system comments when requested and honors latest ordering', () => {
    const threads = filterPullRequestCommentThreads(commentsResult.threads, {
      includeSystem: true,
      latest: 1,
    });

    expect(threads).toEqual([
      {
        id: 'issue-20',
        rootComment: {
          id: 20,
          kind: 'issue',
          author: { displayName: 'Linus Torvalds' },
          body: 'General comment',
          createdAt: '2026-01-04T00:00:00Z',
        },
        replies: [],
      },
    ]);
  });

  test('does not apply thread status filters to providers without thread status', () => {
    const threads = filterPullRequestCommentThreads(commentsResult.threads, {
      threadStatus: 'active',
    });

    expect(threads.map((thread) => thread.id)).toEqual(['issue-20', 10]);
  });
});

describe('formatPullRequestCommentsOutput', () => {
  test('renders normalized json with totals', () => {
    const threads = filterPullRequestCommentThreads(commentsResult.threads, {});
    const output = JSON.parse(
      formatPullRequestCommentsOutput(commentsResult, threads, 'json')
    );

    expect(output).toMatchObject({
      prId: 7,
      repositoryLabel: 'github.com/acme/widgets',
      total: 3,
      threads: [
        {
          id: 'issue-20',
          rootComment: {
            author: { displayName: 'Linus Torvalds' },
            body: 'General comment',
          },
        },
        {
          id: 10,
          replies: [
            {
              author: { displayName: 'Grace Hopper' },
              body: 'Done',
            },
          ],
        },
      ],
    });
  });

  test('renders an empty markdown result', () => {
    expect(
      formatPullRequestCommentsOutput(commentsResult, [], 'markdown')
    ).toBe('# PR #7 Comments\n\nNo comments found.');
  });
});
