import { describe, test, expect } from 'bun:test';
import { detectPlatformFromRemote, parsePRUrlAny } from './platform.js';

describe('detectPlatformFromRemote', () => {
  test('detects github.com remote as github', () => {
    expect(detectPlatformFromRemote('git@github.com:o/r.git')).toBe('github');
  });
});

describe('parsePRUrlAny', () => {
  test('carries host for github.com PR URL', () => {
    const r = parsePRUrlAny('https://github.com/o/r/pull/3');
    expect(r?.platform).toBe('github');
    expect(r?.host).toBe('github.com');
    expect(r?.prId).toBe(3);
  });
});
