import { describe, expect, test } from 'bun:test';
import type { ArgumentsCamelCase, CommandModule } from 'yargs';
import yargs from 'yargs';

import type { AidePullRequestViewResult } from '@cli/host/plugin-descriptor.js';
import type { ViewArgs } from '@schemas/pr/view.js';
import viewCommand, { formatPullRequestViewOutput } from './view.js';

async function parseViewArgs(
  args: readonly string[]
): Promise<ArgumentsCamelCase<ViewArgs>> {
  let parsed: ArgumentsCamelCase<ViewArgs> | undefined;
  const command = {
    ...viewCommand,
    handler: (argv: ArgumentsCamelCase<ViewArgs>) => {
      parsed = argv;
    },
  } satisfies CommandModule<object, ViewArgs>;

  await yargs([...args])
    .scriptName('aide pr')
    .command(command)
    .demandCommand(1)
    .strict()
    .exitProcess(false)
    .parseAsync();

  if (parsed === undefined) {
    throw new Error('Expected view command handler to run');
  }

  return parsed;
}

describe('pr view command parsing', () => {
  test('accepts a pull request id as an optional positional', async () => {
    const argv = await parseViewArgs(['view', '10']);

    expect(argv.pr).toBe('10');
  });

  test('continues to accept --pr for compatibility', async () => {
    const argv = await parseViewArgs(['view', '--pr', '10']);

    expect(argv.pr).toBe('10');
  });
});

describe('formatPullRequestViewOutput', () => {
  test('does not duplicate draft status in text output', () => {
    const output = formatPullRequestViewOutput(
      pullRequestViewResult({ status: 'draft', draft: true }),
      'text'
    );

    expect(output).toContain('Status:     draft\n');
    expect(output).not.toContain('draft (draft)');
  });

  test('still annotates non-draft status when a provider reports a draft flag', () => {
    const output = formatPullRequestViewOutput(
      pullRequestViewResult({ status: 'active', draft: true }),
      'text'
    );

    expect(output).toContain('Status:     active (draft)\n');
  });
});

function pullRequestViewResult(
  overrides: Partial<AidePullRequestViewResult['pullRequest']>
): AidePullRequestViewResult {
  return {
    repository: {
      kind: 'github',
      host: 'github.com',
      owner: 'acme',
      repo: 'widgets',
    },
    repositoryLabel: 'github.com/acme/widgets',
    pullRequest: {
      id: 10,
      title: 'Feature',
      status: 'active',
      createdAt: '2026-01-01T00:00:00Z',
      author: { displayName: 'Ada' },
      ...overrides,
    },
  };
}
