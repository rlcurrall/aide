import { jiraCommands } from '@cli/commands/jira/index.js';
import {
  defineAidePlugin,
  pluginCommandModule,
} from '@cli/host/plugin-descriptor.js';

export const jiraPlugin = defineAidePlugin({
  id: 'jira',
  summary: 'Jira ticket management',
  commands: [pluginCommandModule('jira', jiraCommands)],
});
