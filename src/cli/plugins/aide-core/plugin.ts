import primeCommand from '@cli/commands/prime.js';
import upgradeCommand from '@cli/commands/upgrade.js';
import {
  defineAidePlugin,
  pluginCommandModule,
} from '@cli/host/plugin-descriptor.js';

export const aideCorePlugin = defineAidePlugin({
  id: 'aide-core',
  summary: 'Core aide commands',
  commands: [
    pluginCommandModule('prime', primeCommand),
    pluginCommandModule('upgrade', upgradeCommand),
  ],
});
