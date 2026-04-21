/**
 * Jira raw API passthrough command.
 * Mirrors `gh api` ergonomics. Reuses Jira credentials from keyring/env.
 */

import type { ArgumentsCamelCase, Argv, CommandModule } from 'yargs';
import { validateArgs } from '@lib/validation.js';
import { ApiArgsSchema, type ApiArgs } from '@schemas/jira/api.js';
import { handleCommandError } from '@lib/errors.js';

async function handler(argv: ArgumentsCamelCase<ApiArgs>): Promise<void> {
  try {
    const args = validateArgs(ApiArgsSchema, argv, 'api arguments');
    // TODO(Task 5): load config, build request, fetch, stream body to stdout
    console.log(JSON.stringify(args, null, 2));
  } catch (error) {
    handleCommandError(error);
  }
}

export default {
  command: 'api <endpoint>',
  describe: 'Make an authenticated raw request to the Jira REST API',
  builder: (yargs) =>
    yargs
      .positional('endpoint', {
        type: 'string',
        describe:
          'Path (e.g., rest/api/3/myself) or absolute URL on the configured Jira host',
        demandOption: true,
      })
      .option('method', {
        alias: 'X',
        type: 'string',
        choices: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] as const,
        default: 'GET' as const,
        describe: 'HTTP method',
      })
      .option('field', {
        alias: 'f',
        type: 'string',
        array: true,
        default: [] as string[],
        describe:
          'String field (key=value). Querystring on GET/HEAD/DELETE, JSON body otherwise. Repeatable.',
      })
      .option('raw-field', {
        alias: 'F',
        type: 'string',
        array: true,
        default: [] as string[],
        describe:
          'Typed field (key=value) — numbers, booleans, null, or @file. Repeatable.',
      })
      .option('header', {
        alias: 'H',
        type: 'string',
        array: true,
        default: [] as string[],
        describe: 'Extra header (Name: Value). Repeatable.',
      })
      .option('input', {
        type: 'string',
        describe:
          'Raw request body from file path, or "-" for stdin. Overrides -f/-F body fields.',
      })
      .example('$0 jira api rest/api/3/myself', 'Get the current user')
      .example(
        '$0 jira api -X POST rest/api/3/issue --input body.json',
        'POST a raw JSON body from a file'
      )
      .example(
        'echo \'{"body":"hi"}\' | $0 jira api -X POST rest/api/3/issue/PROJ-1/comment --input -',
        'POST a JSON body from stdin'
      ) as unknown as Argv<ApiArgs>,
  handler,
} satisfies CommandModule<object, ApiArgs>;
