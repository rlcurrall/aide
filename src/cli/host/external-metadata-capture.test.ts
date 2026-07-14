import { describe, expect, test } from 'bun:test';
import { Effect } from 'effect';
import yargs from 'yargs';

import {
  AIDE_PLUGIN_API_VERSION,
  textResult,
  type AidePluginManifest,
  type AidePublicPluginDescriptor,
} from '@aide/plugin-api';
import { exportedErrorText } from '@lib/error-redaction.test-helper.js';
import { createCommandRegistry } from './command-registry.js';
import { registerCommands } from './yargs-adapter.js';
import { makeTestKeyring } from '@lib/auth-keyring.test-helper.js';

const captureDiagnostic = 'External plugin metadata capture failed';

function manifest(
  id: string,
  capabilities: readonly string[] = ['commands']
): AidePluginManifest {
  return {
    id,
    version: '1.0.0',
    aidePluginApiVersion: AIDE_PLUGIN_API_VERSION,
    capabilities,
  } as AidePluginManifest;
}

function command(id: string) {
  return {
    kind: 'descriptor' as const,
    id,
    descriptor: {
      id,
      route: `${id}-route`,
      summary: `${id} summary`,
      run: () => Effect.succeed(textResult(id)),
    },
  };
}

function plugin(
  id: string,
  overrides: Partial<
    Record<'summary' | 'commands' | 'capabilities', unknown>
  > = {}
): AidePublicPluginDescriptor {
  return {
    id,
    summary: overrides.summary ?? `${id} summary`,
    commands: overrides.commands ?? [command(`${id}:command`)],
    ...(overrides.capabilities === undefined
      ? {}
      : { capabilities: overrides.capabilities }),
  } as AidePublicPluginDescriptor;
}

function authInputPlugin(
  id: string,
  fields: readonly unknown[]
): AidePublicPluginDescriptor {
  return plugin(id, {
    capabilities: {
      authProvider: {
        providerId: `${id}-provider`,
        label: `${id} provider`,
        login: { fields },
        status: () => Effect.succeed({ state: 'configured' as const }),
      },
    },
  });
}

function fullExternalRegistration(id: string): {
  readonly plugin: AidePublicPluginDescriptor;
  readonly options: { manifest: AidePluginManifest };
  readonly shells: Readonly<Record<string, Record<PropertyKey, unknown>>>;
} {
  const loading = { order: 1, after: [] as string[], before: [] as string[] };
  const conflicts = {
    commands: 'reject' as const,
    authProviders: 'reject' as const,
    pullRequestProviders: 'reject' as const,
  };
  const sourceManifest = {
    ...manifest(id, [
      'commands',
      'auth',
      'auth-provider',
      'prime-contribution',
      'pull-request-provider',
    ]),
    loading,
    conflicts,
  };
  const options = { manifest: sourceManifest };
  const loginCommand = { name: 'login', aliases: ['signin'] };
  const logoutCommand = { name: 'logout', aliases: ['signout'] };
  const choice = { value: 'one', label: 'One' };
  const inputField = {
    kind: 'select' as const,
    key: 'account',
    label: 'Account',
    choices: [choice],
  };
  const envMigration = {
    description: 'Import credentials',
    variables: ['TOKEN'],
  };
  const login = {
    command: loginCommand,
    summary: 'Log in',
    fields: [inputField],
    envMigration,
  };
  const logout = { command: logoutCommand, summary: 'Log out' };
  const authOperations = {
    login: () => Effect.succeed({ status: 'stored' as const }),
    logout: () => Effect.succeed({ status: 'removed' as const }),
  };
  const auth = {
    status: () => Effect.succeed({ state: 'configured' as const }),
  };
  const authProvider = {
    providerId: `${id}-auth`,
    label: 'Auth provider',
    login,
    logout,
    status: () => Effect.succeed({ state: 'configured' as const }),
    accounts: () => Effect.succeed([]),
    operations: authOperations,
  };
  const primeMessages = {
    configured: 'Configured',
    notConfigured: 'Not configured',
    misconfigured: 'Misconfigured',
  };
  const primeStatus = {
    groupId: `${id}-group`,
    groupLabel: 'Group',
    label: 'Status',
    messages: primeMessages,
    status: () => Effect.succeed({ state: 'configured' as const }),
  };
  const primeContribution = {
    status: [primeStatus],
    sections: () => Effect.succeed([]),
  };
  const pullRequestFeatures = {
    draftPullRequests: true,
    reviewComments: true,
    threadedComments: true,
    enterpriseHosts: true,
  };
  const pullRequestOperations = {
    listPullRequests: () => Effect.die('unreachable'),
    getPullRequest: () => Effect.die('unreachable'),
    createPullRequest: () => Effect.die('unreachable'),
    updatePullRequest: () => Effect.die('unreachable'),
    getPullRequestDiff: () => Effect.die('unreachable'),
    listPullRequestComments: () => Effect.die('unreachable'),
    addPullRequestComment: () => Effect.die('unreachable'),
    replyToPullRequestComment: () => Effect.die('unreachable'),
    findPullRequestForBranch: () => Effect.die('unreachable'),
  };
  const pullRequestProvider = {
    providerId: `${id}-pr`,
    priority: 1,
    features: pullRequestFeatures,
    matchRemote: () => null,
    matchRepository: () => Effect.succeed(null),
    matchPullRequestUrl: () => null,
    operations: pullRequestOperations,
    authStatus: () => Effect.succeed({ state: 'configured' as const }),
  };
  const capabilities = {
    auth,
    authProvider,
    primeContribution,
    pullRequestProvider,
  };
  const extension = { kind: 'allowlist' as const, pluginIds: ['friend'] };
  const yargsMetadata = {};
  const placement = {
    ...command(`${id}:command`),
    acceptsChildren: true,
    extension,
  };
  (placement.descriptor as Record<string, unknown>).yargs = yargsMetadata;
  const sourcePlugin = plugin(id, {
    commands: [placement],
    capabilities,
  });

  return {
    plugin: sourcePlugin,
    options,
    shells: {
      options,
      manifest: sourceManifest,
      loading,
      conflicts,
      plugin: sourcePlugin as unknown as Record<string, unknown>,
      capabilities,
      auth,
      authProvider,
      login,
      logout,
      loginCommand,
      logoutCommand,
      inputField,
      choice,
      envMigration,
      authOperations,
      primeContribution,
      primeStatus,
      primeMessages,
      pullRequestProvider,
      pullRequestFeatures,
      pullRequestOperations,
      placement,
      extension,
      descriptor: placement.descriptor as unknown as Record<string, unknown>,
      yargs: yargsMetadata,
    },
  };
}

function captureThrown(run: () => void): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('Expected operation to throw');
}

function expectFixedAtomicFailure(
  register: () => void,
  attacker?: Error,
  secret?: string
): void {
  const first = captureThrown(register);
  const second = captureThrown(register);

  for (const error of [first, second]) {
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBe(attacker);
    expect((error as Error).message).toBe(captureDiagnostic);
    expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
    if (secret !== undefined) {
      expect(exportedErrorText(error as Error)).not.toContain(secret);
    }
  }
  expect(first).not.toBe(second);
}

function accessorRecord(
  base: Record<string, unknown>,
  field: string,
  attacker: Error,
  reads: { value: number }
): Record<string, unknown> {
  return Object.defineProperty(base, field, {
    configurable: true,
    enumerable: true,
    get() {
      reads.value += 1;
      throw attacker;
    },
  });
}

function hostileProxy<T extends object>(
  target: T,
  attacker: Error,
  traps: { value: number }
): T {
  return new Proxy(target, {
    get() {
      traps.value += 1;
      throw attacker;
    },
    getOwnPropertyDescriptor() {
      traps.value += 1;
      throw attacker;
    },
    ownKeys() {
      traps.value += 1;
      throw attacker;
    },
    getPrototypeOf() {
      traps.value += 1;
      throw attacker;
    },
  });
}

function sourceMetadataBudget(roots: readonly unknown[]): {
  readonly values: number;
  readonly stringUnits: number;
} {
  const seen = new WeakSet<object>();
  let values = 0;
  let stringUnits = 0;
  const account = (value: unknown): void => {
    values += 1;
    if (typeof value === 'string') stringUnits += value.length;
  };
  const visit = (value: unknown): void => {
    account(value);
    if (
      value === null ||
      (typeof value !== 'object' && typeof value !== 'function') ||
      typeof value === 'function'
    ) {
      return;
    }
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        account(String(index));
        visit(value[index]);
      }
      return;
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') continue;
      account(key);
      visit((value as Record<string, unknown>)[key]);
    }
  };
  for (const root of roots) visit(root);
  return { values, stringUnits };
}

function collectSourceObjects(roots: readonly unknown[]): WeakSet<object> {
  const sources = new WeakSet<object>();
  const visit = (value: unknown): void => {
    if (typeof value !== 'object' || value === null || sources.has(value)) {
      return;
    }
    sources.add(value);
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor !== undefined &&
        Object.prototype.hasOwnProperty.call(descriptor, 'value')
      ) {
        visit(descriptor.value);
      }
    }
  };
  for (const root of roots) visit(root);
  return sources;
}

function expectDetachedRecursivelyFrozen(
  value: unknown,
  sources: WeakSet<object>,
  seen = new WeakSet<object>()
): void {
  if (typeof value !== 'object' || value === null || seen.has(value)) return;
  seen.add(value);
  expect(sources.has(value)).toBe(false);
  expect(Object.isFrozen(value)).toBe(true);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor !== undefined &&
      Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ) {
      expectDetachedRecursivelyFrozen(descriptor.value, sources, seen);
    }
  }
}

function instrumentSourceCallbacks(
  shells: Readonly<Record<string, Record<PropertyKey, unknown>>>,
  calls: { value: number }
): void {
  const visited = new WeakSet<object>();
  for (const shell of Object.values(shells)) {
    if (visited.has(shell)) continue;
    visited.add(shell);
    for (const key of Reflect.ownKeys(shell)) {
      const descriptor = Object.getOwnPropertyDescriptor(shell, key);
      if (
        descriptor === undefined ||
        !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
        typeof descriptor.value !== 'function'
      ) {
        continue;
      }
      const callback = descriptor.value as (...args: unknown[]) => unknown;
      Object.defineProperty(shell, key, {
        ...descriptor,
        value: (...args: unknown[]) => {
          calls.value += 1;
          return callback(...args);
        },
      });
    }
  }
}

