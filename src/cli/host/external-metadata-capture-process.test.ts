import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';
import { readFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

type FixtureMode =
  | 'commands-iterator'
  | 'route-iterator'
  | 'route-prototype'
  | 'prototype-semantic'
  | 'registry-prototype-semantic'
  | 'yargs-inner-lifecycle'
  | 'yargs-lifecycle-normal';
type Lane = 'source' | 'native';
type PrototypeConfigurability = 'configurable' | 'nonconfigurable';
type PrototypeHook =
  | 'numeric-setter'
  | 'map'
  | 'filter'
  | 'some'
  | 'push'
  | 'iterator';
type RegistryPrototypeHook =
  | 'reserved-includes'
  | 'object-has-own-property'
  | 'function-call';
type InnerLifecycleTiming = 'nested-builder' | 'handler';

const fixturePath = fileURLToPath(
  new URL(
    './test-fixtures/external-metadata-capture.fixture.ts',
    import.meta.url
  )
);
const children = new Set<ReturnType<typeof Bun.spawn>>();
const nativeFixturePath = `/private/tmp/aide-external-metadata-${process.pid}`;
const pluginApiPath = fileURLToPath(
  new URL('../plugin-api.ts', import.meta.url)
);
const registryPath = fileURLToPath(
  new URL('./command-registry.ts', import.meta.url)
);

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

function prototypeProperty(hook: PrototypeHook): PropertyKey {
  return hook === 'numeric-setter'
    ? '0'
    : hook === 'iterator'
      ? Symbol.iterator
      : hook;
}

beforeAll(async () => {
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      'build',
      '--compile',
      '--target=bun-darwin-arm64',
      fixturePath,
      '--outfile',
      nativeFixturePath,
    ],
    cwd: import.meta.dir,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  children.add(child);
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout as ReadableStream<Uint8Array>).text(),
    new Response(child.stderr as ReadableStream<Uint8Array>).text(),
  ]);
  children.delete(child);
  expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
}, 30_000);

afterAll(async () => {
  try {
    await unlink(nativeFixturePath);
  } catch (error) {
    if (
      typeof error !== 'object' ||
      error === null ||
      !('code' in error) ||
      error.code !== 'ENOENT'
    ) {
      throw error;
    }
  }
});

afterEach(async () => {
  for (const child of children) child.kill('SIGKILL');
  await Promise.allSettled([...children].map((child) => child.exited));
  children.clear();
});

