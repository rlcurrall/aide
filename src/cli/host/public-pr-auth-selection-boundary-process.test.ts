import { afterEach, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

type Mode =
  | 'request-own-scope'
  | 'request-own-selector'
  | 'request-accessor-scope'
  | 'request-accessor-selector'
  | 'request-live-proxy'
  | 'request-revoked-proxy'
  | 'options-own-scope'
  | 'options-own-selector'
  | 'options-accessor-scope'
  | 'options-accessor-selector'
  | 'options-live-proxy'
  | 'options-revoked-proxy'
  | 'request-inherited-scope'
  | 'request-inherited-selector'
  | 'options-inherited-scope'
  | 'options-inherited-selector'
  | 'prototype-selector-return'
  | 'prototype-selector-throw'
  | 'prototype-selector-slow'
  | 'prototype-auth-scope'
  | 'prototype-auth-scope-getter'
  | 'prototype-selection-timeout'
  | 'prototype-preferred'
  | 'prototype-matcher-timeout'
  | 'prototype-resolution-own-control'
  | 'prototype-identity';

type Surface =
  | 'initial'
  | 'bound'
  | 'resolve-remote'
  | 'resolve-url'
  | 'resolve-repository'
  | 'resolve-repository-input'
  | 'builtin-github'
  | 'builtin-github-control'
  | 'ambient-nine-public'
  | 'ambient-nine-selected'
  | 'ambient-bound-all';

const fixturePath = fileURLToPath(
  new URL(
    './test-fixtures/public-pr-auth-selection-boundary.fixture.ts',
    import.meta.url
  )
);
const children = new Set<ReturnType<typeof Bun.spawn>>();

afterEach(async () => {
  for (const child of children) child.kill('SIGKILL');
  await Promise.allSettled([...children].map((child) => child.exited));
  children.clear();
});

async function runFixture(surface: Surface, mode: Mode) {
  const environment: Record<string, string | undefined> = {
    ...Bun.env,
    HOME: '/private/tmp/aide-todo147-disabled-home',
    GH_CONFIG_DIR: '/private/tmp/aide-todo147-disabled-gh',
    NO_COLOR: '1',
    PATH: '',
  };
  for (const name of [
    'AIDE_SECRET_SERVICE_OVERRIDE',
    'FORCE_COLOR',
    'GH_ENTERPRISE_TOKEN',
    'GH_HOST',
    'GH_TOKEN',
    'GITHUB_ENTERPRISE_TOKEN',
    'GITHUB_TOKEN',
  ]) {
    delete environment[name];
  }
  const child = Bun.spawn({
    cmd: [process.execPath, 'run', fixturePath, surface, mode],
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
      kind: 'exit' as const,
      exitCode,
      stdout,
      stderr,
    })),
    Bun.sleep(2_000).then(() => ({ kind: 'timeout' as const })),
  ]);
  if (outcome.kind === 'timeout') {
    child.kill('SIGKILL');
    await child.exited;
    children.delete(child);
    throw new Error(`fixture ${surface}/${mode} exceeded its hard deadline`);
  }
  children.delete(child);
  return {
    ...outcome,
    value: JSON.parse(outcome.stdout.trim()) as Record<string, unknown>,
  };
}

const hostileModes = [
  'request-own-scope',
  'request-own-selector',
  'request-accessor-scope',
  'request-accessor-selector',
  'request-live-proxy',
  'request-revoked-proxy',
  'options-own-scope',
  'options-own-selector',
  'options-accessor-scope',
  'options-accessor-selector',
  'options-live-proxy',
  'options-revoked-proxy',
] as const satisfies readonly Mode[];

const inheritedModes = [
  'request-inherited-scope',
  'request-inherited-selector',
  'options-inherited-scope',
  'options-inherited-selector',
] as const satisfies readonly Mode[];

const resolutionHostileModes = hostileModes.filter((mode) =>
  mode.startsWith('options-')
);
const resolutionInheritedModes = inheritedModes.filter((mode) =>
  mode.startsWith('options-')
);

function hostileExpectation(surface: Surface, mode: Mode) {
  return {
    ok: true,
    surface,
    mode,
    inherited: false,
    diagnostic: 'Pull request authentication selection failed.',
    failureTag: 'PullRequestAuthScopeSelectionError',
    trapReads: 0,
    matcherCallbacks: 0,
    providerCallbacks: 0,
    clientCallbacks: 0,
    networkCallbacks: 0,
    exactAccountKeyReads: 0,
    broadDiscoveryCallbacks: 0,
    preferredCallbacks: 0,
  };
}