function budgetRegistration(
  id: string,
  commandCount: number
): {
  readonly plugin: AidePublicPluginDescriptor;
  readonly options: { manifest: AidePluginManifest };
  readonly commands: ReturnType<typeof command>[];
} {
  const commands = Array.from({ length: commandCount }, (_, index) => {
    const value = command(`${id}:${index}`);
    value.descriptor.route = `${id}-route-${index}`;
    value.descriptor.summary = 's';
    return value;
  });
  return {
    plugin: plugin(id, { summary: 's', commands }),
    options: { manifest: manifest(id) },
    commands,
  };
}

function addCrossSchemaBudgetAlias(
  value: ReturnType<typeof budgetRegistration>
): void {
  const sharedLoginLogout = {
    summary: 'shared-cross-schema-budget-metadata',
  };
  (value.plugin as unknown as Record<string, unknown>).capabilities = {
    authProvider: {
      providerId: `${value.plugin.id}-auth`,
      label: 'Budget auth provider',
      login: sharedLoginLogout,
      logout: sharedLoginLogout,
      status: () => Effect.succeed({ state: 'configured' as const }),
    },
  };
  (value.options.manifest as unknown as Record<string, unknown>).capabilities =
    ['commands', 'auth-provider'];
}

describe('external plugin metadata capture', () => {
  test('completes plugin and manifest structural capture before plugin-id semantics', () => {
    const registry = createCommandRegistry();
    const attacker = new Error('SECRET-LATE-MANIFEST-VERSION');
    const reads = { value: 0 };
    const hostileManifest = accessorRecord(
      manifest('Invalid Plugin Id') as unknown as Record<string, unknown>,
      'version',
      attacker,
      reads
    ) as unknown as AidePluginManifest;

    expectFixedAtomicFailure(
      () =>
        void registry.registerExternalPlugin(plugin('Invalid Plugin Id'), {
          manifest: hostileManifest,
        }),
      attacker,
      attacker.message
    );
    expect(reads.value).toBe(0);
    expect(registry.plugins()).toEqual([]);
    expect(registry.commands()).toEqual([]);
  });

  test('captures every descriptor-kind field before identity and namespace semantics', () => {
    const registry = createCommandRegistry();
    const attacker = new Error('SECRET-LATE-DESCRIPTOR-ROUTE');
    const reads = { value: 0 };
    const placement = command('foreign:command');
    accessorRecord(
      placement.descriptor as unknown as Record<string, unknown>,
      'route',
      attacker,
      reads
    );

    expectFixedAtomicFailure(
      () =>
        void registry.registerExternalPlugin(
          plugin('namespace-order', { commands: [placement] }),
          { manifest: manifest('namespace-order') }
        ),
      attacker,
      attacker.message
    );
    expect(reads.value).toBe(0);
    expect(registry.plugins()).toEqual([]);
    expect(registry.commands()).toEqual([]);
  });

  test('classifies hostile placement structure before deferred identity defects', () => {
    const variants = [
      {
        name: 'missing id before parentId accessor',
        build(attacker: Error, reads: { value: number }) {
          const placement = {
            kind: 'descriptor' as const,
            descriptor: command('placement-order:command').descriptor,
          } as Record<string, unknown>;
          return accessorRecord(placement, 'parentId', attacker, reads);
        },
      },
      {
        name: 'missing id before acceptsChildren accessor',
        build(attacker: Error, reads: { value: number }) {
          const placement = {
            kind: 'descriptor' as const,
            descriptor: command('placement-order:command').descriptor,
          } as Record<string, unknown>;
          return accessorRecord(placement, 'acceptsChildren', attacker, reads);
        },
      },
      {
        name: 'missing id before extension accessor',
        build(attacker: Error, reads: { value: number }) {
          const placement = {
            kind: 'descriptor' as const,
            descriptor: command('placement-order:command').descriptor,
          } as Record<string, unknown>;
          return accessorRecord(placement, 'extension', attacker, reads);
        },
      },
      {
        name: 'id accessor before later parentId accessor',
        build(attacker: Error, reads: { value: number }) {
          const placement = {
            kind: 'descriptor' as const,
            descriptor: command('placement-order:command').descriptor,
          } as Record<string, unknown>;
          accessorRecord(placement, 'id', attacker, reads);
          return accessorRecord(placement, 'parentId', attacker, reads);
        },
      },
      {
        name: 'primitive descriptor before later extension accessor',
        build(attacker: Error, reads: { value: number }) {
          const placement = {
            kind: 'descriptor' as const,
            id: 'placement-order:command',
            descriptor: 'invalid descriptor reference',
          } as Record<string, unknown>;
          return accessorRecord(placement, 'extension', attacker, reads);
        },
      },
    ] as const;

    for (const variant of variants) {
      const registry = createCommandRegistry();
      const attacker = new Error(`SECRET-${variant.name}`);
      const reads = { value: 0 };
      const placement = variant.build(attacker, reads);

      expectFixedAtomicFailure(
        () =>
          void registry.registerExternalPlugin(
            plugin('placement-order', { commands: [placement] }),
            { manifest: manifest('placement-order') }
          ),
        attacker,
        attacker.message
      );
      expect(reads.value, variant.name).toBe(0);
      expect(registry.pluginIds(), variant.name).toEqual([]);
      expect(registry.commandIds(), variant.name).toEqual([]);
    }
  });

  test('classifies hostile descriptor structure before deferred id defects', () => {
    const variants = [
      ['missing id before route accessor', 'missing', 'route'],
      ['missing id before yargs accessor', 'missing', 'yargs'],
      ['id accessor before route accessor', 'accessor', 'route'],
      ['id accessor before yargs accessor', 'accessor', 'yargs'],
      ['malformed id before route accessor', 'malformed', 'route'],
      ['malformed id before yargs accessor', 'malformed', 'yargs'],
    ] as const;

    for (const [name, idVariant, hostileField] of variants) {
      const registry = createCommandRegistry();
      const attacker = new Error(`SECRET-${name}`);
      const reads = { value: 0 };
      const descriptor: Record<string, unknown> = {};
      if (idVariant === 'accessor') {
        accessorRecord(descriptor, 'id', attacker, reads);
      } else if (idVariant === 'malformed') {
        descriptor.id = 42;
      }
      if (hostileField !== 'route') {
        descriptor.route = 'descriptor-order-route';
      }
      descriptor.summary = 'Descriptor ordering';
      descriptor.run = () => Effect.succeed(textResult('unreachable'));
      accessorRecord(descriptor, hostileField, attacker, reads);
      const placement = {
        kind: 'descriptor' as const,
        id: 'descriptor-order:command',
        descriptor,
      };

      expectFixedAtomicFailure(
        () =>
          void registry.registerExternalPlugin(
            plugin('descriptor-order', { commands: [placement] }),
            { manifest: manifest('descriptor-order') }
          ),
        attacker,
        attacker.message
      );
      expect(reads.value, name).toBe(0);
      expect(registry.pluginIds(), name).toEqual([]);
      expect(registry.commandIds(), name).toEqual([]);
    }
  });

  test('classifies custom-prototype descriptor shells before deferred id defects', () => {
    const structuralVariants = [
      {
        name: 'inherited id before route accessor',
        build(
          attacker: Error,
          _idReads: { value: number },
          laterReads: { value: number }
        ) {
          const prototype = { id: 'custom-descriptor-order:command' };
          const descriptor = Object.assign(Object.create(prototype), {
            summary: 'Inherited identity ordering',
            run: () => Effect.succeed(textResult('unreachable')),
          }) as Record<string, unknown>;
          return accessorRecord(descriptor, 'route', attacker, laterReads);
        },
      },
      {
        name: 'own id accessor before yargs accessor',
        build(
          attacker: Error,
          idReads: { value: number },
          laterReads: { value: number }
        ) {
          const descriptor = Object.assign(Object.create({}), {
            route: 'custom-prototype-route',
            summary: 'Accessor identity ordering',
            run: () => Effect.succeed(textResult('unreachable')),
          }) as Record<string, unknown>;
          accessorRecord(descriptor, 'id', attacker, idReads);
          return accessorRecord(descriptor, 'yargs', attacker, laterReads);
        },
      },
    ] as const;

    for (const variant of structuralVariants) {
      const registry = createCommandRegistry();
      const attacker = new Error(`SECRET-${variant.name}`);
      const idReads = { value: 0 };
      const laterReads = { value: 0 };
      const descriptor = variant.build(attacker, idReads, laterReads);

      expectFixedAtomicFailure(
        () =>
          void registry.registerExternalPlugin(
            plugin('custom-descriptor-order', {
              commands: [
                {
                  kind: 'descriptor',
                  id: 'custom-descriptor-order:command',
                  descriptor,
                },
              ],
            }),
            { manifest: manifest('custom-descriptor-order') }
          ),
        attacker,
        attacker.message
      );
      expect(idReads.value, variant.name).toBe(0);
      expect(laterReads.value, variant.name).toBe(0);
      expect(registry.pluginIds(), variant.name).toEqual([]);
      expect(registry.commandIds(), variant.name).toEqual([]);
    }
  });

  test('retains identity diagnostics for custom-prototype descriptor controls', () => {
    const identityDiagnostic =
      'External plugin command identity must use valid own string data properties';
    const controls = [
      {
        name: 'inherited id',
        build(_attacker: Error, _idReads: { value: number }) {
          const prototype = { id: 'custom-descriptor-control:command' };
          return Object.assign(Object.create(prototype), {
            route: 'custom-prototype-route',
            summary: 'Inherited identity control',
            run: () => Effect.succeed(textResult('unreachable')),
          }) as Record<string, unknown>;
        },
      },
      {
        name: 'own id accessor',
        build(attacker: Error, idReads: { value: number }) {
          const descriptor = Object.assign(Object.create({}), {
            route: 'custom-prototype-route',
            summary: 'Accessor identity control',
            run: () => Effect.succeed(textResult('unreachable')),
            yargs: {},
          }) as Record<string, unknown>;
          return accessorRecord(descriptor, 'id', attacker, idReads);
        },
      },
    ] as const;

    for (const control of controls) {
      const registry = createCommandRegistry();
      const attacker = new Error(`SECRET-${control.name}`);
      const idReads = { value: 0 };
      const descriptor = control.build(attacker, idReads);
      const register = () =>
        void registry.registerExternalPlugin(
          plugin('custom-descriptor-control', {
            commands: [
              {
                kind: 'descriptor',
                id: 'custom-descriptor-control:command',
                descriptor,
              },
            ],
          }),
          { manifest: manifest('custom-descriptor-control') }
        );
      const first = captureThrown(register);
      const second = captureThrown(register);

      for (const error of [first, second]) {
        expect(error, control.name).toBeInstanceOf(Error);
        expect(error, control.name).not.toBe(attacker);
        expect((error as Error).message, control.name).toBe(identityDiagnostic);
        expect(
          (error as Error & { cause?: unknown }).cause,
          control.name
        ).toBeUndefined();
        expect(exportedErrorText(error as Error), control.name).not.toContain(
          attacker.message
        );
      }
      expect(first, control.name).not.toBe(second);
      expect(idReads.value, control.name).toBe(0);
      expect(registry.pluginIds(), control.name).toEqual([]);
      expect(registry.commandIds(), control.name).toEqual([]);
    }
  });

  test('accounts primitive descriptor references before object and identity classification', () => {
    const identityDiagnostic =
      'External plugin command identity must use valid own string data properties';
    const exactRegistry = createCommandRegistry();
    const exactFailure = captureThrown(() =>
      exactRegistry.registerExternalPlugin(
        plugin('descriptor-reference-boundary', {
          commands: [
            {
              kind: 'descriptor',
              id: 'descriptor-reference-boundary:command',
              descriptor: 'x'.repeat(65_536),
            },
          ],
        }),
        { manifest: manifest('descriptor-reference-boundary') }
      )
    );
    expect((exactFailure as Error).message).toBe(identityDiagnostic);
    expect(exactRegistry.pluginIds()).toEqual([]);
    expect(exactRegistry.commandIds()).toEqual([]);

    const overflowRegistry = createCommandRegistry();
    expectFixedAtomicFailure(
      () =>
        void overflowRegistry.registerExternalPlugin(
          plugin('descriptor-reference-overflow', {
            commands: [
              {
                kind: 'descriptor',
                id: 'descriptor-reference-overflow:command',
                descriptor: 'x'.repeat(65_537),
              },
            ],
          }),
          { manifest: manifest('descriptor-reference-overflow') }
        )
    );
    expect(overflowRegistry.pluginIds()).toEqual([]);
    expect(overflowRegistry.commandIds()).toEqual([]);
  });

  test('schema-closes specialized shells and capability records', () => {
    const cases: readonly [
      string,
      (id: string) => {
        plugin: AidePublicPluginDescriptor;
        options: { manifest: AidePluginManifest };
      },
    ][] = [
      [
        'options',
        (id) => {
          const options = { manifest: manifest(id) };
          Object.defineProperty(options, 'futureMetadata', {
            get() {
              throw new Error('SECRET-OPTIONS-UNKNOWN');
            },
          });
          return { plugin: plugin(id), options };
        },
      ],
      [
        'manifest',
        (id) => ({
          plugin: plugin(id),
          options: {
            manifest: {
              ...manifest(id),
              futureMetadata: true,
            } as unknown as AidePluginManifest,
          },
        }),
      ],
      [
        'plugin',
        (id) => ({
          plugin: {
            ...plugin(id),
            futureMetadata: true,
          } as AidePublicPluginDescriptor,
          options: { manifest: manifest(id) },
        }),
      ],
      [
        'placement',
        (id) => ({
          plugin: plugin(id, {
            commands: [{ ...command(`${id}:command`), futureMetadata: true }],
          }),
          options: { manifest: manifest(id) },
        }),
      ],
      [
        'descriptor',
        (id) => {
          const placement = command(`${id}:command`);
          (placement.descriptor as Record<string, unknown>).futureMetadata =
            true;
          return {
            plugin: plugin(id, { commands: [placement] }),
            options: { manifest: manifest(id) },
          };
        },
      ],
      [
        'capabilities',
        (id) => ({
          plugin: plugin(id, {
            capabilities: { futureCapability: {} },
          }),
          options: { manifest: manifest(id, []) },
        }),
      ],
    ];

    for (const [name, build] of cases) {
      const registry = createCommandRegistry();
      const id = `closed-${name}`;
      const value = build(id);
      expectFixedAtomicFailure(
        () => void registry.registerExternalPlugin(value.plugin, value.options)
      );
      expect(registry.pluginIds(), name).toEqual([]);
      expect(registry.commandIds(), name).toEqual([]);
    }
  });

  test('rejects unknown strings, symbols, and non-enumerable accessors at every record shell', () => {
    const shellNames = Object.keys(
      fullExternalRegistration('shell-list').shells
    );
    const variants = ['unknown', 'symbol', 'accessor'] as const;

    for (const [shellIndex, shellName] of shellNames.entries()) {
      for (const variant of variants) {
        const id = `shell-${shellIndex}-${variant}`;
        const value = fullExternalRegistration(id);
        const shell = value.shells[shellName]!;
        const reads = { value: 0 };
        if (variant === 'unknown') {
          shell.futureMetadata = true;
        } else if (variant === 'symbol') {
          shell[Symbol('futureMetadata')] = true;
        } else {
          Object.defineProperty(shell, 'futureMetadata', {
            configurable: true,
            enumerable: false,
            get() {
              reads.value += 1;
              throw new Error(`SECRET-${shellName}`);
            },
          });
        }

        const registry = createCommandRegistry();
        expectFixedAtomicFailure(
          () =>
            void registry.registerExternalPlugin(value.plugin, value.options)
        );
        expect(reads.value, `${shellName}/${variant}`).toBe(0);
        expect(registry.pluginIds(), `${shellName}/${variant}`).toEqual([]);
        expect(registry.commandIds(), `${shellName}/${variant}`).toEqual([]);
      }
    }
  });

  test('accepts the complete closed capability schema without invoking callbacks', () => {
    const value = fullExternalRegistration('closed-full');
    const registry = createCommandRegistry();
    registry.registerExternalPlugin(value.plugin, value.options);
    expect(registry.pluginIds()).toEqual(['closed-full']);
    expect(registry.commandIds()).toEqual(['closed-full:command']);
    expect(registry.capabilities.auth()).toHaveLength(1);
    expect(registry.capabilities.authProviders()).toHaveLength(1);
    expect(registry.capabilities.primeContributions()).toHaveLength(1);
    expect(registry.capabilities.pullRequestProviders()).toHaveLength(1);
  });

  test('accepts explicit undefined at every optional structured metadata position', () => {
    type Registration = ReturnType<typeof fullExternalRegistration>;
    const full = (id: string, mutate: (value: Registration) => void) => {
      const value = fullExternalRegistration(id);
      mutate(value);
      return value;
    };
    const withoutCapability = (
      id: string,
      field:
        | 'auth'
        | 'authProvider'
        | 'primeContribution'
        | 'pullRequestProvider',
      kind:
        | 'auth'
        | 'auth-provider'
        | 'prime-contribution'
        | 'pull-request-provider'
    ) =>
      full(id, (value) => {
        value.shells.capabilities![field] = undefined;
        value.shells.manifest!.capabilities = (
          value.shells.manifest!.capabilities as string[]
        ).filter((entry) => entry !== kind);
      });

    const cases: readonly [string, (id: string) => Registration][] = [
      [
        'manifest.capabilities',
        (id) => {
          const sourceManifest = manifest(id, []);
          (sourceManifest as unknown as Record<string, unknown>).capabilities =
            undefined;
          const sourcePlugin = plugin(id, { commands: [] });
          return {
            plugin: sourcePlugin,
            options: { manifest: sourceManifest },
            shells: {
              manifest: sourceManifest as unknown as Record<string, unknown>,
              plugin: sourcePlugin as unknown as Record<string, unknown>,
            },
          };
        },
      ],
      [
        'manifest.loading',
        (id) =>
          full(id, (value) => (value.shells.manifest!.loading = undefined)),
      ],
      [
        'manifest.loading.after',
        (id) => full(id, (value) => (value.shells.loading!.after = undefined)),
      ],
      [
        'manifest.loading.before',
        (id) => full(id, (value) => (value.shells.loading!.before = undefined)),
      ],
      [
        'manifest.conflicts',
        (id) =>
          full(id, (value) => (value.shells.manifest!.conflicts = undefined)),
      ],
      [
        'plugin.capabilities',
        (id) => {
          const sourcePlugin = plugin(id);
          (sourcePlugin as unknown as Record<string, unknown>).capabilities =
            undefined;
          return {
            plugin: sourcePlugin,
            options: { manifest: manifest(id) },
            shells: {
              plugin: sourcePlugin as unknown as Record<string, unknown>,
            },
          };
        },
      ],
      ['capabilities.auth', (id) => withoutCapability(id, 'auth', 'auth')],
      [
        'capabilities.authProvider',
        (id) => withoutCapability(id, 'authProvider', 'auth-provider'),
      ],
      [
        'capabilities.primeContribution',
        (id) =>
          withoutCapability(id, 'primeContribution', 'prime-contribution'),
      ],
      [
        'capabilities.pullRequestProvider',
        (id) =>
          withoutCapability(id, 'pullRequestProvider', 'pull-request-provider'),
      ],
      [
        'command.extension',
        (id) =>
          full(id, (value) => (value.shells.placement!.extension = undefined)),
      ],
      [
        'descriptor.yargs',
        (id) =>
          full(id, (value) => (value.shells.descriptor!.yargs = undefined)),
      ],
      [
        'authProvider.login',
        (id) =>
          full(id, (value) => (value.shells.authProvider!.login = undefined)),
      ],
      [
        'authProvider.logout',
        (id) =>
          full(id, (value) => (value.shells.authProvider!.logout = undefined)),
      ],
      [
        'authProvider.operations',
        (id) =>
          full(
            id,
            (value) => (value.shells.authProvider!.operations = undefined)
          ),
      ],
      [
        'login.command',
        (id) => full(id, (value) => (value.shells.login!.command = undefined)),
      ],
      [
        'login.command.aliases',
        (id) =>
          full(id, (value) => (value.shells.loginCommand!.aliases = undefined)),
      ],
      [
        'login.fields',
        (id) => full(id, (value) => (value.shells.login!.fields = undefined)),
      ],
      [
        'login.envMigration',
        (id) =>
          full(id, (value) => (value.shells.login!.envMigration = undefined)),
      ],
      [
        'logout.command',
        (id) => full(id, (value) => (value.shells.logout!.command = undefined)),
      ],
      [
        'logout.command.aliases',
        (id) =>
          full(
            id,
            (value) => (value.shells.logoutCommand!.aliases = undefined)
          ),
      ],
      [
        'primeContribution.status',
        (id) =>
          full(
            id,
            (value) => (value.shells.primeContribution!.status = undefined)
          ),
      ],
      [
        'primeStatus.messages',
        (id) =>
          full(id, (value) => (value.shells.primeStatus!.messages = undefined)),
      ],
      [
        'pullRequestProvider.operations',
        (id) =>
          full(
            id,
            (value) =>
              (value.shells.pullRequestProvider!.operations = undefined)
          ),
      ],
    ];

    for (const [index, [name, build]] of cases.entries()) {
      const id = `optional-undefined-${index}`;
      const value = build(id);
      const sources = collectSourceObjects([value.options, value.plugin]);
      const callbackCalls = { value: 0 };
      instrumentSourceCallbacks(value.shells, callbackCalls);
      const registry = createCommandRegistry();

      registry.registerExternalPlugin(value.plugin, value.options);

      expect(callbackCalls.value, name).toBe(0);
      expect(registry.pluginIds(), name).toEqual([id]);
      const retained = registry.plugins()[0]!;
      expectDetachedRecursivelyFrozen(retained, sources);
      value.shells.plugin!.summary = 'mutated after registration';
      expect(retained.summary, name).toBe(`${id} summary`);
    }
  });

  test('captures compatible cross-schema aliases into detached frozen snapshots', () => {
    const registrations: Array<{
      name: string;
      value: ReturnType<typeof fullExternalRegistration>;
    }> = [];

    {
      const id = 'alias-empty-capabilities-commands';
      const shared: unknown[] = [];
      const sourcePlugin = plugin(id, { commands: shared });
      const sourceManifest = manifest(id, shared as string[]);
      registrations.push({
        name: 'manifest capabilities/plugin commands',
        value: {
          plugin: sourcePlugin,
          options: { manifest: sourceManifest },
          shells: {
            manifest: sourceManifest as unknown as Record<string, unknown>,
            plugin: sourcePlugin as unknown as Record<string, unknown>,
          },
        },
      });
    }
    {
      const value = fullExternalRegistration('alias-login-logout');
      const shared = { summary: 'Shared auth metadata' };
      value.shells.authProvider!.login = shared;
      value.shells.authProvider!.logout = shared;
      registrations.push({ name: 'login/logout metadata', value });
    }
    {
      const value = fullExternalRegistration('alias-empty-records');
      const shared = {};
      value.shells.descriptor!.yargs = shared;
      value.shells.authProvider!.operations = shared;
      value.shells.pullRequestProvider!.operations = shared;
      registrations.push({ name: 'yargs/auth/PR operations', value });
    }
    {
      const value = fullExternalRegistration('alias-leaf-arrays');
      const shared = ['shared'];
      value.shells.loading!.after = shared;
      value.shells.loading!.before = shared;
      value.shells.loginCommand!.aliases = shared;
      value.shells.envMigration!.variables = shared;
      value.shells.descriptor!.route = shared;
      registrations.push({ name: 'compatible leaf arrays', value });
    }

    for (const { name, value } of registrations) {
      const sources = collectSourceObjects([value.options, value.plugin]);
      const callbackCalls = { value: 0 };
      instrumentSourceCallbacks(value.shells, callbackCalls);
      const registry = createCommandRegistry();
      registry.registerExternalPlugin(value.plugin, value.options);
      expect(callbackCalls.value, name).toBe(0);
      expect(registry.pluginIds(), name).toEqual([value.plugin.id]);
      expectDetachedRecursivelyFrozen(registry.plugins()[0], sources);
    }
  });

  test('rejects incompatible cross-schema aliases with fixed fresh atomic failures', () => {
    const recordAlias = fullExternalRegistration('incompatible-record-alias');
    recordAlias.shells.loading!.order = 'SECRET-record';
    recordAlias.shells.authProvider!.login = recordAlias.shells.loading;

    const arrayAlias = fullExternalRegistration('incompatible-array-alias');
    arrayAlias.shells.descriptor!.summary = 'SECRET-array';
    arrayAlias.shells.primeContribution!.status =
      arrayAlias.shells.plugin!.commands;

    for (const [name, value] of [
      ['record', recordAlias],
      ['array', arrayAlias],
    ] as const) {
      const callbackCalls = { value: 0 };
      instrumentSourceCallbacks(value.shells, callbackCalls);
      const registry = createCommandRegistry();
      expectFixedAtomicFailure(
        () => void registry.registerExternalPlugin(value.plugin, value.options),
        undefined,
        `SECRET-${name}`
      );
      expect(callbackCalls.value, name).toBe(0);
      expect(registry.pluginIds(), name).toEqual([]);
      expect(registry.commandIds(), name).toEqual([]);
    }
  });

  test('rejects active cycles globally while allowing repeated non-active aliases', () => {
    const sameSchemaCycle = fullExternalRegistration(
      'active-same-schema-cycle'
    );
    const cyclicRoute: unknown[] = [];
    cyclicRoute.push(cyclicRoute);
    sameSchemaCycle.shells.descriptor!.route = cyclicRoute;

    const selfCycle = fullExternalRegistration('active-self-cycle');
    selfCycle.shells.authProvider!.login = selfCycle.shells.authProvider;

    const graphCycle = fullExternalRegistration('active-graph-cycle');
    graphCycle.shells.placement!.descriptor = graphCycle.shells.placement;

    for (const [name, value] of [
      ['same route-array schema', sameSchemaCycle],
      ['same source across nested schemas', selfCycle],
      ['placement/descriptor schemas', graphCycle],
    ] as const) {
      const registry = createCommandRegistry();
      expectFixedAtomicFailure(
        () => void registry.registerExternalPlugin(value.plugin, value.options)
      );
      expect(registry.pluginIds(), name).toEqual([]);
      expect(registry.commandIds(), name).toEqual([]);
    }

    const repeated = fullExternalRegistration('repeated-non-active-alias');
    const shared = { summary: 'Shared auth metadata' };
    repeated.shells.authProvider!.login = shared;
    repeated.shells.authProvider!.logout = shared;
    const registry = createCommandRegistry();
    registry.registerExternalPlugin(repeated.plugin, repeated.options);
    expect(registry.pluginIds()).toEqual(['repeated-non-active-alias']);
  });

  test('accounts both source command identity strings before equality checks', () => {
    const registry = createCommandRegistry();
    const placement = command('identity-budget:short');
    placement.descriptor.id = `identity-budget:${'x'.repeat(70_000)}`;

    expectFixedAtomicFailure(
      () =>
        void registry.registerExternalPlugin(
          plugin('identity-budget', { commands: [placement] }),
          { manifest: manifest('identity-budget') }
        )
    );
    expect(registry.pluginIds()).toEqual([]);
    expect(registry.commandIds()).toEqual([]);
  });

  test('applies exact key and both identity-position string bounds', () => {
    for (const keyLength of [65_536, 65_537]) {
      const id = `key-boundary-${keyLength}`;
      const sourceManifest = manifest(id) as unknown as Record<string, unknown>;
      const reads = { value: 0 };
      Object.defineProperty(sourceManifest, 'k'.repeat(keyLength), {
        configurable: true,
        enumerable: false,
        get() {
          reads.value += 1;
          throw new Error('SECRET-KEY-ACCESSOR');
        },
      });
      const registry = createCommandRegistry();
      expectFixedAtomicFailure(
        () =>
          void registry.registerExternalPlugin(plugin(id), {
            manifest: sourceManifest as unknown as AidePluginManifest,
          })
      );
      expect(reads.value).toBe(0);
      expect(registry.pluginIds()).toEqual([]);
    }

    const prefix = 'identity-position:';
    const exactIdentity = `${prefix}${'x'.repeat(65_536 - prefix.length)}`;
    const exactPlacement = command(exactIdentity);
    exactPlacement.descriptor.route = 'identity-position-route';
    exactPlacement.descriptor.summary = 'Identity position';
    const exactRegistry = createCommandRegistry();
    exactRegistry.registerExternalPlugin(
      plugin('identity-position', { commands: [exactPlacement] }),
      { manifest: manifest('identity-position') }
    );
    expect(exactRegistry.commandIds()).toEqual([exactIdentity]);

    for (const position of ['placement', 'descriptor'] as const) {
      const overlong = `${prefix}${'x'.repeat(65_537 - prefix.length)}`;
      const placement = command('identity-position:safe');
      if (position === 'placement') placement.id = overlong;
      else placement.descriptor.id = overlong;
      const registry = createCommandRegistry();
      expectFixedAtomicFailure(
        () =>
          void registry.registerExternalPlugin(
            plugin('identity-position', { commands: [placement] }),
            { manifest: manifest('identity-position') }
          )
      );
      expect(registry.pluginIds(), position).toEqual([]);
      expect(registry.commandIds(), position).toEqual([]);
    }
  });

  test('enforces exact individual and cumulative string-unit boundaries', () => {
    const individualId = 'individual-boundary';
    const acceptedIndividual = plugin(individualId, {
      summary: 'x'.repeat(65_536),
    });
    const acceptedRegistry = createCommandRegistry();
    acceptedRegistry.registerExternalPlugin(acceptedIndividual, {
      manifest: manifest(individualId),
    });
    expect(acceptedRegistry.pluginIds()).toEqual([individualId]);

    const rejectedIndividual = plugin('individual-overflow', {
      summary: 'x'.repeat(65_537),
    });
    const rejectedRegistry = createCommandRegistry();
    expectFixedAtomicFailure(
      () =>
        void rejectedRegistry.registerExternalPlugin(rejectedIndividual, {
          manifest: manifest('individual-overflow'),
        })
    );

    const buildCumulative = (extraUnits: number) => {
      const value = budgetRegistration('cumulative-boundary', 1_000);
      addCrossSchemaBudgetAlias(value);
      for (const [index, placement] of value.commands.entries()) {
        const suffix = 'x'.repeat(430);
        const identity = `cumulative-boundary:${index}-${suffix}`;
        placement.id = identity;
        placement.descriptor.id = identity;
      }
      const before = sourceMetadataBudget([value.options, value.plugin]);
      const needed = 1_048_576 + extraUnits - before.stringUnits;
      expect(needed).toBeGreaterThan(0);
      expect(needed).toBeLessThan(65_536);
      (value.plugin as unknown as Record<string, unknown>).summary =
        `s${'x'.repeat(needed)}`;
      return value;
    };

    const exact = buildCumulative(0);
    expect(
      sourceMetadataBudget([exact.options, exact.plugin]).stringUnits
    ).toBe(1_048_576);
    const exactRegistry = createCommandRegistry();
    exactRegistry.registerExternalPlugin(exact.plugin, exact.options);
    expect(exactRegistry.commandIds()).toHaveLength(1_000);

    const overflow = buildCumulative(1);
    expect(
      sourceMetadataBudget([overflow.options, overflow.plugin]).stringUnits
    ).toBe(1_048_577);
    const overflowRegistry = createCommandRegistry();
    expectFixedAtomicFailure(
      () =>
        void overflowRegistry.registerExternalPlugin(
          overflow.plugin,
          overflow.options
        )
    );
    expect(overflowRegistry.pluginIds()).toEqual([]);
  });

  test('accounts exact shell, key, and scalar value totals without alias bypass', () => {
    const buildAtValueCount = (overflow: boolean) => {
      const value = budgetRegistration('value-boundary', 1_000);
      addCrossSchemaBudgetAlias(value);
      const optionalSlots: Array<() => void> = [];
      for (const placement of value.commands) {
        optionalSlots.push(
          () => {
            (placement as Record<string, unknown>).acceptsChildren = false;
          },
          () => {
            (placement.descriptor as Record<string, unknown>).yargs = {};
          }
        );
      }
      for (const add of optionalSlots) {
        const current = sourceMetadataBudget([value.options, value.plugin]);
        if (current.values >= 20_000) break;
        add();
      }
      const exact = sourceMetadataBudget([value.options, value.plugin]);
      expect(exact.values).toBe(20_000);
      if (overflow) {
        const placement = value.commands.find(
          (entry) => !Object.prototype.hasOwnProperty.call(entry, 'parentId')
        );
        expect(placement).toBeDefined();
        (placement as Record<string, unknown>).parentId = undefined;
      }
      return value;
    };

    const exact = buildAtValueCount(false);
    const exactRegistry = createCommandRegistry();
    exactRegistry.registerExternalPlugin(exact.plugin, exact.options);
    expect(exactRegistry.commandIds()).toHaveLength(1_000);

    const overflow = buildAtValueCount(true);
    expect(
      sourceMetadataBudget([overflow.options, overflow.plugin]).values
    ).toBe(20_002);
    const overflowRegistry = createCommandRegistry();
    expectFixedAtomicFailure(
      () =>
        void overflowRegistry.registerExternalPlugin(
          overflow.plugin,
          overflow.options
        )
    );
    expect(overflowRegistry.pluginIds()).toEqual([]);

    const sharedDependencies = ['shared-dependency'];
    const aliasPlugin = plugin('alias-budget');
    const aliasOptions = {
      manifest: {
        ...manifest('alias-budget'),
        loading: {
          after: sharedDependencies,
          before: sharedDependencies,
        },
      },
    };
    const aliasRegistry = createCommandRegistry();
    aliasRegistry.registerExternalPlugin(aliasPlugin, aliasOptions);
    expect(aliasRegistry.pluginIds()).toEqual(['alias-budget']);

    const crossSchemaAlias = fullExternalRegistration('cross-schema-alias');
    const sharedLeafArray = ['shared'];
    crossSchemaAlias.shells.loginCommand!.aliases = sharedLeafArray;
    crossSchemaAlias.shells.envMigration!.variables = sharedLeafArray;
    const crossSchemaRegistry = createCommandRegistry();
    crossSchemaRegistry.registerExternalPlugin(
      crossSchemaAlias.plugin,
      crossSchemaAlias.options
    );
    expect(crossSchemaRegistry.pluginIds()).toEqual(['cross-schema-alias']);
  });

  test('schema-closes wrong-kind placement shells without reading later identity metadata', () => {
    const registry = createCommandRegistry();
    const reads = { value: 0 };
    const wrongKind = {
      kind: 'module',
      module: {},
      futureMetadata: true,
    };
    Object.defineProperty(wrongKind, 'id', {
      enumerable: true,
      get() {
        reads.value += 1;
        throw new Error('SECRET-WRONG-KIND-ID');
      },
    });

    expectFixedAtomicFailure(
      () =>
        void registry.registerExternalPlugin(
          plugin('wrong-kind-closed', { commands: [wrongKind] }),
          { manifest: manifest('wrong-kind-closed') }
        )
    );
    expect(reads.value).toBe(0);
    expect(registry.pluginIds()).toEqual([]);
    expect(registry.commandIds()).toEqual([]);
  });

  test('schema-closes descriptor placement against every module property shape', () => {
    const variants: readonly {
      readonly name: string;
      readonly build: (
        placement: Record<string, unknown>,
        attacker: Error,
        reads: { value: number },
        traps: { value: number },
        callbacks: { value: number }
      ) => void;
    }[] = [
      {
        name: 'data',
        build: (placement) => {
          placement.module = { command: 'forged' };
        },
      },
      {
        name: 'undefined data',
        build: (placement) => {
          placement.module = undefined;
        },
      },
      {
        name: 'function',
        build: (_placement, _attacker, _reads, _traps, callbacks) => {
          _placement.module = () => {
            callbacks.value += 1;
          };
        },
      },
      {
        name: 'accessor',
        build: (placement, attacker, reads) => {
          accessorRecord(placement, 'module', attacker, reads);
        },
      },
      {
        name: 'Proxy object',
        build: (placement, attacker, _reads, traps) => {
          placement.module = hostileProxy(
            { command: 'forged' },
            attacker,
            traps
          );
        },
      },
      {
        name: 'Proxy function',
        build: (placement, attacker, _reads, traps) => {
          placement.module = hostileProxy(() => undefined, attacker, traps);
        },
      },
    ];

    for (const variant of variants) {
      const id = `descriptor-module-${variant.name.toLowerCase().replaceAll(' ', '-')}`;
      const registry = createCommandRegistry();
      const placement = command(`${id}:command`) as unknown as Record<
        string,
        unknown
      >;
      const attacker = new Error(`SECRET-${variant.name}`);
      const reads = { value: 0 };
      const traps = { value: 0 };
      const callbacks = { value: 0 };
      variant.build(placement, attacker, reads, traps, callbacks);

      expectFixedAtomicFailure(
        () =>
          void registry.registerExternalPlugin(
            plugin(id, { commands: [placement] }),
            { manifest: manifest(id) }
          ),
        attacker,
        attacker.message
      );
      expect(reads.value, variant.name).toBe(0);
      expect(traps.value, variant.name).toBe(0);
      expect(callbacks.value, variant.name).toBe(0);
      expect(registry.pluginIds(), variant.name).toEqual([]);
      expect(registry.commandIds(), variant.name).toEqual([]);
    }
  });

  test('accepts only closed detached extension-policy variants', () => {
    const id = 'closed-extension-variants';
    const allowlist = ['friend-plugin'];
    const placements = [
      {
        ...command(`${id}:same`),
        acceptsChildren: true,
        extension: { kind: 'same-plugin' as const },
      },
      {
        ...command(`${id}:open`),
        acceptsChildren: true,
        extension: { kind: 'open' as const },
      },
      {
        ...command(`${id}:allowlist`),
        acceptsChildren: true,
        extension: { kind: 'allowlist' as const, pluginIds: allowlist },
      },
    ];
    const registry = createCommandRegistry();

    registry.registerExternalPlugin(plugin(id, { commands: placements }), {
      manifest: manifest(id),
    });
    allowlist[0] = 'mutated';
    (placements[0]!.extension as { kind: string }).kind = 'mutated';

    const extensions = registry
      .plugins()[0]!
      .commands.map((entry) => entry.extension);
    expect(extensions).toEqual([
      { kind: 'same-plugin' },
      { kind: 'open' },
      { kind: 'allowlist', pluginIds: ['friend-plugin'] },
    ]);
    for (const extension of extensions) {
      expect(Object.isFrozen(extension)).toBe(true);
    }
    const retainedAllowlist = extensions[2]!;
    if (retainedAllowlist?.kind !== 'allowlist') {
      throw new Error('expected retained allowlist extension');
    }
    expect(Object.isFrozen(retainedAllowlist.pluginIds)).toBe(true);
  });

  test('rejects malformed extension-policy variants with fixed fresh atomic failures', () => {
    const attacker = new Error('SECRET-EXTENSION-VARIANT');
    const kindReads = { value: 0 };
    const proxyTraps = { value: 0 };
    const cases: readonly [string, () => unknown][] = [
      [
        'same-plugin with pluginIds',
        () => ({ kind: 'same-plugin', pluginIds: [] }),
      ],
      [
        'same-plugin with undefined pluginIds',
        () => ({ kind: 'same-plugin', pluginIds: undefined }),
      ],
      [
        'open with pluginIds',
        () => ({ kind: 'open', pluginIds: ['attacker'] }),
      ],
      [
        'open with undefined pluginIds',
        () => ({ kind: 'open', pluginIds: undefined }),
      ],
      ['allowlist missing pluginIds', () => ({ kind: 'allowlist' })],
      [
        'allowlist undefined pluginIds',
        () => ({ kind: 'allowlist', pluginIds: undefined }),
      ],
      [
        'allowlist scalar pluginIds',
        () => ({ kind: 'allowlist', pluginIds: 'attacker' }),
      ],
      [
        'allowlist non-string pluginId',
        () => ({ kind: 'allowlist', pluginIds: [1] }),
      ],
      [
        'allowlist Proxy pluginIds',
        () => ({
          kind: 'allowlist',
          pluginIds: hostileProxy([], attacker, proxyTraps),
        }),
      ],
      ['unknown kind', () => ({ kind: 'future' })],
      ['non-string kind', () => ({ kind: 1 })],
      ['missing kind', () => ({ pluginIds: [] })],
      ['accessor kind', () => accessorRecord({}, 'kind', attacker, kindReads)],
    ];

    for (const [index, [name, build]] of cases.entries()) {
      const id = `bad-extension-${index}`;
      const registry = createCommandRegistry();
      const placement = {
        ...command(`${id}:command`),
        acceptsChildren: true,
        extension: build(),
      };
      expectFixedAtomicFailure(
        () =>
          void registry.registerExternalPlugin(
            plugin(id, { commands: [placement] }),
            { manifest: manifest(id) }
          ),
        attacker,
        attacker.message
      );
      expect(registry.pluginIds(), name).toEqual([]);
      expect(registry.commandIds(), name).toEqual([]);
    }
    expect(kindReads.value).toBe(0);
    expect(proxyTraps.value).toBe(0);
  });

  test('accepts closed auth input variants with optional undefined and inert callbacks', () => {
    const id = 'closed-auth-inputs';
    let validateCalls = 0;
    const fields = [
      {
        kind: 'text',
        key: 'username',
        label: 'Username',
        stdin: true,
        validate: (_value: string) => {
          validateCalls += 1;
          return null;
        },
      },
      {
        kind: 'secret',
        key: 'token',
        label: 'Token',
        stdin: undefined,
        validate: undefined,
      },
      {
        kind: 'select',
        key: 'account',
        label: 'Account',
        choices: [{ value: 'one', label: 'One' }],
        default: undefined,
      },
    ];
    const registry = createCommandRegistry();

    registry.registerExternalPlugin(authInputPlugin(id, fields), {
      manifest: manifest(id, ['commands', 'auth-provider']),
    });
    expect(validateCalls).toBe(0);

    (fields[0] as Record<string, unknown>).label = 'MUTATED';
    (
      (fields[2] as Record<string, unknown>).choices as Record<
        string,
        unknown
      >[]
    )[0]!.value = 'mutated';
    const retained =
      registry.capabilities.authProviders()[0]!.capability.login!.fields!;
    expect(retained.map((field) => field.kind)).toEqual([
      'text',
      'secret',
      'select',
    ]);
    expect(retained[0]!.label).toBe('Username');
    const retainedSelect = retained[2]!;
    if (retainedSelect.kind !== 'select') {
      throw new Error('expected retained select field');
    }
    expect(retainedSelect.choices[0]!.value).toBe('one');
    expect(Object.isFrozen(retained)).toBe(true);
    for (const field of retained) expect(Object.isFrozen(field)).toBe(true);
    expect(Object.isFrozen(retainedSelect.choices)).toBe(true);
    expect(Object.isFrozen(retainedSelect.choices[0])).toBe(true);
  });

  test('rejects cross-arm and malformed auth input variants without hostile execution', () => {
    const attacker = new Error('SECRET-AUTH-INPUT-VARIANT');
    const kindReads = { value: 0 };
    const choicesReads = { value: 0 };
    const proxyTraps = { value: 0 };
    let validateCalls = 0;
    const cases: readonly [string, () => unknown][] = [
      [
        'text with choices',
        () => ({ kind: 'text', key: 'field', label: 'Field', choices: [] }),
      ],
      [
        'text with undefined choices',
        () => ({
          kind: 'text',
          key: 'field',
          label: 'Field',
          choices: undefined,
        }),
      ],
      [
        'text with default',
        () => ({ kind: 'text', key: 'field', label: 'Field', default: 'one' }),
      ],
      [
        'text with undefined default',
        () => ({
          kind: 'text',
          key: 'field',
          label: 'Field',
          default: undefined,
        }),
      ],
      [
        'select with stdin',
        () => ({
          kind: 'select',
          key: 'field',
          label: 'Field',
          choices: [{ value: 'one' }],
          stdin: true,
        }),
      ],
      [
        'select with undefined stdin',
        () => ({
          kind: 'select',
          key: 'field',
          label: 'Field',
          choices: [{ value: 'one' }],
          stdin: undefined,
        }),
      ],
      [
        'select with validate',
        () => ({
          kind: 'select',
          key: 'field',
          label: 'Field',
          choices: [{ value: 'one' }],
          validate: () => {
            validateCalls += 1;
            return null;
          },
        }),
      ],
      [
        'select with undefined validate',
        () => ({
          kind: 'select',
          key: 'field',
          label: 'Field',
          choices: [{ value: 'one' }],
          validate: undefined,
        }),
      ],
      [
        'select missing choices',
        () => ({ kind: 'select', key: 'field', label: 'Field' }),
      ],
      [
        'select undefined choices',
        () => ({
          kind: 'select',
          key: 'field',
          label: 'Field',
          choices: undefined,
        }),
      ],
      [
        'select choices accessor',
        () =>
          accessorRecord(
            { kind: 'select', key: 'field', label: 'Field' },
            'choices',
            attacker,
            choicesReads
          ),
      ],
      [
        'text Proxy validate callback',
        () => ({
          kind: 'text',
          key: 'field',
          label: 'Field',
          validate: hostileProxy(() => null, attacker, proxyTraps),
        }),
      ],
      [
        'unknown kind',
        () => ({ kind: 'future', key: 'field', label: 'Field' }),
      ],
      ['non-string kind', () => ({ kind: 1, key: 'field', label: 'Field' })],
      ['missing kind', () => ({ key: 'field', label: 'Field' })],
      [
        'accessor kind',
        () =>
          accessorRecord(
            { key: 'field', label: 'Field' },
            'kind',
            attacker,
            kindReads
          ),
      ],
      [
        'Proxy field',
        () =>
          hostileProxy(
            { kind: 'text', key: 'field', label: 'Field' },
            attacker,
            proxyTraps
          ),
      ],
    ];

    for (const [index, [name, build]] of cases.entries()) {
      const id = `bad-auth-input-${index}`;
      const registry = createCommandRegistry();
      expectFixedAtomicFailure(
        () =>
          void registry.registerExternalPlugin(authInputPlugin(id, [build()]), {
            manifest: manifest(id, ['commands', 'auth-provider']),
          }),
        attacker,
        attacker.message
      );
      expect(registry.pluginIds(), name).toEqual([]);
      expect(registry.commandIds(), name).toEqual([]);
      expect(registry.capabilities.authProviders(), name).toEqual([]);
    }
    expect(kindReads.value).toBe(0);
    expect(choicesReads.value).toBe(0);
    expect(proxyTraps.value).toBe(0);
    expect(validateCalls).toBe(0);
  });

  test('replaces the exact manifest version accessor leak with a fixed fresh atomic failure', () => {
    const registry = createCommandRegistry();
    const attacker = new Error('SECRET-MANIFEST-VERSION-ACCESSOR');
    const reads = { value: 0 };
    const hostileManifest = accessorRecord(
      manifest('version-accessor') as unknown as Record<string, unknown>,
      'version',
      attacker,
      reads
    ) as unknown as AidePluginManifest;

    expectFixedAtomicFailure(
      () =>
        void registry.registerExternalPlugin(plugin('version-accessor'), {
          manifest: hostileManifest,
        }),
      attacker,
      attacker.message
    );
    expect(reads.value).toBe(0);
    expect(registry.plugins()).toEqual([]);
    expect(registry.commands()).toEqual([]);
  });

  test('guard-captures every manifest top-level field before semantic validation', () => {
    const fields = [
      'id',
      'version',
      'aidePluginApiVersion',
      'main',
      'summary',
      'trust',
      'capabilities',
      'loading',
      'conflicts',
    ] as const;

    for (const [index, field] of fields.entries()) {
      const id = `manifest-field-${index}`;
      const registry = createCommandRegistry();
      const attacker = new Error(`SECRET-MANIFEST-${field}`);
      const reads = { value: 0 };
      const hostileManifest = accessorRecord(
        {
          ...manifest(id),
          main: './index.js',
          summary: 'Manifest summary',
          trust: 'external',
          loading: { order: 1, after: [], before: [] },
          conflicts: {
            commands: 'reject',
            authProviders: 'reject',
            pullRequestProviders: 'reject',
          },
        },
        field,
        attacker,
        reads
      ) as unknown as AidePluginManifest;

      expectFixedAtomicFailure(
        () =>
          void registry.registerExternalPlugin(plugin(id), {
            manifest: hostileManifest,
          }),
        attacker,
        attacker.message
      );
      expect(reads.value, field).toBe(0);
      expect(registry.pluginIds(), field).toEqual([]);
      expect(registry.commandIds(), field).toEqual([]);
    }
  });

  test('guard-captures the registration options manifest reference', () => {
    const id = 'options-manifest';
    const registry = createCommandRegistry();
    const attacker = new Error('SECRET-OPTIONS-MANIFEST');
    const reads = { value: 0 };
    const options = accessorRecord({}, 'manifest', attacker, reads);

    expectFixedAtomicFailure(
      () =>
        void registry.registerExternalPlugin(
          plugin(id),
          options as unknown as { manifest: AidePluginManifest }
        ),
      attacker,
      attacker.message
    );
    expect(reads.value).toBe(0);
    expect(registry.pluginIds()).toEqual([]);
  });

  test('rejects inherited required manifest and descriptor values', () => {
    for (const [index, field] of [
      'id',
      'version',
      'aidePluginApiVersion',
    ].entries()) {
      const id = `inherited-manifest-${index}`;
      const source = manifest(id) as unknown as Record<string, unknown>;
      const inheritedValue = source[field];
      delete source[field];
      Object.setPrototypeOf(source, { [field]: inheritedValue });
      const registry = createCommandRegistry();

      expectFixedAtomicFailure(
        () =>
          void registry.registerExternalPlugin(plugin(id), {
            manifest: source as unknown as AidePluginManifest,
          })
      );
      expect(registry.pluginIds(), field).toEqual([]);
    }

    const id = 'inherited-descriptor';
    const placement = command(`${id}:command`);
    const descriptor = placement.descriptor as unknown as Record<
      string,
      unknown
    >;
    const route = descriptor.route;
    delete descriptor.route;
    Object.setPrototypeOf(descriptor, { route });
    const registry = createCommandRegistry();
    expectFixedAtomicFailure(
      () =>
        void registry.registerExternalPlugin(
          plugin(id, { commands: [placement] }),
          { manifest: manifest(id) }
        )
    );
    expect(registry.pluginIds()).toEqual([]);
  });

  test('rejects inherited, malformed, live Proxy, and revoked Proxy manifest branches without traps', () => {
    const branches: readonly [string, unknown][] = [
      ['version', Object.create({ inherited: true })],
      ['aidePluginApiVersion', Object.create({ inherited: true })],
      ['trust', Object.create({ inherited: true })],
      ['capabilities', Object.create({ inherited: true })],
      ['loading', Object.create({ inherited: true })],
      ['conflicts', Object.create({ inherited: true })],
    ];

    for (const [index, [field, malformed]] of branches.entries()) {
      const id = `manifest-shape-${index}`;
      const registry = createCommandRegistry();
      const attacker = new Error(`SECRET-MANIFEST-PROXY-${field}`);
      const traps = { value: 0 };
      const live = hostileProxy({}, attacker, traps);
      const revoked = Proxy.revocable({}, {});
      revoked.revoke();

      for (const value of [malformed, live, revoked.proxy]) {
        const hostileManifest = {
          ...manifest(id),
          [field]: value,
        } as unknown as AidePluginManifest;
        expectFixedAtomicFailure(
          () =>
            void registry.registerExternalPlugin(plugin(id), {
              manifest: hostileManifest,
            }),
          attacker,
          attacker.message
        );
      }
      expect(traps.value, field).toBe(0);
      expect(registry.pluginIds(), field).toEqual([]);
    }
  });

  test('guard-captures nested capabilities, loading, and conflicts fields and dense entries', () => {
    const cases: readonly {
      readonly name: string;
      readonly build: (
        id: string,
        attacker: Error,
        reads: { value: number }
      ) => AidePluginManifest;
    }[] = [
      {
        name: 'capabilities entry',
        build: (id, attacker, reads) => {
          const capabilities = ['commands'];
          Object.defineProperty(capabilities, '0', {
            get() {
              reads.value += 1;
              throw attacker;
            },
          });
          return { ...manifest(id), capabilities } as AidePluginManifest;
        },
      },
      ...(['order', 'after', 'before'] as const).map((field) => ({
        name: `loading.${field}`,
        build: (id: string, attacker: Error, reads: { value: number }) =>
          ({
            ...manifest(id),
            loading: accessorRecord(
              { order: 1, after: [], before: [] },
              field,
              attacker,
              reads
            ),
          }) as AidePluginManifest,
      })),
      ...(['commands', 'authProviders', 'pullRequestProviders'] as const).map(
        (field) => ({
          name: `conflicts.${field}`,
          build: (id: string, attacker: Error, reads: { value: number }) =>
            ({
              ...manifest(id),
              conflicts: accessorRecord(
                {
                  commands: 'reject',
                  authProviders: 'reject',
                  pullRequestProviders: 'reject',
                },
                field,
                attacker,
                reads
              ),
            }) as AidePluginManifest,
        })
      ),
      ...(['after', 'before'] as const).map((field) => ({
        name: `loading.${field}[0]`,
        build: (id: string, attacker: Error, reads: { value: number }) => {
          const values = ['dependency'];
          Object.defineProperty(values, '0', {
            get() {
              reads.value += 1;
              throw attacker;
            },
          });
          return {
            ...manifest(id),
            loading: { [field]: values },
          } as AidePluginManifest;
        },
      })),
    ];

    for (const [index, entry] of cases.entries()) {
      const id = `nested-manifest-${index}`;
      const registry = createCommandRegistry();
      const attacker = new Error(`SECRET-${entry.name}`);
      const reads = { value: 0 };
      expectFixedAtomicFailure(
        () =>
          void registry.registerExternalPlugin(plugin(id), {
            manifest: entry.build(id, attacker, reads),
          }),
        attacker,
        attacker.message
      );
      expect(reads.value, entry.name).toBe(0);
      expect(registry.pluginIds(), entry.name).toEqual([]);
    }
  });

  test('rejects sparse arrays, custom prototypes, cycles, excessive depth, and excessive size', () => {
    const cases: readonly [
      string,
      () => {
        plugin: AidePublicPluginDescriptor;
        manifest: AidePluginManifest;
      },
    ][] = [
      [
        'sparse commands',
        () => {
          const commands: unknown[] = [];
          commands.length = 1;
          return {
            plugin: plugin('sparse-commands', { commands }),
            manifest: manifest('sparse-commands'),
          };
        },
      ],
      [
        'sparse capabilities',
        () => {
          const capabilities: string[] = [];
          capabilities.length = 1;
          return {
            plugin: plugin('sparse-capabilities'),
            manifest: manifest('sparse-capabilities', capabilities),
          };
        },
      ],
      [
        'custom array prototype',
        () => {
          const capabilities = ['commands'];
          Object.setPrototypeOf(capabilities, Object.create(Array.prototype));
          return {
            plugin: plugin('custom-array-prototype'),
            manifest: manifest('custom-array-prototype', capabilities),
          };
        },
      ],
      [
        'cycle',
        () => {
          const yargsMetadata: Record<string, unknown> = {};
          yargsMetadata.self = yargsMetadata;
          const cyclicCommand = command('cyclic-metadata:command');
          (cyclicCommand.descriptor as Record<string, unknown>).yargs =
            yargsMetadata;
          return {
            plugin: plugin('cyclic-metadata', { commands: [cyclicCommand] }),
            manifest: manifest('cyclic-metadata'),
          };
        },
      ],
      [
        'depth',
        () => {
          let nested: Record<string, unknown> = {};
          for (let index = 0; index < 20; index += 1) nested = { nested };
          const deepCommand = command('deep-metadata:command');
          (deepCommand.descriptor as Record<string, unknown>).yargs = nested;
          return {
            plugin: plugin('deep-metadata', { commands: [deepCommand] }),
            manifest: manifest('deep-metadata'),
          };
        },
      ],
      [
        'string size',
        () => ({
          plugin: plugin('large-metadata', { summary: 'x'.repeat(65_537) }),
          manifest: manifest('large-metadata'),
        }),
      ],
      [
        'record size',
        () => {
          const yargsMetadata = Object.fromEntries(
            Array.from({ length: 129 }, (_, index) => [`field${index}`, index])
          );
          const wideCommand = command('wide-metadata:command');
          (wideCommand.descriptor as Record<string, unknown>).yargs =
            yargsMetadata;
          return {
            plugin: plugin('wide-metadata', { commands: [wideCommand] }),
            manifest: manifest('wide-metadata'),
          };
        },
      ],
      [
        'array size',
        () => {
          const commands = Array.from({ length: 1_001 }, () =>
            command('large-array:command')
          );
          return {
            plugin: plugin('large-array', { commands }),
            manifest: manifest('large-array'),
          };
        },
      ],
    ];

    for (const [name, build] of cases) {
      const registry = createCommandRegistry();
      const value = build();
      expectFixedAtomicFailure(
        () =>
          void registry.registerExternalPlugin(value.plugin, {
            manifest: value.manifest,
          })
      );
      expect(registry.pluginIds(), name).toEqual([]);
      expect(registry.commandIds(), name).toEqual([]);
    }
  });

  test('rejects arrays in every record-only external metadata position', () => {
    const cases: readonly [
      string,
      () => {
        plugin: AidePublicPluginDescriptor;
        manifest: AidePluginManifest;
      },
    ][] = [
      [
        'manifest.loading',
        () => ({
          plugin: plugin('array-loading'),
          manifest: {
            ...manifest('array-loading'),
            loading: [] as unknown as NonNullable<
              AidePluginManifest['loading']
            >,
          },
        }),
      ],
      [
        'manifest.conflicts',
        () => ({
          plugin: plugin('array-conflicts'),
          manifest: {
            ...manifest('array-conflicts'),
            conflicts: [] as unknown as NonNullable<
              AidePluginManifest['conflicts']
            >,
          },
        }),
      ],
      [
        'plugin.capabilities',
        () => ({
          plugin: plugin('array-capabilities', { capabilities: [] }),
          manifest: manifest('array-capabilities'),
        }),
      ],
      [
        'placement.extension',
        () => {
          const placement = command('array-extension:command');
          (placement as Record<string, unknown>).extension = [];
          return {
            plugin: plugin('array-extension', { commands: [placement] }),
            manifest: manifest('array-extension'),
          };
        },
      ],
      [
        'descriptor.yargs',
        () => {
          const placement = command('array-yargs:command');
          (placement.descriptor as Record<string, unknown>).yargs = [];
          return {
            plugin: plugin('array-yargs', { commands: [placement] }),
            manifest: manifest('array-yargs'),
          };
        },
      ],
      [
        'authProvider.login',
        () => ({
          plugin: plugin('array-auth-login', {
            capabilities: {
              authProvider: {
                providerId: 'array-auth-login-provider',
                label: 'Array Auth',
                status: () => Effect.succeed({ state: 'configured' }),
                login: [],
              },
            },
          }),
          manifest: manifest('array-auth-login', ['commands', 'auth-provider']),
        }),
      ],
      [
        'prime status entry',
        () => ({
          plugin: plugin('array-prime-status', {
            capabilities: { primeContribution: { status: [[]] } },
          }),
          manifest: manifest('array-prime-status', [
            'commands',
            'prime-contribution',
          ]),
        }),
      ],
      [
        'pull request features',
        () => ({
          plugin: plugin('array-pr-features', {
            capabilities: {
              pullRequestProvider: {
                providerId: 'array-pr-features-provider',
                priority: 1,
                features: [],
                matchRemote: () => null,
                matchPullRequestUrl: () => null,
                authStatus: () => Effect.succeed({ state: 'configured' }),
              },
            },
          }),
          manifest: manifest('array-pr-features', [
            'commands',
            'pull-request-provider',
          ]),
        }),
      ],
    ];

    for (const [name, build] of cases) {
      const registry = createCommandRegistry();
      const value = build();
      expectFixedAtomicFailure(
        () =>
          void registry.registerExternalPlugin(value.plugin, {
            manifest: value.manifest,
          })
      );
      expect(registry.pluginIds(), name).toEqual([]);
    }
  });

  test('guard-captures adjacent plugin, placement, descriptor, and capability metadata', () => {
    const cases: readonly {
      readonly name: string;
      readonly build: (
        id: string,
        attacker: Error,
        reads: { value: number }
      ) => AidePublicPluginDescriptor;
      readonly capabilities?: readonly string[];
    }[] = [
      ...(['summary', 'commands', 'capabilities'] as const).map((field) => ({
        name: `plugin.${field}`,
        build: (id: string, attacker: Error, reads: { value: number }) =>
          accessorRecord(
            plugin(id) as unknown as Record<string, unknown>,
            field,
            attacker,
            reads
          ) as unknown as AidePublicPluginDescriptor,
      })),
      ...(['parentId', 'acceptsChildren', 'extension'] as const).map(
        (field) => ({
          name: `placement.${field}`,
          build: (id: string, attacker: Error, reads: { value: number }) => {
            const placement = accessorRecord(
              command(`${id}:command`) as unknown as Record<string, unknown>,
              field,
              attacker,
              reads
            );
            return plugin(id, { commands: [placement] });
          },
        })
      ),
      ...(['route', 'summary', 'run', 'yargs'] as const).map((field) => ({
        name: `descriptor.${field}`,
        build: (id: string, attacker: Error, reads: { value: number }) => {
          const placement = command(`${id}:command`);
          accessorRecord(
            placement.descriptor as unknown as Record<string, unknown>,
            field,
            attacker,
            reads
          );
          return plugin(id, { commands: [placement] });
        },
      })),
      {
        name: 'extension.kind',
        build: (id, attacker, reads) => {
          const placement = command(`${id}:command`);
          (placement as Record<string, unknown>).extension = accessorRecord(
            { kind: 'same-plugin' },
            'kind',
            attacker,
            reads
          );
          return plugin(id, { commands: [placement] });
        },
      },
      {
        name: 'capabilities.auth.status',
        capabilities: ['commands', 'auth'],
        build: (id, attacker, reads) =>
          plugin(id, {
            capabilities: {
              auth: accessorRecord({}, 'status', attacker, reads),
            },
          }),
      },
      {
        name: 'capabilities.authProvider.login.fields',
        capabilities: ['commands', 'auth-provider'],
        build: (id, attacker, reads) =>
          plugin(id, {
            capabilities: {
              authProvider: {
                providerId: `${id}-provider`,
                label: 'Provider',
                status: () => Effect.succeed({ state: 'configured' }),
                login: accessorRecord({}, 'fields', attacker, reads),
              },
            },
          }),
      },
      {
        name: 'capabilities.primeContribution.status.entry.label',
        capabilities: ['commands', 'prime-contribution'],
        build: (id, attacker, reads) =>
          plugin(id, {
            capabilities: {
              primeContribution: {
                status: [
                  accessorRecord(
                    {
                      groupId: `${id}-group`,
                      groupLabel: 'Group',
                      status: () => Effect.succeed({ state: 'configured' }),
                    },
                    'label',
                    attacker,
                    reads
                  ),
                ],
              },
            },
          }),
      },
      {
        name: 'capabilities.pullRequestProvider.features',
        capabilities: ['commands', 'pull-request-provider'],
        build: (id, attacker, reads) =>
          plugin(id, {
            capabilities: {
              pullRequestProvider: {
                providerId: `${id}-provider`,
                priority: 1,
                features: accessorRecord(
                  {},
                  'draftPullRequests',
                  attacker,
                  reads
                ),
                matchRemote: () => null,
                matchPullRequestUrl: () => null,
                authStatus: () => Effect.succeed({ state: 'configured' }),
              },
            },
          }),
      },
    ];

    for (const [index, entry] of cases.entries()) {
      const id = `adjacent-${index}`;
      const registry = createCommandRegistry();
      const attacker = new Error(`SECRET-${entry.name}`);
      const reads = { value: 0 };

      expectFixedAtomicFailure(
        () =>
          void registry.registerExternalPlugin(
            entry.build(id, attacker, reads),
            { manifest: manifest(id, entry.capabilities ?? ['commands']) }
          ),
        attacker,
        attacker.message
      );
      expect(reads.value, entry.name).toBe(0);
      expect(registry.pluginIds(), entry.name).toEqual([]);
      expect(registry.commandIds(), entry.name).toEqual([]);
    }
  });

  test('rejects adjacent live and revoked Proxies without invoking traps', () => {
    const branches = [
      'commands',
      'capabilities',
      'placement.extension',
      'descriptor.route',
      'descriptor.yargs',
    ] as const;

    for (const [index, branch] of branches.entries()) {
      const id = `adjacent-proxy-${index}`;
      const attacker = new Error(`SECRET-${branch}`);
      const traps = { value: 0 };
      const live = hostileProxy({}, attacker, traps);
      const revoked = Proxy.revocable({}, {});
      revoked.revoke();

      for (const value of [live, revoked.proxy]) {
        const placement = command(`${id}:command`);
        let candidate: AidePublicPluginDescriptor;
        switch (branch) {
          case 'commands':
            candidate = plugin(id, { commands: value });
            break;
          case 'capabilities':
            candidate = plugin(id, { capabilities: value });
            break;
          case 'placement.extension':
            (placement as Record<string, unknown>).extension = value;
            candidate = plugin(id, { commands: [placement] });
            break;
          case 'descriptor.route':
            (placement.descriptor as Record<string, unknown>).route = value;
            candidate = plugin(id, { commands: [placement] });
            break;
          case 'descriptor.yargs':
            (placement.descriptor as Record<string, unknown>).yargs = value;
            candidate = plugin(id, { commands: [placement] });
            break;
        }

        const registry = createCommandRegistry();
        expectFixedAtomicFailure(
          () =>
            void registry.registerExternalPlugin(candidate, {
              manifest: manifest(id),
            }),
          attacker,
          attacker.message
        );
        expect(registry.pluginIds(), branch).toEqual([]);
      }
      expect(traps.value, branch).toBe(0);
    }
  });

  test('registers, freezes, replays, helps, and dispatches a full detached external snapshot', async () => {
    const id = 'full-external';
    const route = ['full-external', 'fx'];
    const allowlist = ['friend-plugin'];
    const after = ['dependency-one'];
    const before = ['dependency-two'];
    let runCalls = 0;
    const placement = {
      ...command(`${id}:root`),
      acceptsChildren: true,
      extension: { kind: 'allowlist' as const, pluginIds: allowlist },
    };
    (placement.descriptor as Record<string, unknown>).route = route;
    placement.descriptor.summary = 'Full external command';
    placement.descriptor.run = () => {
      runCalls += 1;
      return Effect.succeed(textResult('FULL-EXTERNAL-DISPATCH'));
    };
    (placement.descriptor as Record<string, unknown>).yargs = {};
    const source = plugin(id, { commands: [placement] });
    const sourceManifest = {
      ...manifest(id),
      main: './plugin.js',
      summary: 'Full manifest',
      trust: 'external' as const,
      loading: { order: 10, after, before },
      conflicts: {
        commands: 'reject' as const,
        authProviders: 'reject' as const,
        pullRequestProviders: 'reject' as const,
      },
    };
    const registry = createCommandRegistry();

    registry.registerExternalPlugin(source, { manifest: sourceManifest });
    expect(runCalls).toBe(0);

    (source as unknown as Record<string, unknown>).summary = 'MUTATED';
    route[0] = 'mutated';
    allowlist[0] = 'mutated';
    after[0] = 'mutated';
    before[0] = 'mutated';
    placement.descriptor.summary = 'MUTATED';

    const snapshot = registry.plugins()[0]!;
    const snapshotCommand = snapshot.commands[0]!;
    expect(snapshot.provenance).toBe('external');
    expect(snapshot.summary).toBe('full-external summary');
    expect(snapshotCommand.id).toBe(`${id}:root`);
    expect(snapshotCommand.kind).toBe('descriptor');
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.commands)).toBe(true);
    expect(Object.isFrozen(snapshotCommand)).toBe(true);
    if (snapshotCommand.kind !== 'descriptor') throw new Error('descriptor');
    expect(snapshotCommand.descriptor.route).toEqual(['full-external', 'fx']);
    expect(snapshotCommand.descriptor.summary).toBe('Full external command');
    expect(snapshotCommand.extension).toEqual({
      kind: 'allowlist',
      pluginIds: ['friend-plugin'],
    });
    expect(Object.isFrozen(snapshotCommand.descriptor)).toBe(true);
    expect(Object.isFrozen(snapshotCommand.descriptor.route)).toBe(true);
    expect(Object.isFrozen(snapshotCommand.extension)).toBe(true);

    const replay = createCommandRegistry();
    replay.registerPlugin(snapshot);
    expect(replay.plugins()[0]?.provenance).toBe('external');
    expect(replay.plugins()[0]).not.toBe(snapshot);

    const output: string[] = [];
    const log = console.log;
    console.log = (...values: unknown[]) => output.push(values.join(' '));
    try {
      const help = await registerCommands(
        yargs(['full-external', '--help'])
          .scriptName('aide')
          .exitProcess(false),
        registry,
        {
          keyringLayer: makeTestKeyring().layer,
        }
      ).getHelp();
      expect(help).toContain('full-external');

      await registerCommands(
        yargs(['full-external']).scriptName('aide').exitProcess(false),
        registry,
        {
          keyringLayer: makeTestKeyring().layer,
        }
      ).parseAsync();
    } finally {
      console.log = log;
    }
    expect(output).toContain('FULL-EXTERNAL-DISPATCH');
    expect(runCalls).toBe(1);
  });
});
