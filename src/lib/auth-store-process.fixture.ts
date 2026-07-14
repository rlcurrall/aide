import {
  mkdir,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

import { Effect, Layer } from 'effect';

import {
  deleteAuthSecretEffect,
  listIndexedAuthScopesEffect,
  writeAuthSecretEffect,
  type AuthProviderId,
  type AuthStoreScope,
} from './auth-store.js';
import {
  KeyringService,
  KeyringUnavailableError,
  type KeyringSecretName,
} from './auth-keyring.js';

interface FixtureOperation {
  readonly kind: 'write' | 'delete' | 'list';
  readonly providerId: AuthProviderId;
  readonly scope?: AuthStoreScope;
  readonly value?: string;
}

const storeDirectory = requiredEnv('AUTH_PROCESS_FIXTURE_STORE_DIR');
const eventDirectory = requiredEnv('AUTH_PROCESS_FIXTURE_EVENT_DIR');
const processId = requiredEnv('AUTH_PROCESS_FIXTURE_ID');
const service = requiredEnv('AIDE_SECRET_SERVICE_OVERRIDE');

function requiredEnv(name: string): string {
  const value = Bun.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing fixture environment variable ${name}.`);
  }
  return value;
}

function secretPath(service: string, name: string): string {
  return join(
    storeDirectory,
    Buffer.from(`${service}\0${name}`).toString('base64url')
  );
}

async function maybePause(
  operation: 'get' | 'set' | 'delete',
  name: string,
  phase: 'before' | 'after'
): Promise<void> {
  if (
    Bun.env.AUTH_PROCESS_FIXTURE_PAUSE_OPERATION !== operation ||
    Bun.env.AUTH_PROCESS_FIXTURE_PAUSE_NAME !== name ||
    (Bun.env.AUTH_PROCESS_FIXTURE_PAUSE_PHASE ?? 'before') !== phase
  ) {
    return;
  }

  await writeFile(join(eventDirectory, `${processId}.paused`), 'paused', {
    mode: 0o600,
  });
  const releasePath = join(eventDirectory, `${processId}.release`);
  // proper-lockfile deliberately unrefs its heartbeat timer. Keep one ref'd
  // timer active so this simulated pending native keyring promise exercises
  // heartbeat compromise handling while it is blocked.
  const heartbeatKeepalive = setInterval(() => undefined, 1_000);
  try {
    while (!(await Bun.file(releasePath).exists())) {
      await Bun.sleep(10);
    }
  } finally {
    clearInterval(heartbeatKeepalive);
  }
}

function shouldFail(operation: 'get' | 'set' | 'delete', name: string) {
  return (
    Bun.env.AUTH_PROCESS_FIXTURE_FAIL_OPERATION === operation &&
    Bun.env.AUTH_PROCESS_FIXTURE_FAIL_NAME === name
  );
}

function ownDataProperty(value: unknown, name: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    return descriptor !== undefined && Object.hasOwn(descriptor, 'value')
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function errorCode(value: unknown): string | undefined {
  const code = ownDataProperty(value, 'code');
  return typeof code === 'string' ? code : undefined;
}

await mkdir(storeDirectory, { recursive: true, mode: 0o700 });
await mkdir(eventDirectory, { recursive: true, mode: 0o700 });

const fixtureKeyring = {
  get: (name: KeyringSecretName) =>
    Effect.tryPromise({
      try: async () => {
        await maybePause('get', name, 'before');
        let value: string | null;
        try {
          value = await readFile(secretPath(service, name), 'utf8');
        } catch (error) {
          if (errorCode(error) !== 'ENOENT') throw error;
          value = null;
        }
        await maybePause('get', name, 'after');
        if (shouldFail('get', name)) throw new Error('fixture get failure');
        return value;
      },
      catch: () => new KeyringUnavailableError('get'),
    }),
  set: (name: KeyringSecretName, value: string) =>
    Effect.tryPromise({
      try: async () => {
        await maybePause('set', name, 'before');
        if (shouldFail('set', name)) throw new Error('fixture set failure');
        const path = secretPath(service, name);
        const temporaryPath = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
        await writeFile(temporaryPath, value, { mode: 0o600 });
        await rename(temporaryPath, path);
        await maybePause('set', name, 'after');
      },
      catch: () => new KeyringUnavailableError('set'),
    }),
  delete: (name: KeyringSecretName) =>
    Effect.tryPromise({
      try: async () => {
        await maybePause('delete', name, 'before');
        if (shouldFail('delete', name)) {
          throw new Error('fixture delete failure');
        }
        try {
          await unlink(secretPath(service, name));
          await maybePause('delete', name, 'after');
          return true;
        } catch (error) {
          if (errorCode(error) !== 'ENOENT') throw error;
          await maybePause('delete', name, 'after');
          return false;
        }
      },
      catch: () => new KeyringUnavailableError('delete'),
    }),
} satisfies import('./auth-keyring.js').KeyringServiceShape;
const fixtureKeyringLayer = Layer.succeed(KeyringService, fixtureKeyring);

const rawOperation = Bun.argv.at(-1);
if (rawOperation === undefined) throw new Error('Missing fixture operation.');
const operation = JSON.parse(rawOperation) as FixtureOperation;

async function runFixtureEffect<A, E>(
  effect: Effect.Effect<A, E, KeyringService>
): Promise<A> {
  const result = await Effect.runPromise(
    Effect.either(effect.pipe(Effect.provide(fixtureKeyringLayer)))
  );
  if (result._tag === 'Left') throw result.left;
  return result.right;
}

try {
  let result: unknown;
  switch (operation.kind) {
    case 'write':
      result = await runFixtureEffect(
        writeAuthSecretEffect(
          operation.providerId,
          operation.value ?? 'fixture-value',
          operation.scope
        )
      );
      break;
    case 'delete':
      result = await runFixtureEffect(
        deleteAuthSecretEffect(operation.providerId, operation.scope)
      );
      break;
    case 'list':
      result = await runFixtureEffect(
        listIndexedAuthScopesEffect(operation.providerId)
      );
      break;
  }
  await Bun.write(Bun.stdout, JSON.stringify({ ok: true, result }));
} catch (error) {
  const tag = ownDataProperty(error, '_tag');
  const ownName = ownDataProperty(error, 'name');
  await Bun.write(
    Bun.stdout,
    JSON.stringify({
      ok: false,
      name:
        typeof tag === 'string'
          ? tag
          : typeof ownName === 'string'
            ? ownName
            : 'UnknownError',
      operation: ownDataProperty(error, 'operation'),
      phase: ownDataProperty(error, 'phase'),
      rollback: ownDataProperty(error, 'rollback'),
      residualState: ownDataProperty(error, 'residualState'),
    })
  );
  process.exitCode = 2;
} finally {
  await rm(join(eventDirectory, `${processId}.paused`), { force: true });
}
