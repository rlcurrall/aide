import {
  createKeyringCommandRegistry,
  type KeyringCommandRegistry,
} from '@cli/host/command-registry.js';

import { aideCorePlugin } from './aide-core/plugin.js';
import { azureDevOpsPlugin } from './azure-devops/plugin.js';
import { claudeCodePlugin } from './claude-code/plugin.js';
import { githubPlugin } from './github/plugin.js';
import { jiraPlugin } from './jira/plugin.js';
import { legacyAuthPlugin } from './legacy-auth/plugin.js';
import { pullRequestsPlugin } from './pull-requests/plugin.js';

export const builtinPlugins = [
  jiraPlugin,
  githubPlugin,
  azureDevOpsPlugin,
  pullRequestsPlugin,
  claudeCodePlugin,
  aideCorePlugin,
  legacyAuthPlugin,
] as const;

export type BuiltinCommandRegistry = KeyringCommandRegistry;

export function createBuiltinCommandRegistry(): BuiltinCommandRegistry {
  const registry = createKeyringCommandRegistry();
  for (const plugin of builtinPlugins) {
    registry.registerPlugin(plugin);
  }
  return registry;
}
