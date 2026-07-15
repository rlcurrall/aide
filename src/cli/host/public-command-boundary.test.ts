import { describe, expect, test } from 'bun:test';
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FiberId,
  FiberRef,
  Option,
} from 'effect';
import yargs from 'yargs';

import {
  AIDE_PLUGIN_API_VERSION,
  defineAideCommand,
  defineAidePlugin,
  emptyResult,
  pluginCommandDescriptor,
  textResult,
  type CommandResult,
} from '@aide/plugin-api';
import { createCommandRegistry } from './command-registry.js';
import {
  invokePublicCommandEffect,
  PublicCommandHostError,
  snapshotPublicCommandResult,
} from './public-command-invocation.js';
import {
  AideHostServicesTag,
  createAideHostServices,
} from './runtime-context.js';
import { registerCommands } from './yargs-adapter.js';
import { makeTestKeyring } from '@lib/auth-keyring.test-helper.js';
import { testGitHubAuthCatalogLayer } from '@lib/github-auth-catalog.test-helper.js';
import { exportedErrorText } from '@lib/error-redaction.test-helper.js';

const testKeyringLayer = makeTestKeyring().layer;

type ExternalRun = () => unknown;

function externalManifest(id: string) {
  return {
    id,
    version: '1.0.0',
    aidePluginApiVersion: AIDE_PLUGIN_API_VERSION,
    capabilities: ['commands'],
  } as const;
}

async function parseExternalCommand(
  id: string,
  run: ExternalRun,
  lines: string[] = []
): Promise<void> {
  const registry = createCommandRegistry();
  registry.registerExternalPlugin(
    defineAidePlugin({
      id,
      summary: 'External command boundary test plugin',
      commands: [
        pluginCommandDescriptor(
          defineAideCommand({
            id: `${id}:probe`,
            route: `${id}-probe`,
            summary: 'External command boundary probe',
            run: run as () => Effect.Effect<CommandResult, unknown, never>,
          })
        ),
      ],
    }),
    { manifest: externalManifest(id) }
  );

  const originalLog = console.log;
  console.log = (...args: unknown[]) => lines.push(args.join(' '));
  try {
    await registerCommands(
      yargs([`${id}-probe`])
        .scriptName('aide')
        .exitProcess(false),
      registry,
      {
        keyringLayer: testKeyringLayer,
        githubAuthCatalogLayer: testGitHubAuthCatalogLayer,
      }
    )
      .strict()
      .showHelpOnFail(false)
      .fail((_message, error) => {
        throw error ?? new Error('unexpected yargs validation failure');
      })
      .parseAsync();
  } finally {
    console.log = originalLog;
  }
}

async function rejectedExternalCommand(id: string, run: ExternalRun) {
  try {
    await parseExternalCommand(id, run);
    throw new Error('expected external command rejection');
  } catch (error) {
    return error;
  }
}

