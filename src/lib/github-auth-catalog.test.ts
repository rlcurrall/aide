import { inspect } from 'node:util';
import { runInNewContext } from 'node:vm';

import { describe, expect, test } from 'bun:test';
import {
  Cause,
  Effect,
  Exit,
  Fiber,
  FiberId,
  Layer,
  TestClock,
  TestContext,
} from 'effect';

import {
  discoverGitHubAuthCatalog,
  GitHubAuthCatalogDocumentError,
  GitHubAuthCatalogService,
  type GitHubAuthCatalogChild,
  type GitHubAuthCatalogExecutor,
  type GitHubAuthCatalogResult,
  type GitHubAuthCatalogSpawnOptions,
  GitHubAuthCatalogUnavailableError,
  githubAuthCatalog,
  makeGitHubAuthCatalogExecutor,
  makeGitHubAuthCatalogService,
  parseGitHubAuthCatalogDocument,
  parseGitHubAuthCatalogOutput,
} from './github-auth-catalog.js';

const encoder = new TextEncoder();

function bytes(value: string): Uint8Array {
  return encoder.encode(value);
}

function jsonBytes(value: unknown): Uint8Array {
  return bytes(JSON.stringify(value));
}

function record(
  overrides: Readonly<Record<string, unknown>> = {}
): Record<string, unknown> {
  return {
    active: true,
    host: 'github.com',
    login: 'octocat',
    state: 'success',
    ...overrides,
  };
}

function document(
  host = 'github.com',
  records: readonly unknown[] = [record({ host })]
): Record<string, unknown> {
  return { hosts: { [host]: records } };
}

function rawExecutor(
  stdout: Uint8Array,
  exitCode = 0
): GitHubAuthCatalogExecutor {
  return () =>
    Effect.succeed({
      kind: 'completed' as const,
      exitCode,
      stdout,
    });
}

async function parseDocumentExit(value: unknown) {
  return Effect.runPromiseExit(parseGitHubAuthCatalogDocument(value));
}

async function parseOutputExit(value: Uint8Array) {
  return Effect.runPromiseExit(parseGitHubAuthCatalogOutput(value));
}

function closedStream(
  chunks: readonly Uint8Array[]
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function completedChild(
  stdout: Uint8Array,
  exitCode = 0,
  kill: () => void = () => {
    throw new Error('a settled child must not be killed');
  }
): GitHubAuthCatalogChild {
  return {
    stdout: closedStream([stdout]),
    exited: Promise.resolve(exitCode),
    exitCode,
    kill,
  };
}

interface ControlledChild {
  readonly child: GitHubAuthCatalogChild;
  readonly observations: string[];
  readonly readStarted: Promise<void>;
  settle(exitCode?: number): void;
}

function controlledChild(
  options: {
    readonly cancellation?: Promise<void>;
    readonly firstChunk?: Uint8Array;
    readonly settleOnKill?: boolean;
  } = {}
): ControlledChild {
  const observations: string[] = [];
  let exitCode: number | null = null;
  let resolveExit!: (value: number) => void;
  let resolveReadStarted!: () => void;
  let readStarted = false;
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const readStartedPromise = new Promise<void>((resolve) => {
    resolveReadStarted = resolve;
  });
  const stdout = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!readStarted) {
        readStarted = true;
        observations.push('read-started');
        resolveReadStarted();
        if (options.firstChunk !== undefined) {
          controller.enqueue(options.firstChunk);
        }
      }
    },
    cancel() {
      observations.push('read-cancel-started');
      return (options.cancellation ?? Promise.resolve()).then(() => {
        observations.push('read-cancel-settled');
      });
    },
  });

  const settle = (value = 0) => {
    if (exitCode !== null) return;
    exitCode = value;
    observations.push('process-settled');
    resolveExit(value);
  };

  return {
    child: {
      stdout,
      exited,
      get exitCode() {
        return exitCode;
      },
      kill() {
        observations.push('kill');
        if (options.settleOnKill !== false) settle(143);
      },
    },
    observations,
    readStarted: readStartedPromise,
    settle,
  };
}

interface ScriptedChild {
  readonly child: GitHubAuthCatalogChild;
  readonly observations: string[];
  readonly readCount: () => number;
  settle(exitCode?: number): void;
  rejectSettlement(error: unknown): void;
}

function scriptedChild(
  reads: readonly GitHubAuthCatalogReadResult[],
  options: {
    readonly cancelFailure?: unknown;
    readonly killFailure?: unknown;
    readonly releaseFailure?: unknown;
    readonly settleOnKill?: boolean;
  } = {}
): ScriptedChild {
  const observations: string[] = [];
  let nextRead = 0;
  let exitCode: number | null = null;
  let settlementFinished = false;
  let resolveExit!: (value: number) => void;
  let rejectExit!: (error: unknown) => void;
  const exited = new Promise<number>((resolve, reject) => {
    resolveExit = resolve;
    rejectExit = reject;
  });
  const reader = {
    read: () => {
      observations.push(`read:${nextRead + 1}`);
      const value = reads[nextRead] ?? { done: true as const };
      nextRead += 1;
      return Promise.resolve(value);
    },
    cancel: () => {
      observations.push('read-cancel');
      return options.cancelFailure === undefined
        ? Promise.resolve()
        : Promise.reject(options.cancelFailure);
    },
    releaseLock: () => {
      observations.push('read-release');
      if (options.releaseFailure !== undefined) throw options.releaseFailure;
    },
  };
  const stdout = {
    getReader: () => reader,
  } as unknown as ReadableStream<Uint8Array>;
  const settle = (value = 0) => {
    if (settlementFinished) return;
    settlementFinished = true;
    exitCode = value;
    observations.push('process-settled');
    resolveExit(value);
  };
  const rejectSettlement = (error: unknown) => {
    if (settlementFinished) return;
    settlementFinished = true;
    observations.push('process-rejected');
    rejectExit(error);
  };
  return {
    child: {
      stdout,
      exited,
      get exitCode() {
        return exitCode;
      },
      kill() {
        observations.push('kill');
        if (options.settleOnKill !== false) settle(143);
        if (options.killFailure !== undefined) throw options.killFailure;
      },
    },
    observations,
    readCount: () => nextRead,
    settle,
    rejectSettlement,
  };
}

type GitHubAuthCatalogReadResult =
  | { readonly done: false; readonly value: Uint8Array }
  | { readonly done: true; readonly value?: undefined };

function chunk(value: Uint8Array): GitHubAuthCatalogReadResult {
  return { done: false, value };
}

function exactSizeEmptyCatalog(byteLength: number): Uint8Array {
  const fixedBytes = bytes('{"hosts":{},"padding":""}').byteLength;
  const output = bytes(
    `{"hosts":{},"padding":"${'x'.repeat(byteLength - fixedBytes)}"}`
  );
  expect(output.byteLength).toBe(byteLength);
  return output;
}

async function flushMicrotasks(iterations = 40): Promise<void> {
  for (let index = 0; index < iterations; index += 1) {
    await Promise.resolve();
  }
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('deterministic test condition was not reached');
}

function loggerLikeOwnDataTraversal(value: unknown): string {
  const seen = new Set<object>();
  const parts: string[] = [];
  const visit = (candidate: unknown) => {
    if (
      candidate === null ||
      (typeof candidate !== 'object' && typeof candidate !== 'function')
    ) {
      parts.push(String(candidate));
      return;
    }
    if (seen.has(candidate)) return;
    seen.add(candidate);
    for (const key of Reflect.ownKeys(candidate)) {
      parts.push(String(key));
      let descriptor: PropertyDescriptor | undefined;
      try {
        descriptor = Object.getOwnPropertyDescriptor(candidate, key);
      } catch {
        parts.push('descriptor-failed');
        continue;
      }
      if (descriptor !== undefined && Object.hasOwn(descriptor, 'value')) {
        visit(descriptor.value);
      } else {
        parts.push('accessor');
      }
    }
  };
  visit(value);
  return parts.join('\n');
}

function errorSurfaces(error: unknown): string {
  return [
    String(error),
    error instanceof Error ? error.message : '',
    inspect(error, { depth: 20, showHidden: true }),
    JSON.stringify(error),
    Cause.pretty(Cause.fail(error)),
  ].join('\n');
}

