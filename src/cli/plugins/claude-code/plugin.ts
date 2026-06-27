import { pluginCommands } from '@cli/commands/plugin/index.js';
import {
  defineAidePlugin,
  pluginCommandModule,
} from '@cli/host/plugin-descriptor.js';

export const claudeCodePlugin = defineAidePlugin({
  id: 'claude-code',
  summary: 'Claude Code plugin installation helpers',
  commands: [pluginCommandModule('plugin', pluginCommands)],
});
