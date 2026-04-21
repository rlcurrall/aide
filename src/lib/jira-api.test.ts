/**
 * Tests for jira-api helpers.
 *
 * resolveEndpoint is security-critical: it prevents credential leakage
 * when callers pass absolute URLs by rejecting anything that isn't on
 * the configured Jira host, and anything that isn't HTTPS.
 */

import { describe, test, expect } from 'bun:test';
import { resolveEndpoint } from './jira-api.js';
import type { JiraConfig } from '../schemas/config.js';

const CONFIG: JiraConfig = {
  url: 'https://example.atlassian.net',
  email: 'user@example.com',
  apiToken: 'token',
};

describe('resolveEndpoint', () => {
  test('prepends scheme+host to a bare relative path', () => {
    expect(resolveEndpoint(CONFIG, 'rest/api/3/myself')).toBe(
      'https://example.atlassian.net/rest/api/3/myself'
    );
  });

  test('prepends scheme+host to a leading-slash relative path', () => {
    expect(resolveEndpoint(CONFIG, '/rest/api/3/myself')).toBe(
      'https://example.atlassian.net/rest/api/3/myself'
    );
  });

  test('strips trailing slash from configured url before joining', () => {
    const cfg = { ...CONFIG, url: 'https://example.atlassian.net/' };
    expect(resolveEndpoint(cfg, 'rest/api/3/myself')).toBe(
      'https://example.atlassian.net/rest/api/3/myself'
    );
  });

  test('accepts absolute URL on the configured host', () => {
    expect(
      resolveEndpoint(
        CONFIG,
        'https://example.atlassian.net/rest/api/3/issue/PROJ-1'
      )
    ).toBe('https://example.atlassian.net/rest/api/3/issue/PROJ-1');
  });

  test('strips userinfo from absolute URL on configured host', () => {
    expect(
      resolveEndpoint(
        CONFIG,
        'https://someuser:somepass@example.atlassian.net/rest/api/3/myself'
      )
    ).toBe('https://example.atlassian.net/rest/api/3/myself');
  });

  test('rejects absolute URL on a different host', () => {
    expect(() =>
      resolveEndpoint(CONFIG, 'https://evil.example.com/steal')
    ).toThrow(/host/i);
  });

  test('rejects http:// absolute URL even on the configured host', () => {
    expect(() =>
      resolveEndpoint(CONFIG, 'http://example.atlassian.net/rest/api/3/myself')
    ).toThrow(/https/i);
  });

  test('rejects malformed URL', () => {
    expect(() => resolveEndpoint(CONFIG, 'https://')).toThrow();
  });
});