describe('public external command boundary through real registry and yargs', () => {
  test('replaces synchronous callback throws with fresh fixed diagnostics', async () => {
    const attacker = new Error('SECRET-COMMAND-CALLBACK');
    const first = await rejectedExternalCommand('callback-one', () => {
      throw attacker;
    });
    const second = await rejectedExternalCommand('callback-two', () => {
      throw attacker;
    });

    expect(first).not.toBe(attacker);
    expect(second).not.toBe(attacker);
    expect(first).not.toBe(second);
    expect(exportedErrorText(first as Error)).not.toContain(
      'SECRET-COMMAND-CALLBACK'
    );
    expect(exportedErrorText(second as Error)).not.toContain(
      'SECRET-COMMAND-CALLBACK'
    );
  });

  test('rejects a non-Effect Proxy without reading plugin-owned pipe', async () => {
    const attacker = new Error('SECRET-COMMAND-PIPE');
    let reads = 0;
    const value = new Proxy(
      {},
      {
        get(_target, property) {
          reads += 1;
          if (property === 'pipe') throw attacker;
          throw new Error('SECRET-COMMAND-OTHER-GET');
        },
      }
    );

    const error = await rejectedExternalCommand(
      'non-effect-proxy',
      () => value
    );

    expect(reads).toBe(0);
    expect(error).not.toBe(attacker);
    expect(exportedErrorText(error as Error)).not.toContain('SECRET-COMMAND');
  });

  test('never reads a genuine returned Effect own pipe property', async () => {
    const lines: string[] = [];
    let reads = 0;
    const effect = Effect.succeed(textResult('static composition'));
    Object.defineProperty(effect, 'pipe', {
      get() {
        reads += 1;
        throw new Error('SECRET-GENUINE-EFFECT-PIPE');
      },
    });

    await parseExternalCommand('effect-pipe', () => effect, lines);

    expect(reads).toBe(0);
    expect(lines).toEqual(['static composition']);
  });

  test('rejects a revoked Effect Proxy without invoking traps', async () => {
    const revoked = Proxy.revocable(Effect.succeed(emptyResult), {});
    revoked.revoke();

    const error = await rejectedExternalCommand(
      'revoked-effect-proxy',
      () => revoked.proxy
    );

    expect(exportedErrorText(error as Error)).not.toContain('Cannot perform');
  });

  test('snapshots a hostile result Proxy without reading result fields', async () => {
    const attacker = new Error('SECRET-COMMAND-RESULT');
    let reads = 0;
    const result = new Proxy(
      {},
      {
        get() {
          reads += 1;
          throw attacker;
        },
      }
    );

    const error = await rejectedExternalCommand('result-proxy', () =>
      Effect.succeed(result)
    );

    expect(reads).toBe(0);
    expect(error).not.toBe(attacker);
    expect(exportedErrorText(error as Error)).not.toContain(
      'SECRET-COMMAND-RESULT'
    );
  });

  test('rejects accessors and inherited CommandResult fields without invoking accessors', async () => {
    let reads = 0;
    const attacker = new Error('SECRET-COMMAND-RESULT-ACCESSOR');
    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessor, '_tag', {
      get() {
        reads += 1;
        throw attacker;
      },
    });
    const textAccessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(textAccessor, '_tag', { value: 'Text' });
    Object.defineProperty(textAccessor, 'text', {
      get() {
        reads += 1;
        throw attacker;
      },
    });
    const inherited = Object.create({ _tag: 'Text', text: 'unsafe inherited' });

    const accessorError = await rejectedExternalCommand('result-accessor', () =>
      Effect.succeed(accessor)
    );
    const inheritedError = await rejectedExternalCommand(
      'result-inherited',
      () => Effect.succeed(inherited)
    );
    const textAccessorError = await rejectedExternalCommand(
      'result-text-accessor',
      () => Effect.succeed(textAccessor)
    );

    expect(reads).toBe(0);
    expect(accessorError).not.toBe(attacker);
    expect(textAccessorError).not.toBe(attacker);
    expect(exportedErrorText(accessorError as Error)).not.toContain(
      attacker.message
    );
    expect(exportedErrorText(textAccessorError as Error)).not.toContain(
      attacker.message
    );
    expect(exportedErrorText(inheritedError as Error)).not.toContain(
      'unsafe inherited'
    );
  });

  test('keeps valid text and empty results compatible', async () => {
    const lines: string[] = [];
    await parseExternalCommand(
      'valid-text',
      () => Effect.succeed(textResult('external text')),
      lines
    );
    await parseExternalCommand(
      'valid-empty',
      () => Effect.succeed(emptyResult),
      lines
    );

    expect(lines).toEqual(['external text']);
  });
});

class AmbientCommandService extends Context.Tag(
  'aide.test.AmbientCommandService'
)<AmbientCommandService, { readonly marker: string }>() {}

function directDescriptor(run: ExternalRun) {
  return defineAideCommand({
    id: 'direct-command-boundary:probe',
    route: 'direct-command-boundary-probe',
    summary: 'Direct command boundary probe',
    run: run as () => Effect.Effect<CommandResult, unknown, never>,
  });
}

