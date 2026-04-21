/**
 * Tests for jira-api helpers.
 *
 * resolveEndpoint is security-critical: it prevents credential leakage
 * when callers pass absolute URLs by rejecting anything that isn't on
 * the configured Jira host, and anything that isn't HTTPS.
 */

import { describe, test, expect } from 'bun:test';
import { resolveEndpoint, parseFields, buildRequest } from './jira-api.js';
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

  test('rejects relative path when configured URL is non-HTTPS', () => {
    const cfg = { ...CONFIG, url: 'http://example.atlassian.net' };
    expect(() => resolveEndpoint(cfg, 'rest/api/3/myself')).toThrow(
      /non-HTTPS configured URL/i
    );
  });

  test('rejects malformed URL', () => {
    expect(() => resolveEndpoint(CONFIG, 'https://')).toThrow();
  });
});

describe('parseFields', () => {
  test('parses -f as string values', () => {
    const out = parseFields({
      stringFields: ['name=alice', 'role=admin'],
      typedFields: [],
    });
    expect(out).toEqual({ name: 'alice', role: 'admin' });
  });

  test('string value may contain = signs after the first', () => {
    const out = parseFields({
      stringFields: ['jql=project = PROJ AND key = PROJ-1'],
      typedFields: [],
    });
    expect(out).toEqual({ jql: 'project = PROJ AND key = PROJ-1' });
  });

  test('parses -F integers and floats as numbers', () => {
    const out = parseFields({
      stringFields: [],
      typedFields: ['count=3', 'ratio=0.5'],
    });
    expect(out).toEqual({ count: 3, ratio: 0.5 });
  });

  test('parses -F booleans and null', () => {
    const out = parseFields({
      stringFields: [],
      typedFields: ['ok=true', 'done=false', 'note=null'],
    });
    expect(out).toEqual({ ok: true, done: false, note: null });
  });

  test('-F non-typed value falls through as string', () => {
    const out = parseFields({ stringFields: [], typedFields: ['name=alice'] });
    expect(out).toEqual({ name: 'alice' });
  });

  test('duplicate -f keys promote to an array (gh/curl semantics)', () => {
    const out = parseFields({
      stringFields: ['expand=names', 'expand=schema'],
      typedFields: [],
    });
    expect(out).toEqual({ expand: ['names', 'schema'] });
  });

  test('duplicate -F keys promote to an array', () => {
    const out = parseFields({
      stringFields: [],
      typedFields: ['id=1', 'id=2', 'id=3'],
    });
    expect(out).toEqual({ id: [1, 2, 3] });
  });

  test('mixed -f/-F duplicates promote to an array in declaration order', () => {
    const out = parseFields({
      stringFields: ['id=first'],
      typedFields: ['id=2'],
    });
    // -f values are applied first, then -F values — arrays reflect that order.
    expect(out).toEqual({ id: ['first', 2] });
  });

  test('rejects fields without an = sign', () => {
    expect(() =>
      parseFields({ stringFields: ['bad'], typedFields: [] })
    ).toThrow(/=.*required|expected.*key=value/i);
  });

  test('rejects empty key', () => {
    expect(() =>
      parseFields({ stringFields: ['=value'], typedFields: [] })
    ).toThrow();
  });

  test('-F does not coerce Infinity (JSON-incompatible)', () => {
    const out = parseFields({ stringFields: [], typedFields: ['n=Infinity'] });
    expect(out).toEqual({ n: 'Infinity' });
  });

  test('-F does not coerce -Infinity', () => {
    const out = parseFields({ stringFields: [], typedFields: ['n=-Infinity'] });
    expect(out).toEqual({ n: '-Infinity' });
  });

  test('-F does not coerce whitespace-only values to 0', () => {
    const out = parseFields({ stringFields: [], typedFields: ['count=   '] });
    expect(out).toEqual({ count: '   ' });
  });

  test('-F does not coerce hex literals', () => {
    const out = parseFields({ stringFields: [], typedFields: ['x=0xff'] });
    expect(out).toEqual({ x: '0xff' });
  });

  test('-F does not coerce leading-plus numbers', () => {
    const out = parseFields({ stringFields: [], typedFields: ['n=+5'] });
    expect(out).toEqual({ n: '+5' });
  });

  test('-F still coerces standard integers, floats, negatives, and exponents', () => {
    const out = parseFields({
      stringFields: [],
      typedFields: [
        'a=0',
        'b=42',
        'c=-3',
        'd=0.5',
        'e=-1.25',
        'f=1e3',
        'g=1.5E-2',
      ],
    });
    expect(out).toEqual({
      a: 0,
      b: 42,
      c: -3,
      d: 0.5,
      e: -1.25,
      f: 1000,
      g: 0.015,
    });
  });
});

