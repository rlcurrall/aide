import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { authIndexSecretName } from './auth-store.js';

interface FixtureOperation {
  readonly kind: 'write' | 'delete' | 'list';
  readonly providerId: string;
  readonly scope?: Record<string, string>;
  readonly value?: string;
}

interface Scenario {
  readonly root: string;
  readonly store: string;
  readonly events: string;
  readonly locks: string;
  readonly service: string;
}

const fixturePath = fileURLToPath(
  new URL('./auth-store-process.fixture.ts', import.meta.url)
);
const scenarios = new Set<string>();
const children = new Set<ReturnType<typeof Bun.spawn>>();

async function createScenario(): Promise<Scenario> {
  const root = await mkdtemp(join(tmpdir(), 'aide-auth-process-'));
  const store = join(root, 'store');
  const events = join(root, 'events');
  const locks = join(root, 'locks');
  await Promise.all([
    mkdir(store, { mode: 0o700 }),
    mkdir(events, { mode: 0o700 }),
    mkdir(locks, { mode: 0o700 }),
  ]);
  await Promise.all([chmod(root, 0o700), chmod(locks, 0o700)]);
  scenarios.add(root);
  return {
    root,
    store,
    events,
    locks,
    service: `aide-process-${basename(root)}`,
  };
}

function spawnFixture(
  scenario: Scenario,
  id: string,
  operation: FixtureOperation,
  environment: Record<string, string> = {}
) {
  const inheritedEnvironment = { ...Bun.env };
  delete inheritedEnvironment.FORCE_COLOR;
  delete inheritedEnvironment.NO_COLOR;
  const child = Bun.spawn({
    cmd: [process.execPath, 'run', fixturePath, JSON.stringify(operation)],
    cwd: import.meta.dir,
    env: {
      ...inheritedEnvironment,
      AIDE_SECRET_SERVICE_OVERRIDE: scenario.service,
      AIDE_AUTH_INDEX_LOCK_ROOT: scenario.locks,
      AUTH_PROCESS_FIXTURE_STORE_DIR: scenario.store,
      AUTH_PROCESS_FIXTURE_EVENT_DIR: scenario.events,
      AUTH_PROCESS_FIXTURE_ID: id,
      ...environment,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  children.add(child);
  void child.exited.finally(() => children.delete(child));
  return child;
}

async function waitForFile(path: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await Bun.file(path).exists())) {
    if (Date.now() >= deadline)
      throw new Error(`Timed out waiting for ${path}`);
    await Bun.sleep(10);
  }
}

async function waitForLockDirectory(root: string): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const entry = (await readdir(root)).find((name) => name.endsWith('.lock'));
    if (entry !== undefined) return join(root, entry);
    await Bun.sleep(10);
  }
  throw new Error('Timed out waiting for an auth index lock directory.');
}

async function stateWithin(
  child: ReturnType<typeof Bun.spawn>,
  timeoutMs = 300
): Promise<'exited' | 'running'> {
  return Promise.race([
    child.exited.then(() => 'exited' as const),
    Bun.sleep(timeoutMs).then(() => 'running' as const),
  ]);
}

async function finish(child: ReturnType<typeof Bun.spawn>) {
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout as ReadableStream<Uint8Array>).text(),
    new Response(child.stderr as ReadableStream<Uint8Array>).text(),
  ]);
  children.delete(child);
  return {
    exitCode,
    stdout,
    stderr,
    value: stdout.length === 0 ? undefined : JSON.parse(stdout),
  };
}

async function release(scenario: Scenario, id: string): Promise<void> {
  await writeFile(join(scenario.events, `${id}.release`), 'release', {
    mode: 0o600,
  });
}

function storedSecretPath(
  scenario: Scenario,
  name: string,
  service = scenario.service
): string {
  return join(
    scenario.store,
    Buffer.from(`${service}\0${name}`).toString('base64url')
  );
}

