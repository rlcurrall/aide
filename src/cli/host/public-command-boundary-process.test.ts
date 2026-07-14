import { afterEach, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

type FixtureMode =
  | 'sync-throw'
  | 'non-effect-proxy'
  | 'revoked-effect-proxy'
  | 'result-proxy'
  | 'result-accessor'
  | 'timeout-finalizer';

const fixturePath = fileURLToPath(
  new URL('./test-fixtures/public-command-boundary.fixture.ts', import.meta.url)
);
const children = new Set<ReturnType<typeof Bun.spawn>>();

afterEach(async () => {
  for (const child of children) child.kill('SIGKILL');
  await Promise.allSettled([...children].map((child) => child.exited));
  children.clear();
});

async function runFixture(mode: FixtureMode) {
  const environment = { ...Bun.env };
  delete environment.FORCE_COLOR;
  delete environment.NO_COLOR;
  const child = Bun.spawn({
    cmd: [process.execPath, 'run', fixturePath, mode],
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

describe('public external command subprocess hard-deadline probes', () => {
  const modes: readonly FixtureMode[] = [
    'sync-throw',
    'non-effect-proxy',
    'revoked-effect-proxy',
    'result-proxy',
    'result-accessor',
    'timeout-finalizer',
  ];

  for (const mode of modes) {
    test(`contains ${mode} under a hard deadline`, async () => {
      const result = await runFixture(mode);
      expect(result.exitCode, mode).toBe(0);
      expect(result.stderr, mode).toBe('');
      expect(result.value, mode).toMatchObject({
        ok: true,
        mode,
        safe: true,
        uncaughtExceptions: 0,
        unhandledRejections: 0,
      });
      if (mode !== 'timeout-finalizer') {
        expect(result.value.trapReads, mode).toBe(0);
      }
      if (mode === 'timeout-finalizer') {
        expect(result.value.releases, mode).toBe(1);
      }
    }, 4_000);
  }
});
