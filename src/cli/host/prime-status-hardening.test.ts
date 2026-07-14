import { describe, expect, test } from 'bun:test';
import { Cause, Effect, FiberId } from 'effect';

import {
  AIDE_PLUGIN_API_VERSION,
  defineAidePlugin as definePublicAidePlugin,
} from '@aide/plugin-api';
import { buildPrimeOutput } from '@cli/plugins/aide-core/prime.js';
import { makeTestKeyring } from '@lib/auth-keyring.test-helper.js';

import { createKeyringCommandRegistry } from './command-registry.js';
import { createAideInternalHostServices } from './runtime-context.js';
import type {
  AidePluginAuthStatus,
  AidePrimeStatusContribution,
} from './plugin-descriptor.js';

function manifest(id: string) {
  return {
    id,
    version: '1.0.0',
    aidePluginApiVersion: AIDE_PLUGIN_API_VERSION,
    capabilities: ['prime-contribution'] as const,
  };
}

function registerStatus(
  status: () => Effect.Effect<AidePluginAuthStatus, unknown>,
  options: {
    readonly pluginId?: string;
    readonly groupId?: string;
    readonly groupLabel?: string;
    readonly label?: string;
  } = {}
) {
  const pluginId = options.pluginId ?? 'external-status-hardening';
  const registry = createKeyringCommandRegistry();
  registry.registerExternalPlugin(
    definePublicAidePlugin({
      id: pluginId,
      summary: 'External status hardening probe',
      commands: [],
      capabilities: {
        primeContribution: {
          status: [
            {
              groupId: options.groupId ?? 'external-status-hardening',
              groupLabel: options.groupLabel ?? 'External Status Hardening',
              label: options.label ?? 'External Status Hardening',
              status,
            },
          ],
        },
      },
    }),
    { manifest: manifest(pluginId) }
  );
  return {
    registry,
    services: createAideInternalHostServices(registry, makeTestKeyring().layer),
  };
}

