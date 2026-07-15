import { Effect } from 'effect';

import {
  AIDE_PLUGIN_API_VERSION,
  defineAidePlugin as definePublicAidePlugin,
} from '@aide/plugin-api';
import {
  authScopeFromArgs,
  runDynamicAuthProviderAccounts,
  runDynamicAuthProviderLogin,
  runDynamicAuthProviderLogout,
  runDynamicAuthProviderStatus,
} from '@cli/commands/auth-provider-command-utils.js';
import {
  AuthProviderOperationError,
  InvalidAuthProviderOperationResultError,
} from '@cli/host/auth-provider-operations.js';
import { createKeyringCommandRegistry } from '@cli/host/command-registry.js';
import { createAideInternalHostServices } from '@cli/host/runtime-context.js';
import { makeTestKeyring } from '@lib/auth-keyring.test-helper.js';
import { testGitHubAuthCatalogLayer } from '@lib/github-auth-catalog.test-helper.js';
import { exportedErrorText } from '@lib/error-redaction.test-helper.js';
import {
  resolveGitHubAuthRequest,
  type CanonicalGitHubAuthRequest,
} from '@lib/github-auth.js';
import { resolveGitHubCredential } from '@lib/github-credential-resolver.js';
import { installMockSecrets } from '@lib/test-helpers.js';

type Mode =
  | 'non-effect-proxy'
  | 'revoked-proxy'
  | 'effect-proxy'
  | 'forged-instruction'
  | 'pipe-getter'
  | 'hostile-composed-output'
  | 'result-status'
  | 'result-accounts'
  | 'result-login'
  | 'result-logout'
  | 'prototype-array'
  | 'github-credential-prototype'
  | 'auth-capture-intrinsic';

type PrototypeBehavior = 'returning' | 'throwing' | 'slow';
type PrototypeHook =
  | 'numeric-setter'
  | 'map'
  | 'filter'
  | 'some'
  | 'push'
  | 'iterator';
type PrototypeSite = 'accounts' | 'account-metadata' | 'login' | 'logout';
type AuthCaptureHook =
  | 'has-own-property'
  | 'object-has-own'
  | 'object-get-own-property-descriptor'
  | 'fields-iterator';

const mode = process.argv[2] as Mode;
const prototypeSite = process.argv[3] as PrototypeSite | undefined;
const prototypeHook = process.argv[4] as PrototypeHook | undefined;
const prototypeBehavior = process.argv[5] as PrototypeBehavior | undefined;
const authCaptureHook = process.argv[3] as AuthCaptureHook | undefined;
const authCaptureBehavior = process.argv[4] as PrototypeBehavior | undefined;
const secret = `SECRET-AUTH-SUBPROCESS-${mode}`;
let uncaughtExceptions = 0;
let unhandledRejections = 0;
let trapReads = 0;

function publicGitHubRequest(): CanonicalGitHubAuthRequest {
  const request = resolveGitHubAuthRequest({ host: 'github.com' });
  if (!request.ok) throw new Error(request.reason);
  return request;
}

function customGitHubRequest(): CanonicalGitHubAuthRequest {
  const request = resolveGitHubAuthRequest({ host: 'acme.ghe.com' });
  if (!request.ok) throw new Error(request.reason);
  return request;
}

function restoreObjectPrototypeProperty(
  name: string,
  descriptor: PropertyDescriptor | undefined
): boolean {
  Reflect.deleteProperty(Object.prototype, name);
  if (descriptor !== undefined) {
    Object.defineProperty(Object.prototype, name, descriptor);
  }
  return descriptorsEqual(
    Reflect.getOwnPropertyDescriptor(Object.prototype, name),
    descriptor
  );
}

function restoreDescriptor(
  target: object,
  property: PropertyKey,
  descriptor: PropertyDescriptor | undefined
): boolean {
  Reflect.deleteProperty(target, property);
  if (descriptor !== undefined)
    Object.defineProperty(target, property, descriptor);
  return descriptorsEqual(
    Reflect.getOwnPropertyDescriptor(target, property),
    descriptor
  );
}

