import { describe, expect, test } from 'bun:test';
import { inspect } from 'node:util';
import { Cause, Effect, Exit, Option } from 'effect';

import {
  AIDE_PLUGIN_API_VERSION,
  PrimeContributionError as PublicPrimeContributionError,
  defineAidePlugin as definePublicAidePlugin,
  type AidePrimeSection,
} from '@aide/plugin-api';
import { renderTopLevelError } from '@cli/index.js';
import { createKeyringCommandRegistry } from './command-registry.js';
import {
  PrimeContributionError,
  invokePrimeSectionsCallback,
  snapshotPrimeSections,
  snapshotValidPrimeSections,
} from './prime-contribution.js';
import { createAideHostServices } from './runtime-context.js';
import {
  backendFailureSentinels,
  exportedErrorText,
  maliciousBackendFailure,
  reachableOwnDataText,
} from '@lib/error-redaction.test-helper.js';

const pluginId = 'secret-redaction-prime';
const invalidDiagnosticPluginId = '<invalid-plugin>';

function diagnosticSurfaces(error: PrimeContributionError): readonly string[] {
  return [
    error.pluginId,
    error.message,
    String(error),
    JSON.stringify(error),
    JSON.stringify(Object.keys(error)),
    JSON.stringify(Reflect.ownKeys(error).map(String)),
    inspect(Object.getOwnPropertyDescriptors(error), {
      depth: 20,
      getters: false,
      showHidden: true,
    }),
    reachableOwnDataText(error),
    inspect(error, { depth: 20, getters: false, showHidden: true }),
    error.stack ?? '',
    renderTopLevelError(error),
  ];
}

function expectInvalidDiagnosticPluginId(
  error: PrimeContributionError,
  hostilePluginId: string
): void {
  expect(error.pluginId).toBe(invalidDiagnosticPluginId);
  for (const surface of diagnosticSurfaces(error)) {
    expect(surface).not.toContain(hostilePluginId);
  }
}

function directPrimeError(pluginIdValue: string): PrimeContributionError {
  return new PrimeContributionError({
    pluginId: pluginIdValue,
    contribution: 'sections',
    reason: 'effect-failed',
  });
}

function attackerOwnedPrimeError(label: string): {
  readonly error: PrimeContributionError;
  readonly secrets: readonly string[];
} {
  const secret = `SECRET-FORGED-PRIME-${label}`;
  const secretKey = `attacker-${secret}`;
  const error = new PublicPrimeContributionError({
    pluginId: 'valid-attacker-construction',
    contribution: 'sections',
    reason: 'invalid-result',
    diagnostic: 'entry-unreadable',
    entryIndex: 0,
  });
  Object.assign(error as unknown as Record<string, unknown>, {
    pluginId: secret,
    reason: secret,
    diagnostic: secret,
    entryIndex: secret,
  });
  Object.defineProperties(error, {
    [secretKey]: {
      configurable: true,
      enumerable: true,
      value: { nested: secret },
      writable: true,
    },
    cause: {
      configurable: true,
      enumerable: true,
      value: { nested: secret },
      writable: true,
    },
    attackerAccessor: {
      configurable: true,
      enumerable: true,
      get: () => secret,
    },
  });
  return { error, secrets: [secret, secretKey] };
}

