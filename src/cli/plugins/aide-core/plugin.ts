import upgradeCommand from '@cli/commands/upgrade.js';
import {
  defineAidePlugin,
  pluginCommandDescriptor,
  pluginCommandModule,
} from '@cli/host/plugin-descriptor.js';
import { primeCommandDescriptor } from './prime.js';

export const aideCorePlugin = defineAidePlugin({
  id: 'aide-core',
  summary: 'Core aide commands',
  commands: [
    pluginCommandDescriptor(primeCommandDescriptor),
    pluginCommandModule('upgrade', upgradeCommand),
  ],
});