async function indexScopes(scenario: Scenario, providerId: string) {
  const raw = await readFile(
    storedSecretPath(scenario, authIndexSecretName(providerId)),
    'utf8'
  );
  return (JSON.parse(raw) as { scopes: readonly Record<string, string>[] })
    .scopes;
}

afterEach(async () => {
  for (const child of children) child.kill('SIGKILL');
  await Promise.allSettled([...children].map((child) => child.exited));
  children.clear();
  await Promise.all(
    [...scenarios].map((root) => rm(root, { recursive: true }))
  );
  scenarios.clear();
});

describe('auth index cross-process critical sections', () => {
  test('does not expose an index-first write to enumeration repair', async () => {
    const scenario = await createScenario();
    const credentialName = 'auth:github:host:github.com:account:alpha' as const;
    const writer = spawnFixture(
      scenario,
      'writer',
      {
        kind: 'write',
        providerId: 'github',
        value: 'ALPHA',
        scope: { host: 'github.com', account: 'alpha' },
      },
      {
        AUTH_PROCESS_FIXTURE_PAUSE_OPERATION: 'set',
        AUTH_PROCESS_FIXTURE_PAUSE_NAME: credentialName,
      }
    );
    await waitForFile(join(scenario.events, 'writer.paused'));

    const reader = spawnFixture(scenario, 'reader', {
      kind: 'list',
      providerId: 'github',
    });
    const readerWhileWriterPaused = await stateWithin(reader);
    await release(scenario, 'writer');

    const [writerResult, readerResult] = await Promise.all([
      finish(writer),
      finish(reader),
    ]);
    expect(readerWhileWriterPaused).toBe('running');
    expect(writerResult).toMatchObject({ exitCode: 0, value: { ok: true } });
    expect(readerResult).toMatchObject({
      exitCode: 0,
      value: {
        ok: true,
        result: [
          { providerId: 'github', host: 'github.com', account: 'alpha' },
        ],
      },
    });
    expect(await indexScopes(scenario, 'github')).toEqual([
      { providerId: 'github', host: 'github.com', account: 'alpha' },
    ]);
  });

  test('serializes canonical aliases so two writers cannot lose an entry', async () => {
    const scenario = await createScenario();
    const indexName = authIndexSecretName('ado');
    const first = spawnFixture(
      scenario,
      'first',
      {
        kind: 'write',
        providerId: 'ado',
        value: 'ALPHA',
        scope: { host: 'dev.azure.com', org: 'alpha' },
      },
      {
        AUTH_PROCESS_FIXTURE_PAUSE_OPERATION: 'get',
        AUTH_PROCESS_FIXTURE_PAUSE_NAME: indexName,
        AUTH_PROCESS_FIXTURE_PAUSE_PHASE: 'after',
      }
    );
    await waitForFile(join(scenario.events, 'first.paused'));

    const second = spawnFixture(scenario, 'second', {
      kind: 'write',
      providerId: 'azure-devops',
      value: 'BRAVO',
      scope: { host: 'dev.azure.com', org: 'bravo' },
    });
    const secondWhileFirstPaused = await stateWithin(second);
    await release(scenario, 'first');

    const [firstResult, secondResult] = await Promise.all([
      finish(first),
      finish(second),
    ]);
    expect(secondWhileFirstPaused).toBe('running');
    expect(firstResult.exitCode).toBe(0);
    expect(secondResult.exitCode).toBe(0);
    expect(await indexScopes(scenario, 'azure-devops')).toEqual([
      {
        providerId: 'azure-devops',
        host: 'dev.azure.com',
        org: 'alpha',
      },
      {
        providerId: 'azure-devops',
        host: 'dev.azure.com',
        org: 'bravo',
      },
    ]);
  });

  test('terminates a compromised owner before its in-flight keyring promise can mutate', async () => {
    const scenario = await createScenario();
    const credentialName =
      'auth:github:host:github.com:account:compromise-test' as const;
    const scope = {
      host: 'github.com',
      account: 'compromise-test',
    } as const;
    const seed = spawnFixture(scenario, 'seed', {
      kind: 'write',
      providerId: 'github',
      value: 'seed-secret-sentinel',
      scope,
    });
    expect((await finish(seed)).exitCode).toBe(0);

    const first = spawnFixture(
      scenario,
      'first-owner',
      {
        kind: 'write',
        providerId: 'github',
        value: 'first-secret-sentinel',
        scope,
      },
      {
        AUTH_PROCESS_FIXTURE_PAUSE_OPERATION: 'set',
        AUTH_PROCESS_FIXTURE_PAUSE_NAME: credentialName,
      }
    );
    await waitForFile(join(scenario.events, 'first-owner.paused'));

    // proper-lockfile probes by rounding the initial directory mtime to the
    // next second. Move past that precision window before replacing it so the
    // first heartbeat cannot mistake the second owner's directory for its own.
    await Bun.sleep(1_200);
    const firstLockDirectory = await waitForLockDirectory(scenario.locks);
    await rename(firstLockDirectory, `${firstLockDirectory}.stolen`);

    const second = spawnFixture(
      scenario,
      'second-owner',
      {
        kind: 'write',
        providerId: 'github',
        value: 'second-secret-sentinel',
        scope,
      },
      {
        AUTH_PROCESS_FIXTURE_PAUSE_OPERATION: 'set',
        AUTH_PROCESS_FIXTURE_PAUSE_NAME: credentialName,
        AUTH_PROCESS_FIXTURE_PAUSE_PHASE: 'after',
      }
    );
    await waitForFile(join(scenario.events, 'second-owner.paused'));
    await waitForLockDirectory(scenario.locks);

    const firstStateAfterHeartbeat = await stateWithin(first, 7_000);
    if (firstStateAfterHeartbeat === 'running') {
      // On the old implementation this proves the compromised process can
      // continue its already-started, non-cancellable keyring promise.
      await release(scenario, 'first-owner');
    }
    const firstResult = await finish(first);
    await release(scenario, 'second-owner');
    const secondResult = await finish(second);
    const storedCredential = await readFile(
      storedSecretPath(scenario, credentialName),
      'utf8'
    );

    expect(secondResult).toMatchObject({ exitCode: 0, value: { ok: true } });
    expect({
      state: firstStateAfterHeartbeat,
      exitCode: firstResult.exitCode,
      storedCredential,
    }).toEqual({
      state: 'exited',
      exitCode: 1,
      storedCredential: 'second-secret-sentinel',
    });
    expect(firstResult.stdout).toBe('');
    expect(firstResult.stderr).toBe(
      'AuthIndexLockCompromisedFatalError: Auth index lock ownership was compromised; terminating safely.\n'
    );
    expect(firstResult.stderr).not.toContain(scenario.root);
    expect(firstResult.stderr).not.toContain('first-secret-sentinel');
    expect(firstResult.stderr).not.toContain('second-secret-sentinel');
    expect(firstResult.stderr).not.toContain('ENOENT');
  }, 20_000);

  test('keeps whole-document compensation from overwriting a successful writer', async () => {
    const scenario = await createScenario();
    const seed = spawnFixture(scenario, 'seed', {
      kind: 'write',
      providerId: 'github',
      value: 'SEED',
      scope: { host: 'github.com', account: 'seed' },
    });
    expect((await finish(seed)).exitCode).toBe(0);

    const failingCredential =
      'auth:github:host:github.com:account:alpha' as const;
    const failingWriter = spawnFixture(
      scenario,
      'failing-writer',
      {
        kind: 'write',
        providerId: 'github',
        value: 'ALPHA',
        scope: { host: 'github.com', account: 'alpha' },
      },
      {
        AUTH_PROCESS_FIXTURE_PAUSE_OPERATION: 'set',
        AUTH_PROCESS_FIXTURE_PAUSE_NAME: failingCredential,
        AUTH_PROCESS_FIXTURE_FAIL_OPERATION: 'set',
        AUTH_PROCESS_FIXTURE_FAIL_NAME: failingCredential,
      }
    );
    await waitForFile(join(scenario.events, 'failing-writer.paused'));

    const successfulWriter = spawnFixture(scenario, 'successful-writer', {
      kind: 'write',
      providerId: 'github',
      value: 'BRAVO',
      scope: { host: 'github.com', account: 'bravo' },
    });
    const successfulWriterWhileRollbackPending =
      await stateWithin(successfulWriter);
    await release(scenario, 'failing-writer');

    const [failed, succeeded] = await Promise.all([
      finish(failingWriter),
      finish(successfulWriter),
    ]);
    expect(successfulWriterWhileRollbackPending).toBe('running');
    expect(failed).toMatchObject({
      exitCode: 2,
      value: {
        ok: false,
        name: 'AuthIndexConsistencyError',
        rollback: 'succeeded',
      },
    });
    expect(succeeded.exitCode).toBe(0);
    expect(await indexScopes(scenario, 'github')).toEqual([
      { providerId: 'github', host: 'github.com', account: 'bravo' },
      { providerId: 'github', host: 'github.com', account: 'seed' },
    ]);
  });

  test('holds enumeration through stale-entry repair before allowing a writer', async () => {
    const scenario = await createScenario();
    const staleCredential =
      'auth:github:host:github.com:account:stale' as const;
    const seed = spawnFixture(scenario, 'seed', {
      kind: 'write',
      providerId: 'github',
      value: 'STALE',
      scope: { host: 'github.com', account: 'stale' },
    });
    expect((await finish(seed)).exitCode).toBe(0);
    await unlink(storedSecretPath(scenario, staleCredential));

    const reader = spawnFixture(
      scenario,
      'repair-reader',
      { kind: 'list', providerId: 'github' },
      {
        AUTH_PROCESS_FIXTURE_PAUSE_OPERATION: 'set',
        AUTH_PROCESS_FIXTURE_PAUSE_NAME: authIndexSecretName('github'),
      }
    );
    await waitForFile(join(scenario.events, 'repair-reader.paused'));

    const writer = spawnFixture(scenario, 'post-repair-writer', {
      kind: 'write',
      providerId: 'github',
      value: 'BRAVO',
      scope: { host: 'github.com', account: 'bravo' },
    });
    const writerWhileRepairPaused = await stateWithin(writer);
    await release(scenario, 'repair-reader');

    const [readerResult, writerResult] = await Promise.all([
      finish(reader),
      finish(writer),
    ]);
    expect(writerWhileRepairPaused).toBe('running');
    expect(readerResult).toMatchObject({
      exitCode: 0,
      value: { ok: true, result: [] },
    });
    expect(writerResult.exitCode).toBe(0);
    expect(await indexScopes(scenario, 'github')).toEqual([
      { providerId: 'github', host: 'github.com', account: 'bravo' },
    ]);
  });

  test('does not make a different canonical provider wait', async () => {
    const scenario = await createScenario();
    const githubCredential =
      'auth:github:host:github.com:account:alpha' as const;
    const githubWriter = spawnFixture(
      scenario,
      'github-writer',
      {
        kind: 'write',
        providerId: 'github',
        value: 'ALPHA',
        scope: { host: 'github.com', account: 'alpha' },
      },
      {
        AUTH_PROCESS_FIXTURE_PAUSE_OPERATION: 'set',
        AUTH_PROCESS_FIXTURE_PAUSE_NAME: githubCredential,
      }
    );
    await waitForFile(join(scenario.events, 'github-writer.paused'));

    const jiraWriter = spawnFixture(scenario, 'jira-writer', {
      kind: 'write',
      providerId: 'jira',
      value: 'JIRA',
      scope: { host: 'jira.example.com', account: 'dev@example.com' },
    });
    const jiraState = await stateWithin(jiraWriter, 1_000);
    const jiraResult = await finish(jiraWriter);
    await release(scenario, 'github-writer');
    const githubResult = await finish(githubWriter);

    expect(jiraState).toBe('exited');
    expect(jiraResult.exitCode).toBe(0);
    expect(githubResult.exitCode).toBe(0);
  });
});
