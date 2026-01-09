import { existsSync, unlinkSync } from 'fs';

const isWindows = process.platform === 'win32';

/**
 * Get the path to the currently running binary
 */
export function getCurrentBinaryPath(): string {
  return process.execPath;
}

/**
 * Get the path for the temporary update file
 */
export function getTempUpdatePath(currentPath: string): string {
  const ext = isWindows ? '.exe' : '';
  return currentPath.replace(new RegExp(ext + '$'), `.tmp${ext}`);
}

/**
 * Get the path for the backup/old version file
 */
export function getBackupPath(currentPath: string): string {
  const ext = isWindows ? '.exe' : '';
  return currentPath.replace(new RegExp(ext + '$'), `.old${ext}`);
}

/**
 * Check for and clean up old backup files from a previous upgrade
 * This runs at startup before the main CLI logic
 */
export function cleanupOldBackup(): void {
  try {
    const currentPath = getCurrentBinaryPath();
    const backupPath = getBackupPath(currentPath);

    // Clean up old backup if it exists
    if (existsSync(backupPath)) {
      unlinkSync(backupPath);
    }
  } catch {
    // Silently ignore cleanup errors - not critical
  }
}
