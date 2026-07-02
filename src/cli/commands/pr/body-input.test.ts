import { describe, expect, test } from 'bun:test';
import type { Options } from 'yargs';
import yargs from 'yargs/yargs';

import prCreateCommand from './pr-create.js';
import prUpdateCommand from './pr-update.js';
import {
  decodePullRequestBodyChunks,
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

function builderOption(command: { builder?: unknown }, optionName: string) {
  if (!command.builder || typeof command.builder !== 'object') {
    throw new Error('Expected command to use an object builder');
  }

  const option = (command.builder as Record<string, Options | undefined>)[
    optionName
  ];
  if (!option) {
    throw new Error(`Expected command builder to define ${optionName}`);
  }

  return option;
}

async function parseBuilderOption(
  optionName: string,
  option: Options,
  args: string[]
) {
  return yargs(args).exitProcess(false).option(optionName, option).parse();
}

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

  test('decodes UTF-8 after joining chunks so split multi-byte characters survive', () => {
    const body = Buffer.from('Summary 😀 done', 'utf8');

    expect(
      decodePullRequestBodyChunks([body.subarray(0, 11), body.subarray(11)])
    ).toBe('Summary 😀 done');
  });

  test('rejects empty body file paths with an alias-safe message', () => {
    expect(() =>
      selectPullRequestBodyInputSource({ 'description-file': '' })
    ).toThrow('PR body file path cannot be empty');
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

describe('PR body yargs builders', () => {
  test('pr create accepts dash as a body-file stdin value', async () => {
    const argv = await parseBuilderOption(
      'body-file',
      builderOption(prCreateCommand, 'body-file'),
      ['--body-file', '-']
    );

    expect(argv._).toEqual([]);
    expect(argv.bodyFile).toBe('-');
    expect(argv['body-file']).toBe('-');
    expect(argv.descriptionFile).toBe('-');
    expect(argv['description-file']).toBe('-');
  });

  test('pr create accepts dash as an inline body value', async () => {
    const argv = await parseBuilderOption(
      'body',
      builderOption(prCreateCommand, 'body'),
      ['--body', '-']
    );

    expect(argv._).toEqual([]);
    expect(argv.body).toBe('-');
    expect(argv.description).toBe('-');
  });

  test('pr update accepts dash as a description-file stdin value', async () => {
    const argv = await parseBuilderOption(
      'description-file',
      builderOption(prUpdateCommand, 'description-file'),
      ['--description-file', '-']
    );

    expect(argv._).toEqual([]);
    expect(argv.descriptionFile).toBe('-');
    expect(argv['description-file']).toBe('-');
    expect(argv.bodyFile).toBe('-');
    expect(argv['body-file']).toBe('-');
  });

  test('pr update accepts dash as an inline description value', async () => {
    const argv = await parseBuilderOption(
      'description',
      builderOption(prUpdateCommand, 'description'),
      ['--description', '-']
    );

    expect(argv._).toEqual([]);
    expect(argv.description).toBe('-');
    expect(argv.body).toBe('-');
  });
});
