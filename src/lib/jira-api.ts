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
 * - Configured Jira URL must be HTTPS; otherwise we refuse to attach
 *   basic-auth credentials to any request (cleartext leak guard).
 * - Relative path (with or without leading slash): prepend configured scheme+host.
 * - Absolute URL: must be HTTPS and must match the configured Jira host, else throw.
 *
 * The host check prevents credential exfiltration: the caller's Jira basic-auth
 * header is about to be attached, and we refuse to send it to any other origin.
 */
export function resolveEndpoint(config: JiraConfig, endpoint: string): string {
  const base = new URL(config.url); // throws on malformed configured URL

  if (base.protocol !== 'https:') {
    throw new Error(
      `Refusing to send Jira credentials over non-HTTPS configured URL: ${config.url}`
    );
  }

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

  // Preserve any path component in config.url — e.g. self-hosted Jira
  // mounted at /jira. The rest of this repo joins with `${config.url}/rest/...`
  // (see jira-client.ts); use the same shape here so behavior stays consistent.
  const normalizedBase = config.url.replace(/\/+$/, '');
  const path = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  return `${normalizedBase}${path}`;
}

export interface ParseFieldsInput {
  stringFields: string[]; // from -f
  typedFields: string[]; // from -F
}

type Scalar = string | number | boolean | null;
type FieldValue = Scalar | Scalar[];

/**
 * Parse -f/-F `key=value` args into an object.
 *
 * Duplicate keys promote to arrays, matching `gh api` / `curl` semantics:
 *   -f expand=names -f expand=schema  →  { expand: ['names', 'schema'] }
 *
 * Consumers serialize arrays naturally: `JSON.stringify` handles JSON bodies;
 * `URLSearchParams.append` writes repeated querystring entries.
 */
export function parseFields(
  input: ParseFieldsInput
): Record<string, FieldValue> {
  const result: Record<string, FieldValue> = {};

  for (const raw of input.stringFields) {
    const [key, value] = splitKeyValue(raw);
    appendField(result, key, value);
  }

  for (const raw of input.typedFields) {
    const [key, value] = splitKeyValue(raw);
    appendField(result, key, coerceTypedValue(value));
  }

  return result;
}

function appendField(
  result: Record<string, FieldValue>,
  key: string,
  value: Scalar
): void {
  const existing = result[key];
  if (existing === undefined) {
    result[key] = value;
    return;
  }
  if (Array.isArray(existing)) {
    existing.push(value);
  } else {
    result[key] = [existing, value];
  }
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

function coerceTypedValue(value: string): Scalar {
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

export interface RequestShape {
  method: string;
  hasInput: boolean;
  hasFields: boolean;
}

/**
 * Validate method/input/field compatibility.
 *
 * Exposed so the CLI handler can fail fast *before* reading stdin or a file:
 * `aide jira api rest/api/3/myself --input -` should error on the method
 * mismatch, not hang waiting on stdin.
 */
export function validateRequestShape(shape: RequestShape): void {
  if (QUERY_METHODS.has(shape.method) && shape.hasInput) {
    throw new Error(
      `--input is not supported with ${shape.method}: fields go on the querystring for this method`
    );
  }
  if (!QUERY_METHODS.has(shape.method) && shape.hasInput && shape.hasFields) {
    throw new Error(
      '--input cannot be combined with -f/-F on body methods (ambiguous body source — pick one)'
    );
  }
}

export function buildRequest(
  config: JiraConfig,
  input: BuildRequestInput
): BuiltRequest {
  // Method is validated by the valibot schema (picklist of uppercase verbs),
  // so we can trust it here without defensive .toUpperCase().
  const method = input.method;
  const fields = parseFields({
    stringFields: input.stringFields,
    typedFields: input.typedFields,
  });
  const fieldEntries = Object.entries(fields);
  const hasFields = fieldEntries.length > 0;
  const hasBody = input.body !== undefined;

  validateRequestShape({ method, hasInput: hasBody, hasFields });

  let urlStr = resolveEndpoint(config, input.endpoint);
  let body: string | undefined = input.body;

  if (QUERY_METHODS.has(method) && hasFields) {
    const url = new URL(urlStr);
    for (const [k, v] of fieldEntries) {
      if (Array.isArray(v)) {
        for (const item of v) url.searchParams.append(k, String(item));
      } else {
        url.searchParams.append(k, String(v));
      }
    }
    urlStr = url.toString();
  } else if (!QUERY_METHODS.has(method) && hasFields) {
    // Fields become a JSON body; arrays serialize naturally.
    body = JSON.stringify(fields);
  }

  const credentials = Buffer.from(
    `${config.email}:${config.apiToken}`
  ).toString('base64');
  const headers: Record<string, string> = {
    authorization: `Basic ${credentials}`,
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
