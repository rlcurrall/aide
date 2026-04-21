/**
 * Jira raw API passthrough command.
 * Mirrors `gh api` ergonomics. Reuses Jira credentials from keyring/env.
 */

import type { ArgumentsCamelCase, Argv, CommandModule } from 'yargs';
import { loadConfig } from '@lib/config.js';
import { buildRequest } from '@lib/jira-api.js';
import { validateArgs } from '@lib/validation.js';
import { ApiArgsSchema, type ApiArgs } from '@schemas/jira/api.js';
import { handleCommandError } from '@lib/errors.js';

async function readBody(spec: string | undefined): Promise<string | undefined> {
  if (spec === undefined) return undefined;
  if (spec === '-') {
    // Read full stdin
    const chunks: Uint8Array[] = [];
    for await (const chunk of Bun.stdin.stream()) {
      chunks.push(chunk);
    }
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.length;
    }
    return new TextDecoder().decode(merged);
  }
  return await Bun.file(spec).text();
}

async function handler(argv: ArgumentsCamelCase<ApiArgs>): Promise<void> {
  try {
    const args = validateArgs(ApiArgsSchema, argv, 'api arguments');
    const { config } = await loadConfig();

    const body = await readBody(args.input);
    const { url, init } = buildRequest(config, {
      endpoint: args.endpoint,
      method: args.method,
      stringFields: args.field,
      typedFields: args.rawField,
      headers: args.header,
      body,
    });

    const response = await fetch(url, { ...init, redirect: 'manual' });
    const text = await response.text();
    if (text.length > 0) {
      process.stdout.write(text);
      if (!text.endsWith('\n')) process.stdout.write('\n');
    }

    if (!response.ok) {
      process.exit(1);
    }
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
          'Typed field (key=value) — numbers, booleans, null. Repeatable.',
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
      ) as unknown as Argv<ApiArgs>, // Double cast required: yargs infers 'raw-field' (kebab) from the
  // CLI option literal, but ApiArgs uses 'rawField' (camel). Not an established
  // pattern—single cast works elsewhere where flag names already match.
  handler,
} satisfies CommandModule<object, ApiArgs>;
