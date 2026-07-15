import { describe, expect, test } from 'bun:test';
import {
  Cause,
  Deferred,
  Effect,
  Either,
  Exit,
  Fiber,
  FiberId,
  FiberRef,
  Option,
} from 'effect';

import {
  AIDE_PLUGIN_API_VERSION,
  defineAidePlugin as definePublicAidePlugin,
} from '@aide/plugin-api';
import {
  runDynamicAuthProviderAccounts,
  runDynamicAuthProviderLogin,
  runDynamicAuthProviderLogout,
  runDynamicAuthProviderStatus,
} from '@cli/commands/auth-provider-command-utils.js';
import { renderTopLevelError } from '@cli/index.js';
import { createKeyringCommandRegistry } from './command-registry.js';
import {
  AuthProviderOperationError,
  InvalidAuthProviderOperationResultError,
  getAuthProviderStatus,
  listAuthProviderAccounts,
  loginWithAuthProvider,
  logoutWithAuthProvider,
} from './auth-provider-operations.js';
import type {
  AideAuthAccount,
  AideAuthLoginRequest,
  AideAuthLoginResult,
  AideAuthLogoutResult,
  AidePluginAuthStatus,
} from './plugin-descriptor.js';
import {
  AideInternalHostServicesTag,
  createAideInternalHostServices,
  type AideAuthProviderRegistration,
  type AideInternalHostServices,
} from './runtime-context.js';
import { KeyringService } from '@lib/auth-keyring.js';
import { makeTestKeyring } from '@lib/auth-keyring.test-helper.js';
import { GitHubAuthCatalogService } from '@lib/github-auth-catalog.js';
import { testGitHubAuthCatalogLayer } from '@lib/github-auth-catalog.test-helper.js';
import {
  backendFailureSentinels,
  exportedErrorText,
  maliciousBackendFailure,
} from '@lib/error-redaction.test-helper.js';

type AuthOperation = 'status' | 'accounts' | 'login' | 'logout';

const operations = ['status', 'accounts', 'login', 'logout'] as const;

function currentFiberRefValue<A>(
  fiberRef: FiberRef.FiberRef<A>
): A | undefined {
  const current = (
    globalThis as typeof globalThis & {
      readonly ['effect/FiberCurrent']?: {
        readonly getFiberRef: (ref: FiberRef.FiberRef<A>) => A;
      };
    }
  )['effect/FiberCurrent'];
  return current?.getFiberRef(fiberRef);
}

function validResult(operation: AuthOperation): unknown {
  switch (operation) {
    case 'status':
      return { state: 'configured' as const };
    case 'accounts':
      return [{ id: 'work', label: 'Work' }] satisfies AideAuthAccount[];
    case 'login':
      return { status: 'stored' as const } satisfies AideAuthLoginResult;
    case 'logout':
      return { status: 'removed' as const } satisfies AideAuthLogoutResult;
  }
}

function expectedResult(operation: AuthOperation, providerId: string): unknown {
  const result = validResult(operation);
  return operation === 'accounts'
    ? [{ id: 'work', providerId, label: 'Work' }]
    : result;
}

function externalManifest(id: string) {
  return {
    id,
    version: '1.0.0',
    aidePluginApiVersion: AIDE_PLUGIN_API_VERSION,
    capabilities: ['auth-provider'],
  } as const;
}

type CallbackResults = Readonly<Record<AuthOperation, () => unknown>>;

function makeExternalProvider(
  id: string,
  callbacks: CallbackResults
): {
  readonly provider: Extract<
    AideAuthProviderRegistration,
    { readonly provenance: 'external' }
  >;
  readonly services: AideInternalHostServices;
} {
  const registry = createKeyringCommandRegistry();
  registry.registerExternalPlugin(
    definePublicAidePlugin({
      id,
      summary: 'External auth boundary probe',
      commands: [],
      capabilities: {
        authProvider: {
          providerId: id,
          label: 'External Auth Boundary Probe',
          login: { fields: [] },
          logout: {},
          status: callbacks.status as () => Effect.Effect<AidePluginAuthStatus>,
          accounts: callbacks.accounts as () => Effect.Effect<
            readonly AideAuthAccount[]
          >,
          operations: {
            login: callbacks.login as (
              request: AideAuthLoginRequest
            ) => Effect.Effect<AideAuthLoginResult>,
            logout:
              callbacks.logout as () => Effect.Effect<AideAuthLogoutResult>,
          },
        },
      },
    }),
    { manifest: externalManifest(id) }
  );
  const services = createAideInternalHostServices(
    registry,
    makeTestKeyring(new Map([['aide:jira', 'FAKE-AMBIENT-KEYRING']])).layer,
    testGitHubAuthCatalogLayer
  );
  const provider = services.authProviderRegistrations()[0];
  expect(provider?.provenance).toBe('external');
  if (provider === undefined || provider.provenance !== 'external') {
    throw new Error('Missing external auth provider');
  }
  return { provider, services };
}

function callbacksFor(
  selected: AuthOperation,
  callback: () => unknown
): CallbackResults {
  return Object.fromEntries(
    operations.map((operation) => [
      operation,
      operation === selected
        ? callback
        : () => Effect.succeed(validResult(operation)),
    ])
  ) as unknown as CallbackResults;
}