async function runGitHubCredentialPrototypeProbe() {
  let envReflection = 0;
  let inheritedKeySelection = 0;
  let hostOnlyEligibility = 0;
  let crossAccountRejection = 0;
  let corruptedPayloadRejection = 0;
  let restored = true;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const envProperties = [
      'GITHUB_TOKEN',
      'GH_ENTERPRISE_TOKEN',
      'GH_HOST',
    ] as const;
    const envOriginals = new Map(
      envProperties.map((property) => [
        property,
        Reflect.getOwnPropertyDescriptor(Object.prototype, property),
      ])
    );
    let restoreSecrets = installMockSecrets(new Map());
    try {
      let passed = true;
      for (const [request, injected] of [
        [publicGitHubRequest(), { GITHUB_TOKEN: 'inherited-public-token' }],
        [
          customGitHubRequest(),
          {
            GH_HOST: 'acme.ghe.com',
            GH_ENTERPRISE_TOKEN: 'inherited-enterprise-token',
          },
        ],
      ] as const) {
        const resolved = await resolveGitHubCredential(request, {
          env: {},
          ghAuthProbe: () =>
            new Proxy(
              { kind: 'unavailable' as const, host: request.host },
              {
                getOwnPropertyDescriptor(target, property) {
                  if (property === 'kind') {
                    for (const [name, value] of Object.entries(injected)) {
                      Object.defineProperty(Object.prototype, name, {
                        configurable: true,
                        value,
                        writable: true,
                      });
                    }
                  }
                  return Reflect.getOwnPropertyDescriptor(target, property);
                },
              }
            ),
        });
        passed = passed && resolved.kind === 'missing';
        for (const property of envProperties) {
          restored =
            restoreObjectPrototypeProperty(
              property,
              envOriginals.get(property)
            ) && restored;
        }
      }
      if (passed) envReflection += 1;
    } finally {
      for (const property of envProperties) {
        restored =
          restoreObjectPrototypeProperty(
            property,
            envOriginals.get(property)
          ) && restored;
      }
      restoreSecrets();
    }

    const accountOriginal = Reflect.getOwnPropertyDescriptor(
      Object.prototype,
      'account'
    );
    const requestedKeys: string[] = [];
    const accountStore = new (class extends Map<string, string> {
      override get(key: string): string | undefined {
        requestedKeys.push(key);
        return super.get(key);
      }
    })([
      [
        'aide:auth:github:host:github.com',
        JSON.stringify({
          token: 'host-only-token',
          identity: { host: 'github.com' },
        }),
      ],
      [
        'aide:auth:github:host:github.com:account:attacker',
        JSON.stringify({
          token: 'attacker-token',
          identity: { host: 'github.com', account: 'attacker' },
        }),
      ],
    ]);
    restoreSecrets = installMockSecrets(accountStore);
    try {
      Object.defineProperty(Object.prototype, 'account', {
        configurable: true,
        value: 'attacker',
        writable: true,
      });
      const resolved = await resolveGitHubCredential(publicGitHubRequest(), {
        env: {},
        ghAuthProbe: (candidate) => ({
          kind: 'unavailable',
          host: candidate.host,
        }),
      });
      if (
        requestedKeys.length === 1 &&
        requestedKeys[0] === 'aide:auth:github:host:github.com' &&
        resolved.kind === 'failure' &&
        resolved.code === 'malformed-credential'
      ) {
        inheritedKeySelection += 1;
      }
    } finally {
      restored =
        restoreObjectPrototypeProperty('account', accountOriginal) && restored;
      restoreSecrets();
    }

    let descriptorCalls = 0;
    restoreSecrets = installMockSecrets(new Map());
    try {
      const resolved = await resolveGitHubCredential(publicGitHubRequest(), {
        env: { GITHUB_TOKEN: 'host-only-env-token' },
        ghAuthProbe: () =>
          new Proxy(
            { kind: 'unavailable' as const, host: 'github.com' },
            {
              getOwnPropertyDescriptor(target, property) {
                if (property === 'kind') {
                  descriptorCalls += 1;
                  Object.defineProperty(Object.prototype, 'account', {
                    configurable: true,
                    value: 'attacker',
                    writable: true,
                  });
                }
                return Reflect.getOwnPropertyDescriptor(target, property);
              },
            }
          ),
      });
      if (
        descriptorCalls === 0 &&
        resolved.kind === 'env' &&
        resolved.credential.token === 'host-only-env-token'
      ) {
        hostOnlyEligibility += 1;
      }
    } finally {
      restored =
        restoreObjectPrototypeProperty('account', accountOriginal) && restored;
      restoreSecrets();
    }

    const mismatchStore = new Map([
      [
        'aide:auth:github:host:github.com',
        JSON.stringify({
          token: 'wrong-host-key-token',
          identity: { host: 'github.com', account: 'payload-attacker' },
        }),
      ],
      [
        'aide:auth:github:host:github.com:account:attacker',
        JSON.stringify({
          token: 'attacker-token',
          identity: { host: 'github.com', account: 'attacker' },
        }),
      ],
    ]);
    restoreSecrets = installMockSecrets(mismatchStore);
    try {
      const resolved = await resolveGitHubCredential(publicGitHubRequest(), {
        env: {},
        ghAuthProbe: () => {
          Object.defineProperty(Object.prototype, 'account', {
            configurable: true,
            value: 'attacker',
            writable: true,
          });
          return { kind: 'unavailable', host: 'github.com' };
        },
      });
      if (resolved.kind === 'failure' && resolved.code === 'account-mismatch') {
        crossAccountRejection += 1;
      }
    } finally {
      restored =
        restoreObjectPrototypeProperty('account', accountOriginal) && restored;
      restoreSecrets();
    }

    restoreSecrets = installMockSecrets(
      new Map([
        [
          'aide:auth:github:host:github.com',
          JSON.stringify({
            token: 'host-only-token',
            identity: { host: 'github.com' },
          }),
        ],
      ])
    );
    try {
      const resolved = await resolveGitHubCredential(publicGitHubRequest(), {
        env: {},
        ghAuthProbe: () => {
          Object.defineProperty(Object.prototype, 'account', {
            configurable: true,
            get(this: object) {
              return Object.hasOwn(this, 'ok') && Object.hasOwn(this, 'token')
                ? 'attacker'
                : undefined;
            },
          });
          return { kind: 'unavailable', host: 'github.com' };
        },
      });
      if (
        resolved.kind === 'failure' &&
        resolved.code === 'malformed-credential'
      ) {
        corruptedPayloadRejection += 1;
      }
    } finally {
      restored =
        restoreObjectPrototypeProperty('account', accountOriginal) && restored;
      restoreSecrets();
    }
  }

  return {
    attempts: 2,
    corruptedPayloadRejection,
    crossAccountRejection,
    envReflection,
    globalAccountPrototypeMalformedRejection: inheritedKeySelection,
    hostOnlyEligibility,
    inheritedKeySelection,
    restored,
    safe:
      envReflection === 2 &&
      inheritedKeySelection === 2 &&
      hostOnlyEligibility === 2 &&
      crossAccountRejection === 2 &&
      corruptedPayloadRejection === 2 &&
      restored,
  };
}