function expectDocumentError(
  exit: Exit.Exit<unknown, unknown>,
  reason: 'invalid-document' | 'output-too-large' = 'invalid-document'
): GitHubAuthCatalogDocumentError {
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isSuccess(exit)) throw new Error('expected document failure');
  const failures = Array.from(Cause.failures(exit.cause));
  expect(failures).toHaveLength(1);
  expect(failures[0]).toBeInstanceOf(GitHubAuthCatalogDocumentError);
  expect(failures[0]).toMatchObject({
    classification: 'document',
    reason,
  });
  return failures[0] as GitHubAuthCatalogDocumentError;
}

function expectUnavailableError(
  exit: Exit.Exit<unknown, unknown>,
  reason: 'spawn-failed' | 'command-failed' | 'timeout'
): GitHubAuthCatalogUnavailableError {
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isSuccess(exit)) throw new Error('expected unavailable failure');
  const failures = Array.from(Cause.failures(exit.cause));
  expect(failures).toHaveLength(1);
  expect(failures[0]).toBeInstanceOf(GitHubAuthCatalogUnavailableError);
  expect(failures[0]).toMatchObject({
    classification: 'unavailable',
    reason,
  });
  return failures[0] as GitHubAuthCatalogUnavailableError;
}

describe('GitHub gh auth catalog fixed execution boundary', () => {
  test('uses exact argv, strips auth-selection env, and disables every broader execution surface', async () => {
    const calls: Array<{
      readonly argv: readonly string[];
      readonly options: GitHubAuthCatalogSpawnOptions;
    }> = [];
    const environment = {
      PATH: '/safe/bin',
      HOME: '/safe/home',
      SAFE_MARKER: 'kept',
      GH_TOKEN: 'SECRET-GH-TOKEN',
      GITHUB_TOKEN: 'SECRET-GITHUB-TOKEN',
      GH_ENTERPRISE_TOKEN: 'SECRET-GH-ENTERPRISE',
      GITHUB_ENTERPRISE_TOKEN: 'SECRET-GITHUB-ENTERPRISE',
      GH_HOST: 'SECRET-GH-HOST',
    };
    const executor = makeGitHubAuthCatalogExecutor({
      environment,
      spawn: (argv, options) => {
        calls.push({ argv: [...argv], options });
        return completedChild(jsonBytes({ hosts: {} }));
      },
    });

    const result = await Effect.runPromise(discoverGitHubAuthCatalog(executor));

    expect(result).toEqual({
      identities: [],
      hasUnhealthyActiveIdentity: false,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.argv).toEqual(['gh', 'auth', 'status', '--json', 'hosts']);
    expect(calls[0]?.options).toMatchObject({
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
      env: {
        PATH: '/safe/bin',
        HOME: '/safe/home',
        SAFE_MARKER: 'kept',
      },
    });
    expect(Object.hasOwn(calls[0]!.options, 'shell')).toBe(false);
    const invocation = JSON.stringify(calls);
    for (const forbidden of [
      '--show-token',
      '--active',
      '--hostname',
      '--jq',
      '--template',
      'SECRET-GH-TOKEN',
      'SECRET-GITHUB-TOKEN',
      'SECRET-GH-ENTERPRISE',
      'SECRET-GITHUB-ENTERPRISE',
      'SECRET-GH-HOST',
    ]) {
      expect(invocation).not.toContain(forbidden);
    }
    expect(invocation).not.toMatch(/\btoken\b/iu);
  });

  test('exposes only fixed catalog discovery through the service tag', async () => {
    const service = makeGitHubAuthCatalogService(
      rawExecutor(jsonBytes({ hosts: {} }))
    );
    expect(Object.keys(service)).toEqual(['discover']);
    expect(Object.isFrozen(service)).toBe(true);
    const layer = Layer.succeed(GitHubAuthCatalogService, service);

    const result = await Effect.runPromise(
      githubAuthCatalog.pipe(Effect.provide(layer))
    );

    expect(result.identities).toEqual([]);
  });

  test('treats synchronous ENOENT as a successful absent catalog', async () => {
    const result = await Effect.runPromise(
      discoverGitHubAuthCatalog(
        makeGitHubAuthCatalogExecutor({
          environment: {},
          spawn: () => {
            const error = new Error('SECRET-MISSING-PATH') as Error & {
              code: string;
            };
            error.code = 'ENOENT';
            throw error;
          },
        })
      )
    );

    expect(result).toEqual({
      identities: [],
      hasUnhealthyActiveIdentity: false,
    });
  });

  test('maps non-ENOENT spawn failure to a fresh fixed unavailable error', async () => {
    const exit = await Effect.runPromiseExit(
      discoverGitHubAuthCatalog(
        makeGitHubAuthCatalogExecutor({
          environment: {},
          spawn: () => {
            const error = new Error('SECRET-SPAWN-BACKEND') as Error & {
              code: string;
            };
            error.code = 'EACCES';
            throw error;
          },
        })
      )
    );

    const error = expectUnavailableError(exit, 'spawn-failed');
    expect(errorSurfaces(error)).not.toContain('SECRET-SPAWN-BACKEND');
  });

  test('treats a valid nonzero command result as unavailable after validation', async () => {
    const exit = await Effect.runPromiseExit(
      discoverGitHubAuthCatalog(rawExecutor(jsonBytes({ hosts: {} }), 1))
    );

    expectUnavailableError(exit, 'command-failed');
  });

  test('does not use exit zero as an account-health signal', async () => {
    const result = await Effect.runPromise(
      discoverGitHubAuthCatalog(
        rawExecutor(
          jsonBytes(
            document('github.com', [
              record({ error: 'SECRET-EXPIRED', state: 'failed' }),
            ])
          )
        )
      )
    );

    expect(result).toEqual({
      identities: [],
      hasUnhealthyActiveIdentity: true,
    });
    expect(JSON.stringify(result)).not.toContain('SECRET-EXPIRED');
  });
});

describe('GitHub gh auth catalog decoding and structural validation', () => {
  test('accepts an own empty hosts object as a complete absent catalog', async () => {
    await expect(
      Effect.runPromise(parseGitHubAuthCatalogOutput(jsonBytes({ hosts: {} })))
    ).resolves.toEqual({
      identities: [],
      hasUnhealthyActiveIdentity: false,
    });
  });

  test('rejects malformed JSON with a fixed document failure', async () => {
    expectDocumentError(await parseOutputExit(bytes('{"hosts":')));
  });

  test('rejects invalid UTF-8 with fatal decoding', async () => {
    expectDocumentError(
      await parseOutputExit(new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x7d]))
    );
  });

  test('rejects stdout above 262144 bytes before decoding', async () => {
    const output = new Uint8Array(262_145);
    output.fill(0x20);
    const error = expectDocumentError(
      await parseOutputExit(output),
      'output-too-large'
    );
    expect(errorSurfaces(error)).not.toContain('262145');
  });

  test('rejects missing, inherited, accessor, array, null, and wrong-type hosts', async () => {
    let getterCalls = 0;
    const inherited = Object.create({ hosts: {} });
    const accessor = {};
    Object.defineProperty(accessor, 'hosts', {
      get() {
        getterCalls += 1;
        return {};
      },
    });
    for (const value of [
      {},
      inherited,
      accessor,
      { hosts: [] },
      { hosts: null },
      { hosts: 'SECRET-HOSTS' },
    ]) {
      expectDocumentError(await parseDocumentExit(value));
    }
    expect(getterCalls).toBe(0);
  });

  test('rejects missing, partial, accessor, and wrong-type required record fields', async () => {
    let getterCalls = 0;
    const accessorRecord = record();
    Object.defineProperty(accessorRecord, 'login', {
      configurable: true,
      get() {
        getterCalls += 1;
        return 'octocat';
      },
    });
    const cases: readonly unknown[] = [
      {},
      { active: true, host: 'github.com', login: 'octocat' },
      record({ active: 'true' }),
      record({ host: 1 }),
      record({ login: null }),
      record({ state: false }),
      record({ error: false }),
      accessorRecord,
      null,
      [],
    ];
    for (const candidate of cases) {
      expectDocumentError(
        await parseDocumentExit(document('github.com', [candidate]))
      );
    }
    expect(getterCalls).toBe(0);
  });

  test('rejects sparse account arrays through the raw document seam', async () => {
    const sparse: unknown[] = [];
    sparse.length = 2;
    sparse[1] = record();

    expectDocumentError(
      await parseDocumentExit(document('github.com', sparse))
    );
  });

  test('caps host buckets and total account records at 1000 each', async () => {
    const tooManyHosts = Object.create(null) as Record<string, unknown>;
    for (let index = 0; index < 1_001; index += 1) {
      const host = `host-${index}.example.com`;
      tooManyHosts[host] = [];
    }
    const tooManyRecords = Array.from({ length: 1_001 }, (_, index) =>
      record({ active: false, login: `account-${index}` })
    );

    expectDocumentError(
      await parseDocumentExit({ hosts: tooManyHosts }),
      'invalid-document'
    );
    expectDocumentError(
      await parseDocumentExit(document('github.com', tooManyRecords)),
      'invalid-document'
    );
  });
});

