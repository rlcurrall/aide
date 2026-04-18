import { describe, test, expect } from 'bun:test';
import { isGhCliAvailable } from './gh-utils.js';

describe('isGhCliAvailable', () => {
  test('returns true when gh auth status exits 0', () => {
    let capturedArgs: string[] | undefined;
    const result = isGhCliAvailable(
      ((args: string[]) => {
        capturedArgs = args;
        return { exitCode: 0 };
      }) as unknown as typeof import('bun').spawnSync
    );
    expect(result).toBe(true);
    expect(capturedArgs).toEqual(['gh', 'auth', 'status']);
  });

  test('returns false when gh auth status exits non-zero', () => {
    let capturedArgs: string[] | undefined;
    const result = isGhCliAvailable(
      ((args: string[]) => {
        capturedArgs = args;
        return { exitCode: 1 };
      }) as unknown as typeof import('bun').spawnSync
    );
    expect(result).toBe(false);
    expect(capturedArgs).toEqual(['gh', 'auth', 'status']);
  });

  test('returns false when spawn throws (gh not installed)', () => {
    let capturedArgs: string[] | undefined;
    const result = isGhCliAvailable(
      ((args: string[]) => {
        capturedArgs = args;
        throw new Error('ENOENT');
      }) as unknown as typeof import('bun').spawnSync
    );
    expect(result).toBe(false);
    expect(capturedArgs).toEqual(['gh', 'auth', 'status']);
  });
});