describe('buildRequest', () => {
  test('GET with -f fields builds querystring, no body', () => {
    const { url, init } = buildRequest(CONFIG, {
      endpoint: 'rest/api/3/search',
      method: 'GET',
      stringFields: ['jql=project = PROJ', 'maxResults=50'],
      typedFields: [],
      headers: [],
      body: undefined,
    });
    expect(url).toBe(
      'https://example.atlassian.net/rest/api/3/search?jql=project+%3D+PROJ&maxResults=50'
    );
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
  });

  test('POST with -f/-F fields builds JSON body, no querystring', () => {
    const { url, init } = buildRequest(CONFIG, {
      endpoint: 'rest/api/3/issue',
      method: 'POST',
      stringFields: ['summary=Test'],
      typedFields: ['priority=3'],
      headers: [],
      body: undefined,
    });
    expect(url).toBe('https://example.atlassian.net/rest/api/3/issue');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ summary: 'Test', priority: 3 }));
  });

  test('sets Authorization header from config', () => {
    const { init } = buildRequest(CONFIG, {
      endpoint: 'rest/api/3/myself',
      method: 'GET',
      stringFields: [],
      typedFields: [],
      headers: [],
      body: undefined,
    });
    const headers = init.headers as Record<string, string>;
    const expected = `Basic ${Buffer.from('user@example.com:token').toString('base64')}`;
    expect(headers['authorization']).toBe(expected);
    expect(headers['accept']).toBe('application/json');
  });

  test('defaults Content-Type to application/json on body requests', () => {
    const { init } = buildRequest(CONFIG, {
      endpoint: 'rest/api/3/issue',
      method: 'POST',
      stringFields: ['summary=Test'],
      typedFields: [],
      headers: [],
      body: undefined,
    });
    const headers = init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
  });

  test('omits Content-Type on GET with no body', () => {
    const { init } = buildRequest(CONFIG, {
      endpoint: 'rest/api/3/myself',
      method: 'GET',
      stringFields: [],
      typedFields: [],
      headers: [],
      body: undefined,
    });
    const headers = init.headers as Record<string, string>;
    expect(headers['content-type']).toBeUndefined();
  });

  test('-H override replaces default Content-Type', () => {
    const { init } = buildRequest(CONFIG, {
      endpoint: 'rest/api/3/issue',
      method: 'POST',
      stringFields: [],
      typedFields: [],
      headers: ['Content-Type: text/plain'],
      body: 'hello',
    });
    const headers = init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('text/plain');
    expect(init.body).toBe('hello');
  });

  test('-H merges extra headers', () => {
    const { init } = buildRequest(CONFIG, {
      endpoint: 'rest/api/3/myself',
      method: 'GET',
      stringFields: [],
      typedFields: [],
      headers: ['X-Atlassian-Token: no-check', 'X-Trace-Id: abc'],
      body: undefined,
    });
    const headers = init.headers as Record<string, string>;
    expect(headers['x-atlassian-token']).toBe('no-check');
    expect(headers['x-trace-id']).toBe('abc');
  });

  test('rejects malformed -H without colon', () => {
    expect(() =>
      buildRequest(CONFIG, {
        endpoint: 'rest/api/3/myself',
        method: 'GET',
        stringFields: [],
        typedFields: [],
        headers: ['BadHeader'],
        body: undefined,
      })
    ).toThrow(/header/i);
  });

  test('DELETE routes fields to querystring like GET', () => {
    const { url, init } = buildRequest(CONFIG, {
      endpoint: 'rest/api/3/issue/PROJ-1',
      method: 'DELETE',
      stringFields: ['deleteSubtasks=true'],
      typedFields: [],
      headers: [],
      body: undefined,
    });
    expect(url).toBe(
      'https://example.atlassian.net/rest/api/3/issue/PROJ-1?deleteSubtasks=true'
    );
    expect(init.method).toBe('DELETE');
    expect(init.body).toBeUndefined();
  });

  test('-H override works with mixed case (late override wins)', () => {
    const { init } = buildRequest(CONFIG, {
      endpoint: 'rest/api/3/issue',
      method: 'POST',
      stringFields: [],
      typedFields: [],
      headers: ['Authorization: Bearer custom-token'],
      body: 'x',
    });
    const h = init.headers as Record<string, string>;
    expect(h['authorization']).toBe('Bearer custom-token');
    expect(
      Object.keys(h).filter((k) => k.toLowerCase() === 'authorization')
    ).toHaveLength(1);
  });

  test('rejects --input on GET', () => {
    expect(() =>
      buildRequest(CONFIG, {
        endpoint: 'rest/api/3/myself',
        method: 'GET',
        stringFields: [],
        typedFields: [],
        headers: [],
        body: '{"x":1}',
      })
    ).toThrow(/--input.*GET/);
  });

  test('rejects --input on HEAD', () => {
    expect(() =>
      buildRequest(CONFIG, {
        endpoint: 'rest/api/3/myself',
        method: 'HEAD',
        stringFields: [],
        typedFields: [],
        headers: [],
        body: 'anything',
      })
    ).toThrow(/--input.*HEAD/);
  });

  test('rejects --input on DELETE', () => {
    expect(() =>
      buildRequest(CONFIG, {
        endpoint: 'rest/api/3/issue/PROJ-1',
        method: 'DELETE',
        stringFields: [],
        typedFields: [],
        headers: [],
        body: '{}',
      })
    ).toThrow(/--input.*DELETE/);
  });

  test('rejects --input combined with -f on POST (ambiguous body source)', () => {
    expect(() =>
      buildRequest(CONFIG, {
        endpoint: 'rest/api/3/issue',
        method: 'POST',
        stringFields: ['summary=Test'],
        typedFields: [],
        headers: [],
        body: '{"fields":{"summary":"Other"}}',
      })
    ).toThrow(/--input.*-f\/-F|ambiguous body/i);
  });

  test('rejects --input combined with -F on PATCH', () => {
    expect(() =>
      buildRequest(CONFIG, {
        endpoint: 'rest/api/3/issue/PROJ-1',
        method: 'PATCH',
        stringFields: [],
        typedFields: ['priority=2'],
        headers: [],
        body: '{"fields":{}}',
      })
    ).toThrow(/--input.*-f\/-F|ambiguous body/i);
  });

  test('accepts --input on POST with no -f/-F', () => {
    const { init } = buildRequest(CONFIG, {
      endpoint: 'rest/api/3/issue',
      method: 'POST',
      stringFields: [],
      typedFields: [],
      headers: [],
      body: '{"fields":{"summary":"Real"}}',
    });
    expect(init.body).toBe('{"fields":{"summary":"Real"}}');
  });

  test('duplicate -f on GET writes repeated querystring entries', () => {
    const { url } = buildRequest(CONFIG, {
      endpoint: 'rest/api/3/search',
      method: 'GET',
      stringFields: ['expand=names', 'expand=schema'],
      typedFields: [],
      headers: [],
      body: undefined,
    });
    const q = new URL(url).searchParams.getAll('expand');
    expect(q).toEqual(['names', 'schema']);
  });

  test('duplicate -f on POST writes a JSON array', () => {
    const { init } = buildRequest(CONFIG, {
      endpoint: 'rest/api/3/issue',
      method: 'POST',
      stringFields: ['label=urgent', 'label=backend'],
      typedFields: [],
      headers: [],
      body: undefined,
    });
    expect(init.body).toBe(JSON.stringify({ label: ['urgent', 'backend'] }));
  });

  test('endpoint with existing querystring is preserved when -f fields are added', () => {
    const { url } = buildRequest(CONFIG, {
      endpoint: 'rest/api/3/search?expand=names',
      method: 'GET',
      stringFields: ['maxResults=50'],
      typedFields: [],
      headers: [],
      body: undefined,
    });
    const params = new URL(url).searchParams;
    expect(params.get('expand')).toBe('names');
    expect(params.get('maxResults')).toBe('50');
  });
});
