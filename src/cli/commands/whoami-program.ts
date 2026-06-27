import { Data, Effect, Layer } from 'effect';

import {
  probeJiraConfig,
  probeAdoConfig,
  probeGithubConfig,
  isKeyringCredentialValid,
  activeJiraEnvVars,
  activeAdoEnvVars,
  activeGithubEnvVars,
  type ConfigStatus,
  type GithubConfigValue,
} from '@lib/config.js';
import type { SecretName } from '@lib/secrets.js';
import type { AzureDevOpsConfig, JiraConfig } from '@schemas/config.js';

export type ServiceName = 'jira' | 'ado' | 'github';
export type WhoamiSource =
  | 'env'
  | 'keyring'
  | 'gh-cli'
  | 'not-configured'
  | 'corrupted';

export interface WhoamiStatus {
  service: ServiceName;
  source: WhoamiSource;
  identity: string | null;
  // Populated only when source === 'env': the list of env vars currently
  // set for this service (used by the migration tip in buildWhoamiOutput).
  envVarsSet?: string[];
  // Populated only when source === 'env': true if the keyring also holds a
  // valid credential blob for this service (i.e. env is shadowing the
  // keyring). Drives which flavor of tip whoami prints.
  keyringAlsoConfigured?: boolean;
}

type WhoamiConfigReadService = ServiceName | 'keyring';

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class WhoamiConfigReadError extends Data.TaggedError(
  'WhoamiConfigReadError'
)<{
  readonly service: WhoamiConfigReadService;
  readonly operation: string;
  readonly originalError: unknown;
}> {
  override get message(): string {
    return `Failed to read ${this.service} credentials while ${this.operation}: ${formatUnknownError(this.originalError)}`;
  }
}

export type WhoamiError = WhoamiConfigReadError;

export interface WhoamiConfigServiceShape {
  readonly probeJira: () => Effect.Effect<
    ConfigStatus<JiraConfig>,
    WhoamiError
  >;
  readonly probeAdo: () => Effect.Effect<
    ConfigStatus<AzureDevOpsConfig>,
    WhoamiError
  >;
  readonly probeGithub: () => Effect.Effect<
    ConfigStatus<GithubConfigValue>,
    WhoamiError
  >;
  readonly isKeyringCredentialValid: (
    name: SecretName
  ) => Effect.Effect<boolean, WhoamiError>;
  readonly activeJiraEnvVars: () => string[];
  readonly activeAdoEnvVars: () => string[];
  readonly activeGithubEnvVars: () => string[];
}

interface WhoamiConfigOptions {
  ghAvailable?: () => boolean;
}

function tryWhoamiPromise<A>(
  service: WhoamiConfigReadService,
  operation: string,
  run: () => Promise<A>
): Effect.Effect<A, WhoamiError> {
  return Effect.tryPromise({
    try: run,
    catch: (error) =>
      new WhoamiConfigReadError({
        service,
        operation,
        originalError: error,
      }),
  });
}

function makeLiveWhoamiConfigService(
  opts: WhoamiConfigOptions = {}
): WhoamiConfigServiceShape {
  return {
    probeJira: () =>
      tryWhoamiPromise('jira', 'probing Jira configuration', () =>
        probeJiraConfig()
      ),
    probeAdo: () =>
      tryWhoamiPromise('ado', 'probing Azure DevOps configuration', () =>
        probeAdoConfig()
      ),
    probeGithub: () =>
      tryWhoamiPromise('github', 'probing GitHub configuration', () =>
        probeGithubConfig({ ghAvailable: opts.ghAvailable })
      ),
    isKeyringCredentialValid: (name) =>
      tryWhoamiPromise('keyring', `checking ${name} keyring credentials`, () =>
        isKeyringCredentialValid(name)
      ),
    activeJiraEnvVars,
    activeAdoEnvVars,
    activeGithubEnvVars,
  };
}

export class WhoamiConfigService extends Effect.Service<WhoamiConfigService>()(
  'aide/WhoamiConfigService',
  {
    sync: makeLiveWhoamiConfigService,
  }
) {}

export function makeWhoamiConfigLayer(
  opts: WhoamiConfigOptions = {}
): Layer.Layer<WhoamiConfigService> {
  return Layer.succeed(
    WhoamiConfigService,
    WhoamiConfigService.make(makeLiveWhoamiConfigService(opts))
  );
}

function redactUrlUserInfo(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.username || url.password) {
      url.username = '';
      url.password = '';
      return url.toString().replace(/\/$/, '');
    }
    return raw;
  } catch {
    return raw;
  }
}

const statusJiraEffect: Effect.Effect<
  WhoamiStatus,
  WhoamiError,
  WhoamiConfigService
