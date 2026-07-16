import { describe, expect, test } from 'vitest';
import { Effect, Layer } from 'effect';

import {
  buildWhoamiOutputEffect,
  getWhoamiStatusEffect,
  WhoamiConfigService,
  WhoamiConfigReadError,
  type WhoamiConfigServiceShape,
} from './whoami.js';

function makeLayer(
  overrides: Partial<WhoamiConfigServiceShape> = {}
): Layer.Layer<WhoamiConfigService> {
  const service: WhoamiConfigServiceShape = {
    probeJira: () => Effect.succeed({ kind: 'missing' }),
    probeAdo: () => Effect.succeed({ kind: 'missing' }),
    probeGithub: () => Effect.succeed({ kind: 'missing' }),
    isKeyringCredentialValid: () => Effect.succeed(false),
    activeJiraEnvVars: () => [],
    activeAdoEnvVars: () => [],
    activeGithubEnvVars: () => [],
    ...overrides,
  };
  return Layer.succeed(WhoamiConfigService, WhoamiConfigService.make(service));
}

describe('whoami Effect program', () => {
  test('runs from injected services without reading real env or keyring state', async () => {
    const layer = makeLayer({
      probeJira: () =>
        Effect.succeed({
          kind: 'env',
          value: {
            url: 'https://user:pass@example.atlassian.net',
            email: 'a@b.c',
            apiToken: 'super-secret-token',
          },
        }),
      isKeyringCredentialValid: (name) => Effect.succeed(name === 'jira'),
      activeJiraEnvVars: () => ['JIRA_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN'],
    });

    const output = await Effect.runPromise(
      buildWhoamiOutputEffect({ service: 'jira' }).pipe(Effect.provide(layer))
    );

    expect(output).toContain(
      'jira      env         a@b.c at https://example.atlassian.net'
    );
    expect(output).toContain(
      'JIRA_URL, JIRA_EMAIL, JIRA_API_TOKEN override your stored keyring entry'
    );
    expect(output).not.toContain('user:pass');
    expect(output).not.toContain('super-secret-token');
  });

  test('preserves service ordering in the status program', async () => {
    const statuses = await Effect.runPromise(
      getWhoamiStatusEffect.pipe(Effect.provide(makeLayer()))
    );

    expect(statuses.map((status) => status.service)).toEqual([
      'jira',
      'ado',
      'github',
    ]);
    expect(statuses.every((status) => status.source === 'not-configured')).toBe(
      true
    );
  });

  test('maps gh CLI availability status through the GitHub branch', async () => {
    const layer = makeLayer({
      probeGithub: () =>
        Effect.succeed({
          kind: 'env',
          value: { source: 'gh-cli' },
        }),
    });

    const output = await Effect.runPromise(
      buildWhoamiOutputEffect({ service: 'github' }).pipe(Effect.provide(layer))
    );

    expect(output).toBe('github    gh CLI');
  });

  test('keeps dependency failures in the typed Effect error channel', async () => {
    const error = new WhoamiConfigReadError({
      service: 'jira',
      operation: 'probing Jira configuration',
      originalError: new Error('keyring exploded'),
    });
    const layer = makeLayer({
      probeJira: () => Effect.fail(error),
    });

    const failure = await Effect.runPromise(
      getWhoamiStatusEffect.pipe(Effect.provide(layer), Effect.flip)
    );

    expect(failure).toBeInstanceOf(WhoamiConfigReadError);
    expect(failure).toMatchObject({
      _tag: 'WhoamiConfigReadError',
      service: 'jira',
      operation: 'probing Jira configuration',
    });
    expect(failure.message).toContain('keyring exploded');
  });
});
