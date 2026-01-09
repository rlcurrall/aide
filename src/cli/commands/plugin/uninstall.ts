/**
 * Plugin uninstall command
 * Removes the aide Claude Code plugin from specified scopes
 */

import type { CommandModule, ArgumentsCamelCase } from 'yargs';
import { homedir } from 'os';
import { join } from 'path';
import { existsSync, rmSync, readFileSync, writeFileSync } from 'fs';

type Scope = 'user' | 'project' | 'local';

export interface UninstallArgv {
  user: boolean;
  project: boolean;
  local: boolean;
  all: boolean;
}

interface InstallPaths {
  pluginDir: string;
  settingsFile: string;
}

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
 * Remove the aide plugin entry from a settings file
 * Returns true if the settings were modified
 */
function removeFromSettings(settingsFile: string): boolean {
  if (!existsSync(settingsFile)) return false;

  try {
    const settings = JSON.parse(readFileSync(settingsFile, 'utf-8'));
    if (
      settings.enabledPlugins &&
      typeof settings.enabledPlugins === 'object' &&
      'aide@aide-marketplace' in settings.enabledPlugins
    ) {
      delete settings.enabledPlugins['aide@aide-marketplace'];
      writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
      return true;
    }
  } catch {
    // Ignore parse errors
  }
  return false;
}

async function handler(argv: ArgumentsCamelCase<UninstallArgv>): Promise<void> {
  // Determine which scopes to uninstall from
  const scopes: Scope[] = argv.all
    ? ['user', 'project', 'local']
    : [argv.project ? 'project' : argv.local ? 'local' : 'user'];

  let removedAny = false;

  for (const scope of scopes) {
    const paths = getInstallPaths(scope);
    let removed = false;

    // Remove plugin directory if it exists
    if (existsSync(paths.pluginDir)) {
      rmSync(paths.pluginDir, { recursive: true, force: true });
      console.log(`[OK] Removed plugin files (${scope}): ${paths.pluginDir}`);
      removed = true;
    }

    // Remove from settings file
    if (removeFromSettings(paths.settingsFile)) {
      console.log(`[OK] Updated settings (${scope}): ${paths.settingsFile}`);
      removed = true;
    }

    if (removed) removedAny = true;
  }

  if (!removedAny) {
    console.log('No aide plugin installation found');
    process.exit(1);
  }

  console.log('');
  console.log('Uninstall complete. Restart Claude Code to apply changes.');
}

export const uninstallCommand: CommandModule<object, UninstallArgv> = {
  command: 'uninstall',
  describe: 'Remove the aide plugin from Claude Code',
  builder: {
    user: {
      type: 'boolean',
      default: false,
      describe: 'Remove from user scope (default)',
    },
    project: {
      type: 'boolean',
      default: false,
      describe: 'Remove from project scope',
    },
    local: {
      type: 'boolean',
      default: false,
      describe: 'Remove from local scope',
    },
    all: {
      type: 'boolean',
      default: false,
      describe: 'Remove from all scopes',
    },
  },
  handler,
};