describe('Prime status hardening', () => {
  test('snapshots state/detail exactly once into fresh frozen primitive-only status data', async () => {
    let stateReads = 0;
    let detailReads = 0;
    let trimReads = 0;
    const hostileDetail = Object.freeze({
      get trim() {
        trimReads += 1;
        throw new Error('SECRET-STATUS-TRIM');
      },
      toString() {
        throw new Error('SECRET-STATUS-COERCION');
      },
    });
    const changing = Object.create(null) as Record<string, unknown>;
    Object.defineProperties(changing, {
      state: {
        enumerable: true,
        get: () => {
          stateReads += 1;
          return stateReads === 1 ? 'misconfigured' : hostileDetail;
        },
      },
      detail: {
        enumerable: true,
        get: () => {
          detailReads += 1;
          return detailReads === 1 ? 'safe captured detail' : hostileDetail;
        },
      },
    });
    const { services } = registerStatus(() =>
      Effect.succeed(changing as unknown as AidePluginAuthStatus)
    );

    const output = await buildPrimeOutput({ services });

    expect(output).toContain(
      '- External Status Hardening: Misconfigured (safe captured detail)'
    );
    expect(stateReads).toBe(1);
    expect(detailReads).toBe(1);
    expect(trimReads).toBe(0);
    expect(output).not.toContain('SECRET-STATUS');
  });

  test('turns throwing getters, proxies, forged values, and unsafe details into fixed fallback', async () => {
    let attackerReads = 0;
    const values: unknown[] = [
      Object.defineProperty({}, 'state', {
        get() {
          attackerReads += 1;
          throw new Error('SECRET-THROWING-STATE');
        },
      }),
      Object.defineProperties(
        {},
        {
          state: { value: 'misconfigured' },
          detail: {
            get() {
              attackerReads += 1;
              throw new Error('SECRET-THROWING-DETAIL');
            },
          },
        }
      ),
      new Proxy(
        {},
        {
          get() {
            attackerReads += 1;
            throw new Error('SECRET-PROXY-STATUS');
          },
        }
      ),
      { state: 'misconfigured', detail: { trim: () => 'SECRET' } },
      { state: 'misconfigured', detail: `unsafe\nline` },
      { state: 'misconfigured', detail: `unsafe\u2028line` },
      { state: 'misconfigured', detail: 'x'.repeat(1_025) },
    ];

    for (const [index, value] of values.entries()) {
      const { services } = registerStatus(
        () => Effect.succeed(value as AidePluginAuthStatus),
        {
          pluginId: `external-status-hostile-${index}`,
          groupId: `external-status-hostile-${index}`,
        }
      );
      const output = await buildPrimeOutput({ services });
      expect(output, String(index)).toContain('status is unavailable:');
      expect(output, String(index)).not.toContain('SECRET-');
      expect(output, String(index)).not.toContain('unsafe\nline');
      expect(output, String(index)).not.toContain('unsafe\u2028line');
      expect(output, String(index)).not.toContain('x'.repeat(1_025));
    }
    expect(attackerReads).toBe(2);
  });

  test('applies NFC normalization to status detail before unsafe checks and snapshots the normalized detail', async () => {
    const safeDetails = 'Cafe\u0301 detail';
    const safeServices = registerStatus(
      () =>
        Effect.succeed({
          state: 'misconfigured',
          detail: safeDetails,
        }),
      { pluginId: 'external-status-nfc-safe', groupId: 'external-status-nfc' }
    ).services;
    const safeOutput = await buildPrimeOutput({ services: safeServices });
    expect(safeOutput).toContain('Caf\u00e9 detail');
    expect(safeOutput).not.toContain('Cafe\u0301 detail');

    const unsafeDetails = [
      'safe \u00ad status SECRET-NFC-AD',
      'safe \u061c status SECRET-NFC-ALM',
      'safe \u180e status SECRET-NFC-MMSP',
      'safe \u2060 status SECRET-NFC-WJ',
      'safe \ufffb status SECRET-NFC-CONS',
    ] as const;

    for (const [index, detail] of unsafeDetails.entries()) {
      const { services } = registerStatus(
        () =>
          Effect.succeed({
            state: 'misconfigured',
            detail,
          }),
        {
          pluginId: `external-status-nfc-${index + 1}`,
          groupId: 'external-status-nfc',
          label: `External Status NFC ${index + 1}`,
        }
      );
      const output = await buildPrimeOutput({ services });
      expect(output).toContain(
        'status is unavailable: returned an unsafe status detail'
      );
      expect(output).not.toContain('SECRET-NFC');
      expect(output).not.toContain(detail);
    }
  });

  test('falls back when normalized status detail length exceeds 1024 UTF-16 units', async () => {
    const marker = ' SECRET-NORM-LENGTH';
    const raw = '\u0344'.repeat(510);
    expect(raw.length + marker.length).toBe(529);
    expect(raw.normalize('NFC').length + marker.length).toBe(1_039);

    const detail = `${marker}${raw}`;
    const { services } = registerStatus(
      () =>
        Effect.succeed({
          state: 'misconfigured',
          detail,
        }),
      {
        pluginId: 'external-status-overflow-normalized',
        groupId: 'external-status-overflow-normalized',
      }
    );
    const output = await buildPrimeOutput({ services });

    expect(output).toContain(
      'status is unavailable: returned an unsafe status detail'
    );
    expect(output).not.toContain('SECRET-NORM-LENGTH');
  });

  test('redacts every mixed Cause and propagates only interruption-only Causes', async () => {
    const failure = Object.freeze({ secret: 'SECRET-MIXED-FAILURE' });
    const defect = new Error('SECRET-MIXED-DEFECT');
    const interrupt = Cause.interrupt(FiberId.none);
    const mixed = [
      Cause.parallel(Cause.fail(failure), interrupt),
      Cause.sequential(Cause.fail(failure), interrupt),
      Cause.parallel(Cause.die(defect), interrupt),
      Cause.sequential(Cause.die(defect), interrupt),
      Cause.parallel(
        Cause.fail(failure),
        Cause.sequential(Cause.die(defect), interrupt)
      ),
    ] as const;

    for (const [index, cause] of mixed.entries()) {
      const { services } = registerStatus(() => Effect.failCause(cause), {
        pluginId: `external-status-mixed-${index}`,
        groupId: `external-status-mixed-${index}`,
      });
      const output = await buildPrimeOutput({ services });
      expect(output, String(index)).toContain(
        'status is unavailable: status Effect execution failed'
      );
      expect(output, String(index)).not.toContain(failure.secret);
      expect(output, String(index)).not.toContain(defect.message);
    }
  });
});

