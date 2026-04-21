/**
 * Jira raw API passthrough command.
 * Mirrors `gh api` ergonomics. Reuses Jira credentials from keyring/env.
 */

import type { ArgumentsCamelCase, CommandModule } from 'yargs';
import { loadConfig } from '@lib/config.js';
import { buildRequest, validateRequestShape } from '@lib/jira-api.js';
import { validateArgs } from '@lib/validation.js';
import { ApiArgsSchema, type ApiArgs } from '@schemas/jira/api.js';
import { handleCommandError } from '@lib/errors.js';

async function readBody(spec: string | undefined): Promise<string | undefined> {
  if (spec === undefined) return undefined;
  if (spec === '-') return await Bun.stdin.text();
  return await Bun.file(spec).text();
}

/**
 * Write a chunk to stdout honoring backpressure. Without this, piping a large
 * response into a slow consumer (`| jq .`, `| less`) grows the in-process
 * write buffer and can hit truncation if the process exits before drain.
 */
function writeChunk(chunk: Uint8Array): Promise<void> {
  return new Promise((resolve) => {
    if (process.stdout.write(chunk)) {
      resolve();
    } else {
      process.stdout.once('drain', () => resolve());
    }
  });
}

async function handler(argv: ArgumentsCamelCase<ApiArgs>): Promise<void> {
  try {
    const args = validateArgs(ApiArgsSchema, argv, 'api arguments');
    const { config } = await loadConfig();

    // Fail fast before touching stdin/file — otherwise `GET --input -`
    // blocks on stdin and looks like a deadlock to the caller.
    validateRequestShape({
      method: args.method,
      hasInput: args.input !== undefined,
      hasFields: args.field.length > 0 || args.rawField.length > 0,
    });

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

    // Stream the response body to stdout — keeps memory bounded on large
    // payloads (attachments, exports) and matches `gh api` passthrough
    // semantics. writeChunk awaits drain events so a slow consumer applies
    // real backpressure instead of ballooning the in-process write buffer.
    const stream = response.body;
    if (stream) {
      const reader = stream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) await writeChunk(value);
        }
      } finally {
        reader.releaseLock();
      }
    }

    // Set exit code instead of calling process.exit(1) so stdout has a chance
    // to flush when piped (e.g. `aide jira api ... | jq .`).
    if (!response.ok) {
      process.exitCode = 1;
    }
  } catch (error) {
    handleCommandError(error);
  }
}

const command = {
  command: 'api <endpoint>',
  describe: 'Make an authenticated raw request to the Jira REST API',
  builder: {
    endpoint: {
      type: 'string',
      demandOption: true,
      describe:
        'Path (e.g., rest/api/3/myself) or absolute URL on the configured Jira host',
    },
    method: {
      alias: 'X',
      type: 'string',
      choices: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] as const,
      default: 'GET' as const,
      describe: 'HTTP method',
    },
    field: {
      alias: 'f',
      type: 'string',
      array: true,
      default: [] as string[],
      describe:
        'String field (key=value). Querystring on GET/HEAD/DELETE, JSON body otherwise. Repeatable; duplicate keys produce an array.',
    },
    'raw-field': {
      alias: 'F',
      type: 'string',
      array: true,
      default: [] as string[],
      describe:
        'Typed field (key=value) — numbers, booleans, null. Repeatable; duplicate keys produce an array.',
    },
    header: {
      alias: 'H',
      type: 'string',
      array: true,
      default: [] as string[],
      describe: 'Extra header (Name: Value). Repeatable.',
    },
    input: {
      type: 'string',
      // nargs: 1 forces yargs to consume the next token as the value, even
      // when it's "-" (stdin). Without this, `--input -` triggers the
      // strict-mode "Unknown argument: -" path.
      nargs: 1,
      describe:
        'Raw request body from file path, or "-" for stdin. Incompatible with GET/HEAD/DELETE and with -f/-F on body methods.',
    },
  },
  handler,
} satisfies CommandModule<object, ApiArgs>;

export default command;
