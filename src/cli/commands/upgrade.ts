/**
 * Upgrade command - Downloads and installs the latest version of aide
 *
 * Works by:
 * 1. Downloading the latest release to a temp file
 * 2. Renaming the current binary to .old (works even while running!)
 * 3. Renaming the temp file to the current binary name
 * 4. On next startup, cleanup removes the .old file
 */

import { createCommandModule } from '@cli/utils';
import { spawnSync } from 'child_process';
import { renameSync, existsSync } from 'fs';
import {
  getCurrentBinaryPath,
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
      ['-Command', `Invoke-WebRequest -Uri "${url}" -OutFile "${outputPath}"`],
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
    spawnSync('chmod', ['+x', outputPath]);
  }
}

export default createCommandModule({
  command: 'upgrade',
  describe: 'Upgrade aide to the latest version',
  builder: {},
  async handler() {
    try {
      const currentPath = getCurrentBinaryPath();
      const tempPath = getTempUpdatePath(currentPath);
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

      // Rename temp to current
      renameSync(tempPath, currentPath);

      console.log('✓ aide upgraded successfully!');
      console.log('\nRestart aide to use the new version.\n');
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : error}`);
      console.error('\nUpgrade failed. Your current version is still intact.');
      process.exit(1);
    }
  },
});
