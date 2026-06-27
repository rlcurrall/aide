import { prCommands } from '@cli/commands/pr/index.js';
import {
  defineAidePlugin,
  pluginCommandModule,
} from '@cli/host/plugin-descriptor.js';

export const pullRequestsPlugin = defineAidePlugin({
  id: 'pull-requests',
  summary: 'Pull request workflows for GitHub and Azure DevOps',
  commands: [pluginCommandModule('pr', prCommands)],
});
