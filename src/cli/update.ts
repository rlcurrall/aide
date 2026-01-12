import { existsSync, unlinkSync } from 'fs';
import path from 'path';

const isWindows = process.platform === 'win32';

/**
 * Get the path to the currently running binary (actual filesystem path)
 */
export function getCurrentBinaryPath(): string {
  return process.execPath;
}

/**
 * Get the target path for the binary after upgrade
 * Normalizes the binary name:
 * - Windows: ensures path ends with .exe (for PowerShell compatibility)
 * - Linux/Mac: normalizes aide-linux/aide-mac to just 'aide'
 */
export function getTargetBinaryPath(): string {
  const execPath = process.execPath;
  const dir = path.dirname(execPath);

  if (isWindows) {
    // Ensure the path ends with .exe
    if (!execPath.toLowerCase().endsWith('.exe')) {
      return execPath + '.exe';
    }
    return execPath;
  }

  // Linux/Mac: normalize to just 'aide'
  const basename = path.basename(execPath);
  if (basename === 'aide-linux' || basename === 'aide-mac') {
    return path.join(dir, 'aide');
  }

  return execPath;
}

/**
 * Get the path for the temporary update file
 */
export function getTempUpdatePath(currentPath: string): string {
  if (isWindows) {
    // Remove .exe if present, then add .tmp.exe
    const basePath = currentPath.replace(/\.exe$/i, '');
    return `${basePath}.tmp.exe`;
  }
  return `${currentPath}.tmp`;
}

/**
 * Get the path for the backup/old version file
 */
export function getBackupPath(currentPath: string): string {
  if (isWindows) {
    // Remove .exe if present, then add .old
    // (backup doesn't need .exe since it won't be executed)
    const basePath = currentPath.replace(/\.exe$/i, '');
    return `${basePath}.old`;
  }
  return `${currentPath}.old`;
}

/**
 * Check for and clean up old backup files from a previous upgrade
 * This runs at startup before the main CLI logic
 */
export function cleanupOldBackup(): void {
  try {
    const currentPath = getCurrentBinaryPath();
    const dir = path.dirname(currentPath);

    // List of possible backup files to clean up
    // This handles transitions between naming conventions (e.g., aide-linux -> aide)
    const backupPaths = [
      getBackupPath(currentPath), // Current binary's backup
      path.join(dir, 'aide.old'), // Normalized name backup
      path.join(dir, 'aide-linux.old'), // Legacy Linux backup
      path.join(dir, 'aide-mac.old'), // Legacy macOS backup
    ];

    // Clean up any backup files that exist
    for (const backupPath of backupPaths) {
      if (existsSync(backupPath)) {
        unlinkSync(backupPath);
      }
    }
  } catch {
    // Silently ignore cleanup errors - not critical
  }
}
