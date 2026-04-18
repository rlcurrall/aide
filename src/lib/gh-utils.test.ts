import { describe, test, expect } from 'bun:test';
import { isGhCliAvailable } from './gh-utils.js';

describe('isGhCliAvailable', () => {
  test('returns true when gh auth status exits 0', () => {
    const result = isGhCliAvailable(
      (() => ({ exitCode: 0 })) as unknown as typeof import('bun').spawnSync
    );
    expect(result).toBe(true);
  });

  test('returns false when gh auth status exits non-zero', () => {
    const result = isGhCliAvailable(
      (() => ({ exitCode: 1 })) as unknown as typeof import('bun').spawnSync
    );
    expect(result).toBe(false);
  });

  test('returns false when spawn throws (gh not installed)', () => {
    const result = isGhCliAvailable(
      (() => {
        throw new Error('ENOENT');
      }) as unknown as typeof import('bun').spawnSync
    );
    expect(result).toBe(false);
  });
});