describe('Prime status registration snapshots', () => {
  const contribution = (): AidePrimeStatusContribution<never> => ({
    groupId: 'snapshot-status',
    groupLabel: 'Snapshot Status',
    label: 'Snapshot Status',
    status: () => Effect.succeed({ state: 'configured' }),
  });

  function pluginWithStatus(status: readonly AidePrimeStatusContribution[]) {
    return definePublicAidePlugin({
      id: 'external-status-array',
      summary: 'External status array probe',
      commands: [],
      capabilities: { primeContribution: { status } },
    });
  }

  test('never invokes own map/iterator hooks and retains fresh frozen snapshots', () => {
    let mapCalls = 0;
    let iteratorReads = 0;
    const original = contribution();
    const injected = {
      ...contribution(),
      groupLabel: 'Injected Mutable Label',
    };
    const source = [original];
    Object.defineProperty(source, 'map', {
      configurable: true,
      value: () => {
        mapCalls += 1;
        return [injected];
      },
    });
    Object.defineProperty(source, Symbol.iterator, {
      configurable: true,
      get: () => {
        iteratorReads += 1;
        throw new Error('iterator must not be read');
      },
    });
    const registry = createKeyringCommandRegistry();

    registry.registerExternalPlugin(pluginWithStatus(source), {
      manifest: manifest('external-status-array'),
    });
    const snapshot =
      registry.capabilities.primeContributions()[0]!.capability.status!;

    expect(mapCalls).toBe(0);
    expect(iteratorReads).toBe(0);
    expect(snapshot).not.toBe(source);
    expect(snapshot[0]).not.toBe(original);
    expect(snapshot[0]?.groupLabel).toBe('Snapshot Status');
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot[0])).toBe(true);
    injected.groupLabel = 'Mutated Injection';
    (original as { groupLabel: string }).groupLabel = 'Mutated Original';
    source.push(contribution());
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]?.groupLabel).toBe('Snapshot Status');
  });

  test('atomically rejects accessor, sparse, Proxy, and oversized arrays without invoking hooks', () => {
    let accessorReads = 0;
    const accessor: AidePrimeStatusContribution[] = [];
    accessor.length = 1;
    Object.defineProperty(accessor, '0', {
      enumerable: true,
      get: () => {
        accessorReads += 1;
        return contribution();
      },
    });
    const sparse: AidePrimeStatusContribution[] = [];
    sparse.length = 2;
    sparse[0] = contribution();
    const oversized: AidePrimeStatusContribution[] = [];
    oversized.length = 1_001;
    const proxy = new Proxy([contribution()], {
      get() {
        throw new Error('proxy array trap');
      },
    });

    for (const status of [accessor, sparse, oversized, proxy]) {
      const registry = createKeyringCommandRegistry();
      expect(() =>
        registry.registerExternalPlugin(pluginWithStatus(status), {
          manifest: manifest('external-status-array'),
        })
      ).toThrow();
      expect(registry.pluginIds()).toEqual([]);
    }
    expect(accessorReads).toBe(0);
  });
});

describe('external Prime metadata contract', () => {
  function registerMetadata(
    pluginId: string,
    groupId: string,
    groupLabel: string,
    label: string
  ) {
    const registry = createKeyringCommandRegistry();
    registry.registerExternalPlugin(
      definePublicAidePlugin({
        id: pluginId,
        summary: 'Metadata hardening probe',
        commands: [],
        capabilities: {
          primeContribution: {
            status: [
              {
                groupId,
                groupLabel,
                label,
                status: () => Effect.succeed({ state: 'configured' }),
              },
            ],
          },
        },
      }),
      { manifest: manifest(pluginId) }
    );
    return registry;
  }

  test('rejects noncanonical, control-bearing, bidi, whitespace, prototype, and overlong ids', () => {
    const invalidIds = [
      'Uppercase',
      '-leading',
      'trailing-',
      'has/slash',
      'has:colon',
      'constructor',
      '__proto__',
      ' leading',
      'trailing ',
      'line\nbreak',
      'delete\u007fchar',
      'c1\u0085char',
      'bidi\u202echar',
      'separator\u2028char',
      'prototype',
      'x'.repeat(65),
    ];

    for (const id of invalidIds) {
      expect(() =>
        registerMetadata(id, 'valid-group', 'Valid', 'Valid')
      ).toThrow();
      expect(() =>
        registerMetadata('valid-plugin', id, 'Valid', 'Valid')
      ).toThrow();
    }
  });

  test('rejects unsafe/overlong labels and snapshots printable Unicode in NFC', () => {
    const invalidLabels = [
      ' leading',
      'trailing ',
      'line\nbreak',
      'carriage\rreturn',
      'delete\u007fchar',
      'c1\u0085char',
      'bidi\u202echar',
      'separator\u2028char',
      'paragraph\u2029char',
      'zero\u200bwidth',
      '\ud800surrogate',
      'x'.repeat(129),
    ];
    for (const label of invalidLabels) {
      expect(() =>
        registerMetadata('valid-plugin', 'valid-group', label, 'Valid')
      ).toThrow();
      expect(() =>
        registerMetadata('valid-plugin', 'valid-group', 'Valid', label)
      ).toThrow();
    }

    const registry = registerMetadata(
      'vendor.plugin-1',
      'vendor.group-1',
      'Cafe\u0301 Tool',
      'Re\u0301sume\u0301'
    );
    const snapshot =
      registry.capabilities.primeContributions()[0]!.capability.status![0]!;
    expect(snapshot.groupLabel).toBe('Caf\u00e9 Tool');
    expect(snapshot.label).toBe('R\u00e9sum\u00e9');
  });
});
