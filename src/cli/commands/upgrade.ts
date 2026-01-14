/**
 * Upgrade command - Downloads and installs the latest version of aide
 *
 * Works by:
 * 1. Downloading the latest release to a temp file
 * 2. Renaming the current binary to .old (works even while running!)
 * 3. Renaming the temp file to the current binary name
 * 4. On next startup, cleanup removes the .old file
 */

import type { CommandModule } from 'yargs';
import { spawnSync } from 'child_process';
import { renameSync, existsSync } from 'fs';
import {
  getCurrentBinaryPath,
  getTargetBinaryPath,
  getTempUpdatePath,
  getBackupPath,
} from '../update.js';

const isWindows = process.platform === 'win32';

/**
 * Download the latest release for the current platform
 */
async function downloadLatestRelease(outputPath: string): Promise<void> {
  // Detect platform and binary name
  let binaryName: string;
  if (isWindows) {
    binaryName = 'aide.exe';
  } else if (process.platform === 'darwin') {
    binaryName = 'aide-mac';
  } else {
    binaryName = 'aide-linux';
  }

  const url = `https://github.com/rlcurrall/aide/releases/latest/download/${binaryName}`;

  console.log(`Downloading from ${url}...`);

  // Use platform-specific download tool
  if (isWindows) {
    const result = spawnSync(
      'powershell',
      ['-Command', `$ProgressPreference = 'SilentlyContinue'; Invoke-WebRequest -Uri "${url}" -OutFile "${outputPath}"`],
      { stdio: 'inherit' }
    );
    if (result.status !== 0) {
      throw new Error('Download failed');
    }
  } else {
    const result = spawnSync('curl', ['-fsSL', url, '-o', outputPath], {
      stdio: 'inherit',
    });
    if (result.status !== 0) {
      throw new Error('Download failed');
    }
    // Make executable
    const chmodResult = spawnSync('chmod', ['+x', outputPath]);
    if (chmodResult.status !== 0) {
      throw new Error('Failed to make binary executable');
    }
  }
}

export default {
  command: 'upgrade',
  describe: 'Upgrade aide to the latest version',
  async handler() {
    try {
      const currentPath = getCurrentBinaryPath();
      const targetPath = getTargetBinaryPath();
      const tempPath = getTempUpdatePath(targetPath);
      const backupPath = getBackupPath(currentPath);

      console.log('Checking for updates...\n');

      // Download to temp location
      await downloadLatestRelease(tempPath);

      console.log('\nApplying update...');

      // Verify temp file exists
      if (!existsSync(tempPath)) {
        throw new Error('Downloaded file not found');
      }

      // Rename current to .old (works even while running!)
      renameSync(currentPath, backupPath);

      try {
        // Rename temp to target (ensures .exe on Windows)
        renameSync(tempPath, targetPath);
      } catch (error) {
        // Restore the backup if final rename fails
        renameSync(backupPath, currentPath);
        throw error;
      }

      console.log('✓ aide upgraded successfully!');
      if (currentPath !== targetPath) {
        console.log(`  Binary renamed to: ${targetPath}`);
      }
      console.log('\nRestart aide to use the new version.\n');
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : error}`);
      console.error('\nUpgrade failed. Your current version is still intact.');
      process.exit(1);
    }
  },
} satisfies CommandModule;