async function runAuthCaptureIntrinsicProbe() {
  if (authCaptureHook === undefined || authCaptureBehavior === undefined) {
    throw new Error('missing auth capture intrinsic probe arguments');
  }
  const request = publicGitHubRequest();
  const provider = {
    pluginId: 'auth-capture-intrinsic',
    capability: {
      providerId: 'auth-capture-intrinsic',
      label: 'Auth capture intrinsic fixture',
      status: () => Effect.succeed({ state: 'not-configured' as const }),
    },
  };
  const target =
    authCaptureHook === 'has-own-property'
      ? Object.prototype
      : authCaptureHook === 'fields-iterator'
        ? Array.prototype
        : Object;
  const property: PropertyKey =
    authCaptureHook === 'has-own-property'
      ? 'hasOwnProperty'
      : authCaptureHook === 'object-has-own'
        ? 'hasOwn'
        : authCaptureHook === 'object-get-own-property-descriptor'
          ? 'getOwnPropertyDescriptor'
          : Symbol.iterator;
  const original = Reflect.getOwnPropertyDescriptor(target, property);
  if (
    original === undefined ||
    !Object.hasOwn(original, 'value') ||
    typeof original.value !== 'function'
  ) {
    throw new Error('auth capture intrinsic is unavailable');
  }
  const originalValue = original.value;
  let armed = true;
  let hookCalls = 0;
  let reachabilityCalls = 0;
  const trigger = () => {
    if (!armed) {
      reachabilityCalls += 1;
      return;
    }
    hookCalls += 1;
    if (authCaptureBehavior === 'throwing') {
      throw new Error(`SECRET-AUTH-CAPTURE-${authCaptureHook}`);
    }
    if (authCaptureBehavior === 'slow') {
      for (;;) {
        // The parent kills and awaits a regressed child at the hard deadline.
      }
    }
  };
  const isHostSnapshotFields = (value: unknown): boolean => {
    if (!Array.isArray(value)) return false;
    const first = Reflect.getOwnPropertyDescriptor(value, '0');
    if (
      first === undefined ||
      !Object.hasOwn(first, 'value') ||
      typeof first.value !== 'object' ||
      first.value === null
    ) {
      return false;
    }
    const name = Reflect.getOwnPropertyDescriptor(first.value, '0');
    return (
      name !== undefined &&
      Object.hasOwn(name, 'value') &&
      (name.value === 'ok' || name.value === 'id')
    );
  };

  Object.defineProperty(target, property, {
    configurable: true,
    enumerable: original.enumerable,
    get(this: unknown) {
      if (authCaptureHook !== 'fields-iterator' || isHostSnapshotFields(this)) {
        trigger();
      }
      return originalValue;
    },
  });

  let restored = false;
  let scopeSuccess = 0;
  let credentialSuccess = 0;
  const restoreSecrets = installMockSecrets(new Map());
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const scope = authScopeFromArgs(provider, {
        'scope-host': 'example.test',
      });
      if (scope?.host === 'example.test') scopeSuccess += 1;
      const resolved = await resolveGitHubCredential(request, {
        env: { GITHUB_TOKEN: `host-token-${attempt}` },
        ghAuthProbe: () => ({ kind: 'unavailable', host: request.host }),
      });
      if (
        resolved.kind === 'env' &&
        resolved.credential.token === `host-token-${attempt}`
      ) {
        credentialSuccess += 1;
      }
    }
    armed = false;
    if (authCaptureHook === 'fields-iterator') {
      const fields = [['ok', true] as const];
      Reflect.get(fields, Symbol.iterator);
    } else {
      Reflect.get(target, property);
    }
  } finally {
    restoreSecrets();
    restored = restoreDescriptor(target, property, original);
  }

  return {
    attempts: 2,
    behavior: authCaptureBehavior,
    credentialSuccess,
    hook: authCaptureHook,
    hookCalls,
    reachabilityCalls,
    restored,
    safe:
      scopeSuccess === 2 &&
      credentialSuccess === 2 &&
      hookCalls === 0 &&
      reachabilityCalls === 1 &&
      restored,
    scopeSuccess,
  };
}

