import { describe, test, expect } from 'bun:test';
import * as v from 'valibot';

import {
  StoredJiraSchema,
  StoredAdoSchema,
  StoredGithubSchema,
} from './config.js';

describe('StoredJiraSchema', () => {
  test('accepts a valid jira blob and strips trailing slash on url', () => {
    const result = v.parse(StoredJiraSchema, {
      url: 'https://example.atlassian.net/',
      email: 'a@b.c',
      apiToken: 'tkn',
    });
    expect(result.url).toBe('https://example.atlassian.net');
  });

  test('rejects missing apiToken', () => {
    expect(() =>
      v.parse(StoredJiraSchema, { url: 'https://x.y', email: 'a@b.c' })
    ).toThrow();
  });

  test('rejects empty email', () => {
    expect(() =>
      v.parse(StoredJiraSchema, { url: 'https://x.y', email: '', apiToken: 't' })
    ).toThrow();
  });
});

describe('StoredAdoSchema', () => {
  test('accepts a valid ado blob with default authMethod', () => {
    const result = v.parse(StoredAdoSchema, {
      orgUrl: 'https://dev.azure.com/org',
      pat: 'tkn',
    });
    expect(result.authMethod).toBe('pat');
  });

  test('accepts bearer auth method', () => {
    const result = v.parse(StoredAdoSchema, {
      orgUrl: 'https://dev.azure.com/org',
      pat: 'tkn',
      authMethod: 'bearer',
    });
    expect(result.authMethod).toBe('bearer');
  });

  test('rejects unknown authMethod', () => {
    expect(() =>
      v.parse(StoredAdoSchema, {
        orgUrl: 'https://dev.azure.com/org',
        pat: 'tkn',
        authMethod: 'weird',
      })
    ).toThrow();
  });
});

describe('StoredGithubSchema', () => {
  test('accepts a valid github blob', () => {
    const result = v.parse(StoredGithubSchema, { token: 'ghp_xxx' });
    expect(result.token).toBe('ghp_xxx');
  });

  test('rejects empty token', () => {
    expect(() => v.parse(StoredGithubSchema, { token: '' })).toThrow();
  });
});