function failureFromExit(exit: Exit.Exit<unknown, unknown>): unknown {
  if (Exit.isSuccess(exit)) throw new Error('expected failure');
  const failure = Cause.failureOption(exit.cause);
  if (Option.isNone(failure)) throw new Error('expected typed failure');
  return failure.value;
}

describe('public external command Effect semantics', () => {
  test('provides exactly the selected AideHostServicesTag with empty ambient Context and FiberRefs', async () => {
    const services = createAideHostServices(createCommandRegistry());
    const ambientServices = createAideHostServices(createCommandRegistry());
    const fiberRef = FiberRef.unsafeMake('initial');
    const observations: string[] = [];
    const descriptor = directDescriptor(() =>
      Effect.gen(function* () {
        const selected = yield* AideHostServicesTag;
        const ambient = yield* Effect.serviceOption(AmbientCommandService);
        const refValue = yield* FiberRef.get(fiberRef);
        observations.push(
          `${selected === services}:${Option.isNone(ambient)}:${refValue}`
        );
        return textResult('isolated');
      })
    );

    const program = Effect.gen(function* () {
      yield* FiberRef.set(fiberRef, 'outer');
      const result = yield* invokePublicCommandEffect(descriptor, {}, services);
      expect(result).toEqual(textResult('isolated'));
      expect(Object.isFrozen(result)).toBe(true);
      expect(yield* FiberRef.get(fiberRef)).toBe('outer');
      expect(yield* AideHostServicesTag).toBe(ambientServices);
      expect(yield* AmbientCommandService).toEqual({ marker: 'outer' });
    }).pipe(
      Effect.provideService(AideHostServicesTag, ambientServices),
      Effect.provideService(AmbientCommandService, { marker: 'outer' })
    );

    await Effect.runPromise(program);
    expect(observations).toEqual(['true:true:initial']);
  });

  test('preserves typed Fail, Die, Interrupt, and mixed Cause structure', async () => {
    const services = createAideHostServices(createCommandRegistry());
    const typedFailure = Object.freeze({ kind: 'typed-command-failure' });
    const defect = new Error('command-defect-identity');
    const interrupt = Cause.interrupt(FiberId.none);
    const causes = [
      Cause.fail(typedFailure),
      Cause.die(defect),
      interrupt,
      Cause.parallel(Cause.fail(typedFailure), interrupt),
      Cause.sequential(Cause.die(defect), interrupt),
    ] as const;

    for (const cause of causes) {
      const exit = await Effect.runPromiseExit(
        invokePublicCommandEffect(
          directDescriptor(() => Effect.failCause(cause)),
          {},
          services
        )
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isSuccess(exit)) throw new Error('expected Cause failure');
      expect(exit.cause).toEqual(cause);
      for (const failure of Cause.failures(exit.cause)) {
        expect(failure).toBe(typedFailure);
      }
      for (const actualDefect of Cause.defects(exit.cause)) {
        expect(actualDefect).toBe(defect);
      }
    }
  });

  test('forwards interruption and waits for the returned Effect finalizer', async () => {
    const services = createAideHostServices(createCommandRegistry());
    const observations: string[] = [];
    const program = Effect.gen(function* () {
      const acquired = yield* Deferred.make<void>();
      const released = yield* Deferred.make<void>();
      const descriptor = directDescriptor(() =>
        Effect.acquireUseRelease(
          Effect.sync(() => observations.push('acquire')).pipe(
            Effect.tap(() => Deferred.succeed(acquired, undefined))
          ),
          () => Effect.never,
          () =>
            Effect.sync(() => observations.push('release')).pipe(
              Effect.zipRight(Deferred.succeed(released, undefined))
            )
        )
      );
      const fiber = yield* Effect.fork(
        invokePublicCommandEffect(descriptor, {}, services)
      );
      yield* Deferred.await(acquired);
      const interrupted = yield* Fiber.interrupt(fiber);
      expect(Exit.isFailure(interrupted)).toBe(true);
      expect(yield* Deferred.isDone(released)).toBe(true);
    });

    await Effect.runPromise(program);
    expect(observations).toEqual(['acquire', 'release']);
  });

  test('outer timeout joins the returned Effect finalizer exactly once', async () => {
    const services = createAideHostServices(createCommandRegistry());
    let releases = 0;
    const descriptor = directDescriptor(() =>
      Effect.acquireUseRelease(
        Effect.void,
        () => Effect.never,
        () => Effect.sync(() => void (releases += 1))
      )
    );
    const exit = await Effect.runPromiseExit(
      invokePublicCommandEffect(descriptor, {}, services).pipe(
        Effect.timeoutFail({
          duration: '20 millis',
          onTimeout: () => 'command-timeout' as const,
        })
      )
    );

    expect(exit).toEqual(Exit.fail('command-timeout'));
    expect(releases).toBe(1);
  }, 2_000);

  test('returns fresh fixed command-domain errors for every host boundary phase', async () => {
    const services = createAideHostServices(createCommandRegistry());
    const attacker = new Error('SECRET-COMMAND-DOMAIN');
    const callbackExits = await Promise.all([
      Effect.runPromiseExit(
        invokePublicCommandEffect(
          directDescriptor(() => {
            throw attacker;
          }),
          {},
          services
        )
      ),
      Effect.runPromiseExit(
        invokePublicCommandEffect(
          directDescriptor(() => {
            throw attacker;
          }),
          {},
          services
        )
      ),
    ]);
    const invalidExit = await Effect.runPromiseExit(
      invokePublicCommandEffect(
        directDescriptor(() => null),
        {},
        services
      )
    );
    const resultExit = await Effect.runPromiseExit(
      invokePublicCommandEffect(
        directDescriptor(() => Effect.succeed({ _tag: 'Unknown' })),
        {},
        services
      )
    );

    const first = failureFromExit(callbackExits[0]!);
    const second = failureFromExit(callbackExits[1]!);
    const invalid = failureFromExit(invalidExit);
    const result = failureFromExit(resultExit);
    expect(first).toBeInstanceOf(PublicCommandHostError);
    expect(second).toBeInstanceOf(PublicCommandHostError);
    expect(first).not.toBe(second);
    expect(first).toMatchObject({
      _tag: 'PublicCommandHostError',
      reason: 'callback-threw',
      message: 'External command callback threw',
    });
    expect(invalid).toMatchObject({
      reason: 'invalid-effect',
      message: 'External command callback must return an Effect',
    });
    expect(result).toMatchObject({
      reason: 'invalid-result',
      message: 'External command returned an invalid CommandResult',
    });
    expect(exportedErrorText(first as Error)).not.toContain(attacker.message);
    expect(exportedErrorText(second as Error)).not.toContain(attacker.message);
  });
});