process.on('uncaughtException', () => {
  uncaughtExceptions += 1;
});
process.on('unhandledRejection', () => {
  unhandledRejections += 1;
});

function hostileReturn(): unknown {
  const success = () => Effect.succeed({ state: 'configured' as const });
  switch (mode) {
    case 'non-effect-proxy':
      return new Proxy(
        {},
        {
          has() {
            trapReads += 1;
            throw new Error(secret);
          },
        }
      );
    case 'revoked-proxy': {
      const pair = Proxy.revocable({}, {});
      pair.revoke();
      return pair.proxy;
    }
    case 'effect-proxy':
      return new Proxy(success(), {
        get() {
          trapReads += 1;
          throw new Error(secret);
        },
        has() {
          trapReads += 1;
          throw new Error(secret);
        },
      });
    case 'forged-instruction': {
      const genuine = success();
      const forged = Object.create(Object.getPrototypeOf(genuine)) as Record<
        PropertyKey,
        unknown
      >;
      Object.defineProperty(forged, Effect.EffectTypeId, {
        value: Object.freeze({}),
      });
      Object.defineProperty(forged, '_op', {
        get() {
          trapReads += 1;
          throw new Error(secret);
        },
      });
      return forged;
    }
    case 'pipe-getter': {
      const effect = success();
      Object.defineProperty(effect, 'pipe', {
        get() {
          trapReads += 1;
          throw new Error(secret);
        },
      });
      return effect;
    }
    case 'hostile-composed-output': {
      const effect = success();
      Object.defineProperty(effect, 'pipe', {
        value() {
          trapReads += 1;
          return new Proxy(
            {},
            {
              get() {
                trapReads += 1;
                throw new Error(secret);
              },
            }
          );
        },
      });
      return effect;
    }
    case 'result-status':
      return Effect.succeed(
        new Proxy(
          { state: 'configured' as const },
          {
            get() {
              trapReads += 1;
              throw new Error(secret);
            },
            getOwnPropertyDescriptor() {
              trapReads += 1;
              throw new Error(secret);
            },
          }
        )
      );
    case 'result-accounts':
      return Effect.succeed(
        new Proxy([{ id: 'work', label: 'Work' }], {
          get() {
            trapReads += 1;
            throw new Error(secret);
          },
          getOwnPropertyDescriptor() {
            trapReads += 1;
            throw new Error(secret);
          },
        })
      );
    case 'result-login':
      return Effect.succeed({
        status: 'stored' as const,
        messages: new Proxy(['stored'], {
          get() {
            trapReads += 1;
            throw new Error(secret);
          },
          getOwnPropertyDescriptor() {
            trapReads += 1;
            throw new Error(secret);
          },
        }),
      });
    case 'result-logout': {
      const messages: string[] = [];
      messages.length = 1;
      Object.defineProperty(messages, '0', {
        get() {
          trapReads += 1;
          throw new Error(secret);
        },
      });
      return Effect.succeed({ status: 'removed' as const, messages });
    }
    case 'prototype-array':
      return Effect.succeed({ state: 'configured' as const });
    case 'github-credential-prototype':
      return Effect.succeed({ state: 'configured' as const });
  }
}

