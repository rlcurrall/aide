/**
 * Plugin install command
 * Installs the aide Claude Code plugin from embedded files
 */

import { extractPluginFiles, listEmbeddedFiles } from '@lib/embedded-plugin.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import type { ArgumentsCamelCase, CommandModule } from 'yargs';

type Scope = 'user' | 'project' | 'local';

export interface InstallArgv {
  user: boolean;
  project: boolean;
  local: boolean;
  force: boolean;
}

interface InstallPaths {
  pluginDir: string;
  settingsFile: string;
}

// Marketplace name used to reference the local plugin installation
const MARKETPLACE_NAME = 'aide-marketplace';

/**
 * Get the installation paths based on the specified scope
 */
function getInstallPaths(scope: Scope): InstallPaths {
  const home = homedir();

  switch (scope) {
    case 'user':
      return {
        pluginDir: join(home, '.claude', 'plugins', 'aide'),
        settingsFile: join(home, '.claude', 'settings.json'),
      };
    case 'project':
      return {
        pluginDir: join(process.cwd(), '.claude', 'plugins', 'aide'),
        settingsFile: join(process.cwd(), '.claude', 'settings.json'),
      };
    case 'local':
      return {
        pluginDir: join(process.cwd(), '.claude', 'plugins', 'aide'),
        settingsFile: join(process.cwd(), '.claude', 'settings.local.json'),
      };
  }
}

/**
 * Update the Claude Code settings file to add the plugin marketplace and enable the plugin
 */
function updateSettings(settingsFile: string, pluginDir: string): void {
  let settings: Record<string, unknown> = {};

  if (existsSync(settingsFile)) {
    try {
      settings = JSON.parse(readFileSync(settingsFile, 'utf-8'));
    } catch {
      // Start fresh if invalid JSON
    }
  }

  // Add the plugin directory as a local marketplace
  // Claude Code discovers plugins through marketplaces, so we register
  // the plugin directory as a "directory" type marketplace
  if (
    !settings.extraKnownMarketplaces ||
    typeof settings.extraKnownMarketplaces !== 'object'
  ) {
    settings.extraKnownMarketplaces = {};
  }

  (settings.extraKnownMarketplaces as Record<string, unknown>)[
    MARKETPLACE_NAME
  ] = {
    source: {
      source: 'directory',
      path: pluginDir,
    },
  };

  // Enable the ax plugin from our local marketplace
  // Format: "plugin-name@marketplace-name"
  if (!settings.enabledPlugins || typeof settings.enabledPlugins !== 'object') {
    settings.enabledPlugins = {};
  }

  (settings.enabledPlugins as Record<string, boolean>)[
    `aide@${MARKETPLACE_NAME}`
  ] = true;

  // Ensure parent directory exists
  const dir = dirname(settingsFile);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
}

async function handler(argv: ArgumentsCamelCase<InstallArgv>): Promise<void> {
  // Determine scope (only one should be specified)
  let scope: Scope = 'user';
  if (argv.project) scope = 'project';
  if (argv.local) scope = 'local';

  const force = argv.force;
  const paths = getInstallPaths(scope);

  // Check for existing installation
  if (existsSync(paths.pluginDir) && !force) {
    console.error(`Plugin already installed at: ${paths.pluginDir}`);
    console.error('Use --force to overwrite');
    process.exit(1);
  }

  try {
    console.log(`Installing aide plugin (${scope} scope)...`);
    console.log(`  Plugin directory: ${paths.pluginDir}`);
    console.log(`  Settings file: ${paths.settingsFile}`);
    console.log('');

    // List embedded files for verbose output
    const files = listEmbeddedFiles();
    console.log(`Extracting ${files.length} plugin files...`);

    // Extract embedded files
    await extractPluginFiles(paths.pluginDir, { overwrite: force });

    // Update settings to add marketplace and enable plugin
    updateSettings(paths.settingsFile, paths.pluginDir);

    console.log('');
    console.log('[OK] Plugin files extracted');
    console.log('[OK] Marketplace registered');
    console.log('[OK] Plugin enabled');
    console.log('');
    console.log(
      'Installation complete! Restart Claude Code to load the plugin.'
    );
    console.log('');
    console.log('Available commands after restart:');
    console.log('  /aide:ticket KEY     - Load Jira ticket context');
    console.log('  /aide:search "JQL"   - Search Jira tickets');
    console.log('  /aide:pr PR-ID       - Load PR comments');
  } catch (error) {
    console.error(
      `Installation failed: ${error instanceof Error ? error.message : error}`
    );
    process.exit(1);
  }
}

export const installCommand: CommandModule<object, InstallArgv> = {
  command: 'install',
  describe: 'Install the aide plugin to Claude Code',
  builder: {
    user: {
      type: 'boolean',
      default: false,
      describe: 'Install globally for current user (default)',
    },
    project: {
      type: 'boolean',
      default: false,
      describe: 'Install to project .claude/ directory (team-shared)',
    },
    local: {
      type: 'boolean',
      default: false,
      describe: 'Install to project .claude/ with local settings (gitignored)',
    },
    force: {
      type: 'boolean',
      default: false,
      describe: 'Overwrite existing installation',
    },
  },
  handler,
};
