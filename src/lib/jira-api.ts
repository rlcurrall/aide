import type { JiraConfig } from '../schemas/config.js';

// `RequestInit` isn't in the node/eslint globals set; reach the type via
// `typeof fetch` instead so eslint `no-undef` stays clean without a config change.
type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;

/**
 * Regex to match JSON-standard numeric literals.
 * Accepts:
 *  - Integers: 0, -5, 42
 *  - Decimals: 0.5, -1.25
 *  - Scientific notation: 1e3, 1.5E-2
 *
 * Rejects:
 *  - Infinity/-Infinity (not JSON-serializable)
 *  - Whitespace-only strings (Number('   ') === 0)
 *  - Hex literals (0xff)
 *  - Leading plus (Number('+5') === 5 but not valid JSON)
 */
const JSON_NUMBER_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

/**
 * Resolve an endpoint argument to a full URL, enforcing security guards.
 *
 * - Relative path (with or without leading slash): prepend configured scheme+host.
 * - Absolute URL: must be HTTPS and must match the configured Jira host, else throw.
 *
 * The host check prevents credential exfiltration: the caller's Jira basic-auth
 * header is about to be attached, and we refuse to send it to any other origin.
 */
export function resolveEndpoint(config: JiraConfig, endpoint: string): string {
  const base = new URL(config.url); // throws on malformed configured URL

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(endpoint)) {
    const target = new URL(endpoint);
    if (target.protocol !== 'https:') {
      throw new Error(
        `Refusing to send Jira credentials over non-HTTPS URL: ${endpoint}`
      );
    }
    if (target.host !== base.host) {
      throw new Error(
        `Refusing to send Jira credentials to host '${target.host}'; ` +
          `configured host is '${base.host}'. Pass a relative path or a URL on the configured host.`
      );
    }
    target.username = '';
    target.password = '';
    return target.toString();
  }

  const path = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  const baseOrigin = `${base.protocol}//${base.host}`;
  return `${baseOrigin}${path}`;
}

export interface ParseFieldsInput {
  stringFields: string[]; // from -f
  typedFields: string[]; // from -F
}

export function parseFields(input: ParseFieldsInput): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const raw of input.stringFields) {
    const [key, value] = splitKeyValue(raw);
    result[key] = value;
  }

  for (const raw of input.typedFields) {
    const [key, value] = splitKeyValue(raw);
    result[key] = coerceTypedValue(value);
  }

  return result;
}

function splitKeyValue(raw: string): [string, string] {
  const eq = raw.indexOf('=');
  if (eq === -1) {
    throw new Error(`Expected key=value in field '${raw}' (= is required)`);
  }
  const key = raw.slice(0, eq);
  if (key.length === 0) {
    throw new Error(`Field key cannot be empty in '${raw}'`);
  }
  return [key, raw.slice(eq + 1)];
}

function coerceTypedValue(value: string): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (JSON_NUMBER_RE.test(value)) return Number(value);
  return value;
}

export interface BuildRequestInput {
  endpoint: string;
  method: string;
  stringFields: string[];
  typedFields: string[];
  headers: string[];
  body: string | undefined; // from --input, already-resolved string
}

export interface BuiltRequest {
  url: string;
  init: FetchInit;
}

const QUERY_METHODS = new Set(['GET', 'HEAD', 'DELETE']);

export function buildRequest(
  config: JiraConfig,
  input: BuildRequestInput
): BuiltRequest {
  const method = input.method.toUpperCase();
  const fields = parseFields({
    stringFields: input.stringFields,
    typedFields: input.typedFields,
  });

  let urlStr = resolveEndpoint(config, input.endpoint);
  let body: string | undefined = input.body;

  if (QUERY_METHODS.has(method)) {
    // Fields go on the querystring
    const fieldEntries = Object.entries(fields);
    if (fieldEntries.length > 0) {
      const url = new URL(urlStr);
      for (const [k, v] of fieldEntries) {
        url.searchParams.set(k, String(v));
      }
      urlStr = url.toString();
    }
  } else if (body === undefined && Object.keys(fields).length > 0) {
    // Fields become a JSON body (only if --input didn't supply one)
    body = JSON.stringify(fields);
  }

  const headers: Record<string, string> = {
    authorization: `Basic ${btoa(`${config.email}:${config.apiToken}`)}`,
    accept: 'application/json',
  };

  if (body !== undefined) {
    headers['content-type'] = 'application/json';
  }

  for (const raw of input.headers) {
    const colon = raw.indexOf(':');
    if (colon === -1) {
      throw new Error(
        `Invalid header '${raw}' — expected 'Name: Value' format`
      );
    }
    const name = raw.slice(0, colon).trim().toLowerCase();
    const value = raw.slice(colon + 1).trim();
    headers[name] = value;
  }

  const init: FetchInit = { method, headers };
  if (body !== undefined) {
    init.body = body;
  }

  return { url: urlStr, init };
}