function invokeDynamic(
  operation: AuthOperation,
  provider: Extract<
    AideAuthProviderRegistration,
    { readonly provenance: 'external' }
  >,
  services: AideInternalHostServices,
  request: AideAuthLoginRequest = {}
): Promise<unknown> {
  switch (operation) {
    case 'status':
      return runDynamicAuthProviderStatus(provider, services);
    case 'accounts':
      return runDynamicAuthProviderAccounts(provider, services);
    case 'login':
      return runDynamicAuthProviderLogin(provider, request, services);
    case 'logout':
      return runDynamicAuthProviderLogout(provider, services);
  }
}

function operationEffect(
  operation: AuthOperation,
  provider: Extract<
    AideAuthProviderRegistration,
    { readonly provenance: 'external' }
  >,
  request: AideAuthLoginRequest = {}
): Effect.Effect<unknown, unknown> {
  switch (operation) {
    case 'status':
      return getAuthProviderStatus(provider);
    case 'accounts':
      return listAuthProviderAccounts(provider);
    case 'login':
      return loginWithAuthProvider(provider, request);
    case 'logout':
      return logoutWithAuthProvider(provider);
  }
}

function throwingPipeGetter(result: unknown, secret: string): unknown {
  const effect = Effect.succeed(result);
  Object.defineProperty(effect, 'pipe', {
    configurable: true,
    get() {
      throw new Error(secret);
    },
  });
  return effect;
}

function throwingPipeInvocation(result: unknown, secret: string): unknown {
  const effect = Effect.succeed(result);
  Object.defineProperty(effect, 'pipe', {
    configurable: true,
    value() {
      throw new Error(secret);
    },
  });
  return effect;
}

function hostileComposedOutput(result: unknown, secret: string): unknown {
  const effect = Effect.succeed(result);
  Object.defineProperty(effect, 'pipe', {
    configurable: true,
    value() {
      return new Proxy(
        {},
        {
          get() {
            throw new Error(secret);
          },
        }
      );
    },
  });
  return effect;
}

function forgedInstructionEffect(secret: string): unknown {
  const genuine = Effect.succeed(undefined);
  const forged = Object.create(Object.getPrototypeOf(genuine)) as Record<
    PropertyKey,
    unknown
  >;
  Object.defineProperty(forged, Effect.EffectTypeId, {
    configurable: true,
    value: Object.freeze({}),
  });
  Object.defineProperty(forged, '_op', {
    configurable: true,
    get() {
      throw new Error(secret);
    },
  });
  return forged;
}

function expectRedactedAuthError(
  error: unknown,
  secrets: readonly string[],
  attackers: readonly unknown[] = []
): asserts error is Error {
  expect(error).toBeInstanceOf(Error);
  if (!(error instanceof Error)) throw new Error('Expected an Error');
  for (const attacker of attackers) {
    expect(error).not.toBe(attacker);
    expect((error as Error & { cause?: unknown }).cause).not.toBe(attacker);
  }
  const surfaces = [exportedErrorText(error), renderTopLevelError(error)];
  for (const surface of surfaces) {
    for (const secret of secrets) expect(surface).not.toContain(secret);
  }
}

interface HostileReturnCase {
  readonly name: string;
  readonly make: (result: unknown) => {
    readonly value: unknown;
    readonly secrets: readonly string[];
    readonly reads?: () => number;
  };
  readonly expected: 'success' | 'invalid' | 'operation-error';
}

const hostileReturnCases: readonly HostileReturnCase[] = [
  {
    name: 'primitive return',
    make: () => ({ value: 0, secrets: [] }),
    expected: 'invalid',
  },
  {
    name: 'plain object return',
    make: () => ({ value: {}, secrets: [] }),
    expected: 'invalid',
  },
  {
    name: 'non-Effect Proxy with throwing has trap',
    make: () => {
      const secret = 'SECRET-AUTH-HAS-TRAP';
      let reads = 0;
      return {
        value: new Proxy(
          {},
          {
            has() {
              reads += 1;
              throw new Error(secret);
            },
          }
        ),
        secrets: [secret],
        reads: () => reads,
      };
    },
    expected: 'invalid',
  },
  {
    name: 'revoked Proxy',
    make: () => {
      const pair = Proxy.revocable({}, {});
      pair.revoke();
      return { value: pair.proxy, secrets: ['SECRET-AUTH-REVOKED'] };
    },
    expected: 'invalid',
  },
  {
    name: 'Proxy around genuine Effect',
    make: (result) => {
      const secret = 'SECRET-AUTH-EFFECT-PROXY';
      let reads = 0;
      return {
        value: new Proxy(Effect.succeed(result), {
          get() {
            reads += 1;
            throw new Error(secret);
          },
          has() {
            reads += 1;
            throw new Error(secret);
          },
        }),
        secrets: [secret],
        reads: () => reads,
      };
    },
    expected: 'invalid',
  },
  {
    name: 'genuine Effect with throwing pipe getter',
    make: (result) => {
      const secret = 'SECRET-AUTH-PIPE-GETTER';
      return { value: throwingPipeGetter(result, secret), secrets: [secret] };
    },
    expected: 'success',
  },
  {
    name: 'genuine Effect with throwing pipe invocation',
    make: (result) => {
      const secret = 'SECRET-AUTH-PIPE-INVOCATION';
      return {
        value: throwingPipeInvocation(result, secret),
        secrets: [secret],
      };
    },
    expected: 'success',
  },
  {
    name: 'genuine Effect with hostile composed output',
    make: (result) => {
      const secret = 'SECRET-AUTH-COMPOSED-OUTPUT';
      return {
        value: hostileComposedOutput(result, secret),
        secrets: [secret],
      };
    },
    expected: 'success',
  },
  {
    name: 'forged Effect with throwing instruction getter',
    make: () => {
      const secret = 'SECRET-AUTH-INSTRUCTION';
      return { value: forgedInstructionEffect(secret), secrets: [secret] };
    },
    expected: 'operation-error',
  },
];