> = Effect.gen(function* () {
  const config = yield* WhoamiConfigService;
  const status = yield* config.probeJira();

  if (status.kind === 'env') {
    const keyringAlsoConfigured =
      yield* config.isKeyringCredentialValid('jira');
    return {
      service: 'jira',
      source: 'env',
      identity: `${status.value.email} at ${redactUrlUserInfo(status.value.url)}`,
      envVarsSet: config.activeJiraEnvVars(),
      keyringAlsoConfigured,
    };
  }
  if (status.kind === 'keyring') {
    return {
      service: 'jira',
      source: 'keyring',
      identity: `${status.value.email} at ${redactUrlUserInfo(status.value.url)}`,
    };
  }
  if (status.kind === 'malformed') {
    return {
      service: 'jira',
      source: 'corrupted',
      identity: "run 'aide login jira' to reconfigure",
    };
  }

  return { service: 'jira', source: 'not-configured', identity: null };
});

const statusAdoEffect: Effect.Effect<
  WhoamiStatus,
  WhoamiError,
  WhoamiConfigService
> = Effect.gen(function* () {
  const config = yield* WhoamiConfigService;
  const status = yield* config.probeAdo();

  if (status.kind === 'env') {
    const keyringAlsoConfigured = yield* config.isKeyringCredentialValid('ado');
    return {
      service: 'ado',
      source: 'env',
      identity: `${redactUrlUserInfo(status.value.orgUrl)} (${status.value.authMethod})`,
      envVarsSet: config.activeAdoEnvVars(),
      keyringAlsoConfigured,
    };
  }
  if (status.kind === 'keyring') {
    return {
      service: 'ado',
      source: 'keyring',
      identity: `${redactUrlUserInfo(status.value.orgUrl)} (${status.value.authMethod})`,
    };
  }
  if (status.kind === 'malformed') {
    return {
      service: 'ado',
      source: 'corrupted',
      identity: "run 'aide login ado' to reconfigure",
    };
  }

  return { service: 'ado', source: 'not-configured', identity: null };
});

const statusGithubEffect: Effect.Effect<
  WhoamiStatus,
  WhoamiError,
  WhoamiConfigService
> = Effect.gen(function* () {
  const config = yield* WhoamiConfigService;
  const status = yield* config.probeGithub();

  if (status.kind === 'env') {
    const src = status.value.source;
    if (src === 'gh-cli') {
      return { service: 'github', source: 'gh-cli', identity: null };
    }
    const keyringAlsoConfigured =
      yield* config.isKeyringCredentialValid('github');
    return {
      service: 'github',
      source: 'env',
      identity: null,
      envVarsSet: config.activeGithubEnvVars(),
      keyringAlsoConfigured,
    };
  }
  if (status.kind === 'keyring') {
    return { service: 'github', source: 'keyring', identity: null };
  }
  if (status.kind === 'malformed') {
    return {
      service: 'github',
      source: 'corrupted',
      identity: "run 'aide login github' to reconfigure",
    };
  }

  return { service: 'github', source: 'not-configured', identity: null };
});

export const getWhoamiStatusEffect: Effect.Effect<
  WhoamiStatus[],
  WhoamiError,
  WhoamiConfigService
> = Effect.gen(function* () {
  return [
    yield* statusJiraEffect,
    yield* statusAdoEffect,
    yield* statusGithubEffect,
  ];
});

function formatStatus(s: WhoamiStatus): string {
  const pad = s.service.padEnd(8);
  switch (s.source) {
    case 'not-configured':
      return `${pad}  not configured`;
    case 'env':
      return `${pad}  env         ${s.identity ?? ''}`.trimEnd();
    case 'keyring':
      return `${pad}  keyring     ${s.identity ?? ''}`.trimEnd();
    case 'gh-cli':
      return `${pad}  gh CLI`;
    case 'corrupted':
      return `${pad}  corrupted   ${s.identity ?? ''}`.trimEnd();
  }
}

export function formatWhoamiOutput(
  statuses: readonly WhoamiStatus[],
  service?: ServiceName
): string {
  const filtered = service
    ? statuses.filter((s) => s.service === service)
    : [...statuses];
  const lines = filtered.map(formatStatus);
  const envSourced = filtered.filter((s) => s.source === 'env');
  if (envSourced.length > 0) {
    lines.push('');
    for (const s of envSourced) {
      if (s.keyringAlsoConfigured && s.envVarsSet && s.envVarsSet.length > 0) {
        lines.push(
          `tip: ${s.envVarsSet.join(', ')} override your stored keyring entry. Unset to use the keyring.`
        );
      } else {
        lines.push(
          `tip: run 'aide login ${s.service} --from-env' to store in the keyring`
        );
      }
    }
  }
  return lines.join('\n');
}

export function buildWhoamiOutputEffect(
  opts: { service?: ServiceName } = {}
): Effect.Effect<string, WhoamiError, WhoamiConfigService> {
  return Effect.map(getWhoamiStatusEffect, (statuses) =>
    formatWhoamiOutput(statuses, opts.service)
  );
}
