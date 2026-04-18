import { describe, test, expect } from 'bun:test';
import { isGhCliAvailable } from './gh-utils.js';

describe('isGhCliAvailable', () => {
  test('returns a boolean', () => {
    expect(typeof isGhCliAvailable()).toBe('boolean');
  });
});