function hostileProxy<T extends object>(
  target: T,
  secret: string
): {
  readonly value: T;
  readonly reads: () => number;
} {
  let reads = 0;
  return {
    value: new Proxy(target, {
      get() {
        reads += 1;
        throw new Error(secret);
      },
      getOwnPropertyDescriptor() {
        reads += 1;
        throw new Error(secret);
      },
      ownKeys() {
        reads += 1;
        throw new Error(secret);
      },
    }),
    reads: () => reads,
  };
}

async function expectInvalidSuccessfulResult(
  operation: AuthOperation,
  result: unknown,
  options: {
    readonly id: string;
    readonly secrets?: readonly string[];
    readonly attackers?: readonly unknown[];
    readonly reads?: () => number;
  }
): Promise<void> {
  const { provider, services } = makeExternalProvider(
    options.id,
    callbacksFor(operation, () => Effect.succeed(result))
  );
  const error = await invokeDynamic(operation, provider, services).catch(
    (failure: unknown) => failure
  );
  expect(error, options.id).toBeInstanceOf(
    InvalidAuthProviderOperationResultError
  );
  expectRedactedAuthError(
    error,
    options.secrets ?? [],
    options.attackers ?? []
  );
  expect(options.reads?.() ?? 0, options.id).toBe(0);
}