const prototypeMarker = 'PROTOTYPE-AUTH-SNAPSHOT';

function isPrototypeMarker(value: unknown): boolean {
  if (typeof value === 'string') return value.startsWith(prototypeMarker);
  if (typeof value !== 'object' || value === null) return false;
  const descriptor = Reflect.getOwnPropertyDescriptor(value, 'id');
  return (
    descriptor !== undefined &&
    Object.hasOwn(descriptor, 'value') &&
    typeof descriptor.value === 'string' &&
    descriptor.value.startsWith(prototypeMarker)
  );
}

function isMarkedArray(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  const first = Reflect.getOwnPropertyDescriptor(value, '0');
  return (
    first !== undefined &&
    Object.hasOwn(first, 'value') &&
    isPrototypeMarker(first.value)
  );
}

function descriptorsEqual(
  left: PropertyDescriptor | undefined,
  right: PropertyDescriptor | undefined
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.configurable === right.configurable &&
    left.enumerable === right.enumerable &&
    left.writable === right.writable &&
    Object.is(left.value, right.value) &&
    Object.is(left.get, right.get) &&
    Object.is(left.set, right.set)
  );
}

function triggerPrototypeHook(): void {
  trapReads += 1;
  if (prototypeBehavior === 'throwing') throw new Error(secret);
  if (prototypeBehavior === 'slow') {
    for (;;) {
      // The parent kills and awaits a regressed child at the hard deadline.
    }
  }
}

