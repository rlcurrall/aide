/**
 * `aide logout <service>` - remove stored credentials for a service.
 *
 * Env vars are never touched; this operation only affects the OS keyring.
 */

import type { ArgumentsCamelCase, CommandModule } from 'yargs';

import {
  deleteSecret,
  type SecretName,
} from '@lib/secrets.js';

export type LogoutResult = 'removed' | 'not-found';

export async function logout(service: SecretName): Promise<LogoutResult> {
  const existed = await deleteSecret(service);
  return existed ? 'removed' : 'not-found';
}

interface Args {
  service: SecretName;
}

const command: CommandModule<object, Args> = {
  command: 'logout <service>',
  describe: 'Remove stored credentials from the OS keyring',
  builder: {
    service: {
      type: 'string',
      choices: ['jira', 'ado', 'github'] as const,
      demandOption: true,
      describe: 'Service to log out of',
    },
  },
  handler: async (argv: ArgumentsCamelCase<Args>) => {
    const result = await logout(argv.service);
    if (result === 'removed') {
      console.log(`Removed stored credentials for ${argv.service}.`);
    } else {
      console.log(`No stored credentials for ${argv.service}.`);
    }
  },
};

export default command;
