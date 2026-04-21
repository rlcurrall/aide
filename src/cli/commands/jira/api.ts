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
  if (spec === '-') return await Bun.stdin.text();
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

    // redirect: 'manual' keeps the basic-auth header from being replayed to
    // a different origin on a 3xx. resolveEndpoint already vets the initial
    // host; don't undo that by following redirects implicitly.
    const response = await fetch(url, { ...init, redirect: 'manual' });

    if (response.status >= 300 && response.status < 400) {
      process.stderr.write(
        `Warning: Jira returned ${response.status}; redirect not followed (credentials are not replayed across origins).\n`
      );
    }

    // Stream the raw response to stdout as bytes — no text decode, no newline
    // mutation. Keeps binary endpoints (attachments, thumbnails) intact and
    // matches `gh api` passthrough semantics.
    const buf = new Uint8Array(await response.arrayBuffer());
    if (buf.length > 0) {
      process.stdout.write(buf);
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
          'String field (key=value). Querystring on GET/HEAD/DELETE, JSON body otherwise. Repeatable; duplicate keys produce an array.',
      })
      .option('raw-field', {
        alias: 'F',
        type: 'string',
        array: true,
        default: [] as string[],
        describe:
          'Typed field (key=value) — numbers, booleans, null. Repeatable; duplicate keys produce an array.',
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
          'Raw request body from file path, or "-" for stdin. Incompatible with GET/HEAD/DELETE and with -f/-F on body methods.',
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
  // Yargs infers the `raw-field` literal as a kebab-case key, but the schema
  // uses `rawField` (camel) to match yargs' camel-case-expansion of argv.
  // Runtime is fine — argv gets both keys — but the inferred Argv shape
  // doesn't line up with ApiArgs, so we coerce here. Switching the builder
  // key to `rawField` would drop this cast but would surface `--rawField`
  // in help instead of `--raw-field`, off-style for the rest of aide.
  handler,
} satisfies CommandModule<object, ApiArgs>;