async function runFixture(
  mode: FixtureMode,
  args: readonly string[] = [],
  lane: Lane = 'source'
) {
  const environment = { ...Bun.env };
  delete environment.FORCE_COLOR;
  delete environment.NO_COLOR;
  const child = Bun.spawn({
    cmd:
      lane === 'source'
        ? [process.execPath, 'run', fixturePath, mode, ...args]
        : [nativeFixturePath, mode, ...args],
    cwd: import.meta.dir,
    env: environment,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  children.add(child);

  const outcome = await Promise.race([
    Promise.all([
      child.exited,
      new Response(child.stdout as ReadableStream<Uint8Array>).text(),
      new Response(child.stderr as ReadableStream<Uint8Array>).text(),
    ]).then(([exitCode, stdout, stderr]) => ({
      status: 'exited' as const,
      exitCode,
      stdout,
      stderr,
    })),
    Bun.sleep(2_000).then(() => ({ status: 'deadline' as const })),
  ]);
  if (outcome.status === 'deadline') {
    child.kill('SIGKILL');
    await child.exited;
    children.delete(child);
    throw new Error(`Fixture '${mode}' exceeded its hard deadline`);
  }
  children.delete(child);
  return {
    ...outcome,
    value: JSON.parse(outcome.stdout.trim()) as Record<string, unknown>,
  };
}

describe('external metadata subprocess hard-deadline probes', () => {
  test('source invariant: reserved ids and registry own-data checks have no ambient prototype dispatch', async () => {
    const [pluginApiSource, registrySource] = await Promise.all([
      readFile(pluginApiPath, 'utf8'),
      readFile(registryPath, 'utf8'),
    ]);
    expect(pluginApiSource).not.toContain('aideReservedPluginIds.includes');
    expect(pluginApiSource).not.toContain(
      'aideReservedPullRequestProviderIds.includes'
    );
    expect(pluginApiSource).not.toContain(
      'aideReservedAuthProviderIds.includes'
    );
    expect(registrySource).not.toContain('Object.prototype.hasOwnProperty');
    expect(registrySource).not.toContain('Function.prototype.call');
    expect(registrySource).toContain('const hasOwn = Object.hasOwn;');
  });

  for (const lane of ['source', 'native'] as const) {
    for (const mode of [
      'commands-iterator',
      'route-iterator',
      'route-prototype',
    ] as const) {
      test(`${lane} contains ${mode} under a hard deadline`, async () => {
        const result = await runFixture(mode, [], lane);
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe('');
        expect(result.value).toEqual({
          mode,
          safe: true,
          trapCalls: 0,
          pluginCount: mode === 'route-prototype' ? 0 : 1,
          commandCount: mode === 'route-prototype' ? 0 : 1,
        });
      }, 4_000);
    }
  }

  for (const lane of ['source', 'native'] as const) {
    test(`${lane} preserves normal recursive aliases, help, parse, and dispatch twice`, async () => {
      const result = await runFixture('yargs-lifecycle-normal', [], lane);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.value).toEqual({
        mode: 'yargs-lifecycle-normal',
        trapCalls: 0,
        safe: true,
        attempts: 2,
        registered: 2,
        helped: 2,
        dispatched: 2,
        shown: 2,
        receiverReturns: 2,
        synchronousReturns: 4,
        promiseReturns: 4,
        parseCallbacks: 2,
        ordinaryArrays: true,
      });
    }, 10_000);

    for (const configurability of [
      'configurable',
      'nonconfigurable',
    ] as const satisfies readonly PrototypeConfigurability[]) {
      for (const behavior of ['returning', 'throwing', 'slow'] as const) {
        test(`${lane} fails closed for ${configurability} ${behavior} inherited Array semantics`, async () => {
          for (const hook of [
            'numeric-setter',
            'map',
            'filter',
            'some',
            'push',
            'iterator',
          ] as const satisfies readonly PrototypeHook[]) {
            const property = prototypeProperty(hook);
            const parentDescriptor = Reflect.getOwnPropertyDescriptor(
              Array.prototype,
              property
            );
            const result = await runFixture(
              'prototype-semantic',
              [hook, behavior, configurability],
              lane
            );
            const label = `${lane}:${hook}:${behavior}:${configurability}`;
            expect(result.exitCode, label).toBe(0);
            expect(result.stderr, label).toBe('');
            expect(result.value, label).toMatchObject({
              mode: 'prototype-semantic',
              hook,
              behavior,
              configurability,
              safe: true,
              trapCalls: 0,
              attempts: 2,
              registered: 2,
              replayed: 2,
              collisions: 2,
              atomic: true,
              denseFrozen: true,
              failureCount: 12,
              fixedFailures: true,
              freshFailures: true,
              noExternalRetention: true,
              outsideCallbackCalls: 0,
              descriptorUnchanged: true,
              restored:
                configurability === 'configurable' ? true : 'process-isolated',
            });
            expect(
              descriptorsEqual(
                Reflect.getOwnPropertyDescriptor(Array.prototype, property),
                parentDescriptor
              ),
              `${label}:parent descriptor`
            ).toBe(true);
          }
        }, 30_000);
      }
    }
  }

  for (const lane of ['source', 'native'] as const) {
    for (const configurability of [
      'configurable',
      'nonconfigurable',
    ] as const satisfies readonly PrototypeConfigurability[]) {
      for (const behavior of ['returning', 'throwing', 'slow'] as const) {
        test(`${lane} avoids ${configurability} ${behavior} registry prototype hooks`, async () => {
          for (const hook of [
            'reserved-includes',
            'object-has-own-property',
            'function-call',
          ] as const satisfies readonly RegistryPrototypeHook[]) {
            const result = await runFixture(
              'registry-prototype-semantic',
              [hook, behavior, configurability],
              lane
            );
            const label = `${lane}:${hook}:${behavior}:${configurability}`;
            expect(result.exitCode, label).toBe(0);
            expect(result.stderr, label).toBe('');
            expect(result.value, label).toMatchObject({
              mode: 'registry-prototype-semantic',
              hook,
              behavior,
              configurability,
              safe: true,
              trapCalls: 0,
              outsideAccessorCalls: 0,
              attempts: 2,
              registered: 2,
              replayed: 2,
              collisions: 2,
              atomic: true,
              fixedFailures: true,
              freshFailures: true,
              noExternalRetention: true,
              descriptorUnchanged: true,
              restored:
                configurability === 'configurable' ? true : 'process-isolated',
            });
          }
        }, 15_000);
      }
    }

    for (const configurability of [
      'configurable',
      'nonconfigurable',
    ] as const satisfies readonly PrototypeConfigurability[]) {
      for (const timing of [
        'nested-builder',
        'handler',
      ] as const satisfies readonly InnerLifecycleTiming[]) {
        test(`${lane} fails at the guarded inner ${timing} boundary for ${configurability} divergence twice`, async () => {
          const parentDescriptor = Reflect.getOwnPropertyDescriptor(
            Array.prototype,
            '997'
          );
          for (let attempt = 0; attempt < 2; attempt += 1) {
            const result = await runFixture(
              'yargs-inner-lifecycle',
              [timing, configurability],
              lane
            );
            const label = `${lane}:${timing}:${configurability}:${attempt}`;
            expect(result.exitCode, label).toBe(0);
            expect(result.stderr, label).toBe('');
            expect(result.value, label).toMatchObject({
              mode: 'yargs-inner-lifecycle',
              timing,
              configurability,
              safe: true,
              parentBuilderCalls: 1,
              nestedBuilderCalls: 0,
              handlerCalls: 0,
              fixedFailure: true,
              descriptorUnchanged: true,
              restored:
                configurability === 'configurable' ? true : 'process-isolated',
            });
            expect(
              descriptorsEqual(
                Reflect.getOwnPropertyDescriptor(Array.prototype, '997'),
                parentDescriptor
              ),
              `${label}:parent descriptor`
            ).toBe(true);
          }
        }, 10_000);
      }
    }
  }
});
