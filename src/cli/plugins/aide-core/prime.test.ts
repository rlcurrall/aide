/**
 * Tests for the `prime` command's plugin-driven configuration detection.
 *
 * `buildPrimeOutput` is the seam: it reads prime contributions from host
 * services and returns the text that would be printed.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Cause, Context, Effect, Exit, Layer, Option } from 'effect';

import {
  buildPrimeOutput,
  buildPrimeOutputEffect,
  makePrimeCommandDescriptor,
} from './prime.js';
import {
  authenticatedGitHubAuthProbe,
  installMockSecrets,
  saveEnv,
  restoreEnv,
  unavailableGitHubAuthProbe,
  type Store,
} from '@lib/test-helpers.js';
import { createKeyringCommandRegistry } from '@cli/host/command-registry.js';
import {
  AideInternalHostServicesTag,
  createAideInternalHostServices,
  type AideInternalHostServices,
} from '@cli/host/runtime-context.js';
import { createAzureDevOpsPlugin } from '@cli/plugins/azure-devops/plugin.js';
import { createGitHubPlugin } from '@cli/plugins/github/plugin.js';
import { createJiraPlugin } from '@cli/plugins/jira/plugin.js';
import { pullRequestsPlugin } from '@cli/plugins/pull-requests/plugin.js';
import type { GitHubAuthProbe } from '@lib/gh-utils.js';
import { makeTestKeyring } from '@lib/auth-keyring.test-helper.js';
import { testGitHubAuthCatalogLayer } from '@lib/github-auth-catalog.test-helper.js';
import { KeyringService, type KeyringServiceShape } from '@lib/auth-keyring.js';
import {
  AIDE_PLUGIN_API_VERSION,
  PrimeContributionError,
  defineAidePlugin as definePublicAidePlugin,
} from '@aide/plugin-api';
import {
  defineAidePlugin,
  type AidePluginAuthStatus,
  type AidePrimeSection,
} from '@cli/host/plugin-descriptor.js';

const JIRA_VARS = [
  'JIRA_URL',
  'JIRA_EMAIL',
  'JIRA_USERNAME',
  'JIRA_API_TOKEN',
  'JIRA_TOKEN',
];
const ADO_VARS = ['AZURE_DEVOPS_ORG_URL', 'AZURE_DEVOPS_PAT'];
const GH_VARS = ['GITHUB_TOKEN', 'GH_TOKEN'];
let store: Store = new Map();

class AmbientPrimeTestService extends Context.Tag(
  'aide.test.AmbientPrimeTestService'
)<AmbientPrimeTestService, { readonly marker: string }>() {}

function createPrimeTestServices(
  opts: { readonly ghAuthProbe?: GitHubAuthProbe } = {}
): AideInternalHostServices {
  const registry = createKeyringCommandRegistry();
  registry
    .registerPlugin(createJiraPlugin())
    .registerPlugin(createGitHubPlugin({ ghAuthProbe: opts.ghAuthProbe }))
    .registerPlugin(createAzureDevOpsPlugin())
    .registerPlugin(pullRequestsPlugin);
  return createAideInternalHostServices(
    registry,
    makeTestKeyring(store).layer,
    testGitHubAuthCatalogLayer
  );
}

async function buildPrimeTestOutput(
  opts: { readonly ghAuthProbe?: GitHubAuthProbe } = {}
): Promise<string> {
  return buildPrimeOutput({ services: createPrimeTestServices(opts) });
}

describe('buildPrimeOutput', () => {
  let snap: Map<string, string | undefined>;
  let restore: () => void;

  beforeEach(() => {
    snap = saveEnv([...JIRA_VARS, ...ADO_VARS, ...GH_VARS]);
    Bun.env.AIDE_SECRET_SERVICE_OVERRIDE = 'aide';
    store = new Map();
    restore = installMockSecrets(store);
  });

  afterEach(() => {
    restoreEnv(snap);
    restore();
  });

  test('reports Jira not configured when neither env nor keyring has credentials', async () => {
    const output = await buildPrimeTestOutput({
      ghAuthProbe: unavailableGitHubAuthProbe,
    });
    expect(output).toMatch(/Jira: Not configured/i);
  });

  test('buildPrimeOutputEffect matches the compatibility wrapper output', async () => {
    const services = createPrimeTestServices({
      ghAuthProbe: authenticatedGitHubAuthProbe,
    });
    const effectOutput = await Effect.runPromise(
      buildPrimeOutputEffect().pipe(
        Effect.provideService(AideInternalHostServicesTag, services)
      )
    );
    const wrapperOutput = await buildPrimeOutput({ services });

    expect(effectOutput).toBe(wrapperOutput);
    expect(effectOutput).toContain('# aide - Jira & Git Hosting Integration');
    expect(effectOutput).toMatch(/Pull Requests: Configured/i);
  });

  test('primeCommandDescriptor returns the Effect-backed text result', async () => {
    const services = createPrimeTestServices({
      ghAuthProbe: authenticatedGitHubAuthProbe,
    });
    const descriptor = makePrimeCommandDescriptor();
    const result = await Effect.runPromise(
      descriptor
        .run({ $0: 'aide', _: [] })
        .pipe(Effect.provideService(AideInternalHostServicesTag, services))
    );
    expect(result).toMatchObject({
      _tag: 'Text',
      text: expect.stringContaining('# aide - Jira & Git Hosting Integration'),
    });
  });

  test('runs one trusted status batch with only its scoped keyring and restores caller context', async () => {
    const counts = { constructions: 0, acquisitions: 0, releases: 0 };
    const observations: {
      readonly label: string;
      readonly keyring: KeyringServiceShape;
      readonly internalHostVisible: boolean;
      readonly ambientVisible: boolean;
    }[] = [];
    const keyring: KeyringServiceShape = {
      get: () => Effect.succeed(null),
      set: () => Effect.void,
      delete: () => Effect.succeed(false),
    };
    const makeLayer = () => {
      counts.constructions += 1;
      return Layer.scoped(
        KeyringService,
        Effect.acquireRelease(
          Effect.sync(() => {
            counts.acquisitions += 1;
            return keyring;
          }),
          () =>
            Effect.sync(() => {
              counts.releases += 1;
            })
        )
      );
    };
    const status = (label: string) =>
      Effect.gen(function* () {
        const providedKeyring = yield* KeyringService;
        const internalHost = yield* Effect.serviceOption(
          AideInternalHostServicesTag
        );
        const ambient = yield* Effect.serviceOption(AmbientPrimeTestService);
        observations.push({
          label,
          keyring: providedKeyring,
          internalHostVisible: Option.isSome(internalHost),
          ambientVisible: Option.isSome(ambient),
        });
        return { state: 'configured' as const };
      });
    const registry = createKeyringCommandRegistry().registerPlugin(
      defineAidePlugin({
        id: 'trusted-status-authority',
        summary: 'Trusted status authority probe',
        commands: [],
        capabilities: {
          primeContribution: {
            status: [
              {
                groupId: 'trusted-primary',
                groupLabel: 'Trusted Primary',
                label: 'Trusted Primary',
                status: () => status('primary'),
              },
              {
                groupId: 'trusted-secondary',
                groupLabel: 'Trusted Secondary',
                label: 'Trusted Secondary',
                status: () => status('secondary'),
              },
            ],
          },
        },
      })
    );
    const keyringLayer = makeLayer();
    const services = createAideInternalHostServices(
      registry,
      keyringLayer,
      testGitHubAuthCatalogLayer
    );
    const callerAmbient = { marker: 'caller-ambient' };

    const caller = await Effect.runPromise(
      Effect.gen(function* () {
        const beforeHost = yield* AideInternalHostServicesTag;
        const beforeAmbient = yield* AmbientPrimeTestService;
        const result = yield* makePrimeCommandDescriptor().run({
          $0: 'aide',
          _: [],
        });
        const afterHost = yield* AideInternalHostServicesTag;
        const afterAmbient = yield* AmbientPrimeTestService;
        return {
          beforeHost,
          beforeAmbient,
          result,
          afterHost,
          afterAmbient,
        };
      }).pipe(
        Effect.provideService(AideInternalHostServicesTag, services),
        Effect.provideService(AmbientPrimeTestService, callerAmbient)
      )
    );

    expect(counts).toEqual({
      constructions: 1,
      acquisitions: 1,
      releases: 1,
    });
    expect(observations).toHaveLength(2);
    expect(
      [...observations]
        .sort((left, right) => left.label.localeCompare(right.label))
        .map((entry) => ({
          ...entry,
          keyring: entry.keyring === keyring,
        }))
    ).toEqual([
      {
        label: 'primary',
        keyring: true,
        internalHostVisible: false,
        ambientVisible: false,
      },
      {
        label: 'secondary',
        keyring: true,
        internalHostVisible: false,
        ambientVisible: false,
      },
    ]);
    expect(caller.beforeHost).toBe(services);
    expect(caller.afterHost).toBe(services);
    expect(caller.beforeAmbient).toBe(callerAmbient);
    expect(caller.afterAmbient).toBe(callerAmbient);
    expect(caller.result).toMatchObject({ _tag: 'Text' });
  });

  test('reports Jira configured when env vars are set', async () => {
    Bun.env.JIRA_URL = 'https://x.atlassian.net';
    Bun.env.JIRA_EMAIL = 'a@b.c';
    Bun.env.JIRA_API_TOKEN = 't';
    const output = await buildPrimeTestOutput({
      ghAuthProbe: unavailableGitHubAuthProbe,
    });
    expect(output).toMatch(/Jira: Configured/i);
  });

  test('reports Jira configured when only keyring has credentials', async () => {
    store.set(
      'aide:jira',
      JSON.stringify({
        url: 'https://x.atlassian.net',
        email: 'a@b.c',
        apiToken: 't',
      })
    );
    const output = await buildPrimeTestOutput({
      ghAuthProbe: unavailableGitHubAuthProbe,
    });
    expect(output).toMatch(/Jira: Configured/i);
  });

  test('omits the Configuration Status section when everything is configured', async () => {
    Bun.env.JIRA_URL = 'https://x.atlassian.net';
    Bun.env.JIRA_EMAIL = 'a@b.c';
    Bun.env.JIRA_API_TOKEN = 't';
    Bun.env.AZURE_DEVOPS_ORG_URL = 'https://dev.azure.com/x';
    Bun.env.AZURE_DEVOPS_PAT = 'p';
    const output = await buildPrimeTestOutput({
      ghAuthProbe: unavailableGitHubAuthProbe,
    });
    expect(output).not.toContain('Configuration Status');
  });

  test('reports Jira misconfigured when stored blob fails schema', async () => {
    store.set('aide:jira', JSON.stringify({ url: 'not-a-url' }));
    const output = await buildPrimeTestOutput({
      ghAuthProbe: unavailableGitHubAuthProbe,
    });
    expect(output).toMatch(/Jira: Misconfigured/i);
    expect(output).not.toMatch(/Jira: Configured$/m);
  });

  test('reports PR misconfigured when stored github token blob fails schema', async () => {
    store.set('aide:github', JSON.stringify({ wrongField: 'x' }));
    const output = await buildPrimeTestOutput({
      ghAuthProbe: unavailableGitHubAuthProbe,
    });
    expect(output).toMatch(/Pull Requests: Misconfigured/i);
  });

  test('still omits status section when everything is configured via env', async () => {
    Bun.env.JIRA_URL = 'https://x.atlassian.net';
    Bun.env.JIRA_EMAIL = 'a@b.c';
    Bun.env.JIRA_API_TOKEN = 't';
    Bun.env.AZURE_DEVOPS_ORG_URL = 'https://dev.azure.com/x';
    Bun.env.AZURE_DEVOPS_PAT = 'p';
    const output = await buildPrimeTestOutput({
      ghAuthProbe: unavailableGitHubAuthProbe,
    });
    expect(output).not.toContain('Configuration Status');
  });

  test('reports services as not configured when keyring is unreachable', async () => {
    restore();
    restore = installMockSecrets(store, 'get');
    const output = await buildPrimeTestOutput({
      ghAuthProbe: unavailableGitHubAuthProbe,
    });
    expect(output).toMatch(/Jira: Not configured/i);
    expect(output).toMatch(/Pull Requests: Not configured/i);
  });

  test('reports Jira configured when JIRA_USERNAME is set instead of JIRA_EMAIL', async () => {
    Bun.env.JIRA_URL = 'https://x.atlassian.net';
    Bun.env.JIRA_USERNAME = 'user';
    Bun.env.JIRA_API_TOKEN = 't';
    const output = await buildPrimeTestOutput({
      ghAuthProbe: unavailableGitHubAuthProbe,
    });
    expect(output).toMatch(/Jira: Configured/i);
  });

  test('reports Jira configured when JIRA_TOKEN is set instead of JIRA_API_TOKEN', async () => {
    Bun.env.JIRA_URL = 'https://x.atlassian.net';
    Bun.env.JIRA_EMAIL = 'a@b.c';
    Bun.env.JIRA_TOKEN = 't';
    const output = await buildPrimeTestOutput({
      ghAuthProbe: unavailableGitHubAuthProbe,
    });
    expect(output).toMatch(/Jira: Configured/i);
  });

  test('emits partial status section when Jira is configured but PR is not', async () => {
    Bun.env.JIRA_URL = 'https://x.atlassian.net';
    Bun.env.JIRA_EMAIL = 'a@b.c';
    Bun.env.JIRA_API_TOKEN = 't';
    const output = await buildPrimeTestOutput({
      ghAuthProbe: unavailableGitHubAuthProbe,
    });
    expect(output).toContain('Configuration Status');
    expect(output).toMatch(/Jira: Configured/i);
    expect(output).toMatch(/Pull Requests: Not configured/i);
  });

  test('emits partial status section when PR via gh is configured but Jira is not', async () => {
    const output = await buildPrimeTestOutput({
      ghAuthProbe: authenticatedGitHubAuthProbe,
    });
    expect(output).toContain('Configuration Status');
    expect(output).toMatch(/Jira: Not configured/i);
    expect(output).toMatch(/Pull Requests: Configured/i);
  });

  test('reports PR configured when GITHUB_TOKEN is set', async () => {
    Bun.env.GITHUB_TOKEN = 'ghp_xxx';
    const output = await buildPrimeTestOutput({
      ghAuthProbe: unavailableGitHubAuthProbe,
    });
    expect(output).toMatch(/Pull Requests: Configured/i);
  });

  test('reports PR configured when GH_TOKEN is set', async () => {
    Bun.env.GH_TOKEN = 'ghp_xxx';
    const output = await buildPrimeTestOutput({
      ghAuthProbe: unavailableGitHubAuthProbe,
    });
    expect(output).toMatch(/Pull Requests: Configured/i);
  });

  test('renders dynamically contributed status groups with plugin-owned guidance', async () => {
    const registry = createKeyringCommandRegistry();
    registry.registerPlugin(
      defineAidePlugin({
        id: 'external-tool',
        summary: 'External tool plugin',
        commands: [],
        capabilities: {
          primeContribution: {
            status: [
              {
                groupId: 'external-tool',
                groupLabel: 'External Tool',
                label: 'External Tool',
                messages: {
                  notConfigured: 'run `aide login external-tool`',
                },
                status: () => Effect.succeed({ state: 'not-configured' }),
              },
            ],
            sections: () =>
              Effect.succeed([
                {
                  id: 'external-tool-help',
                  body: '## External Tool',
                },
              ]),
          },
        },
      })
    );

    const output = await buildPrimeOutput({
      services: createAideInternalHostServices(
        registry,
        makeTestKeyring(store).layer,
        testGitHubAuthCatalogLayer
      ),
    });

    expect(output).toContain(
      '- External Tool: Not configured (run `aide login external-tool`)'
    );
    expect(output).toContain('## External Tool');
    expect(output).not.toContain('- Jira:');
    expect(output).not.toContain('- Pull Requests:');
  });

  test('isolates failing plugin status effects to that status group', async () => {
    const registry = createKeyringCommandRegistry();
    registry.registerPlugin(
      defineAidePlugin({
        id: 'unstable-tool',
        summary: 'Unstable tool plugin',
        commands: [],
        capabilities: {
          primeContribution: {
            status: [
              {
                groupId: 'unstable-tool',
                groupLabel: 'Unstable Tool',
                label: 'Unstable Tool',
                status: () => Effect.fail(new Error('status boom')),
              },
            ],
            sections: () =>
              Effect.succeed([
                {
                  id: 'unstable-tool-help',
                  body: '## Unstable Tool',
                },
              ]),
          },
        },
      })
    );

    const output = await buildPrimeOutput({
      services: createAideInternalHostServices(
        registry,
        makeTestKeyring(store).layer,
        testGitHubAuthCatalogLayer
      ),
    });

    expect(output).toContain(
      "- Unstable Tool: Misconfigured (Plugin 'unstable-tool' Unstable Tool status is unavailable: status Effect execution failed)"
    );
    expect(output).not.toContain('status boom');
    expect(output).toContain('## Unstable Tool');
  });

  test('redacts invalid external Prime status callbacks and returns in production output', async () => {
    const pluginId = 'external-status-boundary';
    const label = 'External Status Boundary';
    const forgedSecret = 'SECRET-FORGED-STATUS-BOUNDARY';
    const forgedSecretKey = `attacker-${forgedSecret}`;
    let forgedReads = 0;
    const forged = new PrimeContributionError({
      pluginId: 'valid-attacker-construction',
      contribution: 'sections',
      reason: 'invalid-result',
    });
    Object.assign(forged as unknown as Record<string, unknown>, {
      pluginId: forgedSecret,
      reason: forgedSecret,
      diagnostic: forgedSecret,
      cause: new Error(forgedSecret),
      [forgedSecretKey]: { nested: forgedSecret },
    });
    Object.defineProperty(forged, `accessor-${forgedSecret}`, {
      enumerable: true,
      get: () => {
        forgedReads += 1;
        return forgedSecret;
      },
    });
    Object.defineProperty(forged, 'message', {
      configurable: true,
      get: () => {
        forgedReads += 1;
        return forgedSecret;
      },
    });
    Object.defineProperty(forged, Symbol.toPrimitive, {
      value: () => {
        forgedReads += 1;
        return forgedSecret;
      },
    });

    let callbackThrow: unknown | undefined;
    let callbackResult: unknown = Effect.succeed({ state: 'configured' });
    const registry = createKeyringCommandRegistry();
    registry.registerExternalPlugin(
      definePublicAidePlugin({
        id: pluginId,
        summary: 'External Prime status boundary probe',
        commands: [],
        capabilities: {
          primeContribution: {
            status: [
              {
                groupId: pluginId,
                groupLabel: label,
                label,
                status: (() => {
                  if (callbackThrow !== undefined) throw callbackThrow;
                  return callbackResult;
                }) as unknown as () => Effect.Effect<AidePluginAuthStatus>,
              },
            ],
          },
        },
      }),
      {
        manifest: {
          id: pluginId,
          version: '1.0.0',
          aidePluginApiVersion: AIDE_PLUGIN_API_VERSION,
          capabilities: ['prime-contribution'],
        },
      }
    );
    const services = createAideInternalHostServices(
      registry,
      makeTestKeyring(store).layer,
      testGitHubAuthCatalogLayer
    );
    const render = () => buildPrimeOutput({ services });
    const ordinaryCallbackSecret = 'SECRET-ORDINARY-STATUS-CALLBACK';
    const ordinaryRecognitionSecret = 'SECRET-ORDINARY-STATUS-RECOGNITION';

    for (const testCase of [
      {
        name: 'ordinary callback throw',
        thrown: new Error(ordinaryCallbackSecret),
        secrets: [ordinaryCallbackSecret],
      },
      {
        name: 'forged callback throw',
        thrown: forged,
        secrets: [forgedSecret, forgedSecretKey],
      },
    ]) {
      callbackThrow = testCase.thrown;
      const output = await render();
      expect(output, testCase.name).toContain(
        `- ${label}: Misconfigured (Plugin '${pluginId}' ${label} status is unavailable: status callback failed)`
      );
      for (const secret of testCase.secrets) {
        expect(output, testCase.name).not.toContain(secret);
      }
    }

    callbackThrow = undefined;
    const { proxy: revoked, revoke } = Proxy.revocable({}, {});
    revoke();
    for (const testCase of [
      {
        name: 'ordinary recognition throw',
        value: new Proxy(
          {},
          {
            has() {
              throw new Error(ordinaryRecognitionSecret);
            },
          }
        ),
        secrets: [ordinaryRecognitionSecret],
      },
      {
        name: 'forged recognition throw',
        value: new Proxy(
          {},
          {
            has() {
              throw forged;
            },
          }
        ),
        secrets: [forgedSecret, forgedSecretKey],
      },
      { name: 'revoked Proxy', value: revoked, secrets: [] },
      { name: 'primitive return', value: 0, secrets: [] },
      { name: 'plain-object return', value: {}, secrets: [] },
    ]) {
      callbackResult = testCase.value;
      const output = await render();
      expect(output, testCase.name).toContain(
        `- ${label}: Misconfigured (Plugin '${pluginId}' ${label} status is unavailable: status callback returned an invalid Effect)`
      );
      for (const secret of testCase.secrets) {
        expect(output, testCase.name).not.toContain(secret);
      }
    }
    expect(forgedReads).toBe(0);

    let hostilePipeAccesses = 0;
    const configured = Effect.succeed({ state: 'configured' as const });
    for (const testCase of [
      {
        name: 'hostile pipe getter',
        value: new Proxy(configured, {
          get(target, property, receiver) {
            if (property === 'pipe') {
              hostilePipeAccesses += 1;
              throw new Error('SECRET-STATUS-PIPE-GETTER');
            }
            return Reflect.get(target, property, receiver);
          },
        }),
      },
      {
        name: 'hostile pipe invocation',
        value: new Proxy(configured, {
          get(target, property, receiver) {
            if (property === 'pipe') {
              hostilePipeAccesses += 1;
              return () => {
                throw new Error('SECRET-STATUS-PIPE-INVOCATION');
              };
            }
            return Reflect.get(target, property, receiver);
          },
        }),
      },
    ]) {
      callbackResult = testCase.value;
      const output = await render();
      expect(output, testCase.name).toContain(
        `- ${label}: Misconfigured (Plugin '${pluginId}' ${label} status is unavailable: status callback returned an invalid Effect)`
      );
      expect(output, testCase.name).not.toContain('SECRET-STATUS-PIPE');
    }
    expect(hostilePipeAccesses).toBe(0);
  });

  test('tolerates redacted external Prime status failures and defects while preserving interruption', async () => {
    const pluginId = 'external-status-execution';
    const label = 'External Status Execution';
    let callbackResult: Effect.Effect<AidePluginAuthStatus, unknown> =
      Effect.succeed({ state: 'configured' });
    const registry = createKeyringCommandRegistry();
    registry.registerExternalPlugin(
      definePublicAidePlugin({
        id: pluginId,
        summary: 'External Prime status execution probe',
        commands: [],
        capabilities: {
          primeContribution: {
            status: [
              {
                groupId: pluginId,
                groupLabel: label,
                label,
                status: () => callbackResult,
              },
            ],
          },
        },
      }),
      {
        manifest: {
          id: pluginId,
          version: '1.0.0',
          aidePluginApiVersion: AIDE_PLUGIN_API_VERSION,
          capabilities: ['prime-contribution'],
        },
      }
    );
    const services = createAideInternalHostServices(
      registry,
      makeTestKeyring(store).layer,
      testGitHubAuthCatalogLayer
    );
    const fallback = `- ${label}: Misconfigured (Plugin '${pluginId}' ${label} status is unavailable: status Effect execution failed)`;

    for (const testCase of [
      {
        name: 'typed failure',
        effect: Effect.fail('SECRET-STATUS-TYPED-FAILURE'),
        secret: 'SECRET-STATUS-TYPED-FAILURE',
      },
      {
        name: 'defect',
        effect: Effect.die(new Error('SECRET-STATUS-DEFECT')),
        secret: 'SECRET-STATUS-DEFECT',
      },
    ]) {
      callbackResult = testCase.effect;
      const output = await buildPrimeOutput({ services });
      expect(output, testCase.name).toContain(fallback);
      expect(output, testCase.name).not.toContain(testCase.secret);
    }

    callbackResult = Effect.interrupt;
    const interruptionExit = await Effect.runPromiseExit(
      buildPrimeOutputEffect().pipe(
        Effect.provideService(AideInternalHostServicesTag, services)
      )
    );
    expect(Exit.isFailure(interruptionExit)).toBe(true);
    if (Exit.isFailure(interruptionExit)) {
      expect(Cause.isInterrupted(interruptionExit.cause)).toBe(true);
      expect(Cause.isInterruptedOnly(interruptionExit.cause)).toBe(true);
    }
  });

  test('drops malformed contributed sections without failing prime', async () => {
    const registry = createKeyringCommandRegistry();
    registry.registerPlugin(
      defineAidePlugin({
        id: 'malformed-sections-tool',
        summary: 'Malformed sections plugin',
        commands: [],
        capabilities: {
          primeContribution: {
            sections: () =>
              Effect.succeed([
                {
                  id: '',
                  body: '## Hidden Bad Section',
                },
                {
                  id: 'good-section',
                  body: '## Good Section',
                },
              ] as AidePrimeSection[]),
          },
        },
      })
    );

    const output = await buildPrimeOutput({
      services: createAideInternalHostServices(
        registry,
        makeTestKeyring(store).layer,
        testGitHubAuthCatalogLayer
      ),
    });

    expect(output).toContain('## Good Section');
    expect(output).not.toContain('## Hidden Bad Section');
  });

  test('keeps rendering other Prime sections when contributions fail', async () => {
    const registry = createKeyringCommandRegistry();
    const contribution = (
      id: string,
      sections: () => Effect.Effect<readonly AidePrimeSection[], unknown, never>
    ) =>
      defineAidePlugin({
        id,
        summary: `${id} Prime contribution`,
        commands: [],
        capabilities: { primeContribution: { sections } },
      });

    registry.registerPlugin(
      contribution('throwing-prime-sections', () => {
        throw new Error('Prime section construction failed');
      })
    );
    registry.registerPlugin(
      contribution('failed-prime-sections-effect', () =>
        Effect.fail(new Error('Prime section Effect failed'))
      )
    );
    registry.registerPlugin(
      contribution(
        'non-effect-prime-sections',
        (() => []) as unknown as () => Effect.Effect<
          readonly AidePrimeSection[],
          unknown,
          never
        >
      )
    );
    registry.registerPlugin(
      contribution('healthy-prime-sections', () =>
        Effect.succeed([
          { id: 'healthy-prime-section', body: '## Healthy Prime Section' },
        ])
      )
    );

    const output = await buildPrimeOutput({
      services: createAideInternalHostServices(
        registry,
        makeTestKeyring(store).layer,
        testGitHubAuthCatalogLayer
      ),
    });

    expect(output).toContain('## Healthy Prime Section');
  });

  test('drops non-exact Prime arrays without invoking hostile collection protocols or accepting attacker output', async () => {
    const invocations = { map: 0, flatMap: 0, iterator: 0 };
    const hostile = [
      { id: 'valid-hostile-section', body: '## Valid Hostile Section' },
    ] as AidePrimeSection[];
    Object.defineProperties(hostile, {
      map: {
        value: () => {
          invocations.map += 1;
          return [{ id: 'attacker-map', body: '## ATTACKER MAP' }];
        },
      },
      flatMap: {
        value: () => {
          invocations.flatMap += 1;
          return [{ id: 'attacker-flat-map', body: '## ATTACKER FLATMAP' }];
        },
      },
      [Symbol.iterator]: {
        value: () => {
          invocations.iterator += 1;
          throw new Error('attacker iterator');
        },
      },
    });
    const registry = createKeyringCommandRegistry();
    registry.registerPlugin(
      defineAidePlugin({
        id: 'hostile-protocol-prime',
        summary: 'Hostile protocol Prime contribution',
        commands: [],
        capabilities: {
          primeContribution: {
            sections: () => Effect.succeed(hostile),
          },
        },
      })
    );
    registry.registerPlugin(
      defineAidePlugin({
        id: 'healthy-after-hostile-protocol-prime',
        summary: 'Healthy Prime contribution',
        commands: [],
        capabilities: {
          primeContribution: {
            sections: () =>
              Effect.succeed([
                {
                  id: 'healthy-after-hostile',
                  body: '## Healthy After Hostile',
                },
              ]),
          },
        },
      })
    );

    const output = await buildPrimeOutput({
      services: createAideInternalHostServices(
        registry,
        makeTestKeyring(store).layer,
        testGitHubAuthCatalogLayer
      ),
    });

    expect(invocations).toEqual({ map: 0, flatMap: 0, iterator: 0 });
    expect(output).not.toContain('## Valid Hostile Section');
    expect(output).toContain('## Healthy After Hostile');
    expect(output).not.toContain('ATTACKER MAP');
    expect(output).not.toContain('ATTACKER FLATMAP');
  });

  test('drops arrays with throwing flatMap overrides without suppressing healthy Prime contributions', async () => {
    let flatMapCalls = 0;
    const hostile = [
      { id: 'throwing-flat-map-valid', body: '## Throwing FlatMap Valid' },
    ] as AidePrimeSection[];
    Object.defineProperty(hostile, 'flatMap', {
      value: () => {
        flatMapCalls += 1;
        throw new Error('SECRET-THROWING-FLATMAP');
      },
    });
    const registry = createKeyringCommandRegistry();
    registry.registerPlugin(
      defineAidePlugin({
        id: 'throwing-flat-map-prime',
        summary: 'Throwing flatMap Prime contribution',
        commands: [],
        capabilities: {
          primeContribution: { sections: () => Effect.succeed(hostile) },
        },
      })
    );
    registry.registerPlugin(
      defineAidePlugin({
        id: 'healthy-after-throwing-flat-map',
        summary: 'Healthy Prime contribution',
        commands: [],
        capabilities: {
          primeContribution: {
            sections: () =>
              Effect.succeed([
                {
                  id: 'healthy-after-throwing-flat-map',
                  body: '## Healthy After Throwing FlatMap',
                },
              ]),
          },
        },
      })
    );

    const output = await buildPrimeOutput({
      services: createAideInternalHostServices(
        registry,
        makeTestKeyring(store).layer,
        testGitHubAuthCatalogLayer
      ),
    });

    expect(flatMapCalls).toBe(0);
    expect(output).not.toContain('## Throwing FlatMap Valid');
    expect(output).toContain('## Healthy After Throwing FlatMap');
  });

  test('discards sparse and unreadable Prime entries while retaining healthy entries and contributions', async () => {
    const hostile: AidePrimeSection[] = [];
    hostile.length = 4;
    hostile[0] = {
      id: 'healthy-before-unreadable',
      body: '## Healthy Before Unreadable',
    };
    Object.defineProperty(hostile, '2', {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error('SECRET-UNREADABLE-PRIME-ENTRY');
      },
    });
    hostile[3] = {
      id: 'healthy-after-unreadable',
      body: '## Healthy After Unreadable',
    };
    const registry = createKeyringCommandRegistry();
    registry.registerPlugin(
      defineAidePlugin({
        id: 'sparse-unreadable-prime',
        summary: 'Sparse unreadable Prime contribution',
        commands: [],
        capabilities: {
          primeContribution: { sections: () => Effect.succeed(hostile) },
        },
      })
    );
    registry.registerPlugin(
      defineAidePlugin({
        id: 'unreadable-container-prime',
        summary: 'Unreadable outer Prime contribution',
        commands: [],
        capabilities: {
          primeContribution: {
            sections: () =>
              Effect.succeed(
                new Proxy(
                  [
                    {
                      id: 'must-not-escape-unreadable-container',
                      body: '## Must Not Escape Unreadable Container',
                    },
                  ],
                  {
                    get(target, property, receiver) {
                      if (property === 'length') {
                        throw new Error('SECRET-UNREADABLE-CONTAINER');
                      }
                      return Reflect.get(target, property, receiver);
                    },
                  }
                )
              ),
          },
        },
      })
    );
    registry.registerPlugin(
      defineAidePlugin({
        id: 'healthy-beside-unreadable-prime',
        summary: 'Healthy Prime contribution',
        commands: [],
        capabilities: {
          primeContribution: {
            sections: () =>
              Effect.succeed([
                {
                  id: 'healthy-beside-unreadable',
                  body: '## Healthy Beside Unreadable',
                },
              ]),
          },
        },
      })
    );

    const output = await buildPrimeOutput({
      services: createAideInternalHostServices(
        registry,
        makeTestKeyring(store).layer,
        testGitHubAuthCatalogLayer
      ),
    });

    expect(output).toContain('## Healthy Before Unreadable');
    expect(output).toContain('## Healthy After Unreadable');
    expect(output).toContain('## Healthy Beside Unreadable');
    expect(output).not.toContain('SECRET-UNREADABLE-PRIME-ENTRY');
    expect(output).not.toContain('Must Not Escape Unreadable Container');
    expect(output).not.toContain('SECRET-UNREADABLE-CONTAINER');
  });

  test('drops forged typed getter failures while rendering later entries and external contributions', async () => {
    const secret = 'SECRET-TOLERANT-FORGED-PRIME';
    const forged = new PrimeContributionError({
      pluginId: 'valid-attacker-construction',
      contribution: 'sections',
      reason: 'invalid-result',
      diagnostic: 'entry-unreadable',
      entryIndex: 1,
    });
    Object.assign(forged as unknown as Record<string, unknown>, {
      pluginId: secret,
      reason: secret,
      diagnostic: secret,
    });
    Object.defineProperty(forged, `attacker-${secret}`, {
      enumerable: true,
      value: { nested: secret },
    });
    const hostile: AidePrimeSection[] = [
      { id: 'before-forged-getter', body: '## Before Forged Getter' },
    ];
    hostile.length = 3;
    Object.defineProperty(hostile, '1', {
      enumerable: true,
      get: () => ({
        get id() {
          throw forged;
        },
        body: 'must not render',
      }),
    });
    hostile[2] = {
      id: 'after-forged-getter',
      body: '## After Forged Getter',
    };
    const registry = createKeyringCommandRegistry();
    registry.registerExternalPlugin(
      definePublicAidePlugin({
        id: 'external-tolerant-forged-prime',
        summary: 'External tolerant forged Prime probe',
        commands: [],
        capabilities: {
          primeContribution: { sections: () => Effect.succeed(hostile) },
        },
      }),
      {
        manifest: {
          id: 'external-tolerant-forged-prime',
          version: '1.0.0',
          aidePluginApiVersion: AIDE_PLUGIN_API_VERSION,
          capabilities: ['prime-contribution'],
        },
      }
    );
    registry.registerExternalPlugin(
      definePublicAidePlugin({
        id: 'external-healthy-after-forged-prime',
        summary: 'External healthy Prime probe',
        commands: [],
        capabilities: {
          primeContribution: {
            sections: () =>
              Effect.succeed([
                {
                  id: 'healthy-after-forged-contribution',
                  body: '## Healthy After Forged Contribution',
                },
              ]),
          },
        },
      }),
      {
        manifest: {
          id: 'external-healthy-after-forged-prime',
          version: '1.0.0',
          aidePluginApiVersion: AIDE_PLUGIN_API_VERSION,
          capabilities: ['prime-contribution'],
        },
      }
    );

    const output = await buildPrimeOutput({
      services: createAideInternalHostServices(
        registry,
        makeTestKeyring(store).layer,
        testGitHubAuthCatalogLayer
      ),
    });

    expect(output).toContain('## Before Forged Getter');
    expect(output).toContain('## After Forged Getter');
    expect(output).toContain('## Healthy After Forged Contribution');
    expect(output).not.toContain('must not render');
    expect(output).not.toContain(secret);
  });
});
