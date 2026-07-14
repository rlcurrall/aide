import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineImmutableBuiltinPlugin } from './immutable-builtin-plugin.js';

const fixturePath = fileURLToPath(
  new URL('./test-fixtures/builtin-pr-immutability.fixture.ts', import.meta.url)
);
const children = new Set<ReturnType<typeof Bun.spawn>>();
const temporaryDirectories = new Set<string>();

afterEach(async () => {
  for (const child of children) child.kill('SIGKILL');
  await Promise.allSettled([...children].map((child) => child.exited));
  children.clear();
  await Promise.all(
    [...temporaryDirectories].map((directory) =>
      rm(directory, { force: true, recursive: true })
    )
  );
  temporaryDirectories.clear();
});

async function runFixture(mode: 'before-first' | 'between-registries') {
  const isolatedHome = await mkdtemp(join(tmpdir(), 'aide-pr-freeze-home-'));
  const ghConfig = await mkdtemp(join(tmpdir(), 'aide-pr-freeze-gh-'));
  temporaryDirectories.add(isolatedHome);
  temporaryDirectories.add(ghConfig);
  const env = { ...Bun.env };
  for (const name of [
    'FORCE_COLOR',
    'NO_COLOR',
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'GH_ENTERPRISE_TOKEN',
    'GITHUB_ENTERPRISE_TOKEN',
    'GH_HOST',
  ]) {
    delete env[name];
  }
  Object.assign(env, {
    HOME: isolatedHome,
    GH_CONFIG_DIR: ghConfig,
    AIDE_SECRET_SERVICE_OVERRIDE: `aide-pr-freeze-${process.pid}-${crypto.randomUUID()}`,
  });
  const child = Bun.spawn({
    cmd: [process.execPath, 'run', fixturePath, mode],
    cwd: import.meta.dir,
    env,
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
    Bun.sleep(10_000).then(() => ({ status: 'deadline' as const })),
  ]);
  if (outcome.status === 'deadline') {
    throw new Error(`Built-in immutability ${mode} fixture exceeded deadline`);
  }
  children.delete(child);
  expect(outcome.exitCode).toBe(0);
  expect(outcome.stderr).toBe('');
  return JSON.parse(outcome.stdout) as {
    readonly frozenLayers: Readonly<
      Record<string, Readonly<Record<string, boolean>>>
    >;
    readonly staticUnfrozenContainerPaths: readonly string[];
    readonly factoryFrozenContainerPaths: readonly string[];
    readonly factoryContainersDisjoint: boolean;
    readonly factoryMutationSucceeded: readonly boolean[];
    readonly factoryMutationIsolated: boolean;
    readonly sharedCallbacks: Readonly<Record<string, boolean>>;
    readonly ownedCloneProbe: Readonly<Record<string, boolean | number>>;
    readonly operationMutationSucceeded: boolean;
    readonly diagnosticMutationSucceeded: boolean;
    readonly nestedMutationResults: readonly boolean[];
    readonly registeredOperationIsOriginal: readonly boolean[];
    readonly attackerOperationCalls: number;
    readonly attackerDiagnosticCalls: number;
    readonly rendered: readonly string[];
    readonly leaked: boolean;
  };
}

describe('immutable certified built-in descriptor graphs', () => {
  for (const mode of ['before-first', 'between-registries'] as const) {
    test(`${mode} mutation cannot replace certified operations or diagnostics`, async () => {
      const result = await runFixture(mode);
      for (const layers of Object.values(result.frozenLayers)) {
        expect(Object.values(layers).every(Boolean)).toBe(true);
      }
      expect(result.staticUnfrozenContainerPaths).toEqual([]);
      expect(result.factoryFrozenContainerPaths).toEqual([]);
      expect(result.factoryContainersDisjoint).toBe(true);
      expect(result.factoryMutationSucceeded.every(Boolean)).toBe(true);
      expect(result.factoryMutationIsolated).toBe(true);
      expect(Object.values(result.sharedCallbacks).every(Boolean)).toBe(true);
      expect(result.ownedCloneProbe).toEqual({
        sourceMutable: true,
        cloneDifferent: true,
        cloneFrozen: true,
        nestedDifferent: true,
        nestedFrozen: true,
        cycleRetained: true,
        symbolDifferent: true,
        symbolFrozen: true,
        accessorReads: 0,
        accessorRetained: true,
        callbackShared: true,
        callbackUnfrozen: true,
        callbackPrototypeUnfrozen: true,
      });
      expect(result.operationMutationSucceeded).toBe(false);
      expect(result.diagnosticMutationSucceeded).toBe(false);
      expect(result.nestedMutationResults.every((changed) => !changed)).toBe(
        true
      );
      expect(result.registeredOperationIsOriginal.every(Boolean)).toBe(true);
      expect(result.attackerOperationCalls).toBe(0);
      expect(result.attackerDiagnosticCalls).toBe(0);
      expect(result.leaked).toBe(false);
      for (const rendered of result.rendered) {
        expect(rendered).toContain(
          "GitHub authentication is not configured for 'github.com'"
        );
        expect(rendered).not.toContain('SECRET');
      }
    }, 15_000);
  }

  test('the host immutability helper has no plugin runtime dependency or public export', async () => {
    const helperPath = fileURLToPath(
      new URL('./immutable-builtin-plugin.ts', import.meta.url)
    );
    const pluginApiPath = fileURLToPath(
      new URL('../plugin-api.ts', import.meta.url)
    );
    const [helper, pluginApi] = await Promise.all([
      readFile(helperPath, 'utf8'),
      readFile(pluginApiPath, 'utf8'),
    ]);
    expect(helper).not.toContain('@cli/plugins/');
    expect(pluginApi).not.toContain('immutable-builtin-plugin');
  });

  test('the definition owner clones cycles and symbols without invoking accessors or freezing callbacks', () => {
    const symbol = Symbol('definition');
    let reads = 0;
    function callback() {}
    const definition: {
      self?: unknown;
      nested: { value: number };
      callback: () => void;
      [symbol]: { value: number };
    } = {
      nested: { value: 1 },
      callback,
      [symbol]: { value: 2 },
    };
    definition.self = definition;
    Object.defineProperty(definition, 'accessor', {
      get() {
        reads += 1;
        return 3;
      },
    });
    const owned = defineImmutableBuiltinPlugin(definition);
    expect(owned).not.toBe(definition);
    expect(Object.isFrozen(definition)).toBe(false);
    expect(Object.isFrozen(owned)).toBe(true);
    expect(owned.self).toBe(owned);
    expect(owned.nested).not.toBe(definition.nested);
    expect(Object.isFrozen(owned.nested)).toBe(true);
    expect(owned[symbol]).not.toBe(definition[symbol]);
    expect(Object.isFrozen(owned[symbol])).toBe(true);
    expect(Object.getOwnPropertyDescriptor(owned, 'accessor')?.get).toBe(
      Object.getOwnPropertyDescriptor(definition, 'accessor')?.get
    );
    expect(reads).toBe(0);
    expect(owned.callback).toBe(callback);
    expect(Object.isFrozen(callback)).toBe(false);
    expect(Object.isFrozen(callback.prototype)).toBe(false);
  });
});
