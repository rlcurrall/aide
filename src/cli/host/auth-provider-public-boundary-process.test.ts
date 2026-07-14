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

type Lane = 'source' | 'native';
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

const fixturePath = fileURLToPath(
  new URL(
    './test-fixtures/auth-provider-public-boundary.fixture.ts',
    import.meta.url
  )
);
const children = new Set<ReturnType<typeof Bun.spawn>>();
const nativeFixturePath = `/private/tmp/aide-auth-provider-boundary-${process.pid}`;
const githubCredentialResolverTestPath = fileURLToPath(
  new URL('../../lib/github-credential-resolver.test.ts', import.meta.url)
);
const publicPrResultCaptureTestPath = fileURLToPath(
  new URL('./public-pr-result-capture.test.ts', import.meta.url)
);

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

describe('external auth-provider dangerous subprocess probes', () => {
  test('shared test workers do not mutate Object.prototype or Array.prototype', async () => {
    const sources = await Promise.all([
      readFile(githubCredentialResolverTestPath, 'utf8'),
      readFile(publicPrResultCaptureTestPath, 'utf8'),
    ]);
    for (const source of sources) {
      expect(source).not.toMatch(
        /(?:Object|Reflect)\.defineProperty\(\s*(?:Object|Array)\.prototype/
      );
      expect(source).not.toMatch(
        /Reflect\.deleteProperty\(\s*(?:Object|Array)\.prototype/
      );
    }
  });

  const modes: readonly FixtureMode[] = [
    'non-effect-proxy',
    'revoked-proxy',
    'effect-proxy',
    'forged-instruction',
    'pipe-getter',
    'hostile-composed-output',
    'result-status',
    'result-accounts',
    'result-login',
    'result-logout',
  ];

  for (const mode of modes) {
    for (const lane of ['source', 'native'] as const) {
      test(`${lane} contains ${mode} under a parent-enforced deadline`, async () => {
        const result = await runFixture(mode, [], lane);
        expect(result.exitCode, `${lane}:${mode}`).toBe(0);
        expect(result.stderr, `${lane}:${mode}`).toBe('');
        expect(result.value, `${lane}:${mode}`).toMatchObject({
          ok: true,
          mode,
          safe: true,
          uncaughtExceptions: 0,
          unhandledRejections: 0,
        });
        if (mode === 'forged-instruction') {
          expect(result.value.trapReads, `${lane}:${mode}`).toBe(0);
        }
      }, 4_000);
    }
  }

  const prototypeCases = [
    ['accounts', 'numeric-setter'],
    ['account-metadata', 'numeric-setter'],
    ['account-metadata', 'iterator'],
    ['login', 'numeric-setter'],
    ['logout', 'numeric-setter'],
    ['accounts', 'map'],
    ['accounts', 'filter'],
    ['login', 'some'],
    ['login', 'push'],
    ['logout', 'iterator'],
  ] as const satisfies readonly (readonly [PrototypeSite, PrototypeHook])[];

  for (const lane of ['source', 'native'] as const) {
    test(`${lane} preserves all removed GitHub credential global-prototype controls in an isolated process`, async () => {
      const result = await runFixture('github-credential-prototype', [], lane);
      expect(result.exitCode, lane).toBe(0);
      expect(result.stderr, lane).toBe('');
      expect(result.value, lane).toMatchObject({
        ok: true,
        mode: 'github-credential-prototype',
        safe: true,
        attempts: 2,
        envReflection: 2,
        globalAccountPrototypeMalformedRejection: 2,
        inheritedKeySelection: 2,
        hostOnlyEligibility: 2,
        crossAccountRejection: 2,
        corruptedPayloadRejection: 2,
        restored: true,
        uncaughtExceptions: 0,
        unhandledRejections: 0,
      });
    }, 10_000);

    for (const behavior of ['returning', 'throwing', 'slow'] as const) {
      test(`${lane} auth capture uses early intrinsics under ${behavior} ambient hooks`, async () => {
        for (const hook of [
          'has-own-property',
          'object-has-own',
          'object-get-own-property-descriptor',
          'fields-iterator',
        ] as const satisfies readonly AuthCaptureHook[]) {
          const result = await runFixture(
            'auth-capture-intrinsic',
            [hook, behavior],
            lane
          );
          const label = `${lane}:${hook}:${behavior}`;
          expect(result.exitCode, label).toBe(0);
          expect(result.stderr, label).toBe('');
          expect(result.value, label).toMatchObject({
            ok: true,
            mode: 'auth-capture-intrinsic',
            kind: 'Success',
            safe: true,
            hook,
            behavior,
            attempts: 2,
            scopeSuccess: 2,
            credentialSuccess: 2,
            hookCalls: 0,
            reachabilityCalls: 1,
            restored: true,
            uncaughtExceptions: 0,
            unhandledRejections: 0,
          });
        }
      }, 12_000);
    }

    for (const behavior of ['returning', 'throwing', 'slow'] as const) {
      test(`${lane} auth snapshots ignore ${behavior} inherited Array hooks`, async () => {
        for (const [site, hook] of prototypeCases) {
          const result = await runFixture(
            'prototype-array',
            [site, hook, behavior],
            lane
          );
          const label = `${lane}:${site}:${hook}:${behavior}`;
          expect(result.exitCode, label).toBe(0);
          expect(result.stderr, label).toBe('');
          expect(result.value, label).toMatchObject({
            ok: true,
            mode: 'prototype-array',
            site,
            hook,
            behavior,
            safe: true,
            hookCalls: 0,
            attempts: 2,
            denseFrozen: true,
            restored: true,
            uncaughtExceptions: 0,
            unhandledRejections: 0,
          });
        }
      }, 35_000);
    }
  }
});
