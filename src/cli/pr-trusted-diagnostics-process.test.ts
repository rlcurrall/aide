import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('./index.ts', import.meta.url));
const externalFixturePath = fileURLToPath(
  new URL('./host/test-fixtures/external-pr-yargs.fixture.ts', import.meta.url)
);
const diagnosticAuthorityFixturePath = fileURLToPath(
  new URL(
    './host/test-fixtures/pr-diagnostic-authority.fixture.ts',
    import.meta.url
  )
);
const wrapperDiagnosticFixturePath = fileURLToPath(
  new URL(
    './host/test-fixtures/pr-wrapper-diagnostic.fixture.ts',
    import.meta.url
  )
);
const hostDiagnosticsYargsFixturePath = fileURLToPath(
  new URL(
    './host/test-fixtures/host-pr-diagnostics-yargs.fixture.ts',
    import.meta.url
  )
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

async function runUnauthenticatedSource(
  args: readonly string[],
  cwd: string = import.meta.dir
) {
  const isolatedHome = await mkdtemp(join(tmpdir(), 'aide-pr-diag-home-'));
  const ghConfig = await mkdtemp(join(tmpdir(), 'aide-pr-diag-gh-'));
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
    'AZURE_DEVOPS_ORG_URL',
    'AZURE_DEVOPS_PAT',
    'AZURE_DEVOPS_AUTH_METHOD',
    'AZURE_DEVOPS_DEFAULT_PROJECT',
  ]) {
    delete env[name];
  }
  Object.assign(env, {
    HOME: isolatedHome,
    GH_CONFIG_DIR: ghConfig,
    AIDE_SECRET_SERVICE_OVERRIDE: `aide-pr-diag-${process.pid}-${crypto.randomUUID()}`,
  });
  const child = Bun.spawn({
    cmd: [process.execPath, 'run', cliPath, ...args],
    cwd,
    env,
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
  return { exitCode, stdout, stderr };
}

describe('trusted PR diagnostics through the real source CLI', () => {
  for (const command of [
    [
      'pr',
      'list',
      '--provider',
      'github',
      '--owner',
      'openai',
      '--repo',
      'aide',
      '--limit',
      '1',
      '--format',
      'json',
    ],
    ['pr', 'view', '--format', 'json'],
  ] as const) {
    test(`${command[1]} renders host-owned GitHub authentication guidance`, async () => {
      const result = await runUnauthenticatedSource(command);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).not.toContain('GitHub authentication');
      expect(result.stderr).toContain(
        "GitHub authentication is not configured for 'github.com'"
      );
      expect(result.stderr).toContain('gh auth login --hostname github.com');
      expect(result.stderr).toContain('aide login github');
      expect(result.stderr).toContain('GITHUB_TOKEN or GH_TOKEN');
    }, 10_000);
  }

  test('list preserves host-owned Azure DevOps configuration guidance', async () => {
    const result = await runUnauthenticatedSource([
      'pr',
      'list',
      '--provider',
      'azure-devops',
      '--org',
      'example',
      '--project',
      'widgets',
      '--repo',
      'api',
      '--limit',
      '1',
      '--format',
      'json',
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Azure DevOps is not configured');
    expect(
      result.stderr.includes("Run 'aide login ado'") ||
        result.stderr.includes('keyring is unreachable')
    ).toBe(true);
    expect(result.stderr).toContain('AZURE_DEVOPS_ORG_URL');
    expect(result.stderr).toContain('AZURE_DEVOPS_PAT');
  }, 10_000);

  for (const testCase of [
    {
      name: 'non-secret URL',
      remote: 'ssh://example.invalid/owner/repo.git',
      descriptor: 'ssh://example.invalid/owner/repo.git',
      secrets: [],
    },
    {
      name: 'HTTPS userinfo, query, and fragment',
      remote:
        'https://TODO160-CLI-USER:TODO160-CLI-PASSWORD@example.invalid/owner/repo.git?token=TODO160-CLI-QUERY#TODO160-CLI-FRAGMENT',
      descriptor: 'https://example.invalid/owner/repo.git',
      secrets: [
        'TODO160-CLI-USER',
        'TODO160-CLI-PASSWORD',
        'TODO160-CLI-QUERY',
        'TODO160-CLI-FRAGMENT',
      ],
    },
    {
      name: 'SCP-like userinfo, query, and fragment',
      remote:
        'TODO160-SCP-USER@example.invalid:owner/repo.git?token=TODO160-SCP-QUERY#TODO160-SCP-FRAGMENT',
      descriptor: 'example.invalid:owner/repo.git',
      secrets: [
        'TODO160-SCP-USER',
        'TODO160-SCP-QUERY',
        'TODO160-SCP-FRAGMENT',
      ],
    },
    {
      name: 'SCP-like nested userinfo in the retained path',
      remote:
        'TODO160-SCP-OUTER-USER@example.invalid:org/TODO160-SCP-INNER-USER:TODO160-SCP-INNER-PASSWORD@inner.invalid/repo.git',
      descriptor: '<redacted>',
      secrets: [
        'TODO160-SCP-OUTER-USER',
        'TODO160-SCP-INNER-USER',
        'TODO160-SCP-INNER-PASSWORD',
      ],
    },
    {
      name: 'SCP-like colon-delimited password-like path text',
      remote:
        'TODO160-SCP-COLON-OUTER@example.invalid:org:TODO160-SCP-COLON-PASSWORD/repo.git',
      descriptor: '<redacted>',
      secrets: ['TODO160-SCP-COLON-OUTER', 'TODO160-SCP-COLON-PASSWORD'],
    },
    {
      name: 'SCP-like nested scheme text',
      remote:
        'TODO160-SCP-SCHEME-OUTER@example.invalid:org/ssh:TODO160-SCP-SCHEME-USER:TODO160-SCP-SCHEME-PASSWORD@inner.invalid/repo.git',
      descriptor: '<redacted>',
      secrets: [
        'TODO160-SCP-SCHEME-OUTER',
        'TODO160-SCP-SCHEME-USER',
        'TODO160-SCP-SCHEME-PASSWORD',
      ],
    },
    {
      name: 'SCP-like nested URL text',
      remote:
        'TODO160-SCP-URL-OUTER@example.invalid:org/https://TODO160-SCP-URL-USER:TODO160-SCP-URL-PASSWORD@inner.invalid/repo.git',
      descriptor: '<redacted>',
      secrets: [
        'TODO160-SCP-URL-OUTER',
        'TODO160-SCP-URL-USER',
        'TODO160-SCP-URL-PASSWORD',
      ],
    },
    {
      name: 'SCP-like nested IPv6 and userinfo delimiters',
      remote:
        'TODO160-SCP-IPV6-OUTER@[2001:db8::1]:org/TODO160-SCP-IPV6-USER:TODO160-SCP-IPV6-PASSWORD@[2001:db8::2]/repo.git',
      descriptor: '<redacted>',
      secrets: [
        'TODO160-SCP-IPV6-OUTER',
        'TODO160-SCP-IPV6-USER',
        'TODO160-SCP-IPV6-PASSWORD',
      ],
    },
    {
      name: 'SCP-like mixed at-sign and colon path delimiters',
      remote:
        'TODO160-SCP-MIXED-OUTER@example.invalid:org/@TODO160-SCP-MIXED-USER:TODO160-SCP-MIXED-PASSWORD:TODO160-SCP-MIXED-TOKEN/repo.git',
      descriptor: '<redacted>',
      secrets: [
        'TODO160-SCP-MIXED-OUTER',
        'TODO160-SCP-MIXED-USER',
        'TODO160-SCP-MIXED-PASSWORD',
        'TODO160-SCP-MIXED-TOKEN',
      ],
    },
    {
      name: 'malformed credential-bearing URL',
      remote: 'https://todo160-user:TODO160-MALFORMED-PASSWORD@',
      descriptor: '<redacted>',
      secrets: ['todo160-user', 'TODO160-MALFORMED-PASSWORD'],
    },
    {
      name: 'comment 241 truncated HTTPS authority',
      remote:
        'https:outer.invalid/org/RECERT_INNER_USER:RECERT_INNER_PASSWORD@inner.invalid/repo.git',
      descriptor: '<redacted>',
      secrets: ['RECERT_INNER_USER', 'RECERT_INNER_PASSWORD'],
    },
    {
      name: 'comment 241 HTTPS authority backslash',
      remote:
        'https://outer.invalid\\@RECERT_INNER_USER:RECERT_INNER_PASSWORD@inner.invalid/repo.git',
      descriptor: '<redacted>',
      secrets: ['RECERT_INNER_USER', 'RECERT_INNER_PASSWORD'],
    },
    {
      name: 'comment 243 malformed DNS host',
      remote:
        'https://example..invalid/org/CERT_DNS_USER:CERT_DNS_PASSWORD@inner.invalid/repo.git',
      descriptor: '<redacted>',
      secrets: ['CERT_DNS_USER', 'CERT_DNS_PASSWORD'],
    },
    {
      name: 'comment 243 octal IPv4 host',
      remote:
        'https://0177.0.0.1/org/CERT_OCTAL_USER:CERT_OCTAL_PASSWORD@inner.invalid/repo.git',
      descriptor: '<redacted>',
      secrets: ['CERT_OCTAL_USER', 'CERT_OCTAL_PASSWORD'],
    },
    {
      name: 'canonical IPv4 host and port',
      remote: 'https://127.0.0.1:8443/owner/repo.git',
      descriptor: 'https://127.0.0.1:8443/owner/repo.git',
      secrets: [],
    },
    {
      name: 'Unicode IDNA host',
      remote: 'https://bücher.example/owner/repo.git',
      descriptor: 'https://xn--bcher-kva.example/owner/repo.git',
      secrets: [],
    },
    {
      name: 'missing URL authority slash',
      remote:
        'ssh:/outer.invalid/org/TODO160-CLI-SLASH-USER:TODO160-CLI-SLASH-PASSWORD@inner.invalid/repo.git',
      descriptor: '<redacted>',
      secrets: ['TODO160-CLI-SLASH-USER', 'TODO160-CLI-SLASH-PASSWORD'],
    },
    {
      name: 'extra URL authority slash',
      remote:
        'git:///outer.invalid/org/TODO160-CLI-EXTRA-USER:TODO160-CLI-EXTRA-PASSWORD@inner.invalid/repo.git',
      descriptor: '<redacted>',
      secrets: ['TODO160-CLI-EXTRA-USER', 'TODO160-CLI-EXTRA-PASSWORD'],
    },
    {
      name: 'malformed bracketed SCP IPv6 host',
      remote: 'git@[::::]:owner/repo.git',
      descriptor: '<redacted>',
      secrets: [],
    },
  ] as const) {
    test(`unsupported ${testCase.name} uses a redacted descriptor and exit 1`, async () => {
      const repository = await mkdtemp(
        join(tmpdir(), 'aide-pr-unsupported-remote-')
      );
      temporaryDirectories.add(repository);
      const initialized = Bun.spawnSync({
        cmd: ['git', 'init'],
        cwd: repository,
        stdout: 'ignore',
        stderr: 'pipe',
      });
      expect(initialized.exitCode).toBe(0);
      const added = Bun.spawnSync({
        cmd: ['git', 'remote', 'add', 'origin', testCase.remote],
        cwd: repository,
        stdout: 'ignore',
        stderr: 'pipe',
      });
      expect(added.exitCode).toBe(0);

      const result = await runUnauthenticatedSource(
        ['pr', 'list', '--format', 'json'],
        repository
      );
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe(
        `Error: No pull request provider matched git-remote: ${testCase.descriptor}\n`
      );
      for (const secret of testCase.secrets) {
        expect(result.stderr).not.toContain(secret);
      }
    }, 10_000);
  }
});

describe('host PR diagnostics through a real yargs handoff', () => {
  const expected = {
    unsupported:
      'No pull request provider matched git-remote: https://example.invalid/owner/widgets.git',
    ambiguous:
      'Multiple pull request providers matched git-remote: https://example.invalid/owner/widgets.git (ambiguous-a-plugin/ambiguous-a, ambiguous-b-plugin/ambiguous-b)',
    'invalid-matcher':
      "Pull request provider 'invalid-matcher' from plugin 'invalid-matcher-plugin' returned invalid git-remote match for https://example.invalid/owner/widgets.git: match result failed structural capture",
    invocation:
      "Pull request provider 'invocation' from plugin 'invocation-plugin' failed while matching git-remote https://example.invalid/owner/widgets.git",
    'invalid-result':
      "Pull request provider 'invalid-result' from plugin 'invalid-result-plugin' returned invalid listPullRequests result: operation result failed structural capture",
    'unsupported-operation':
      "Pull request provider 'unsupported-operation' from plugin 'unsupported-operation-plugin' does not implement listPullRequests",
    'matcher-timeout':
      "Pull request provider 'matcher-timeout' from plugin 'matcher-timeout-plugin' timed out while matching repository-ref provider=matcher-timeout repo=https://example.invalid/owner/widgets.git",
    'operation-timeout':
      "Pull request provider 'operation-timeout' from plugin 'operation-timeout-plugin' timed out during listPullRequests",
    'mutation-indeterminate':
      "Pull request mutation outcome is indeterminate for provider 'mutation-indeterminate' from plugin 'mutation-indeterminate-plugin' during createPullRequest: the operation may have succeeded; do not retry blindly. Verify the remote state before taking further action.",
  } as const;

  for (const [mode, message] of Object.entries(expected)) {
    test(`${mode} renders its exact captured host diagnostic with exit 1`, async () => {
      const env = { ...Bun.env };
      delete env.FORCE_COLOR;
      delete env.NO_COLOR;
      const child = Bun.spawn({
        cmd: [process.execPath, 'run', hostDiagnosticsYargsFixturePath, mode],
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
        Bun.sleep(2_000).then(() => ({ status: 'deadline' as const })),
      ]);
      if (outcome.status === 'deadline') {
        throw new Error(`Host yargs ${mode} fixture exceeded its deadline`);
      }
      children.delete(child);
      expect(outcome.exitCode).toBe(1);
      expect(outcome.stdout).toBe('');
      expect(outcome.stderr).toBe(`Error: ${message}\n`);
      expect(outcome.stderr).not.toContain('TODO160');
    }, 4_000);
  }
});

describe('external PR failures through real yargs/Effect rendering', () => {
  for (const mode of ['accessor', 'proxy', 'forged-class'] as const) {
    test(`${mode} failures remain fixed and cause-independent`, async () => {
      const env = { ...Bun.env };
      delete env.FORCE_COLOR;
      delete env.NO_COLOR;
      const child = Bun.spawn({
        cmd: [process.execPath, 'run', externalFixturePath, mode],
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
        Bun.sleep(2_000).then(() => ({ status: 'deadline' as const })),
      ]);
      if (outcome.status === 'deadline') {
        throw new Error(`External yargs ${mode} fixture exceeded its deadline`);
      }
      children.delete(child);
      expect(outcome.exitCode).toBe(1);
      expect(outcome.stdout).toBe('');
      expect(outcome.stderr).toBe(
        "Error: Pull request provider 'external-yargs' from plugin 'external-pr-yargs' failed during listPullRequests\n"
      );
      expect(outcome.stderr).not.toContain('SECRET');
    }, 4_000);
  }
});

describe('raw trusted PR diagnostic authority hard deadline', () => {
  test('never invokes a forged hanging formatter Proxy', async () => {
    const env = { ...Bun.env };
    delete env.FORCE_COLOR;
    delete env.NO_COLOR;
    const child = Bun.spawn({
      cmd: [process.execPath, 'run', diagnosticAuthorityFixturePath],
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
      Bun.sleep(2_000).then(() => ({ status: 'deadline' as const })),
    ]);
    if (outcome.status === 'deadline') {
      throw new Error('Raw diagnostic authority fixture exceeded its deadline');
    }
    children.delete(child);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stderr).toBe('');
    expect(outcome.stdout).toBe(
      "Error: Pull request provider 'raw-hanging-diagnostic' from plugin 'raw-hanging-diagnostic' failed during listPullRequests\n"
    );
    expect(outcome.stdout).not.toContain('SECRET');
  }, 4_000);
});

describe('direct exported PR resolver errors through both renderers', () => {
  test('all misses stay generic, zero-read, and under the hard deadline', async () => {
    const env = { ...Bun.env };
    delete env.FORCE_COLOR;
    delete env.NO_COLOR;
    const child = Bun.spawn({
      cmd: [process.execPath, 'run', wrapperDiagnosticFixturePath],
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
      Bun.sleep(2_000).then(() => ({ status: 'deadline' as const })),
    ]);
    if (outcome.status === 'deadline') {
      throw new Error('Direct PR renderer fixture exceeded its deadline');
    }
    children.delete(child);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stderr).toBe('');
    expect(JSON.parse(outcome.stdout)).toEqual({
      count: 25,
      topLevelGeneric: true,
      handledGeneric: true,
      reads: 0,
      leaked: false,
    });
  }, 4_000);
});
