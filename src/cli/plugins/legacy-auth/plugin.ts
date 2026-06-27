import loginCommand from '@cli/commands/login.js';
import logoutCommand from '@cli/commands/logout.js';
import { whoamiCommandDescriptor } from '@cli/commands/whoami.js';
import {
  defineAidePlugin,
  pluginCommandDescriptor,
  pluginCommandModule,
} from '@cli/host/plugin-descriptor.js';

export const legacyAuthPlugin = defineAidePlugin({
  id: 'legacy-auth',
  summary: 'Transitional centralized credential commands',
  commands: [
    pluginCommandModule('login', loginCommand),
    pluginCommandModule('logout', logoutCommand),
    pluginCommandDescriptor(whoamiCommandDescriptor),
  ],
});