describe('external auth-provider public Effect boundary', () => {
  test('admits official inherited-marker Effects through every real auth dispatch family', async () => {
    const callbacks = Object.fromEntries(
      operations.map((operation) => [
        operation,
        () => Either.right(validResult(operation)),
      ])
    ) as unknown as CallbackResults;
    const { provider, services } = makeExternalProvider(
      'auth-inherited-effect-markers',
      callbacks
    );

    for (const operation of operations) {
      await expect(
        invokeDynamic(operation, provider, services),
        operation
      ).resolves.toEqual(
        expectedResult(operation, provider.capability.providerId)
      );
    }
  });

  for (const operation of operations) {
    for (const hostile of hostileReturnCases) {
      test(`${operation} normalizes ${hostile.name} through real host dispatch`, async () => {
        const hostileValue = hostile.make(validResult(operation));
        const { provider, services } = makeExternalProvider(
          `auth-${operation}-${hostile.name}`
            .toLowerCase()
            .replaceAll(/[^a-z0-9]+/g, '-')
            .replace(/-$/, ''),
          callbacksFor(operation, () => hostileValue.value)
        );
        const outcome = await invokeDynamic(operation, provider, services).then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error })
        );

        if (hostile.expected === 'success') {
          expect(outcome.ok, hostile.name).toBe(true);
          if (outcome.ok) {
            expect(outcome.value).toEqual(
              expectedResult(operation, provider.capability.providerId)
            );
          }
        } else {
          expect(outcome.ok, hostile.name).toBe(false);
          if (outcome.ok) throw new Error('Expected hostile return rejection');
          expectRedactedAuthError(outcome.error, hostileValue.secrets);
          expect(outcome.error).toBeInstanceOf(
            hostile.expected === 'invalid'
              ? InvalidAuthProviderOperationResultError
              : AuthProviderOperationError
          );
        }
        expect(hostileValue.reads?.() ?? 0, hostile.name).toBe(0);
      });
    }
  }

  test('rejects ordinary and revoked Proxy successes through all four real dispatch families without traps or retention', async () => {
    for (const operation of operations) {
      const secret = `SECRET-AUTH-RESULT-PROXY-${operation}`;
      const proxy = hostileProxy(validResult(operation) as object, secret);
      await expectInvalidSuccessfulResult(operation, proxy.value, {
        id: `result-proxy-${operation}`,
        secrets: [secret],
        attackers: [proxy.value],
        reads: proxy.reads,
      });

      const revoked = Proxy.revocable(validResult(operation) as object, {});
      revoked.revoke();
      await expectInvalidSuccessfulResult(operation, revoked.proxy, {
        id: `result-revoked-${operation}`,
        secrets: [`SECRET-AUTH-RESULT-REVOKED-${operation}`],
        attackers: [revoked.proxy],
      });
    }
  });

  test('atomically rejects hostile nested detail, messages, account, scope, and metadata shapes', async () => {
    const detail = hostileProxy({}, 'SECRET-AUTH-DETAIL-PROXY');
    await expectInvalidSuccessfulResult(
      'status',
      { state: 'configured', detail: detail.value },
      {
        id: 'nested-detail-proxy',
        secrets: ['SECRET-AUTH-DETAIL-PROXY'],
        attackers: [detail.value],
        reads: detail.reads,
      }
    );

    for (const operation of ['login', 'logout'] as const) {
      const status = operation === 'login' ? 'stored' : 'removed';
      const messageProxy = hostileProxy(
        ['safe message'],
        `SECRET-AUTH-MESSAGES-PROXY-${operation}`
      );
      await expectInvalidSuccessfulResult(
        operation,
        { status, messages: messageProxy.value },
        {
          id: `nested-messages-proxy-${operation}`,
          secrets: [`SECRET-AUTH-MESSAGES-PROXY-${operation}`],
          attackers: [messageProxy.value],
          reads: messageProxy.reads,
        }
      );

      let accessorReads = 0;
      const accessorMessages: string[] = [];
      accessorMessages.length = 1;
      Object.defineProperty(accessorMessages, '0', {
        get() {
          accessorReads += 1;
          throw new Error(`SECRET-AUTH-MESSAGE-ACCESSOR-${operation}`);
        },
      });
      await expectInvalidSuccessfulResult(
        operation,
        { status, messages: accessorMessages },
        {
          id: `nested-messages-accessor-${operation}`,
          secrets: [`SECRET-AUTH-MESSAGE-ACCESSOR-${operation}`],
          attackers: [accessorMessages],
          reads: () => accessorReads,
        }
      );

      const sparseMessages: string[] = [];
      sparseMessages.length = 1;
      await expectInvalidSuccessfulResult(
        operation,
        { status, messages: sparseMessages },
        { id: `nested-messages-sparse-${operation}` }
      );

      let iteratorReads = 0;
      class HostileMessages extends Array<string> {}
      const subclass = new HostileMessages('safe message');
      Object.defineProperty(subclass, Symbol.iterator, {
        value() {
          iteratorReads += 1;
          throw new Error(`SECRET-AUTH-MESSAGE-ITERATOR-${operation}`);
        },
      });
      const { provider } = makeExternalProvider(
        `nested-messages-subclass-${operation}`,
        callbacksFor(operation, () =>
          Effect.succeed({ status, messages: subclass })
        )
      );
      const snapshot = (await Effect.runPromise(
        operationEffect(operation, provider)
      )) as AideAuthLoginResult | AideAuthLogoutResult;
      expect(snapshot).toEqual({ status, messages: ['safe message'] });
      expect(Object.getPrototypeOf(snapshot.messages)).toBe(Array.prototype);
      expect(Object.isFrozen(snapshot.messages)).toBe(true);
      expect(iteratorReads).toBe(0);
    }

    const topAccounts = hostileProxy(
      [{ id: 'work', label: 'Work' }],
      'SECRET-AUTH-ACCOUNTS-PROXY'
    );
    await expectInvalidSuccessfulResult('accounts', topAccounts.value, {
      id: 'nested-accounts-proxy',
      secrets: ['SECRET-AUTH-ACCOUNTS-PROXY'],
      attackers: [topAccounts.value],
      reads: topAccounts.reads,
    });

    let accountAccessorReads = 0;
    const accountAccessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperties(accountAccessor, {
      id: { value: 'work' },
      label: {
        get() {
          accountAccessorReads += 1;
          throw new Error('SECRET-AUTH-ACCOUNT-ACCESSOR');
        },
      },
    });
    await expectInvalidSuccessfulResult('accounts', [accountAccessor], {
      id: 'nested-account-accessor',
      secrets: ['SECRET-AUTH-ACCOUNT-ACCESSOR'],
      attackers: [accountAccessor],
      reads: () => accountAccessorReads,
    });

    const accountProxy = hostileProxy(
      { id: 'work', label: 'Work' },
      'SECRET-AUTH-ACCOUNT-PROXY'
    );
    await expectInvalidSuccessfulResult('accounts', [accountProxy.value], {
      id: 'nested-account-proxy',
      secrets: ['SECRET-AUTH-ACCOUNT-PROXY'],
      attackers: [accountProxy.value],
      reads: accountProxy.reads,
    });

    const inheritedAccount = Object.create({ id: 'inherited-secret' }) as {
      label: string;
    };
    inheritedAccount.label = 'Work';
    await expectInvalidSuccessfulResult('accounts', [inheritedAccount], {
      id: 'nested-account-inherited',
      secrets: ['inherited-secret'],
      attackers: [inheritedAccount],
    });

    const scopeProxy = hostileProxy({ id: 'scope' }, 'SECRET-AUTH-SCOPE-PROXY');
    await expectInvalidSuccessfulResult(
      'accounts',
      [{ id: 'work', label: 'Work', scope: scopeProxy.value }],
      {
        id: 'nested-scope-proxy',
        secrets: ['SECRET-AUTH-SCOPE-PROXY'],
        attackers: [scopeProxy.value],
        reads: scopeProxy.reads,
      }
    );

    let scopeAccessorReads = 0;
    const scopeAccessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(scopeAccessor, 'id', {
      get() {
        scopeAccessorReads += 1;
        throw new Error('SECRET-AUTH-SCOPE-ACCESSOR');
      },
    });
    await expectInvalidSuccessfulResult(
      'accounts',
      [{ id: 'work', label: 'Work', scope: scopeAccessor }],
      {
        id: 'nested-scope-accessor',
        secrets: ['SECRET-AUTH-SCOPE-ACCESSOR'],
        attackers: [scopeAccessor],
        reads: () => scopeAccessorReads,
      }
    );

    const metadataProxy = hostileProxy(
      { rank: 1 },
      'SECRET-AUTH-METADATA-PROXY'
    );
    await expectInvalidSuccessfulResult(
      'accounts',
      [{ id: 'work', label: 'Work', metadata: metadataProxy.value }],
      {
        id: 'nested-metadata-proxy',
        secrets: ['SECRET-AUTH-METADATA-PROXY'],
        attackers: [metadataProxy.value],
        reads: metadataProxy.reads,
      }
    );

    let metadataAccessorReads = 0;
    const accessorMetadata = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessorMetadata, 'rank', {
      enumerable: true,
      get() {
        metadataAccessorReads += 1;
        throw new Error('SECRET-AUTH-METADATA-ACCESSOR');
      },
    });
    await expectInvalidSuccessfulResult(
      'accounts',
      [{ id: 'work', label: 'Work', metadata: accessorMetadata }],
      {
        id: 'nested-metadata-accessor',
        secrets: ['SECRET-AUTH-METADATA-ACCESSOR'],
        attackers: [accessorMetadata],
        reads: () => metadataAccessorReads,
      }
    );

    const symbolSecret = 'SECRET-AUTH-METADATA-SYMBOL';
    const symbolMetadata = { rank: 1 } as Record<PropertyKey, unknown>;
    symbolMetadata[Symbol(symbolSecret)] = symbolSecret;
    await expectInvalidSuccessfulResult(
      'accounts',
      [{ id: 'work', label: 'Work', metadata: symbolMetadata }],
      {
        id: 'nested-metadata-symbol',
        secrets: [symbolSecret],
        attackers: [symbolMetadata],
      }
    );

    const unsafeMetadata = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(unsafeMetadata, '__proto__', {
      enumerable: true,
      value: 'SECRET-AUTH-METADATA-PROTOTYPE',
    });
    await expectInvalidSuccessfulResult(
      'accounts',
      [{ id: 'work', label: 'Work', metadata: unsafeMetadata }],
      {
        id: 'nested-metadata-unsafe-key',
        secrets: ['SECRET-AUTH-METADATA-PROTOTYPE'],
        attackers: [unsafeMetadata],
      }
    );
  });

  test('enforces host-owned auth result snapshot bounds at the documented boundary', async () => {
    const atMessageBounds = Array.from({ length: 1_000 }, () =>
      'm'.repeat(1_024)
    );
    const validLogin = makeExternalProvider(
      'auth-message-boundary-valid',
      callbacksFor('login', () =>
        Effect.succeed({ status: 'stored', messages: atMessageBounds })
      )
    );
    const loginSnapshot = (await Effect.runPromise(
      operationEffect('login', validLogin.provider)
    )) as AideAuthLoginResult;
    expect(loginSnapshot).toEqual({
      status: 'stored',
      messages: atMessageBounds,
    });
    expect(Object.isFrozen(loginSnapshot.messages)).toBe(true);

    await expectInvalidSuccessfulResult(
      'login',
      { status: 'stored', messages: Array(1_001).fill('message') },
      { id: 'auth-message-count-overflow' }
    );
    await expectInvalidSuccessfulResult(
      'logout',
      { status: 'removed', messages: ['m'.repeat(1_025)] },
      { id: 'auth-message-length-overflow' }
    );

    const atAccountBounds = Array.from({ length: 1_000 }, (_, index) => ({
      id: `account-${index}`,
      label: `Account ${index}`,
    }));
    const validAccounts = makeExternalProvider(
      'auth-account-boundary-valid',
      callbacksFor('accounts', () => Effect.succeed(atAccountBounds))
    );
    const accountSnapshot = (await Effect.runPromise(
      operationEffect('accounts', validAccounts.provider)
    )) as readonly AideAuthAccount[];
    expect(accountSnapshot).toHaveLength(1_000);
    expect(Object.isFrozen(accountSnapshot)).toBe(true);

    await expectInvalidSuccessfulResult(
      'accounts',
      Array.from({ length: 1_001 }, (_, index) => ({
        id: `account-${index}`,
        label: `Account ${index}`,
      })),
      { id: 'auth-account-count-overflow' }
    );

    const metadata = Object.fromEntries(
      Array.from({ length: 99 }, (_, index) => [
        `key-${index}`,
        index === 0 ? 'v'.repeat(1_024) : index,
      ])
    );
    const validMetadata = makeExternalProvider(
      'auth-metadata-boundary-valid',
      callbacksFor('accounts', () =>
        Effect.succeed([
          {
            id: 'work',
            label: 'Work',
            metadata: { ...metadata, ['k'.repeat(128)]: true },
          },
        ])
      )
    );
    const metadataSnapshot = (await Effect.runPromise(
      operationEffect('accounts', validMetadata.provider)
    )) as readonly AideAuthAccount[];
    expect(metadataSnapshot[0]!.metadata).toEqual({
      ...metadata,
      ['k'.repeat(128)]: true,
    });
    expect(Object.isFrozen(metadataSnapshot[0]!.metadata)).toBe(true);

    await expectInvalidSuccessfulResult(
      'accounts',
      [
        {
          id: 'work',
          label: 'Work',
          metadata: Object.fromEntries(
            Array.from({ length: 101 }, (_, index) => [`key-${index}`, index])
          ),
        },
      ],
      { id: 'auth-metadata-count-overflow' }
    );
    await expectInvalidSuccessfulResult(
      'accounts',
      [
        {
          id: 'work',
          label: 'Work',
          metadata: { ['k'.repeat(129)]: true },
        },
      ],
      { id: 'auth-metadata-key-overflow' }
    );
    await expectInvalidSuccessfulResult(
      'accounts',
      [
        {
          id: 'work',
          label: 'Work',
          metadata: { note: 'v'.repeat(1_025) },
        },
      ],
      { id: 'auth-metadata-value-overflow' }
    );
  });

  test('redacts ordinary and forged callback throws for every operation family', async () => {
    for (const [index, operation] of operations.entries()) {
      const fixture = maliciousBackendFailure([
        `SECRET-AUTH-CALLBACK-${operation}`,
      ]);
      const thrown: unknown =
        index === 0
          ? fixture.failure
          : index === 1
            ? Object.freeze({
                marker: `SECRET-AUTH-CALLBACK-${operation}`,
                nested: fixture.failure,
              })
            : index === 2
              ? Object.assign(
                  new AuthProviderOperationError({
                    pluginId: 'forged',
                    providerId: 'forged',
                    operation,
                    cause: fixture.failure,
                  }),
                  { forged: `SECRET-AUTH-CALLBACK-${operation}` }
                )
              : Object.assign(
                  new InvalidAuthProviderOperationResultError({
                    pluginId: 'forged',
                    providerId: 'forged',
                    operation,
                    reason: `SECRET-AUTH-CALLBACK-${operation}`,
                  }),
                  { cause: fixture.failure }
                );
      const { provider, services } = makeExternalProvider(
        `callback-throw-${operation}`,
        callbacksFor(operation, () => {
          throw thrown;
        })
      );
      const error = await invokeDynamic(operation, provider, services).catch(
        (failure: unknown) => failure
      );
      expect(error).toBeInstanceOf(AuthProviderOperationError);
      expectRedactedAuthError(
        error,
        [...backendFailureSentinels, `SECRET-AUTH-CALLBACK-${operation}`],
        [thrown, fixture.failure]
      );
      expect(fixture.getterReads()).toBe(0);
    }
  });

  test('maps genuine typed Fail values to fresh fixed auth errors for every family', async () => {
    for (const operation of operations) {
      const fixture = maliciousBackendFailure([
        `SECRET-AUTH-TYPED-FAIL-${operation}`,
      ]);
      const { provider, services } = makeExternalProvider(
        `typed-fail-${operation}`,
        callbacksFor(operation, () => Effect.fail(fixture.failure))
      );
      const error = await invokeDynamic(operation, provider, services).catch(
        (failure: unknown) => failure
      );
      expect(error).toBeInstanceOf(AuthProviderOperationError);
      expectRedactedAuthError(
        error,
        [...backendFailureSentinels, `SECRET-AUTH-TYPED-FAIL-${operation}`],
        [fixture.failure]
      );
      expect(fixture.getterReads()).toBe(0);
    }
  });

  test('preserves documented Success, Fail, Die, Interrupt, and mixed Cause semantics', async () => {
    for (const operation of operations) {
      let returned: unknown = Effect.succeed(validResult(operation));
      const { provider } = makeExternalProvider(
        `cause-semantics-${operation}`,
        callbacksFor(operation, () => returned)
      );

      const success = await Effect.runPromiseExit(
        operationEffect(operation, provider)
      );
      expect(success).toEqual(
        Exit.succeed(expectedResult(operation, provider.capability.providerId))
      );

      const typedFailure = Object.freeze({
        marker: `SECRET-TYPED-CAUSE-${operation}`,
      });
      returned = Effect.fail(typedFailure);
      const failed = await Effect.runPromiseExit(
        operationEffect(operation, provider)
      );
      expect(Exit.isFailure(failed)).toBe(true);
      if (Exit.isFailure(failed)) {
        expect(Array.from(Cause.defects(failed.cause))).toEqual([]);
        const failure = Cause.failureOption(failed.cause);
        expect(Option.isSome(failure)).toBe(true);
        if (Option.isSome(failure)) {
          expect(failure.value).toBeInstanceOf(AuthProviderOperationError);
          expectRedactedAuthError(
            failure.value,
            [typedFailure.marker],
            [typedFailure]
          );
        }
      }

      const defect = new Error(`GENUINE-AUTH-DEFECT-${operation}`);
      returned = Effect.die(defect);
      const defectExit = await Effect.runPromiseExit(
        operationEffect(operation, provider)
      );
      expect(Exit.isFailure(defectExit)).toBe(true);
      if (Exit.isFailure(defectExit)) {
        expect(Cause.dieOption(defectExit.cause)).toEqual(Option.some(defect));
      }

      returned = Effect.interrupt;
      const interruptExit = await Effect.runPromiseExit(
        operationEffect(operation, provider)
      );
      expect(Exit.isFailure(interruptExit)).toBe(true);
      if (Exit.isFailure(interruptExit)) {
        expect(Cause.isInterruptedOnly(interruptExit.cause)).toBe(true);
      }

      const mixed = Cause.parallel(
        Cause.fail(typedFailure),
        Cause.sequential(Cause.die(defect), Cause.interrupt(FiberId.none))
      );
      returned = Effect.failCause(mixed);
      const mixedExit = await Effect.runPromiseExit(
        operationEffect(operation, provider)
      );
      expect(Exit.isFailure(mixedExit)).toBe(true);
      if (Exit.isFailure(mixedExit)) {
        expect(Array.from(Cause.defects(mixedExit.cause))).toEqual([defect]);
        expect(Cause.isInterrupted(mixedExit.cause)).toBe(true);
        const failures = Array.from(Cause.failures(mixedExit.cause));
        expect(failures).toHaveLength(1);
        expect(failures[0]).toBeInstanceOf(AuthProviderOperationError);
        expectRedactedAuthError(
          failures[0],
          [typedFailure.marker],
          [typedFailure]
        );
      }
    }
  });

  test('runs every callback and the login prompt continuation with empty Context and FiberRefs, then restores the caller', async () => {
    const fiberRef = FiberRef.unsafeMake('initial');
    const observations = new Map<
      string,
      {
        readonly keyring: boolean;
        readonly catalog: boolean;
        readonly internal: boolean;
        readonly ref: string;
      }
    >();
    const constructions: string[] = [];
    const synchronousFiberRefs = new Map<string, string | undefined>();
    const observe = (phase: string, result: unknown) =>
      Effect.gen(function* () {
        const keyring = yield* Effect.serviceOption(KeyringService);
        const catalog = yield* Effect.serviceOption(GitHubAuthCatalogService);
        const internal = yield* Effect.serviceOption(
          AideInternalHostServicesTag
        );
        const ref = yield* FiberRef.get(fiberRef);
        observations.set(phase, {
          keyring: Option.isSome(keyring),
          catalog: Option.isSome(catalog),
          internal: Option.isSome(internal),
          ref,
        });
        return result;
      });
    const callback = (operation: AuthOperation) => () => {
      constructions.push(operation);
      synchronousFiberRefs.set(
        `${operation}-callback`,
        currentFiberRefValue(fiberRef)
      );
      return observe(operation, validResult(operation));
    };
    const callbacks: CallbackResults = {
      status: callback('status'),
      accounts: callback('accounts'),
      logout: callback('logout'),
      login: ((request: AideAuthLoginRequest) => {
        constructions.push('login');
        synchronousFiberRefs.set(
          'login-callback',
          currentFiberRefValue(fiberRef)
        );
        synchronousFiberRefs.set(
          'prompt-validate-construction',
          currentFiberRefValue(fiberRef)
        );
        const continuation = request.prompt?.text({
          label: 'Token',
          validate: () => {
            synchronousFiberRefs.set(
              'prompt-validate-execution',
              currentFiberRefValue(fiberRef)
            );
            return null;
          },
        });
        if (continuation === undefined) return Effect.die('missing prompt');
        return Effect.zipRight(
          observe('login', undefined),
          Effect.map(continuation, () => validResult('login'))
        );
      }) as unknown as () => unknown,
    };
    const { provider, services } = makeExternalProvider(
      'auth-context-isolation',
      callbacks
    );
    const prompt = {
      text: (request: {
        readonly validate?: (value: string) => string | null;
      }) => {
        constructions.push('prompt-construction');
        synchronousFiberRefs.set(
          'prompt-construction',
          currentFiberRefValue(fiberRef)
        );
        return Effect.zipRight(
          observe('prompt-execution', undefined),
          Effect.sync(() => {
            synchronousFiberRefs.set(
              'prompt-execution',
              currentFiberRefValue(fiberRef)
            );
            const validation = request.validate?.('token');
            if (validation !== undefined && validation !== null) {
              throw new Error(validation);
            }
            return 'token';
          })
        );
      },
    };
    const ambientKeyring = makeTestKeyring().layer;
    const program = Effect.gen(function* () {
      yield* FiberRef.set(fiberRef, 'ambient');
      for (const operation of operations) {
        const effect = operationEffect(operation, provider, { prompt });
        expect(constructions).not.toContain(operation);
        yield* effect;
      }
      expect(yield* FiberRef.get(fiberRef)).toBe('ambient');
      expect(Option.isSome(yield* Effect.serviceOption(KeyringService))).toBe(
        true
      );
      expect(
        Option.isSome(yield* Effect.serviceOption(GitHubAuthCatalogService))
      ).toBe(true);
      expect(
        Option.isSome(yield* Effect.serviceOption(AideInternalHostServicesTag))
      ).toBe(true);
    }).pipe(
      Effect.provideService(AideInternalHostServicesTag, services),
      Effect.provide(ambientKeyring),
      Effect.provide(testGitHubAuthCatalogLayer)
    );

    await Effect.runPromise(program);

    expect(constructions).toEqual([
      'status',
      'accounts',
      'login',
      'prompt-construction',
      'logout',
    ]);
    for (const phase of [
      'status',
      'accounts',
      'login',
      'prompt-execution',
      'logout',
    ]) {
      expect(observations.get(phase), phase).toEqual({
        keyring: false,
        catalog: false,
        internal: false,
        ref: 'initial',
      });
    }
    expect(synchronousFiberRefs).toEqual(
      new Map([
        ['status-callback', 'initial'],
        ['accounts-callback', 'initial'],
        ['login-callback', 'initial'],
        ['prompt-validate-construction', 'initial'],
        ['prompt-construction', 'initial'],
        ['prompt-execution', 'initial'],
        ['prompt-validate-execution', 'initial'],
        ['logout-callback', 'initial'],
      ])
    );
  });

  test('runs real auth own-data result traversal with initial FiberRefs and restores the caller', async () => {
    const fiberRef = FiberRef.unsafeMake('initial');
    const result = Object.freeze({
      state: 'configured' as const,
      detail: 'ready',
    });
    const observations: string[] = [];
    const { provider } = makeExternalProvider(
      'auth-result-fiberref-traversal',
      callbacksFor('status', () => Effect.succeed(result))
    );
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      Reflect,
      'getOwnPropertyDescriptor'
    );
    if (originalDescriptor === undefined) {
      throw new Error('Missing Reflect.getOwnPropertyDescriptor');
    }
    const original = Reflect.getOwnPropertyDescriptor;
    Object.defineProperty(Reflect, 'getOwnPropertyDescriptor', {
      ...originalDescriptor,
      value(target: object, key: PropertyKey) {
        if (target === result && (key === 'state' || key === 'detail')) {
          observations.push(`${String(key)}:${currentFiberRefValue(fiberRef)}`);
        }
        return original(target, key);
      },
    });

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* FiberRef.set(fiberRef, 'ambient');
          expect(yield* getAuthProviderStatus(provider)).toEqual(result);
          expect(yield* FiberRef.get(fiberRef)).toBe('ambient');
        })
      );
    } finally {
      Object.defineProperty(
        Reflect,
        'getOwnPropertyDescriptor',
        originalDescriptor
      );
    }

    expect(observations).toEqual(['state:initial', 'detail:initial']);
  });

  test('interruption joins external login continuation finalizers under empty authority', async () => {
    const fiberRef = FiberRef.unsafeMake('initial');
    const acquired = await Effect.runPromise(Deferred.make<void>());
    const released = await Effect.runPromise(Deferred.make<void>());
    const observations: string[] = [];
    const { provider, services } = makeExternalProvider(
      'auth-continuation-finalizer',
      callbacksFor('login', () =>
        Effect.acquireUseRelease(
          Effect.gen(function* () {
            const keyring = yield* Effect.serviceOption(KeyringService);
            const internal = yield* Effect.serviceOption(
              AideInternalHostServicesTag
            );
            observations.push(
              `acquire:${Option.isSome(keyring)}:${Option.isSome(internal)}:${yield* FiberRef.get(fiberRef)}`
            );
            yield* Deferred.succeed(acquired, undefined);
          }),
          () => Effect.never,
          () =>
            Effect.gen(function* () {
              const keyring = yield* Effect.serviceOption(KeyringService);
              const internal = yield* Effect.serviceOption(
                AideInternalHostServicesTag
              );
              observations.push(
                `release:${Option.isSome(keyring)}:${Option.isSome(internal)}:${yield* FiberRef.get(fiberRef)}`
              );
              yield* Deferred.succeed(released, undefined);
            })
        )
      )
    );
    const ambientKeyring = makeTestKeyring().layer;
    const program = Effect.gen(function* () {
      yield* FiberRef.set(fiberRef, 'ambient');
      const fiber = yield* Effect.fork(loginWithAuthProvider(provider, {}));
      yield* Deferred.await(acquired);
      const exit = yield* Fiber.interrupt(fiber);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(yield* Deferred.isDone(released)).toBe(true);
      expect(yield* FiberRef.get(fiberRef)).toBe('ambient');
      expect(Option.isSome(yield* Effect.serviceOption(KeyringService))).toBe(
        true
      );
      expect(
        Option.isSome(yield* Effect.serviceOption(AideInternalHostServicesTag))
      ).toBe(true);
    }).pipe(
      Effect.provideService(AideInternalHostServicesTag, services),
      Effect.provide(ambientKeyring)
    );

    await Effect.runPromise(program);
    expect(observations).toEqual([
      'acquire:false:false:initial',
      'release:false:false:initial',
    ]);
  }, 2_000);
});
