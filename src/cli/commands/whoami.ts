/**
 * `aide whoami [service]` - show which credentials are configured and where
 * they come from. Never prints tokens.
 *
 * For github, we report `gh-cli` if the gh CLI is authenticated, otherwise
 * fall back to the same env/keyring check as other services. No network calls.
 */

import { Effect } from 'effect';
import type { CommandModule } from 'yargs';

import { commandModuleFromDescriptor } from '@cli/host/yargs-adapter.js';
import {
  defineAideCommand,
  textResult,
  type AideCommandDescriptor,
  type CommandResult,
} from '@cli/host/command-descriptor.js';

import {
  buildWhoamiOutputEffect,
  getWhoamiStatusEffect,
  makeWhoamiConfigLayer,
  type ServiceName,
  type WhoamiError,
  type WhoamiStatus,
} from './whoami-program.js';

export {
  buildWhoamiOutputEffect,
  formatWhoamiOutput,
  getWhoamiStatusEffect,
  makeWhoamiConfigLayer,
  WhoamiConfigService,
  WhoamiConfigReadError,
  type ServiceName,
  type WhoamiConfigServiceShape,
  type WhoamiError,
  type WhoamiSource,
  type WhoamiStatus,
} from './whoami-program.js';

export async function getWhoamiStatus(
  opts: { ghAvailable?: () => boolean } = {}
): Promise<WhoamiStatus[]> {
  return Effect.runPromise(
    getWhoamiStatusEffect.pipe(Effect.provide(makeWhoamiConfigLayer(opts)))
  );
}

/**
 * Compose the full whoami output, including a migration hint when any
 * service is sourced from env vars. Exported for tests.
 *
 * Two tip flavors:
 *  - env-only (keyring empty): suggest running `aide login <svc> --from-env`
 *  - env+keyring (migration already done): list the env vars overriding the
 *    keyring and suggest unsetting them
 */
export async function buildWhoamiOutput(
  opts: { ghAvailable?: () => boolean; service?: ServiceName } = {}
): Promise<string> {
  return Effect.runPromise(
    buildWhoamiOutputEffect({ service: opts.service }).pipe(
      Effect.provide(makeWhoamiConfigLayer({ ghAvailable: opts.ghAvailable }))
    )
  );
}

interface Args {
  service?: ServiceName;
}

export function buildWhoamiCommandEffect(
  opts: { ghAvailable?: () => boolean; service?: ServiceName } = {}
): Effect.Effect<CommandResult, WhoamiError, never> {
  return buildWhoamiOutputEffect({ service: opts.service }).pipe(
    Effect.map(textResult),
    Effect.provide(makeWhoamiConfigLayer({ ghAvailable: opts.ghAvailable }))
  );
}

export function makeWhoamiCommandDescriptor(
  opts: { ghAvailable?: () => boolean } = {}
): AideCommandDescriptor<Args, WhoamiError, never> {
  return defineAideCommand<Args, WhoamiError, never>({
    id: 'whoami',
    route: 'whoami [service]',
    summary: 'Show configured credentials and their source',
    yargs: {
      builder: {
        service: {
          type: 'string',
          choices: ['jira', 'ado', 'github'] as const,
          describe: 'Limit output to a single service',
        },
      },
    },
    run: (argv) =>
      buildWhoamiCommandEffect({
        ghAvailable: opts.ghAvailable,
        service: argv.service,
      }),
  });
}

export const whoamiCommandDescriptor = makeWhoamiCommandDescriptor();

const command: CommandModule<object, Args> = commandModuleFromDescriptor(
  whoamiCommandDescriptor
);

/*
 * Keep the default export as a yargs CommandModule while the host registry
 * moves from legacy modules toward internal plugin descriptors.
 */
export default command;
