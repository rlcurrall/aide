import { afterEach, describe, expect, test } from 'bun:test';

import { AzureDevOpsClient } from './azure-devops-client.js';

const originalFetch = globalThis.fetch;
const config = {
  orgUrl: 'https://dev.azure.com/acme',
  pat: 'signal-test-token',
  authMethod: 'pat' as const,
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('AzureDevOpsClient AbortSignal transport contract', () => {
  test('forwards one signal through PR reads and create/update/comment/reply fetches', async () => {
    const seenSignals: Array<AbortSignal | null | undefined> = [];
    globalThis.fetch = (async (
      _input: string | URL | Request,
      init?: RequestInit
    ) => {
      seenSignals.push(init?.signal);
      return Response.json({ value: [], comments: [] });
    }) as typeof fetch;
    const client = new AzureDevOpsClient(config);
    const controller = new AbortController();

    await client.getPullRequest('Platform', 'widgets', 7, controller.signal);
    await client.createPullRequest(
      'Platform',
      'widgets',
      'refs/heads/feature',
      'refs/heads/main',
      'Title',
      'Body',
      {},
      controller.signal
    );
    await client.updatePullRequest(
      'Platform',
      'widgets',
      7,
      { title: 'Updated' },
      controller.signal
    );
    await client.createPullRequestThread(
      'Platform',
      'widgets',
      7,
      'Comment',
      undefined,
      controller.signal
    );
    await client.createThreadComment(
      'Platform',
      'widgets',
      7,
      11,
      'Reply',
      undefined,
      controller.signal
    );

    expect(seenSignals).toEqual(Array(5).fill(controller.signal));
  });

  test('aborting a read cancels fetch and prevents post-exit completion', async () => {
    let aborted = 0;
    let completed = 0;
    globalThis.fetch = (async (
      _input: string | URL | Request,
      init?: RequestInit
    ) =>
      new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => {
          completed += 1;
          resolve(Response.json({ pullRequestId: 7 }));
        }, 40);
        init?.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            aborted += 1;
            reject(init.signal?.reason);
          },
          { once: true }
        );
      })) as typeof fetch;
    const client = new AzureDevOpsClient(config);
    const controller = new AbortController();
    const pending = client.getPullRequest(
      'Platform',
      'widgets',
      7,
      controller.signal
    );
    controller.abort();

    expect(
      await pending.then(
        () => 'resolved',
        () => 'rejected'
      )
    ).toBe('rejected');
    expect({ aborted, completed }).toEqual({ aborted: 1, completed: 0 });
    await Bun.sleep(60);
    expect({ aborted, completed }).toEqual({ aborted: 1, completed: 0 });
  });

  test('label list/add/delete operations preserve method and signal', async () => {
    const requests: Array<{
      readonly url: string;
      readonly method: string | undefined;
      readonly signal: AbortSignal | null | undefined;
    }> = [];
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      requests.push({
        url: String(input),
        method: init?.method,
        signal: init?.signal,
      });
      return init?.method === 'DELETE'
        ? new Response(null, { status: 204 })
        : Response.json({ value: [], id: 'label-id', name: 'ready' });
    }) as typeof fetch;
    const client = new AzureDevOpsClient(config);
    const controller = new AbortController();

    await client.getPullRequestLabels(
      'Platform',
      'widgets',
      7,
      controller.signal
    );
    await client.addPullRequestLabel(
      'Platform',
      'widgets',
      7,
      'ready',
      controller.signal
    );
    await client.removePullRequestLabel(
      'Platform',
      'widgets',
      7,
      'label-id',
      controller.signal
    );

    expect(requests.map(({ method }) => method)).toEqual([
      'GET',
      'POST',
      'DELETE',
    ]);
    expect(requests.map(({ url }) => url)).toEqual([
      'https://dev.azure.com/acme/Platform/_apis/git/repositories/widgets/pullRequests/7/labels?api-version=7.1',
      'https://dev.azure.com/acme/Platform/_apis/git/repositories/widgets/pullRequests/7/labels?api-version=7.1',
      'https://dev.azure.com/acme/Platform/_apis/git/repositories/widgets/pullRequests/7/labels/label-id?api-version=7.1',
    ]);
    expect(requests.every(({ signal }) => signal === controller.signal)).toBe(
      true
    );
  });

  test('iteration/change pagination preserves one signal across every page', async () => {
    const signals: Array<AbortSignal | null | undefined> = [];
    const urls: string[] = [];
    let changePage = 0;
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const url = String(input);
      urls.push(url);
      signals.push(init?.signal);
      if (url.includes('/iterations?')) {
        return Response.json({ value: [{ id: 3 }, { id: 7 }] });
      }
      changePage += 1;
      return Response.json(
        changePage === 1
          ? {
              changeEntries: Array.from({ length: 100 }, (_, index) => ({
                changeTrackingId: index,
              })),
              nextSkip: 100,
            }
          : {
              changeEntries: [{ changeTrackingId: 100 }],
            }
      );
    }) as typeof fetch;
    const client = new AzureDevOpsClient(config);
    const controller = new AbortController();

    const changes = await client.getAllPullRequestChanges(
      'Platform',
      'widgets',
      7,
      controller.signal
    );

    expect(changes).toHaveLength(101);
    expect(urls).toHaveLength(3);
    expect(urls[1]).toContain('/iterations/7/changes?');
    expect(urls[1]).toContain('%24top=100');
    expect(urls[2]).toContain('%24skip=100');
    expect(signals).toEqual(Array(3).fill(controller.signal));
  });

  test('composite comment flattening forwards its signal to thread lookup', async () => {
    const signals: Array<AbortSignal | null | undefined> = [];
    globalThis.fetch = (async (
      _input: string | URL | Request,
      init?: RequestInit
    ) => {
      signals.push(init?.signal);
      return Response.json({
        value: [
          {
            id: 11,
            status: 1,
            comments: [
              {
                id: 12,
                parentCommentId: 0,
                author: { displayName: 'Ada' },
                content: 'Comment',
                publishedDate: '2026-01-01T00:00:00Z',
                lastUpdatedDate: '2026-01-01T00:00:00Z',
                commentType: 1,
              },
            ],
          },
        ],
      });
    }) as typeof fetch;
    const client = new AzureDevOpsClient(config);
    const controller = new AbortController();

    const comments = await client.getAllComments(
      'Platform',
      'widgets',
      7,
      controller.signal
    );

    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ threadId: 11, comment: { id: 12 } });
    expect(signals).toEqual([controller.signal]);
  });
});