describe('GitHub gh auth catalog canonical identity and health rules', () => {
  test('requires each host key and record host to be the same already-canonical safe host', async () => {
    const cases: Array<readonly [string, string]> = [
      ['GitHub.com', 'GitHub.com'],
      ['ssh.github.com', 'ssh.github.com'],
      ['github.com', 'acme.example.com'],
      ['github.com\n', 'github.com\n'],
      ['\ud800.example.com', '\ud800.example.com'],
    ];
    for (const [key, host] of cases) {
      expectDocumentError(
        await parseDocumentExit(document(key, [record({ host })]))
      );
    }
  });

  test('enforces the 253-code-unit canonical host bound', async () => {
    const maximumHost = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`;
    expect(maximumHost).toHaveLength(253);
    const result = await Effect.runPromise(
      parseGitHubAuthCatalogDocument(
        document(maximumHost, [record({ host: maximumHost })])
      )
    );
    expect(result.identities[0]?.host).toBe(maximumHost);

    const oversizedHost = `a.${'b'.repeat(252)}`;
    expect(oversizedHost).toHaveLength(254);
    expectDocumentError(
      await parseDocumentExit(
        document(oversizedHost, [record({ host: oversizedHost })])
      )
    );
  });

  test('canonicalizes login case and Unicode without retaining the source spelling', async () => {
    const sourceLogin = ' O\u0308CTOCAT ';
    const result = await Effect.runPromise(
      parseGitHubAuthCatalogDocument(
        document('github.com', [record({ login: sourceLogin })])
      )
    );

    expect(result.identities).toEqual([
      { host: 'github.com', account: '\u00f6ctocat' },
    ]);
    expect(JSON.stringify(result)).not.toContain(sourceLogin);
  });

  test('rejects empty, unsafe, ill-formed, and overlong canonical logins', async () => {
    for (const login of [
      '',
      '   ',
      'octo\u0000cat',
      'octo\u202ecat',
      'octo\ud800cat',
      'a'.repeat(257),
    ]) {
      expectDocumentError(
        await parseDocumentExit(document('github.com', [record({ login })]))
      );
    }
  });

  test('accepts a safe canonical login at the 256-code-unit bound', async () => {
    const login = 'a'.repeat(256);
    const result = await Effect.runPromise(
      parseGitHubAuthCatalogDocument(
        document('github.com', [record({ login })])
      )
    );
    expect(result.identities[0]?.account).toBe(login);
  });

  test('validates state and error bounds and safety even on inactive records', async () => {
    for (const invalid of [
      record({ active: false, state: 's'.repeat(65) }),
      record({ active: false, state: 'unsafe\nstate' }),
      record({ active: false, state: 'bad\ud800state' }),
      record({ active: false, error: 'e'.repeat(1_025) }),
      record({ active: false, error: 'unsafe\u2028error' }),
      record({ active: false, error: 'bad\udffferror' }),
    ]) {
      expectDocumentError(
        await parseDocumentExit(document('github.com', [invalid]))
      );
    }
  });

  test('admits only active success with absent or empty error', async () => {
    for (const healthy of [record(), record({ error: '' })]) {
      const result = await Effect.runPromise(
        parseGitHubAuthCatalogDocument(document('github.com', [healthy]))
      );
      expect(result).toEqual({
        identities: [{ host: 'github.com', account: 'octocat' }],
        hasUnhealthyActiveIdentity: false,
      });
    }

    const result = await Effect.runPromise(
      parseGitHubAuthCatalogDocument(
        document('github.com', [
          record({ active: false, state: 'failed', error: 'INACTIVE-SECRET' }),
          record({ active: true, state: 'failed', error: '' }),
          record({ active: true, login: 'second', error: 'ACTIVE-SECRET' }),
        ])
      )
    );
    expect(result).toEqual({
      identities: [],
      hasUnhealthyActiveIdentity: true,
    });
    expect(JSON.stringify(result)).not.toMatch(/(?:INACTIVE|ACTIVE)-SECRET/u);
  });

  test('tolerates and discards unknown top-level and record fields', async () => {
    const result = await Effect.runPromise(
      parseGitHubAuthCatalogDocument({
        hosts: {
          'github.com': [
            record({
              gitProtocol: 'SECRET-GIT-PROTOCOL',
              tokenSource: 'SECRET-TOKEN-SOURCE',
              nested: { secret: 'SECRET-NESTED' },
            }),
          ],
        },
        future: 'SECRET-TOP-LEVEL',
      })
    );
    const rendered = `${JSON.stringify(result)}\n${inspect(result, {
      depth: 20,
      showHidden: true,
    })}`;

    expect(result).toEqual({
      identities: [{ host: 'github.com', account: 'octocat' }],
      hasUnhealthyActiveIdentity: false,
    });
    expect(rendered).not.toMatch(/SECRET-/u);
  });

  test('parses multi-host and multi-account arrays in deterministic lexical order', async () => {
    const result = await Effect.runPromise(
      parseGitHubAuthCatalogDocument({
        hosts: {
          'zeta.example.com': [
            record({
              active: false,
              host: 'zeta.example.com',
              login: 'old-account',
            }),
            record({ host: 'zeta.example.com', login: 'Zeta' }),
          ],
          'github.com': [record({ login: 'OctoCat' })],
          'acme.example.com': [
            record({ host: 'acme.example.com', login: 'Builder' }),
          ],
        },
      })
    );

    expect(result.identities).toEqual([
      { host: 'acme.example.com', account: 'builder' },
      { host: 'github.com', account: 'octocat' },
      { host: 'zeta.example.com', account: 'zeta' },
    ]);
  });

  test('rejects multiple healthy active accounts for one canonical host', async () => {
    expectDocumentError(
      await parseDocumentExit(
        document('github.com', [record(), record({ login: 'second' })])
      )
    );
  });

  test('returns detached deeply frozen identities and summary', async () => {
    const producerRecord = record({ login: 'OctoCat' });
    const producerRecords = [producerRecord];
    const producerHosts = { 'github.com': producerRecords };
    const producer = { hosts: producerHosts };
    const result = await Effect.runPromise(
      parseGitHubAuthCatalogDocument(producer)
    );

    producerRecord.login = 'SECRET-MUTATION';
    producerRecords.push(record({ login: 'SECRET-LATE' }));
    producerHosts['github.com'] = [];

    expect(result).toEqual({
      identities: [{ host: 'github.com', account: 'octocat' }],
      hasUnhealthyActiveIdentity: false,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.identities)).toBe(true);
    expect(Object.isFrozen(result.identities[0])).toBe(true);
    expect(result).not.toBe(producer);
    expect(result.identities).not.toBe(producerRecords);
    expect(result.identities[0]).not.toBe(producerRecord);
    expect(`${JSON.stringify(result)}${inspect(result)}`).not.toMatch(
      /SECRET-/u
    );
  });
});

describe('GitHub gh auth catalog fixed errors and hostile containment', () => {
  test('creates fresh fixed document errors without retaining hostile document data', async () => {
    const first = expectDocumentError(
      await parseOutputExit(bytes('SECRET-DOCUMENT-ONE'))
    );
    const second = expectDocumentError(
      await parseOutputExit(bytes('SECRET-DOCUMENT-TWO'))
    );

    expect(first).not.toBe(second);
    expect(first.message).toBe(
      'The GitHub CLI auth catalog document is invalid.'
    );
    expect(Object.hasOwn(first, 'cause')).toBe(false);
    expect(errorSurfaces(first)).not.toMatch(/SECRET-DOCUMENT/u);
  });

  test('discards hostile executor failures, defects, and producer objects', async () => {
    const hostile = new Error('SECRET-BACKEND-REJECTION');
    Object.defineProperty(hostile, 'cause', {
      value: { secret: 'SECRET-BACKEND-CAUSE' },
    });
    const failedExecutor = (() =>
      Effect.fail(hostile)) as unknown as GitHubAuthCatalogExecutor;
    const defectExecutor = (() =>
      Effect.die(hostile)) as unknown as GitHubAuthCatalogExecutor;
    const failedExit = await Effect.runPromiseExit(
      discoverGitHubAuthCatalog(failedExecutor)
    );
    const defectExit = await Effect.runPromiseExit(
      discoverGitHubAuthCatalog(defectExecutor)
    );

    for (const exit of [failedExit, defectExit]) {
      const error = expectUnavailableError(exit, 'spawn-failed');
      expect(error.message).toBe('The GitHub CLI auth catalog is unavailable.');
      expect(Object.hasOwn(error, 'cause')).toBe(false);
      expect(errorSurfaces(error)).not.toMatch(/SECRET-BACKEND/u);
    }
  });

  test('normalizes mutated and subclassed known failures into fresh fixed errors', async () => {
    class DecoratedDocumentError extends GitHubAuthCatalogDocumentError {}
    class DecoratedUnavailableError extends GitHubAuthCatalogUnavailableError {}

    let hostileAccessorCalls = 0;
    let hostileJsonCalls = 0;
    let hostileInspectCalls = 0;
    const decorate = (
      prototype: object,
      tag: string,
      classification: unknown,
      reason: unknown,
      sentinel: string
    ): object => {
      const producer = Object.create(prototype) as object;
      Object.defineProperties(producer, {
        _tag: {
          enumerable: true,
          configurable: true,
          writable: true,
          value: tag,
        },
        classification: {
          enumerable: true,
          configurable: true,
          writable: true,
          value: classification,
        },
        reason: {
          enumerable: true,
          configurable: true,
          writable: true,
          value: reason,
        },
        cause: {
          enumerable: true,
          value: { path: `${sentinel}-CAUSE` },
        },
        extra: { enumerable: true, value: `${sentinel}-EXTRA` },
        hostileAccessor: {
          enumerable: true,
          get() {
            hostileAccessorCalls += 1;
            return `${sentinel}-ACCESSOR`;
          },
        },
        toJSON: {
          value() {
            hostileJsonCalls += 1;
            return `${sentinel}-JSON`;
          },
        },
        [inspect.custom]: {
          value() {
            hostileInspectCalls += 1;
            return `${sentinel}-INSPECT`;
          },
        },
      });
      return producer;
    };

    const mutatedDocument = decorate(
      GitHubAuthCatalogDocumentError.prototype,
      'GitHubAuthCatalogDocumentError',
      'document',
      'output-too-large',
      'SECRET-MUTATED-DOCUMENT'
    );
    const subclassedDocument = decorate(
      DecoratedDocumentError.prototype,
      'GitHubAuthCatalogDocumentError',
      'document',
      'SECRET-FORGED-DOCUMENT-REASON',
      'SECRET-SUBCLASSED-DOCUMENT'
    );
    const mutatedUnavailable = decorate(
      GitHubAuthCatalogUnavailableError.prototype,
      'GitHubAuthCatalogUnavailableError',
      'unavailable',
      'SECRET-FORGED-UNAVAILABLE-REASON',
      'SECRET-MUTATED-UNAVAILABLE'
    );
    const subclassedUnavailable = decorate(
      DecoratedUnavailableError.prototype,
      'GitHubAuthCatalogUnavailableError',
      'unavailable',
      'command-failed',
      'SECRET-SUBCLASSED-UNAVAILABLE'
    );
    const cases = [
      {
        producer: mutatedDocument,
        classification: 'document' as const,
        reason: 'output-too-large' as const,
      },
      {
        producer: subclassedDocument,
        classification: 'unavailable' as const,
        reason: 'spawn-failed' as const,
      },
      {
        producer: mutatedUnavailable,
        classification: 'unavailable' as const,
        reason: 'spawn-failed' as const,
      },
      {
        producer: subclassedUnavailable,
        classification: 'unavailable' as const,
        reason: 'command-failed' as const,
      },
    ];

    for (const candidate of cases) {
      const executor = (() =>
        Effect.fail(
          candidate.producer
        )) as unknown as GitHubAuthCatalogExecutor;
      const exit = await Effect.runPromiseExit(
        discoverGitHubAuthCatalog(executor)
      );
      const normalized =
        candidate.classification === 'document'
          ? expectDocumentError(exit, candidate.reason)
          : expectUnavailableError(exit, candidate.reason);

      expect(normalized).not.toBe(candidate.producer);
      expect(Object.isFrozen(normalized)).toBe(true);
      expect(Object.hasOwn(normalized, 'cause')).toBe(false);
      const surfaces = [
        errorSurfaces(normalized),
        loggerLikeOwnDataTraversal(normalized),
        Reflect.ownKeys(normalized).map(String).join('\n'),
      ].join('\n');
      expect(surfaces).not.toMatch(/SECRET-/u);
    }
    expect(hostileAccessorCalls).toBe(0);
    expect(hostileJsonCalls).toBe(0);
    expect(hostileInspectCalls).toBe(0);
  });

  test('never traverses a producer failure prototype and fails closed without producer data', async () => {
    let prototypeTrapCalls = 0;
    const hostilePrototype = new Proxy(Object.create(null) as object, {
      getPrototypeOf() {
        prototypeTrapCalls += 1;
        throw new Error('SECRET-PROTOTYPE-TRAP');
      },
    });
    const producer = Object.create(hostilePrototype) as object;
    Object.defineProperties(producer, {
      _tag: { enumerable: true, value: 'ForgedCatalogFailure' },
      classification: { enumerable: true, value: 'unavailable' },
      reason: { enumerable: true, value: 'spawn-failed' },
      cause: { enumerable: true, value: 'SECRET-PROTOTYPE-CAUSE' },
      extra: { enumerable: true, value: 'SECRET-PROTOTYPE-EXTRA' },
    });
    const executor = (() =>
      Effect.fail(producer)) as unknown as GitHubAuthCatalogExecutor;

    const exit = await Effect.runPromiseExit(
      discoverGitHubAuthCatalog(executor)
    );

    const normalized = expectUnavailableError(exit, 'spawn-failed');
    expect(prototypeTrapCalls).toBe(0);
    expect(normalized).not.toBe(producer);
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.hasOwn(normalized, 'cause')).toBe(false);
    const surfaces = [
      errorSurfaces(normalized),
      loggerLikeOwnDataTraversal(normalized),
      Reflect.ownKeys(normalized).map(String).join('\n'),
    ].join('\n');
    expect(surfaces).not.toMatch(/SECRET-PROTOTYPE/u);
  });

  test('normalizes only one descriptor-known failure across parallel and sequential Cause shapes', async () => {
    const knownDocument = Object.freeze({
      _tag: 'GitHubAuthCatalogDocumentError',
      classification: 'document',
      reason: 'output-too-large',
    });
    const knownUnavailable = Object.freeze({
      _tag: 'GitHubAuthCatalogUnavailableError',
      classification: 'unavailable',
      reason: 'timeout',
    });
    const forged = Object.freeze({
      _tag: 'GitHubAuthCatalogDocumentError',
      classification: 'unavailable',
      reason: 'timeout',
      extra: 'SECRET-FORGED-CAUSE-SIBLING',
    });
    const unknown = new Error('SECRET-UNKNOWN-CAUSE-SIBLING');
    const interruption = Cause.interrupt(FiberId.none);
    const cases: ReadonlyArray<
      | {
          readonly cause: Cause.Cause<unknown>;
          readonly classification: 'document';
          readonly reason: 'invalid-document' | 'output-too-large';
        }
      | {
          readonly cause: Cause.Cause<unknown>;
          readonly classification: 'unavailable';
          readonly reason: 'spawn-failed' | 'command-failed' | 'timeout';
        }
    > = [
      {
        cause: Cause.parallel(Cause.fail(knownDocument), interruption),
        classification: 'document' as const,
        reason: 'output-too-large' as const,
      },
      {
        cause: Cause.sequential(Cause.fail(knownUnavailable), interruption),
        classification: 'unavailable' as const,
        reason: 'timeout' as const,
      },
      {
        cause: Cause.parallel(Cause.fail(unknown), interruption),
        classification: 'unavailable' as const,
        reason: 'spawn-failed' as const,
      },
      {
        cause: Cause.sequential(Cause.fail(forged), interruption),
        classification: 'unavailable' as const,
        reason: 'spawn-failed' as const,
      },
      {
        cause: Cause.parallel(Cause.fail(knownDocument), Cause.fail(unknown)),
        classification: 'unavailable' as const,
        reason: 'spawn-failed' as const,
      },
      {
        cause: Cause.sequential(
          Cause.fail(knownUnavailable),
          Cause.fail(forged)
        ),
        classification: 'unavailable' as const,
        reason: 'spawn-failed' as const,
      },
    ];

    for (const candidate of cases) {
      const executor = (() =>
        Effect.failCause(
          candidate.cause
        )) as unknown as GitHubAuthCatalogExecutor;
      const exit = await Effect.runPromiseExit(
        discoverGitHubAuthCatalog(executor)
      );
      const normalized =
        candidate.classification === 'document'
          ? expectDocumentError(exit, candidate.reason)
          : expectUnavailableError(exit, candidate.reason);
      expect(normalized).not.toBe(knownDocument);
      expect(normalized).not.toBe(knownUnavailable);
      expect(Object.isFrozen(normalized)).toBe(true);
      expect(errorSurfaces(normalized)).not.toMatch(
        /SECRET-(?:UNKNOWN|FORGED)/u
      );
    }

    const pureInterruption = await Effect.runPromiseExit(
      discoverGitHubAuthCatalog((() =>
        Effect.failCause(interruption)) as unknown as GitHubAuthCatalogExecutor)
    );
    expect(Exit.isFailure(pureInterruption)).toBe(true);
    if (Exit.isFailure(pureInterruption)) {
      expect(Cause.isInterruptedOnly(pureInterruption.cause)).toBe(true);
      expect(Cause.failures(pureInterruption.cause)).toHaveLength(0);
    }
  });

  test('rejects accessor-backed known-failure fields without invoking producer accessors', async () => {
    let reasonGetterCalls = 0;
    const producer = Object.create(
      GitHubAuthCatalogDocumentError.prototype
    ) as object;
    Object.defineProperties(producer, {
      _tag: {
        enumerable: true,
        value: 'GitHubAuthCatalogDocumentError',
      },
      classification: { enumerable: true, value: 'document' },
      reason: {
        enumerable: true,
        get() {
          reasonGetterCalls += 1;
          return 'SECRET-ACCESSOR-REASON';
        },
      },
      cause: { value: 'SECRET-ACCESSOR-CAUSE' },
    });
    const executor = (() =>
      Effect.fail(producer)) as unknown as GitHubAuthCatalogExecutor;

    const exit = await Effect.runPromiseExit(
      discoverGitHubAuthCatalog(executor)
    );

    const normalized = expectUnavailableError(exit, 'spawn-failed');
    expect(normalized).not.toBe(producer);
    expect(reasonGetterCalls).toBe(0);
    expect(errorSurfaces(normalized)).not.toContain('SECRET-ACCESSOR');
  });

  test('freezes freshly constructed failures against post-return decoration', () => {
    const errors = [
      new GitHubAuthCatalogDocumentError('invalid-document'),
      new GitHubAuthCatalogUnavailableError('timeout'),
    ];

    for (const error of errors) {
      expect(Object.isFrozen(error)).toBe(true);
      expect(() =>
        Object.defineProperty(error, 'cause', {
          value: 'SECRET-POST-RETURN-CAUSE',
        })
      ).toThrow();
      expect(() =>
        Object.defineProperty(error, 'reason', {
          value: 'SECRET-POST-RETURN-REASON',
        })
      ).toThrow();
      expect(errorSurfaces(error)).not.toContain('SECRET-POST-RETURN');
    }
  });

  test('freezes error constructors and prototypes behind fixed rendering surfaces', () => {
    const exportedTargets: readonly object[] = [
      GitHubAuthCatalogDocumentError,
      GitHubAuthCatalogDocumentError.prototype,
      GitHubAuthCatalogUnavailableError,
      GitHubAuthCatalogUnavailableError.prototype,
    ];
    const decorationKeys: readonly PropertyKey[] = [
      'toJSON',
      inspect.custom,
      'toString',
      Symbol.toPrimitive,
      'reason',
      'cause',
      'extra',
    ];
    const originalDecorations = exportedTargets.flatMap((target) =>
      decorationKeys.map((key) => ({
        target,
        key,
        descriptor: Object.getOwnPropertyDescriptor(target, key),
      }))
    );
    const decorationResults: boolean[] = [];

    try {
      for (const { target, key } of originalDecorations) {
        decorationResults.push(
          Reflect.defineProperty(target, key, {
            configurable: true,
            value: () => 'SECRET-EXPORTED-DECORATION',
          })
        );
      }
    } finally {
      for (const { target, key, descriptor } of originalDecorations) {
        if (descriptor === undefined) Reflect.deleteProperty(target, key);
        else Reflect.defineProperty(target, key, descriptor);
      }
    }

    const globalTargets: readonly object[] = [
      Error.prototype,
      Object.prototype,
    ];
    const rendererKeys: readonly PropertyKey[] = [
      'toJSON',
      inspect.custom,
      'toString',
      Symbol.toPrimitive,
    ];
    const originalRenderers = globalTargets.flatMap((target) =>
      rendererKeys.map((key) => ({
        target,
        key,
        descriptor: Object.getOwnPropertyDescriptor(target, key),
      }))
    );
    let hostileRendererCalls = 0;
    let observations: ReadonlyArray<{
      readonly error: Error;
      readonly rendered: string;
      readonly json: string;
      readonly inspected: string;
      readonly cause: string;
      readonly logger: string;
      readonly keys: readonly PropertyKey[];
    }> = [];

    try {
      for (const { target, key } of originalRenderers) {
        Reflect.defineProperty(target, key, {
          configurable: true,
          value() {
            hostileRendererCalls += 1;
            return 'SECRET-GLOBAL-INHERITED-RENDERER';
          },
        });
      }
      observations = [
        new GitHubAuthCatalogDocumentError('output-too-large'),
        new GitHubAuthCatalogUnavailableError('timeout'),
      ].map((error) => ({
        error,
        rendered: String(error),
        json: JSON.stringify(error),
        inspected: inspect(error, { depth: 20, showHidden: true }),
        cause: Cause.pretty(Cause.fail(error)),
        logger: loggerLikeOwnDataTraversal(error),
        keys: Reflect.ownKeys(error),
      }));
    } finally {
      for (const { target, key, descriptor } of originalRenderers) {
        if (descriptor === undefined) Reflect.deleteProperty(target, key);
        else Reflect.defineProperty(target, key, descriptor);
      }
    }

    expect(decorationResults).toEqual(
      Array.from({ length: originalDecorations.length }, () => false)
    );
    for (const target of exportedTargets)
      expect(Object.isFrozen(target)).toBe(true);
    expect(hostileRendererCalls).toBe(0);
    expect(observations).toHaveLength(2);

    const expected = [
      {
        name: 'GitHubAuthCatalogDocumentError',
        message: 'The GitHub CLI auth catalog document is invalid.',
        _tag: 'GitHubAuthCatalogDocumentError',
        classification: 'document',
        reason: 'output-too-large',
      },
      {
        name: 'GitHubAuthCatalogUnavailableError',
        message: 'The GitHub CLI auth catalog is unavailable.',
        _tag: 'GitHubAuthCatalogUnavailableError',
        classification: 'unavailable',
        reason: 'timeout',
      },
    ] as const;
    for (const [index, observation] of observations.entries()) {
      const fixed = expected[index]!;
      const fixedString = `${fixed.name}: ${fixed.message}`;
      expect(observation.rendered).toBe(fixedString);
      expect(observation.json).toBe(JSON.stringify(fixed));
      expect(observation.inspected).toBe(fixedString);
      expect(observation.cause).toContain(fixedString);
      expect(observation.error.stack).toBe(fixedString);
      expect(Object.isFrozen(observation.error)).toBe(true);
      expect(Object.hasOwn(observation.error, 'cause')).toBe(false);
      expect(Object.hasOwn(observation.error, 'extra')).toBe(false);
      expect(observation.keys.map(String).sort()).toEqual(
        ['_tag', 'classification', 'message', 'name', 'reason', 'stack'].sort()
      );
      for (const key of [
        'name',
        'message',
        '_tag',
        'classification',
        'reason',
      ]) {
        expect(
          Object.getOwnPropertyDescriptor(observation.error, key)
        ).toMatchObject({ configurable: false, writable: false });
      }
      expect(
        `${observation.rendered}\n${observation.json}\n${observation.inspected}\n${observation.cause}\n${observation.logger}`
      ).not.toMatch(/SECRET-|sourceURL|originalLine|originalColumn/u);
    }
  });

  test('validates malformed nonzero output as a document error without retaining stdout', async () => {
    const exit = await Effect.runPromiseExit(
      discoverGitHubAuthCatalog(
        rawExecutor(bytes('SECRET-NONZERO-MALFORMED'), 2)
      )
    );

    const error = expectDocumentError(exit);
    expect(errorSurfaces(error)).not.toContain('SECRET-NONZERO-MALFORMED');
  });
});

describe('GitHub gh auth catalog structured resource ownership', () => {
  async function rejectHostileSettlementShape(
    exited: unknown,
    settleLate: () => void,
    sentinel: string
  ): Promise<void> {
    let kills = 0;
    let stdoutReads = 0;
    let operationCompletions = 0;
    const observations: string[] = [];
    const child = {
      get stdout() {
        stdoutReads += 1;
        throw new Error(`${sentinel}-STDOUT`);
      },
      exited,
      exitCode: null,
      kill() {
        kills += 1;
        observations.push('kill');
      },
    } as unknown as GitHubAuthCatalogChild;

    const exit = await Effect.runPromiseExit(
      discoverGitHubAuthCatalog(
        makeGitHubAuthCatalogExecutor({
          environment: {},
          spawn: () => child,
        })
      )
    ).then((completed) => {
      operationCompletions += 1;
      observations.push('operation-settled');
      return completed;
    });
    const error = expectUnavailableError(exit, 'spawn-failed');
    const fixedSurfaces = errorSurfaces(error);

    expect(kills).toBe(1);
    expect(stdoutReads).toBe(0);
    expect(operationCompletions).toBe(1);
    expect(observations).toEqual(['kill', 'operation-settled']);
    expect(Object.isFrozen(error)).toBe(true);
    expect(fixedSurfaces).not.toContain(sentinel);

    settleLate();
    await flushMicrotasks();
    expect(kills).toBe(1);
    expect(stdoutReads).toBe(0);
    expect(operationCompletions).toBe(1);
    expect(observations).toEqual(['kill', 'operation-settled']);
    expect(errorSurfaces(error)).toBe(fixedSurfaces);
  }

  test('does not kill a child that settled on successful or nonzero completion', async () => {
    for (const exitCode of [0, 1]) {
      let kills = 0;
      const executor = makeGitHubAuthCatalogExecutor({
        environment: {},
        spawn: () =>
          completedChild(jsonBytes({ hosts: {} }), exitCode, () => {
            kills += 1;
          }),
      });
      await Effect.runPromiseExit(discoverGitHubAuthCatalog(executor));
      expect(kills).toBe(0);
    }
  });

  test('accepts exactly 262144 stdout bytes and rejects the next byte before decode', async () => {
    const exact = exactSizeEmptyCatalog(262_144);
    const accepted = await Effect.runPromise(
      discoverGitHubAuthCatalog(
        makeGitHubAuthCatalogExecutor({
          environment: {},
          spawn: () => completedChild(exact),
        })
      )
    );
    expect(accepted).toEqual({
      identities: [],
      hasUnhealthyActiveIdentity: false,
    });

    const fixture = scriptedChild(
      [chunk(exact), chunk(new Uint8Array([0x53]))],
      { settleOnKill: false }
    );
    let operationSettled = false;
    const operation = Effect.runPromiseExit(
      discoverGitHubAuthCatalog(
        makeGitHubAuthCatalogExecutor({
          environment: {},
          spawn: () => fixture.child,
        })
      )
    ).then((exit) => {
      operationSettled = true;
      return exit;
    });

    await waitForCondition(() => fixture.observations.includes('kill'));
    await flushMicrotasks();
    expect(operationSettled).toBe(false);
    expect(fixture.readCount()).toBe(2);
    expect(fixture.observations.filter((item) => item === 'kill')).toHaveLength(
      1
    );

    fixture.settle(143);
    const rejected = await operation;
    const error = expectDocumentError(rejected, 'output-too-large');
    expect(errorSurfaces(error)).not.toContain('SECRET');
  });

  test('bounds zero-progress reads, cancels and kills, and joins delayed settlement', async () => {
    const zeroReads = Array.from({ length: 65 }, () => chunk(new Uint8Array()));
    const fixture = scriptedChild(
      [...zeroReads, chunk(jsonBytes({ hosts: {} })), { done: true }],
      { settleOnKill: false }
    );
    let operationSettled = false;
    const operation = Effect.runPromiseExit(
      discoverGitHubAuthCatalog(
        makeGitHubAuthCatalogExecutor({
          environment: {},
          spawn: () => fixture.child,
        })
      )
    ).then((exit) => {
      operationSettled = true;
      return exit;
    });

    while (fixture.readCount() < 65) await Promise.resolve();
    await flushMicrotasks();
    expect(fixture.readCount()).toBeLessThanOrEqual(65);
    expect(fixture.observations).toContain('read-cancel');
    expect(fixture.observations.filter((item) => item === 'kill')).toHaveLength(
      1
    );
    expect(operationSettled).toBe(false);

    fixture.settle(143);
    const exit = await operation;
    expectDocumentError(exit, 'invalid-document');
    const completedObservations = [...fixture.observations];
    fixture.settle(0);
    await flushMicrotasks();
    expect(fixture.observations).toEqual(completedObservations);
  });

  test('bounds high-count tiny chunks independently of byte progress', async () => {
    const tinyReads = Array.from({ length: 4_097 }, () =>
      chunk(new Uint8Array([0x20]))
    );
    const fixture = scriptedChild(
      [...tinyReads, chunk(jsonBytes({ hosts: {} })), { done: true }],
      { settleOnKill: false }
    );
    let operationSettled = false;
    const operation = Effect.runPromiseExit(
      discoverGitHubAuthCatalog(
        makeGitHubAuthCatalogExecutor({
          environment: {},
          spawn: () => fixture.child,
        })
      )
    ).then((exit) => {
      operationSettled = true;
      return exit;
    });

    while (fixture.readCount() < 4_097) await Promise.resolve();
    await flushMicrotasks();
    expect(fixture.readCount()).toBeLessThanOrEqual(4_097);
    expect(fixture.observations).toContain('read-cancel');
    expect(fixture.observations.filter((item) => item === 'kill')).toHaveLength(
      1
    );
    expect(operationSettled).toBe(false);

    fixture.settle(143);
    const exit = await operation;
    expectDocumentError(exit, 'invalid-document');
  });

  test('copies every positive chunk before a producer can mutate retained bytes', async () => {
    const complete = jsonBytes({ hosts: {} });
    const first = complete.slice(0, 5);
    const second = complete.slice(5);
    let reads = 0;
    const reader = {
      read() {
        reads += 1;
        if (reads === 1)
          return Promise.resolve({ done: false as const, value: first });
        if (reads === 2) {
          first.fill(0x53);
          return Promise.resolve({ done: false as const, value: second });
        }
        return Promise.resolve({ done: true as const });
      },
      cancel: () => Promise.resolve(),
      releaseLock: () => undefined,
    };
    const child: GitHubAuthCatalogChild = {
      stdout: {
        getReader: () => reader,
      } as unknown as ReadableStream<Uint8Array>,
      exited: Promise.resolve(0),
      exitCode: 0,
      kill: () => {
        throw new Error('settled child must not be killed');
      },
    };

    const result = await Effect.runPromise(
      discoverGitHubAuthCatalog(
        makeGitHubAuthCatalogExecutor({
          environment: {},
          spawn: () => child,
        })
      )
    );

    expect(result).toEqual({
      identities: [],
      hasUnhealthyActiveIdentity: false,
    });
    expect(reads).toBe(3);
    expect(JSON.stringify(result)).not.toContain('SSSSS');
  });

  test('owns a raw child before an exited getter or invalid thenable can defect', async () => {
    let exitedGetterKills = 0;
    let invalidThenableKills = 0;
    let invalidThenGetterCalls = 0;
    const exitedGetterChild = {
      get stdout() {
        throw new Error('SECRET-STDOUT-MUST-NOT-BE-READ');
      },
      get exited() {
        throw new Error('SECRET-EXITED-GETTER');
      },
      get exitCode() {
        throw new Error('SECRET-EXIT-CODE-GETTER');
      },
      kill() {
        exitedGetterKills += 1;
      },
    } as unknown as GitHubAuthCatalogChild;
    const invalidSettlement = {};
    const invalidThenKey = ['th', 'en'].join('');
    Object.defineProperty(invalidSettlement, invalidThenKey, {
      get() {
        invalidThenGetterCalls += 1;
        throw new Error('SECRET-INVALID-THENABLE');
      },
    });
    const invalidThenableChild = {
      stdout: closedStream([jsonBytes({ hosts: {} })]),
      exited: invalidSettlement,
      exitCode: null,
      kill() {
        invalidThenableKills += 1;
      },
    } as unknown as GitHubAuthCatalogChild;

    for (const [child, sentinel] of [
      [exitedGetterChild, 'SECRET-EXITED-GETTER'],
      [invalidThenableChild, 'SECRET-INVALID-THENABLE'],
    ] as const) {
      const exit = await Effect.runPromiseExit(
        discoverGitHubAuthCatalog(
          makeGitHubAuthCatalogExecutor({
            environment: {},
            spawn: () => child,
          })
        )
      );
      const error = expectUnavailableError(exit, 'spawn-failed');
      expect(errorSurfaces(error)).not.toContain(sentinel);
    }
    expect(exitedGetterKills).toBe(1);
    expect(invalidThenableKills).toBe(1);
    expect(invalidThenGetterCalls).toBe(0);
  });

  test('rejects a Promise subclass without invoking hostile species or then surfaces', async () => {
    let speciesCalls = 0;
    let thenCalls = 0;
    let resolveExit!: (value: number) => void;
    class HostileSettlementPromise<T> extends Promise<T> {
      static override get [Symbol.species](): PromiseConstructor {
        speciesCalls += 1;
        throw new Error('SECRET-SUBCLASS-SPECIES');
      }
    }
    const exited = new HostileSettlementPromise<number>((resolve) => {
      resolveExit = resolve;
    });
    Object.defineProperty(exited, ['th', 'en'].join(''), {
      get() {
        thenCalls += 1;
        throw new Error('SECRET-SUBCLASS-THEN');
      },
    });

    await rejectHostileSettlementShape(
      exited,
      () => resolveExit(0),
      'SECRET-SUBCLASS'
    );

    expect(speciesCalls).toBe(0);
    expect(thenCalls).toBe(0);
  });

  test('rejects same-realm native Promises with own constructor accessors or overrides', async () => {
    for (const kind of ['accessor', 'override'] as const) {
      let constructorCalls = 0;
      let speciesCalls = 0;
      let thenCalls = 0;
      let resolveExit!: (value: number) => void;
      const exited = new Promise<number>((resolve) => {
        resolveExit = resolve;
      });
      if (kind === 'accessor') {
        Object.defineProperty(exited, 'constructor', {
          get() {
            constructorCalls += 1;
            throw new Error('SECRET-OWN-CONSTRUCTOR-ACCESSOR');
          },
        });
      } else {
        const hostileConstructor = {};
        Object.defineProperty(hostileConstructor, Symbol.species, {
          get() {
            speciesCalls += 1;
            throw new Error('SECRET-OWN-CONSTRUCTOR-SPECIES');
          },
        });
        Object.defineProperty(exited, 'constructor', {
          value: hostileConstructor,
        });
      }
      Object.defineProperty(exited, ['th', 'en'].join(''), {
        get() {
          thenCalls += 1;
          throw new Error('SECRET-OWN-CONSTRUCTOR-THEN');
        },
      });

      await rejectHostileSettlementShape(
        exited,
        () => resolveExit(0),
        'SECRET-OWN-CONSTRUCTOR'
      );

      expect(constructorCalls).toBe(0);
      expect(speciesCalls).toBe(0);
      expect(thenCalls).toBe(0);
    }
  });

  test('rejects a cross-realm Promise without reading producer then or accepting late settlement', async () => {
    let thenCalls = 0;
    const context: Record<string, unknown> = {};
    const exited = runInNewContext(
      'new Promise((resolve) => { globalThis.settleExit = resolve })',
      context
    ) as unknown as object;
    Object.defineProperty(exited, ['th', 'en'].join(''), {
      get() {
        thenCalls += 1;
        throw new Error('SECRET-CROSS-REALM-THEN');
      },
    });
    const settleExit = context.settleExit;
    if (typeof settleExit !== 'function') {
      throw new Error('cross-realm fixture did not expose settlement');
    }

    await rejectHostileSettlementShape(
      exited,
      () => Reflect.apply(settleExit, undefined, [0]),
      'SECRET-CROSS-REALM'
    );

    expect(thenCalls).toBe(0);
  });

  test('kills and joins when stdout access defects after settlement capture', async () => {
    let resolveExit!: (value: number) => void;
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const observations: string[] = [];
    const child = {
      get stdout() {
        observations.push('stdout-getter');
        throw new Error('SECRET-STDOUT-GETTER');
      },
      exited,
      exitCode: null,
      kill() {
        observations.push('kill');
      },
    } as unknown as GitHubAuthCatalogChild;
    let operationSettled = false;
    const operation = Effect.runPromiseExit(
      discoverGitHubAuthCatalog(
        makeGitHubAuthCatalogExecutor({
          environment: {},
          spawn: () => child,
        })
      )
    ).then((exit) => {
      operationSettled = true;
      return exit;
    });

    while (!observations.includes('kill')) await Promise.resolve();
    await flushMicrotasks();
    expect(operationSettled).toBe(false);
    expect(observations).toEqual(['stdout-getter', 'kill']);

    resolveExit(143);
    const exit = await operation;
    const error = expectUnavailableError(exit, 'spawn-failed');
    expect(errorSurfaces(error)).not.toContain('SECRET-STDOUT-GETTER');
    expect(observations.filter((item) => item === 'kill')).toHaveLength(1);
  });

  test('treats rejected-exited ENOENT as absent without killing the settled child', async () => {
    const missing = new Error('SECRET-REJECTED-ENOENT') as Error & {
      code: string;
      extra: string;
    };
    missing.code = 'ENOENT';
    missing.extra = 'SECRET-REJECTED-ENOENT-EXTRA';
    let kills = 0;
    const child: GitHubAuthCatalogChild = {
      stdout: closedStream([jsonBytes({ hosts: {} })]),
      exited: Promise.reject(missing),
      exitCode: null,
      kill() {
        kills += 1;
      },
    };

    const result = await Effect.runPromise(
      discoverGitHubAuthCatalog(
        makeGitHubAuthCatalogExecutor({
          environment: {},
          spawn: () => child,
        })
      )
    );

    expect(result).toEqual({
      identities: [],
      hasUnhealthyActiveIdentity: false,
    });
    expect(kills).toBe(0);
    expect(JSON.stringify(result)).not.toContain('SECRET-REJECTED-ENOENT');
  });

  test('kills a live child on oversized stdout and joins process settlement', async () => {
    const fixture = controlledChild({ firstChunk: new Uint8Array(262_145) });
    const executor = makeGitHubAuthCatalogExecutor({
      environment: {},
      spawn: () => fixture.child,
    });

    const exit = await Effect.runPromiseExit(
      discoverGitHubAuthCatalog(executor)
    );

    expectDocumentError(exit, 'output-too-large');
    expect(
      fixture.observations.filter((value) => value === 'kill')
    ).toHaveLength(1);
    expect(fixture.observations.at(-1)).toBe('process-settled');
  });

  test('preserves caller interruption, kills exactly once while live, and joins read/process finalization', async () => {
    const fixture = controlledChild({ settleOnKill: false });
    const executor = makeGitHubAuthCatalogExecutor({
      environment: {},
      spawn: () => fixture.child,
    });
    const fiber = Effect.runFork(discoverGitHubAuthCatalog(executor));
    await fixture.readStarted;
    let interruptionSettled = false;
    const interrupted = Effect.runPromise(Fiber.interrupt(fiber)).then(
      (exit) => {
        interruptionSettled = true;
        return exit;
      }
    );

    await waitForCondition(() => fixture.observations.includes('kill'));
    await flushMicrotasks();
    expect(interruptionSettled).toBe(false);
    expect(fixture.observations).toEqual([
      'read-started',
      'read-cancel-started',
      'read-cancel-settled',
      'kill',
    ]);

    fixture.settle(143);
    const exit = await interrupted;

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit))
      expect(Cause.isInterrupted(exit.cause)).toBe(true);
    expect(fixture.observations).toEqual([
      'read-started',
      'read-cancel-started',
      'read-cancel-settled',
      'kill',
      'process-settled',
    ]);
  });

  test('does not complete interruption until read cancellation and process settlement join', async () => {
    let resolveCancellation!: () => void;
    const cancellation = new Promise<void>((resolve) => {
      resolveCancellation = resolve;
    });
    const fixture = controlledChild({ cancellation, settleOnKill: false });
    const executor = makeGitHubAuthCatalogExecutor({
      environment: {},
      spawn: () => fixture.child,
    });
    const fiber = Effect.runFork(discoverGitHubAuthCatalog(executor));
    await fixture.readStarted;
    let interruptionSettled = false;
    const interrupted = Effect.runPromise(Fiber.interrupt(fiber)).then(
      (exit) => {
        interruptionSettled = true;
        return exit;
      }
    );

    while (!fixture.observations.includes('read-cancel-started')) {
      await Promise.resolve();
    }
    await Promise.resolve();
    expect(interruptionSettled).toBe(false);
    expect(fixture.observations).not.toContain('kill');

    resolveCancellation();
    await waitForCondition(() => fixture.observations.includes('kill'));
    await flushMicrotasks();
    expect(interruptionSettled).toBe(false);
    expect(fixture.observations).toEqual([
      'read-started',
      'read-cancel-started',
      'read-cancel-settled',
      'kill',
    ]);

    fixture.settle(143);
    const exit = await interrupted;
    expect(Exit.isFailure(exit)).toBe(true);
    expect(interruptionSettled).toBe(true);
    expect(fixture.observations).toEqual([
      'read-started',
      'read-cancel-started',
      'read-cancel-settled',
      'kill',
      'process-settled',
    ]);

    fixture.settle(0);
    await Promise.resolve();
    expect(fixture.observations).toEqual([
      'read-started',
      'read-cancel-started',
      'read-cancel-settled',
      'kill',
      'process-settled',
    ]);
  });

  test('uses the fixed five-second Effect timeout and joins cleanup before returning unavailable', async () => {
    const fixture = controlledChild({ settleOnKill: false });
    const executor = makeGitHubAuthCatalogExecutor({
      environment: {},
      spawn: () => fixture.child,
    });
    const program = Effect.gen(function* () {
      const fiber = yield* Effect.fork(discoverGitHubAuthCatalog(executor));
      yield* Effect.yieldNow();
      yield* TestClock.adjust('5 seconds');
      return yield* Fiber.await(fiber);
    }).pipe(Effect.provide(TestContext.TestContext));

    let timeoutSettled = false;
    const timed = Effect.runPromise(program).then((exit) => {
      timeoutSettled = true;
      return exit;
    });
    await fixture.readStarted;
    await waitForCondition(() => fixture.observations.includes('kill'));
    await flushMicrotasks();
    expect(timeoutSettled).toBe(false);
    expect(fixture.observations).toEqual([
      'read-started',
      'read-cancel-started',
      'read-cancel-settled',
      'kill',
    ]);

    fixture.settle(143);
    const exit = await timed;

    expectUnavailableError(exit, 'timeout');
    expect(fixture.observations).toEqual([
      'read-started',
      'read-cancel-started',
      'read-cancel-settled',
      'kill',
      'process-settled',
    ]);
  });

  test('turns stdout read failure and rejected process settlement into fixed unavailable errors', async () => {
    const readSecret = new Error('SECRET-READ-FAILURE');
    let readKills = 0;
    let resolveReadExit!: (value: number) => void;
    const readExit = new Promise<number>((resolve) => {
      resolveReadExit = resolve;
    });
    const readChild: GitHubAuthCatalogChild = {
      stdout: new ReadableStream({
        pull(controller) {
          controller.error(readSecret);
        },
      }),
      exited: readExit,
      exitCode: null,
      kill() {
        readKills += 1;
        resolveReadExit(143);
      },
    };
    const rejectedChild: GitHubAuthCatalogChild = {
      stdout: closedStream([jsonBytes({ hosts: {} })]),
      exited: Promise.reject(new Error('SECRET-EXIT-REJECTION')),
      exitCode: 1,
      kill() {
        throw new Error('settled rejected child must not be killed');
      },
    };

    const readFailure = await Effect.runPromiseExit(
      discoverGitHubAuthCatalog(
        makeGitHubAuthCatalogExecutor({
          environment: {},
          spawn: () => readChild,
        })
      )
    );
    const exitFailure = await Effect.runPromiseExit(
      discoverGitHubAuthCatalog(
        makeGitHubAuthCatalogExecutor({
          environment: {},
          spawn: () => rejectedChild,
        })
      )
    );

    expect(readKills).toBe(1);
    for (const [exit, sentinel] of [
      [readFailure, 'SECRET-READ-FAILURE'],
      [exitFailure, 'SECRET-EXIT-REJECTION'],
    ] as const) {
      const error = expectUnavailableError(exit, 'spawn-failed');
      expect(errorSurfaces(error)).not.toContain(sentinel);
    }
  });

  test('keeps a document failure through cancel rejection, release throw, kill throw, and settlement rejection', async () => {
    const fixture = scriptedChild([chunk(new Uint8Array(262_145))], {
      cancelFailure: new Error('SECRET-CANCEL-REJECTION'),
      releaseFailure: new Error('SECRET-RELEASE-THROW'),
      killFailure: new Error('SECRET-KILL-THROW'),
      settleOnKill: false,
    });
    let operationSettled = false;
    const operation = Effect.runPromiseExit(
      discoverGitHubAuthCatalog(
        makeGitHubAuthCatalogExecutor({
          environment: {},
          spawn: () => fixture.child,
        })
      )
    ).then((exit) => {
      operationSettled = true;
      return exit;
    });

    await waitForCondition(() => fixture.observations.includes('kill'));
    await flushMicrotasks();
    expect(operationSettled).toBe(false);
    expect(fixture.observations).toContain('read-cancel');
    expect(fixture.observations).toContain('read-release');
    expect(fixture.observations.filter((item) => item === 'kill')).toHaveLength(
      1
    );

    fixture.rejectSettlement(new Error('SECRET-SETTLEMENT-REJECTION'));
    const exit = await operation;
    const error = expectDocumentError(exit, 'output-too-large');
    const surfaces = `${errorSurfaces(error)}\n${loggerLikeOwnDataTraversal(error)}`;
    expect(surfaces).not.toMatch(/SECRET-(?:CANCEL|RELEASE|KILL|SETTLEMENT)/u);
  });

  test('keeps pure interruption through cancel rejection, release throw, and kill throw until settlement', async () => {
    const observations: string[] = [];
    let resolveRead!: (value: GitHubAuthCatalogReadResult) => void;
    let resolveExit!: (value: number) => void;
    const pendingRead = new Promise<GitHubAuthCatalogReadResult>((resolve) => {
      resolveRead = resolve;
    });
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const reader = {
      read() {
        observations.push('read-started');
        return pendingRead;
      },
      cancel() {
        observations.push('read-cancel');
        resolveRead({ done: true });
        return Promise.reject(new Error('SECRET-INTERRUPT-CANCEL'));
      },
      releaseLock() {
        observations.push('read-release');
        throw new Error('SECRET-INTERRUPT-RELEASE');
      },
    };
    const child: GitHubAuthCatalogChild = {
      stdout: {
        getReader: () => reader,
      } as unknown as ReadableStream<Uint8Array>,
      exited,
      exitCode: null,
      kill() {
        observations.push('kill');
        throw new Error('SECRET-INTERRUPT-KILL');
      },
    };
    const fiber = Effect.runFork(
      discoverGitHubAuthCatalog(
        makeGitHubAuthCatalogExecutor({
          environment: {},
          spawn: () => child,
        })
      )
    );
    while (!observations.includes('read-started')) await Promise.resolve();
    let interruptionSettled = false;
    const interrupted = Effect.runPromise(Fiber.interrupt(fiber)).then(
      (exit) => {
        interruptionSettled = true;
        return exit;
      }
    );

    while (!observations.includes('kill')) await Promise.resolve();
    await flushMicrotasks();
    expect(interruptionSettled).toBe(false);
    expect(observations).toEqual([
      'read-started',
      'read-cancel',
      'read-release',
      'kill',
    ]);

    resolveExit(143);
    const exit = await interrupted;
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.isInterruptedOnly(exit.cause)).toBe(true);
      expect(Cause.pretty(exit.cause)).not.toContain('SECRET-INTERRUPT');
    }
    expect(observations.filter((item) => item === 'kill')).toHaveLength(1);
  });

  test('returns only a frozen detached result after successful release', async () => {
    const producerBytes = jsonBytes(document());
    const child = completedChild(producerBytes);
    const executor = makeGitHubAuthCatalogExecutor({
      environment: {},
      spawn: () => child,
    });

    const result: GitHubAuthCatalogResult = await Effect.runPromise(
      discoverGitHubAuthCatalog(executor)
    );
    producerBytes.fill(0x53);

    expect(result).toEqual({
      identities: [{ host: 'github.com', account: 'octocat' }],
      hasUnhealthyActiveIdentity: false,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.identities)).toBe(true);
    expect(Object.isFrozen(result.identities[0])).toBe(true);
    expect(JSON.stringify(result)).not.toContain('SSSS');
  });
});
