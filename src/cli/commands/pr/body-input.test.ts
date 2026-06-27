import { describe, expect, test } from 'bun:test';

import {
  normalizePullRequestBodyText,
  resolvePullRequestBodyInput,
  selectPullRequestBodyInputSource,
  type PullRequestBodyInputReaders,
} from './body-input.js';

const markdownBody = [
  '## Summary',
  '',
  '- first line',
  '- second line',
  '',
  '## Validation',
  '',
  '- bun test',
].join('\n');

describe('resolvePullRequestBodyInput', () => {
  test('selects direct text input without readers', () => {
    expect(selectPullRequestBodyInputSource({ body: markdownBody })).toEqual({
      kind: 'text',
      text: markdownBody,
    });
  });

  test('selects file input without reading the file', () => {
    expect(
      selectPullRequestBodyInputSource({ bodyFile: '/tmp/pr-body.md' })
    ).toEqual({
      kind: 'file',
      path: '/tmp/pr-body.md',
    });
  });

  test('normalizes escaped newlines as a pure string transform', () => {
    expect(normalizePullRequestBodyText('## Summary\\n\\n- fixed')).toBe(
      '## Summary\n\n- fixed'
    );
  });

  test('returns direct body text unchanged, including real newlines', async () => {
    await expect(
      resolvePullRequestBodyInput({ body: markdownBody })
    ).resolves.toBe(markdownBody);
  });

  test('reads PR create body from --body-file with newlines preserved', async () => {
    const readers: PullRequestBodyInputReaders = {
      readTextFile: async (path) => `file:${path}\n${markdownBody}`,
      readStdin: async () => {
        throw new Error('stdin should not be read when body-file is set');
      },
    };

    await expect(
      resolvePullRequestBodyInput({ bodyFile: '/tmp/pr-body.md' }, readers)
    ).resolves.toBe(`file:/tmp/pr-body.md\n${markdownBody}`);
  });

  test('reads PR update description from --description-file with newlines preserved', async () => {
    const readers: PullRequestBodyInputReaders = {
      readTextFile: async (path) => `description:${path}\n${markdownBody}`,
      readStdin: async () => {
        throw new Error(
          'stdin should not be read when description-file is set'
        );
      },
    };

    await expect(
      resolvePullRequestBodyInput({ descriptionFile: './docs/pr.md' }, readers)
    ).resolves.toBe(`description:./docs/pr.md\n${markdownBody}`);
  });

  test('reads stdin when body-file is dash', async () => {
    const readers: PullRequestBodyInputReaders = {
      readTextFile: async () => {
        throw new Error('file should not be read when body-file is dash');
      },
      readStdin: async () => markdownBody,
    };

    await expect(
      resolvePullRequestBodyInput({ bodyFile: '-' }, readers)
    ).resolves.toBe(markdownBody);
  });

  test('rejects ambiguous direct body and body file input', async () => {
    await expect(
      resolvePullRequestBodyInput({
        body: 'inline',
        bodyFile: '/tmp/pr-body.md',
      })
    ).rejects.toThrow(
      'Use only one of --body/--description or --body-file/--description-file'
    );
  });

  test('decodes literal backslash-n sequences from direct CLI input', async () => {
    await expect(
      resolvePullRequestBodyInput({ body: '## Summary\\n\\n- fixed' })
    ).resolves.toBe('## Summary\n\n- fixed');
  });
});
