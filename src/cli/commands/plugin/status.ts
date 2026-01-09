/**
 * Plugin status command
 * Shows the installation status of the aide Claude Code plugin across all scopes
 */

import type { CommandModule } from 'yargs';
import { homedir } from 'os';
import { join } from 'path';
import { existsSync, readFileSync, readdirSync } from 'fs';

type Scope = 'user' | 'project' | 'local';

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
 * Check if the ax plugin is enabled in a settings file
 */
function isPluginEnabled(settingsFile: string): boolean {
  if (!existsSync(settingsFile)) return false;
  try {
    const settings = JSON.parse(readFileSync(settingsFile, 'utf-8'));
    return settings.enabledPlugins?.['aide@aide-marketplace'] === true;
  } catch {
    return false;
  }
}

/**
 * Count files recursively in a directory
 */
function countFiles(dir: string): number {
  if (!existsSync(dir)) return 0;
  let count = 0;
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) {
        count++;
      } else if (entry.isDirectory()) {
        count += countFiles(join(dir, entry.name));
      }
    }
  } catch {
    // Ignore read errors
  }
  return count;
}

async function handler(): Promise<void> {
  console.log('aide Plugin Installation Status');
  console.log('==============================');
  console.log('');

  const scopes: Scope[] = ['user', 'project', 'local'];
  let anyInstalled = false;

  for (const scope of scopes) {
    const paths = getInstallPaths(scope);
    const filesExist = existsSync(paths.pluginDir);
    const enabled = isPluginEnabled(paths.settingsFile);
    const fileCount = countFiles(paths.pluginDir);

    const status =
      filesExist && enabled
        ? '[OK] Installed & Enabled'
        : filesExist
          ? '[!] Files present, not enabled'
          : enabled
            ? '[!] Enabled but files missing'
            : '[-] Not installed';

    console.log(`${scope.toUpperCase()} SCOPE:`);
    console.log(`  Status: ${status}`);
    console.log(`  Plugin dir: ${paths.pluginDir}`);
    if (filesExist) {
      console.log(`  Files: ${fileCount}`);
    }
    console.log(`  Settings: ${paths.settingsFile}`);
    console.log('');

    if (filesExist || enabled) anyInstalled = true;
  }

  if (!anyInstalled) {
    console.log('No installation found. Run "aide plugin install" to install.');
  }
}

export const statusCommand: CommandModule = {
  command: 'status',
  describe: 'Show plugin installation status',
  builder: {},
  handler,
};
