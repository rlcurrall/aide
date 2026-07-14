import { Cause, Effect, Exit, Option } from 'effect';
import yargs from 'yargs';

import {
  AIDE_PLUGIN_API_VERSION,
  defineAideCommand,
  defineAidePlugin,
  emptyResult,
  pluginCommandDescriptor,
  type CommandResult,
} from '@aide/plugin-api';
import { createCommandRegistry } from '@cli/host/command-registry.js';
import { invokePublicCommandEffect } from '@cli/host/public-command-invocation.js';
import { createAideHostServices } from '@cli/host/runtime-context.js';
import { registerCommands } from '@cli/host/yargs-adapter.js';
import { makeTestKeyring } from '@lib/auth-keyring.test-helper.js';

type Mode =
  | 'sync-throw'
  | 'non-effect-proxy'
  | 'revoked-effect-proxy'
  | 'result-proxy'
  | 'result-accessor'
  | 'timeout-finalizer';

const mode = process.argv[2] as Mode;
const secret = `SECRET-PUBLIC-COMMAND-${mode}`;
let trapReads = 0;
let releases = 0;
let uncaughtExceptions = 0;
let unhandledRejections = 0;

process.on('uncaughtException', () => {
  uncaughtExceptions += 1;
});
process.on('unhandledRejection', () => {
  unhandledRejections += 1;
});

function callback(): unknown {
  switch (mode) {
    case 'sync-throw':
      throw new Error(secret);
    case 'non-effect-proxy':
      return new Proxy(
        {},
        {
          get() {
            trapReads += 1;
            throw new Error(secret);
          },
        }
      );
    case 'revoked-effect-proxy': {
      const revoked = Proxy.revocable(Effect.succeed(emptyResult), {});
      revoked.revoke();
      return revoked.proxy;
    }
    case 'result-proxy':
      return Effect.succeed(
        new Proxy(
          {},
          {
            get() {
              trapReads += 1;
              throw new Error(secret);
            },
          }
        )
      );
    case 'result-accessor': {
      const result = Object.create(null) as Record<string, unknown>;
      Object.defineProperty(result, '_tag', {
        get() {
          trapReads += 1;
          throw new Error(secret);
        },
      });
      return Effect.succeed(result);
    }
    case 'timeout-finalizer':
      return Effect.acquireUseRelease(
        Effect.void,
        () => Effect.never,
        () => Effect.sync(() => void (releases += 1))
      );
  }
}

const descriptor = defineAideCommand({
  id: `fixture-${mode}:probe`,
  route: `fixture-${mode}-probe`,
  summary: 'Public command hard-deadline fixture',
  run: callback as () => Effect.Effect<CommandResult, unknown, never>,
});

function failureTag(exit: Exit.Exit<unknown, unknown>): string {
  if (Exit.isSuccess(exit)) return 'Success';
  const failure = Cause.failureOption(exit.cause);
  return Option.isSome(failure) &&
    typeof failure.value === 'object' &&
    failure.value !== null &&
    '_tag' in failure.value
    ? String(failure.value._tag)
    : 'Cause';
}

async function execute(): Promise<Record<string, unknown>> {
  if (mode === 'timeout-finalizer') {
    const exit = await Effect.runPromiseExit(
      invokePublicCommandEffect(
        descriptor,
        {},
        createAideHostServices(createCommandRegistry())
      ).pipe(
        Effect.timeoutFail({
          duration: '20 millis',
          onTimeout: () => 'fixture-timeout' as const,
        })
      )
    );
    return { kind: failureTag(exit) };
  }

  const registry = createCommandRegistry();
  registry.registerExternalPlugin(
    defineAidePlugin({
      id: `fixture-${mode}`,
      summary: 'Public command hard-deadline fixture',
      commands: [pluginCommandDescriptor(descriptor)],
    }),
    {
      manifest: {
        id: `fixture-${mode}`,
        version: '1.0.0',
        aidePluginApiVersion: AIDE_PLUGIN_API_VERSION,
        capabilities: ['commands'],
      },
    }
  );
  try {
    await registerCommands(
      yargs([`fixture-${mode}-probe`])
        .scriptName('aide')
        .exitProcess(false),
      registry,
      { keyringLayer: makeTestKeyring().layer }
    )
      .strict()
      .showHelpOnFail(false)
      .fail((_message, error) => {
        throw error ?? new Error('unexpected yargs validation failure');
      })
      .parseAsync();
    return { kind: 'unexpected-success' };
  } catch (error) {
    return {
      kind: 'PublicCommandHostError',
      safe: !String(error).includes(secret),
    };
  }
}

try {
  const outcome = await execute();
  await Promise.resolve();
  await Bun.sleep(0);
  console.log(
    JSON.stringify({
      ok: true,
      mode,
      safe: outcome.safe ?? true,
      trapReads,
      releases,
      uncaughtExceptions,
      unhandledRejections,
      ...outcome,
    })
  );
} catch {
  await Promise.resolve();
  await Bun.sleep(0);
  console.log(
    JSON.stringify({
      ok: false,
      mode,
      safe: false,
      trapReads,
      releases,
      uncaughtExceptions,
      unhandledRejections,
      kind: 'escaped-runtime-rejection',
    })
  );
}