async function runPrototypeArrayProbe(
  provider: ReturnType<
    ReturnType<
      typeof createAideInternalHostServices
    >['authProviderRegistrations']
  >[number],
  services: ReturnType<typeof createAideInternalHostServices>
) {
  if (
    prototypeSite === undefined ||
    prototypeHook === undefined ||
    prototypeBehavior === undefined
  ) {
    throw new Error('missing prototype probe arguments');
  }
  const property: PropertyKey =
    prototypeHook === 'numeric-setter'
      ? '0'
      : prototypeHook === 'iterator'
        ? Symbol.iterator
        : prototypeHook;
  const original = Reflect.getOwnPropertyDescriptor(Array.prototype, property);
  const originalLog = console.log;
  console.log = () => undefined;
  if (prototypeHook === 'numeric-setter') {
    Object.defineProperty(Array.prototype, property, {
      configurable: true,
      set(this: unknown[], value: unknown) {
        if (isPrototypeMarker(value)) triggerPrototypeHook();
        Object.defineProperty(this, '0', {
          configurable: true,
          enumerable: true,
          value,
          writable: true,
        });
      },
    });
  } else {
    Object.defineProperty(Array.prototype, property, {
      configurable: true,
      get(this: unknown[]) {
        if (isMarkedArray(this)) triggerPrototypeHook();
        return original?.value;
      },
    });
  }

  const outputs: unknown[] = [];
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const output =
        prototypeSite === 'accounts' || prototypeSite === 'account-metadata'
          ? await runDynamicAuthProviderAccounts(provider, services)
          : prototypeSite === 'login'
            ? await runDynamicAuthProviderLogin(provider, {}, services)
            : await runDynamicAuthProviderLogout(provider, services);
      Object.defineProperty(outputs, String(attempt), {
        configurable: true,
        enumerable: true,
        value: output,
        writable: true,
      });
    }
  } finally {
    if (original === undefined) {
      Reflect.deleteProperty(Array.prototype, property);
    } else {
      Object.defineProperty(Array.prototype, property, original);
    }
    console.log = originalLog;
  }

  const restored = descriptorsEqual(
    Reflect.getOwnPropertyDescriptor(Array.prototype, property),
    original
  );
  let denseFrozen = true;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const output = Reflect.getOwnPropertyDescriptor(outputs, String(attempt))
      ?.value as
      | readonly { readonly metadata?: Readonly<Record<string, unknown>> }[]
      | { readonly messages?: readonly string[] };
    const values = Array.isArray(output)
      ? output
      : (output as { readonly messages?: readonly string[] }).messages;
    denseFrozen =
      denseFrozen &&
      Array.isArray(values) &&
      Object.getPrototypeOf(values) === Array.prototype &&
      Object.isFrozen(values) &&
      Reflect.getOwnPropertyDescriptor(values, '0')?.value !== undefined;
    if (Array.isArray(output)) {
      denseFrozen =
        denseFrozen &&
        Object.isFrozen(output[0]) &&
        Object.isFrozen(output[0]?.metadata);
    }
  }
  return {
    attempts: 2,
    behavior: prototypeBehavior,
    denseFrozen,
    hook: prototypeHook,
    hookCalls: trapReads,
    restored,
    safe: trapReads === 0 && restored && denseFrozen,
    site: prototypeSite,
  };
}