function strictTraversalSource(
  boundary:
    | 'length'
    | 'descriptor'
    | 'index-getter'
    | 'id-getter'
    | 'body-getter'
    | 'order-proxy',
  thrown: unknown
): readonly AidePrimeSection[] {
  if (boundary === 'length') {
    return new Proxy([{ id: 'length', body: 'length' }], {
      get(target, property, receiver) {
        if (property === 'length') throw thrown;
        return Reflect.get(target, property, receiver);
      },
    });
  }
  if (boundary === 'descriptor') {
    return new Proxy([{ id: 'descriptor', body: 'descriptor' }], {
      getOwnPropertyDescriptor(target, property) {
        if (property === '0') throw thrown;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });
  }
  if (boundary === 'index-getter') {
    const sections: AidePrimeSection[] = [];
    sections.length = 1;
    Object.defineProperty(sections, '0', {
      enumerable: true,
      get: () => {
        throw thrown;
      },
    });
    return sections;
  }

  const target: Record<string, unknown> = {
    id: 'field-section',
    body: 'field section',
    order: 1,
  };
  if (boundary === 'order-proxy') {
    return [
      new Proxy(target, {
        get(object, property, receiver) {
          if (property === 'order') throw thrown;
          return Reflect.get(object, property, receiver);
        },
      }) as unknown as AidePrimeSection,
    ];
  }
  const field = boundary === 'id-getter' ? 'id' : 'body';
  Object.defineProperty(target, field, {
    enumerable: true,
    get: () => {
      throw thrown;
    },
  });
  return [target as unknown as AidePrimeSection];
}

function expectRedactedPrimeError(
  error: PrimeContributionError,
  secrets: readonly string[]
): void {
  expect(error).toBeInstanceOf(PrimeContributionError);
  expect(error._tag).toBe('PrimeContributionError');
  expect(error.pluginId).toBe(pluginId);
  expect(Object.hasOwn(error, 'cause')).toBe(false);
  expect(Object.getOwnPropertyDescriptor(error, 'cause')).toBeUndefined();
  expect(Object.keys(error)).not.toContain('cause');

  const exported = exportedErrorText(error);
  const cli = renderTopLevelError(error);
  for (const secret of [...backendFailureSentinels, ...secrets]) {
    expect(error.message).not.toContain(secret);
    expect(String(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(exported).not.toContain(secret);
    expect(cli).not.toContain(secret);
  }
}

describe('Prime contribution boundary errors', () => {
  test('replaces every C0, DEL, and C1 diagnostic plugin id wholesale', () => {
    const controls = [
      ...Array.from({ length: 0x20 }, (_, value) => String.fromCharCode(value)),
      String.fromCharCode(0x7f),
      ...Array.from({ length: 0x20 }, (_, value) =>
        String.fromCharCode(0x80 + value)
      ),
    ];

    for (const control of controls) {
      const hostilePluginId = `external-${control}-prime`;
      expectInvalidDiagnosticPluginId(
        directPrimeError(hostilePluginId),
        hostilePluginId
      );
    }
  });

  test('replaces Unicode format, bidi, zero-width, non-ASCII, and surrogate diagnostic ids wholesale', () => {
    const hostilePluginIds = [
      'external-\u202e-bidi-override',
      'external-\u2066-bidi-isolate',
      'external-\u200e-format-mark',
      'external-\u200b-zero-width-space',
      'external-\u200d-zero-width-joiner',
      'external-\ufeff-zero-width-no-break-space',
      'external-caf\u00e9',
      'external-\ud83d\ude08-emoji',
      'external-\ud800-lone-high-surrogate',
      'external-\udc00-lone-low-surrogate',
    ];

    for (const hostilePluginId of hostilePluginIds) {
      expectInvalidDiagnosticPluginId(
        directPrimeError(hostilePluginId),
        hostilePluginId
      );
    }
  });

  test('replaces whitespace, overlong, and terminal-spoofing diagnostic ids wholesale', () => {
    const hostilePluginIds = [
      'external prime',
      'external\tprime',
      'external\r\nprime',
      'external\u00a0prime',
      `external-${'x'.repeat(129)}`,
      'external-\u001b[31m-red',
      'external-\u001b]0;spoofed-title\u0007-prime',
      "external-'][spoofed-diagnostic",
    ];

    for (const hostilePluginId of hostilePluginIds) {
      expectInvalidDiagnosticPluginId(
        directPrimeError(hostilePluginId),
        hostilePluginId
      );
    }
  });

  test('retains a representative canonical plugin id in diagnostics', () => {
    const validPluginId = 'external-prime_1.2';
    const error = directPrimeError(validPluginId);

    expect(error.pluginId).toBe(validPluginId);
    expect(error.message).toContain(validPluginId);
    expect(renderTopLevelError(error)).toContain(validPluginId);
  });

  test('rejects a hostile external plugin id before public Prime registration', () => {
    const hostilePluginId = 'external-\u202e-prime-\u009b-\u200b';
    const registry = createKeyringCommandRegistry();
    expect(() =>
      registry.registerExternalPlugin(
        definePublicAidePlugin({
          id: hostilePluginId,
          summary: 'External hostile diagnostic id probe',
          commands: [],
          capabilities: {
            primeContribution: {
              sections: () => Effect.fail(new Error('ordinary failure')),
            },
          },
        }),
        {
          manifest: {
            id: hostilePluginId,
            version: '1.0.0',
            aidePluginApiVersion: AIDE_PLUGIN_API_VERSION,
            capabilities: ['prime-contribution'],
          },
        }
      )
    ).toThrow(/not canonical/);
    expect(registry.pluginIds()).toEqual([]);
  });

  test('never returns attacker-owned typed errors thrown across strict registered Prime traversal', async () => {
    const registeredPluginId = 'external-forged-prime-traversal';
    let source: readonly AidePrimeSection[] = [];
    const registry = createKeyringCommandRegistry();
    registry.registerExternalPlugin(
      definePublicAidePlugin({
        id: registeredPluginId,
        summary: 'External forged Prime traversal probe',
        commands: [],
        capabilities: {
          primeContribution: { sections: () => Effect.succeed(source) },
        },
      }),
      {
        manifest: {
          id: registeredPluginId,
          version: '1.0.0',
          aidePluginApiVersion: AIDE_PLUGIN_API_VERSION,
          capabilities: ['prime-contribution'],
        },
      }
    );
    const sections =
      createAideHostServices(registry).primeContributions()[0]!.capability
        .sections!;
    const cases = [
      ['id-getter', 'entry-unreadable', 0],
      ['body-getter', 'entry-unreadable', 0],
      ['order-proxy', 'entry-unreadable', 0],
      ['length', 'result-length-unreadable', undefined],
      ['descriptor', 'result-length-unreadable', undefined],
      ['index-getter', 'entry-unreadable', 0],
    ] as const;
    const observations: {
      readonly actual: PrimeContributionError;
      readonly attacker: PrimeContributionError;
      readonly diagnostic: string;
      readonly entryIndex: number | undefined;
      readonly secrets: readonly string[];
    }[] = [];

    for (const [boundary, diagnostic, entryIndex] of cases) {
      const attacker = attackerOwnedPrimeError(boundary);
      source = strictTraversalSource(boundary, attacker.error);
      observations.push({
        actual: await Effect.runPromise(sections().pipe(Effect.flip)),
        attacker: attacker.error,
        diagnostic,
        entryIndex,
        secrets: attacker.secrets,
      });
    }

    expect(
      observations.map(({ actual, attacker }) => actual === attacker)
    ).toEqual(cases.map(() => false));
    for (const observation of observations) {
      expect(observation.actual).not.toBe(observation.attacker);
      expect(observation.actual).toBeInstanceOf(PrimeContributionError);
      expect(observation.actual).toMatchObject({
        _tag: 'PrimeContributionError',
        pluginId: registeredPluginId,
        contribution: 'sections',
        reason: 'invalid-result',
        diagnostic: observation.diagnostic,
      });
      expect(observation.actual.entryIndex).toBe(observation.entryIndex);
      expect(Object.hasOwn(observation.actual, 'cause')).toBe(false);
      for (const surface of diagnosticSurfaces(observation.actual)) {
        for (const secret of observation.secrets) {
          expect(surface).not.toContain(secret);
        }
      }
    }
  });

  test('redacts a forged typed field failure and an ordinary field Error on every public surface', async () => {
    const registeredPluginId = 'external-forged-prime-surface';
    let source: readonly AidePrimeSection[] = [];
    const registry = createKeyringCommandRegistry();
    registry.registerExternalPlugin(
      definePublicAidePlugin({
        id: registeredPluginId,
        summary: 'External forged Prime surface probe',
        commands: [],
        capabilities: {
          primeContribution: { sections: () => Effect.succeed(source) },
        },
      }),
      {
        manifest: {
          id: registeredPluginId,
          version: '1.0.0',
          aidePluginApiVersion: AIDE_PLUGIN_API_VERSION,
          capabilities: ['prime-contribution'],
        },
      }
    );
    const sections =
      createAideHostServices(registry).primeContributions()[0]!.capability
        .sections!;
    const forged = attackerOwnedPrimeError('surface-field');
    source = strictTraversalSource('id-getter', forged.error);
    const forgedResult = await Effect.runPromise(sections().pipe(Effect.flip));
    const ordinarySecret = 'SECRET-ORDINARY-PRIME-FIELD-ERROR';
    source = strictTraversalSource('body-getter', new Error(ordinarySecret));
    const ordinaryResult = await Effect.runPromise(
      sections().pipe(Effect.flip)
    );

    expect(forgedResult.pluginId).toBe(registeredPluginId);
    expect(forgedResult).not.toBe(forged.error);
    for (const surface of diagnosticSurfaces(forgedResult)) {
      for (const secret of forged.secrets)
        expect(surface).not.toContain(secret);
    }
    for (const surface of diagnosticSurfaces(ordinaryResult)) {
      expect(surface).not.toContain(ordinarySecret);
    }
  });

  test('redacts arbitrary callback throws across every exported and CLI surface', async () => {
    const secret = 'SECRET-CALLBACK-THROW-7b33';
    const fixture = maliciousBackendFailure([secret]);
    const error = await Effect.runPromise(
      invokePrimeSectionsCallback(pluginId, () => {
        throw fixture.failure;
      }).pipe(Effect.flip)
    );

    expect(error.reason).toBe('callback-threw');
    expectRedactedPrimeError(error, [secret]);
    expect(fixture.getterReads()).toBe(0);
  });

  test('redacts arbitrary Effect failures while preserving instanceof and catchTag ergonomics', async () => {
    const secret = 'SECRET-EFFECT-FAILURE-1da8';
    const fixture = maliciousBackendFailure([secret]);
    const effect = invokePrimeSectionsCallback(pluginId, () =>
      Effect.fail(fixture.failure)
    );
    const error = await Effect.runPromise(effect.pipe(Effect.flip));
    const caughtReason = await Effect.runPromise(
      effect.pipe(
        Effect.catchTag('PrimeContributionError', (failure) =>
          Effect.succeed(failure.reason)
        )
      )
    );

    expect(error.reason).toBe('effect-failed');
    expect(caughtReason).toBe('effect-failed');
    expectRedactedPrimeError(error, [secret]);
    expect(fixture.getterReads()).toBe(0);
  });

  test('discards constructor-supplied raw causes instead of retaining hidden payloads', () => {
    const secret = 'SECRET-DIRECT-CONSTRUCTION-f05a';
    const fixture = maliciousBackendFailure([secret]);
    const error = new PrimeContributionError({
      pluginId,
      contribution: 'sections',
      reason: 'effect-failed',
      cause: fixture.failure,
    });

    expectRedactedPrimeError(error, [secret]);
    expect(fixture.getterReads()).toBe(0);
  });

  test('enforces exact Array keys while tolerant traversal densifies valid entries', () => {
    const withExtraKey = [{ id: 'extra', body: 'extra' }];
    Object.defineProperty(withExtraKey, 'extra', {
      configurable: true,
      enumerable: true,
      value: 'rejected',
      writable: true,
    });
    expect(() => snapshotPrimeSections(pluginId, withExtraKey)).toThrow(
      expect.objectContaining({
        _tag: 'PrimeContributionError',
        diagnostic: 'result-length-unreadable',
      })
    );
    expect(snapshotValidPrimeSections(pluginId, withExtraKey)).toEqual([]);

    const sparse: AidePrimeSection[] = [];
    sparse.length = 2;
    Object.defineProperty(sparse, '1', {
      configurable: true,
      enumerable: true,
      value: { id: 'retained', body: 'retained', order: 2 },
      writable: true,
    });
    expect(() => snapshotPrimeSections(pluginId, sparse)).toThrow(
      expect.objectContaining({
        _tag: 'PrimeContributionError',
        diagnostic: 'entry-missing',
        entryIndex: 0,
      })
    );
    const tolerant = snapshotValidPrimeSections(pluginId, sparse);
    expect(tolerant).toEqual([{ id: 'retained', body: 'retained', order: 2 }]);
    expect(Reflect.ownKeys(tolerant)).toEqual(['0', 'length']);
    expect(Object.isFrozen(tolerant)).toBe(true);
    expect(Object.isFrozen(tolerant[0])).toBe(true);
    expect(Object.getOwnPropertyDescriptor(tolerant, '0')).toMatchObject({
      enumerable: true,
      value: { id: 'retained', body: 'retained', order: 2 },
    });
  });

  test('requires section fields to be own data descriptors', () => {
    let getterCalls = 0;
    const inherited = Object.create({ id: 'inherited', body: 'inherited' });
    const accessor = { body: 'accessor' } as Record<string, unknown>;
    Object.defineProperty(accessor, 'id', {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'accessor';
      },
    });

    expect(() => snapshotPrimeSections(pluginId, [inherited])).toThrow(
      expect.objectContaining({ diagnostic: 'entry-id-invalid' })
    );
    expect(() => snapshotPrimeSections(pluginId, [accessor])).toThrow(
      expect.objectContaining({ diagnostic: 'entry-unreadable' })
    );
    expect(snapshotValidPrimeSections(pluginId, [inherited, accessor])).toEqual(
      []
    );
    expect(getterCalls).toBe(0);
  });

  test('preserves Effect defects and interruption as causes', async () => {
    const defect = new Error('SECRET-PRIME-DEFECT-e041');
    const defectExit = await Effect.runPromiseExit(
      invokePrimeSectionsCallback(pluginId, () => Effect.die(defect))
    );
    expect(Exit.isFailure(defectExit)).toBe(true);
    if (Exit.isSuccess(defectExit)) throw new Error('expected Prime defect');
    const defectOption = Cause.dieOption(defectExit.cause);
    expect(Option.isSome(defectOption)).toBe(true);
    if (Option.isSome(defectOption)) expect(defectOption.value).toBe(defect);
    expect(Option.isNone(Cause.failureOption(defectExit.cause))).toBe(true);

    const interruptionExit = await Effect.runPromiseExit(
      invokePrimeSectionsCallback(pluginId, () => Effect.interrupt)
    );
    expect(Exit.isFailure(interruptionExit)).toBe(true);
    if (Exit.isSuccess(interruptionExit)) {
      throw new Error('expected Prime interruption');
    }
    expect(Cause.isInterruptedOnly(interruptionExit.cause)).toBe(true);
    expect(Option.isNone(Cause.failureOption(interruptionExit.cause))).toBe(
      true
    );
  });
});