describe('host-owned CommandResult snapshots', () => {
  test('copies and freezes valid Text and Empty results', () => {
    const source = textResult('snapshot text');
    const text = snapshotPublicCommandResult(source);
    const empty = snapshotPublicCommandResult(emptyResult);

    expect(text.ok).toBe(true);
    expect(empty.ok).toBe(true);
    if (!text.ok || !empty.ok) throw new Error('expected valid snapshots');
    expect(text.value).toEqual(source);
    expect(text.value).not.toBe(source);
    expect(Object.isFrozen(text.value)).toBe(true);
    expect(empty.value).toEqual(emptyResult);
    expect(empty.value).not.toBe(emptyResult);
    expect(Object.isFrozen(empty.value)).toBe(true);
  });

  test('rejects malformed and unbounded result data', () => {
    class ResultClass {
      readonly _tag = 'Empty';
    }
    const malformed: readonly unknown[] = [
      undefined,
      null,
      'text',
      [],
      new ResultClass(),
      {},
      { _tag: 'Unknown' },
      { _tag: 'Text' },
      { _tag: 'Text', text: 1 },
      { _tag: 'Text', text: 'x'.repeat(65_537) },
    ];

    for (const value of malformed) {
      expect(snapshotPublicCommandResult(value)).toEqual({ ok: false });
    }
  });
});
