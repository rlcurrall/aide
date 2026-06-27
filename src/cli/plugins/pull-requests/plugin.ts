import {
  prCommandGroup,
  prCommentCommand,
  prCommentsCommand,
  prCreateCommand,
  prDiffCommand,
  prListCommand,
  prReplyCommand,
  prUpdateCommand,
  prViewCommand,
} from '@cli/commands/pr/index.js';
import {
  defineAidePlugin,
  pluginCommandModule,
} from '@cli/host/plugin-descriptor.js';

export const pullRequestsPlugin = defineAidePlugin({
  id: 'pull-requests',
  summary: 'Pull request workflows for GitHub and Azure DevOps',
  commands: [
    pluginCommandModule('pr', prCommandGroup),
    pluginCommandModule('pr:list', prListCommand, { parentId: 'pr' }),
    pluginCommandModule('pr:view', prViewCommand, { parentId: 'pr' }),
    pluginCommandModule('pr:diff', prDiffCommand, { parentId: 'pr' }),
    pluginCommandModule('pr:create', prCreateCommand, { parentId: 'pr' }),
    pluginCommandModule('pr:update', prUpdateCommand, { parentId: 'pr' }),
    pluginCommandModule('pr:comments', prCommentsCommand, { parentId: 'pr' }),
    pluginCommandModule('pr:comment', prCommentCommand, { parentId: 'pr' }),
    pluginCommandModule('pr:reply', prReplyCommand, { parentId: 'pr' }),
  ],
});