async function run() {
  if (mode === 'github-credential-prototype') {
    const result = await runGitHubCredentialPrototypeProbe();
    return { kind: 'Success', ...result };
  }
  if (mode === 'auth-capture-intrinsic') {
    const result = await runAuthCaptureIntrinsicProbe();
    return { kind: 'Success', ...result };
  }
  const registry = createKeyringCommandRegistry();
  registry.registerExternalPlugin(
    definePublicAidePlugin({
      id: `auth-subprocess-${mode}`,
      summary: 'Auth public boundary subprocess fixture',
      commands: [],
      capabilities: {
        authProvider: {
          providerId: `auth-subprocess-${mode}`,
          label: 'Auth subprocess fixture',
          status: (() => hostileReturn()) as never,
          accounts: (() =>
            mode === 'prototype-array'
              ? Effect.succeed([
                  {
                    id:
                      prototypeSite === 'account-metadata'
                        ? 'prototype-account'
                        : `${prototypeMarker}-ACCOUNT`,
                    label: 'Prototype account',
                    metadata: { [`${prototypeMarker}-METADATA`]: true },
                  },
                ])
              : mode === 'result-accounts'
                ? hostileReturn()
                : Effect.succeed([])) as never,
          login: { fields: [] },
          logout: {},
          operations: {
            login: (() =>
              mode === 'prototype-array'
                ? Effect.succeed({
                    status: 'stored' as const,
                    messages: [`${prototypeMarker}-LOGIN`],
                  })
                : mode === 'result-login'
                  ? hostileReturn()
                  : Effect.succeed({ status: 'stored' as const })) as never,
            logout: (() =>
              mode === 'prototype-array'
                ? Effect.succeed({
                    status: 'removed' as const,
                    messages: [`${prototypeMarker}-LOGOUT`],
                  })
                : mode === 'result-logout'
                  ? hostileReturn()
                  : Effect.succeed({ status: 'removed' as const })) as never,
          },
        },
      },
    }),
    {
      manifest: {
        id: `auth-subprocess-${mode}`,
        version: '1.0.0',
        aidePluginApiVersion: AIDE_PLUGIN_API_VERSION,
        capabilities: ['auth-provider'],
      },
    }
  );
  const services = createAideInternalHostServices(
    registry,
    makeTestKeyring().layer,
    testGitHubAuthCatalogLayer
  );
  const provider = services.authProviderRegistrations()[0];
  if (provider === undefined || provider.provenance !== 'external') {
    throw new Error('missing external fixture provider');
  }
  if (mode === 'prototype-array') {
    const prototypeResult = await runPrototypeArrayProbe(provider, services);
    await Promise.resolve();
    await Bun.sleep(0);
    return { kind: 'Success', ...prototypeResult };
  }
  const invocation =
    mode === 'result-accounts'
      ? runDynamicAuthProviderAccounts(provider, services)
      : mode === 'result-login'
        ? runDynamicAuthProviderLogin(provider, {}, services)
        : mode === 'result-logout'
          ? runDynamicAuthProviderLogout(provider, services)
          : runDynamicAuthProviderStatus(provider, services);
  const outcome = await invocation.then(
    () => ({ success: true as const }),
    (error: unknown) => ({ success: false as const, error })
  );
  const expectsSuccess =
    mode === 'pipe-getter' || mode === 'hostile-composed-output';
  const expectedFailure =
    mode === 'forged-instruction'
      ? AuthProviderOperationError
      : InvalidAuthProviderOperationResultError;
  const kind = outcome.success
    ? 'Success'
    : outcome.error instanceof Error
      ? outcome.error.name
      : 'Unknown';
  const surface =
    !outcome.success && outcome.error instanceof Error
      ? exportedErrorText(outcome.error)
      : '';
  const safe =
    !surface.includes(secret) &&
    (expectsSuccess
      ? outcome.success
      : !outcome.success && outcome.error instanceof expectedFailure) &&
    trapReads === 0;
  await Promise.resolve();
  await Bun.sleep(0);
  return { kind, safe };
}

try {
  const result = await run();
  console.log(
    JSON.stringify({
      ok: result.safe,
      mode,
      safe: result.safe,
      trapReads,
      uncaughtExceptions,
      unhandledRejections,
      kind: result.kind,
      ...(mode === 'prototype-array' ||
      mode === 'github-credential-prototype' ||
      mode === 'auth-capture-intrinsic'
        ? result
        : {}),
    })
  );
} catch {
  await Promise.resolve();
  await Bun.sleep(0);
  console.log(
    JSON.stringify({
      ok: false,
      mode,
      safe: false,
      trapReads,
      uncaughtExceptions,
      unhandledRejections,
      kind: 'escaped',
    })
  );
}