describe('public PR authentication selection boundary process', () => {
  for (const mode of [
    'prototype-selector-return',
    'prototype-selector-throw',
    'prototype-selector-slow',
  ] as const satisfies readonly Mode[]) {
    test(`ignores ambient Object.prototype selector authority for plain public services/${mode}`, async () => {
      const result = await runFixture('initial', mode);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.value).toMatchObject({
        ok: true,
        surface: 'initial',
        mode,
        prototypeSelectorCalls: 0,
        prototypeGetterReads: 0,
        ambientScopeObservations: 0,
        providerCallbacks: 1,
      });
    });
  }

  for (const surface of [
    'ambient-nine-public',
    'ambient-bound-all',
  ] as const satisfies readonly Surface[]) {
    for (const mode of [
      'prototype-auth-scope',
      'prototype-auth-scope-getter',
    ] as const satisfies readonly Mode[]) {
      test(`keeps ${surface} public nested provider snapshots immune to ambient authScope/${mode}`, async () => {
        const result = await runFixture(surface, mode);
        expect(result.exitCode, result.stderr).toBe(0);
        expect(result.stderr).toBe('');
        expect(result.value).toMatchObject({
          ok: true,
          surface,
          mode,
          prototypeSelectorCalls: 0,
          prototypeGetterReads: 0,
          ambientScopeObservations: 0,
          nonNullPrototypeSnapshots: 0,
          resolvedLookalikeObservations: 0,
          contextLookalikeObservations: 0,
          nestedMatchLookalikeObservations: 0,
          nestedRepositoryLookalikeObservations: 0,
          nestedPullRequestLookalikeObservations: 0,
          nestedCanonicalFieldFailures: 0,
        });
        expect(result.value.operationNames).toEqual(
          surface === 'ambient-nine-public'
            ? [
                'addPullRequestComment',
                'createPullRequest',
                'findPullRequestForBranch',
                'getPullRequest',
                'getPullRequestDiff',
                'listPullRequestComments',
                'listPullRequests',
                'replyToPullRequestComment',
                'updatePullRequest',
              ]
            : [
                'addPullRequestComment',
                'getPullRequest',
                'getPullRequestDiff',
                'listPullRequestComments',
                'replyToPullRequestComment',
                'updatePullRequest',
              ]
        );
      });
    }
  }

  test('keeps selected scopes and all nine request builders immune to ambient optional identity lookalikes', async () => {
    const result = await runFixture(
      'ambient-nine-selected',
      'prototype-identity'
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.value).toMatchObject({
      ok: true,
      surface: 'ambient-nine-selected',
      mode: 'prototype-identity',
      selectorCalls: 9,
      prototypeSelectorCalls: 0,
      prototypeGetterReads: 0,
      ambientScopeObservations: 0,
      ambientIdentityObservations: 0,
      nonNullPrototypeSnapshots: 0,
      resolvedLookalikeObservations: 0,
      contextLookalikeObservations: 0,
      nestedMatchLookalikeObservations: 0,
      nestedRepositoryLookalikeObservations: 0,
      nestedPullRequestLookalikeObservations: 0,
      nestedCanonicalFieldFailures: 0,
      providerCallbacks: 9,
    });
    expect(result.value.operationNames).toHaveLength(9);
  });

  test('ignores ambient selectionTimeout when the internal wrapper owns only a selector', async () => {
    const result = await runFixture(
      'ambient-nine-selected',
      'prototype-selection-timeout'
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.value).toMatchObject({
      ok: true,
      selectorCalls: 9,
      prototypeSelectorCalls: 0,
      prototypeGetterReads: 0,
      providerCallbacks: 9,
    });
  });

  for (const surface of [
    'resolve-remote',
    'resolve-url',
    'resolve-repository',
    'resolve-repository-input',
  ] as const satisfies readonly Surface[]) {
    for (const mode of [
      'prototype-auth-scope',
      'prototype-auth-scope-getter',
    ] as const satisfies readonly Mode[]) {
      test(`keeps ${surface} nested provider snapshots immune to ambient authScope/${mode}`, async () => {
        const result = await runFixture(surface, mode);
        expect(result.exitCode, result.stderr).toBe(0);
        expect(result.stderr).toBe('');
        expect(result.value).toMatchObject({
          ok: true,
          surface,
          mode,
          prototypeGetterReads: 0,
          nonNullPrototypeSnapshots: 0,
          nestedMatchLookalikeObservations: 0,
          nestedRepositoryLookalikeObservations: 0,
          nestedPullRequestLookalikeObservations: 0,
          nestedCanonicalFieldFailures: 0,
        });
      });
    }

    for (const mode of [
      'prototype-preferred',
      'prototype-matcher-timeout',
    ] as const satisfies readonly Mode[]) {
      test(`keeps ${surface} resolution snapshots immune to ambient ${mode}`, async () => {
        const result = await runFixture(surface, mode);
        expect(result.exitCode, result.stderr).toBe(0);
        expect(result.stderr).toBe('');
        expect(result.value).toMatchObject({
          ok: true,
          surface,
          mode,
          prototypeSelectorCalls: 0,
          prototypeGetterReads: 0,
          preferredCallbacks: 0,
          nonNullPrototypeSnapshots: 0,
          resolvedLookalikeObservations: 0,
        });
      });
    }

    test(`preserves ${surface} own preferred/matcherTimeout controls over hostile ambient lookalikes`, async () => {
      const result = await runFixture(
        surface,
        'prototype-resolution-own-control'
      );
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.value).toMatchObject({
        ok: true,
        surface,
        mode: 'prototype-resolution-own-control',
        prototypeSelectorCalls: 0,
        prototypeGetterReads: 0,
        preferredCallbacks: 1,
        nonNullPrototypeSnapshots: 0,
        resolvedLookalikeObservations: 0,
      });
    });
  }

  for (const surface of [
    'initial',
    'bound',
  ] as const satisfies readonly Surface[]) {
    for (const mode of hostileModes) {
      test(`rejects ${surface}/${mode} before provider, exact-account, client, or network callbacks`, async () => {
        const result = await runFixture(surface, mode);
        expect(result.exitCode, result.stderr).toBe(0);
        expect(result.stderr).toBe('');
        expect(result.value).toEqual(hostileExpectation(surface, mode));
      });
    }

    for (const mode of inheritedModes) {
      test(`ignores ${surface}/${mode} without granting selection authority`, async () => {
        const result = await runFixture(surface, mode);
        expect(result.exitCode, result.stderr).toBe(0);
        expect(result.stderr).toBe('');
        expect(result.value).toEqual({
          ok: true,
          surface,
          mode,
          inherited: true,
          trapReads: 0,
          matcherCallbacks: surface === 'initial' ? 1 : 0,
          providerCallbacks: 1,
          clientCallbacks: 1,
          networkCallbacks: 1,
          exactAccountKeyReads: 0,
          broadDiscoveryCallbacks: 0,
          preferredCallbacks: 0,
        });
      });
    }
  }

  for (const surface of [
    'resolve-remote',
    'resolve-url',
    'resolve-repository',
    'resolve-repository-input',
  ] as const satisfies readonly Surface[]) {
    for (const mode of resolutionHostileModes) {
      test(`rejects ${surface}/${mode} before matcher callbacks`, async () => {
        const result = await runFixture(surface, mode);
        expect(result.exitCode, result.stderr).toBe(0);
        expect(result.stderr).toBe('');
        expect(result.value).toEqual(hostileExpectation(surface, mode));
      });
    }

    for (const mode of resolutionInheritedModes) {
      test(`ignores ${surface}/${mode} without changing resolution`, async () => {
        const result = await runFixture(surface, mode);
        expect(result.exitCode, result.stderr).toBe(0);
        expect(result.stderr).toBe('');
        expect(result.value).toEqual({
          ok: true,
          surface,
          mode,
          inherited: true,
          trapReads: 0,
          matcherCallbacks: surface === 'resolve-repository' ? 0 : 1,
          providerCallbacks: 0,
          clientCallbacks: 0,
          networkCallbacks: 0,
          exactAccountKeyReads: 0,
          broadDiscoveryCallbacks: 0,
          preferredCallbacks: 1,
        });
      });
    }
  }

  for (const mode of hostileModes) {
    test(`rejects trusted builtin-github/${mode} before exact account-key, client, or network callbacks`, async () => {
      const result = await runFixture('builtin-github', mode);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.value).toEqual(hostileExpectation('builtin-github', mode));
    });
  }

  test('wires the trusted built-in GitHub control to the injected exact account-key boundary with network denied', async () => {
    const result = await runFixture(
      'builtin-github-control',
      'request-own-scope'
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.value).toMatchObject({
      ok: true,
      surface: 'builtin-github-control',
      trapReads: 0,
      clientCallbacks: 1,
      networkCallbacks: 0,
      exactAccountKeyReads: 1,
      broadDiscoveryCallbacks: 0,
      preferredCallbacks: 0,
    });
  });
});
