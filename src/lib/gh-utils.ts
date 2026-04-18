/**
 * Helpers for the GitHub CLI (`gh`).
 *
 * Centralizes the "is gh authenticated?" probe so login, whoami, and the
 * GitHub client all use one consistent check. No caching: `gh auth status`
 * is fast and caching across a process's lifetime masks `gh auth login` /
 * `gh auth logout` that a user runs mid-session.
 */

import { spawnSync } from 'bun';

export function isGhCliAvailable(): boolean {
  try {
    const result = spawnSync(['gh', 'auth', 'status'], {
      stdout: 'ignore',
      stderr: 'ignore',
    });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}
