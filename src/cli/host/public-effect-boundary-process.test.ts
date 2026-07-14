import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';
import { unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

type FixtureMode =
  | 'prime-status-proxy'
  | 'prime-strict-sections-proxy'
  | 'prime-tolerant-sections-proxy'
  | 'pr-matcher-proxy'
  | 'pr-operation-proxy'
  | 'forged-instruction'
  | 'prime-message-prototype'
  | 'prime-strict-array-prototype'
  | 'prime-tolerant-array-prototype'
  | 'prime-strict-data-descriptors'
  | 'prime-tolerant-data-descriptors';
type Lane = 'source' | 'native';
type PrimeDescriptorSite =
  | 'array-proxy'
  | 'index-accessor'
  | 'section-proxy'
  | 'field-accessor';

const fixturePath = fileURLToPath(
  new URL('./test-fixtures/public-effect-boundary.fixture.ts', import.meta.url)
);
const children = new Set<ReturnType<typeof Bun.spawn>>();
const nativeFixturePath = `/private/tmp/aide-public-effect-boundary-${process.pid}`;

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

describe('public Effect boundary subprocess probes', () => {
  const expectedKinds: Readonly<Record<FixtureMode, string>> = {
    'prime-status-proxy': 'status-fallback',
    'prime-strict-sections-proxy': 'PrimeContributionError',
    'prime-tolerant-sections-proxy': 'section-dropped',
    'pr-matcher-proxy': 'InvalidPullRequestProviderMatchError',
    'pr-operation-proxy': 'InvalidPullRequestProviderOperationResultError',
    'forged-instruction': 'PrimeContributionError',
    'prime-message-prototype': 'prototype-safe',
    'prime-strict-array-prototype': 'prototype-safe',
    'prime-tolerant-array-prototype': 'prototype-safe',
    'prime-strict-data-descriptors': 'descriptor-safe',
    'prime-tolerant-data-descriptors': 'descriptor-safe',
  };

  const legacyModes = [
    'prime-status-proxy',
    'prime-strict-sections-proxy',
    'prime-tolerant-sections-proxy',
    'pr-matcher-proxy',
    'pr-operation-proxy',
    'forged-instruction',
  ] as const satisfies readonly FixtureMode[];
  for (const lane of ['source', 'native'] as const) {
    for (const mode of legacyModes) {
      test(`${lane} contains ${mode} under a hard deadline`, async () => {
        const result = await runFixture(mode, [], lane);
        expect(result.exitCode, mode).toBe(0);
        expect(result.stderr, mode).toBe('');
        expect(result.value, mode).toMatchObject({
          ok: true,
          mode,
          kind: expectedKinds[mode],
          safe: true,
          uncaughtExceptions: 0,
          unhandledRejections: 0,
        });
        if (mode.endsWith('-proxy')) {
          expect(result.value.instructionReads, mode).toBe(0);
        }
      }, 4_000);
    }
  }

  const descriptorSites = [
    'array-proxy',
    'index-accessor',
    'section-proxy',
    'field-accessor',
  ] as const satisfies readonly PrimeDescriptorSite[];
  for (const lane of ['source', 'native'] as const) {
    for (const behavior of ['returning', 'throwing', 'slow'] as const) {
      test(`${lane} Prime strict/tolerant snapshots never execute ${behavior} hostile getters or traps`, async () => {
        for (const mode of [
          'prime-strict-data-descriptors',
          'prime-tolerant-data-descriptors',
        ] as const) {
          for (const site of descriptorSites) {
            const result = await runFixture(mode, [site, behavior], lane);
            const label = `${lane}:${mode}:${site}:${behavior}`;
            expect(result.exitCode, label).toBe(0);
            expect(result.stderr, label).toBe('');
            expect(result.value, label).toMatchObject({
              ok: true,
              mode,
              kind: 'descriptor-safe',
              site,
              behavior,
              attempts: 2,
              safe: true,
              productionCalls: 0,
              reachabilityCalls: 2,
              defects: 0,
              failureCount: mode === 'prime-strict-data-descriptors' ? 2 : 0,
              denseSanitized: true,
              strictFailuresValid: true,
              tolerantDropped: true,
              attackerRetained: false,
              uncaughtExceptions: 0,
              unhandledRejections: 0,
            });
          }
        }
      }, 20_000);
    }
  }

  for (const lane of ['source', 'native'] as const) {
    for (const behavior of ['returning', 'throwing', 'slow'] as const) {
      test(`${lane} Prime declarations ignore ${behavior} Object prototype setters`, async () => {
        for (const key of [
          'configured',
          'notConfigured',
          'misconfigured',
        ] as const) {
          const result = await runFixture(
            'prime-message-prototype',
            [key, behavior],
            lane
          );
          const label = `${lane}:${key}:${behavior}`;
          expect(result.exitCode, label).toBe(0);
          expect(result.stderr, label).toBe('');
          expect(result.value, label).toMatchObject({
            ok: true,
            mode: 'prime-message-prototype',
            kind: 'prototype-safe',
            key,
            behavior,
            safe: true,
            hookCalls: 0,
            attempts: 2,
            frozenNullPrototype: true,
            atomic: true,
            restored: true,
          });
        }
      }, 15_000);

      test(`${lane} Prime section snapshots ignore ${behavior} inherited numeric setters`, async () => {
        for (const mode of [
          'prime-strict-array-prototype',
          'prime-tolerant-array-prototype',
        ] as const) {
          const result = await runFixture(mode, [behavior], lane);
          const label = `${lane}:${mode}:${behavior}`;
          expect(result.exitCode, label).toBe(0);
          expect(result.stderr, label).toBe('');
          expect(result.value, label).toMatchObject({
            ok: true,
            mode,
            kind: 'prototype-safe',
            behavior,
            safe: true,
            hookCalls: 0,
            attempts: 2,
            denseFrozen: true,
            restored: true,
          });
        }
      }, 10_000);
    }
  }
});
