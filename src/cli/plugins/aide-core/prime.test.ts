/**
 * Tests for the `prime` command's plugin-driven configuration detection.
 *
 * `buildPrimeOutput` is the seam: it reads prime contributions from host
 * services and returns the text that would be printed.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Effect } from 'effect';

import {
  buildPrimeOutput,
  buildPrimeOutputEffect,
  makePrimeCommandDescriptor,
} from './prime.js';
import {
  installMockSecrets,
  saveEnv,
  restoreEnv,
  type Store,
} from '@lib/test-helpers.js';
import { createCommandRegistry } from '@cli/host/command-registry.js';
import {
  AideHostServicesTag,
  createAideHostServices,
  type AideHostServices,
} from '@cli/host/runtime-context.js';
import { createAzureDevOpsPlugin } from '@cli/plugins/azure-devops/plugin.js';
import { createGitHubPlugin } from '@cli/plugins/github/plugin.js';
import { createJiraPlugin } from '@cli/plugins/jira/plugin.js';
import { pullRequestsPlugin } from '@cli/plugins/pull-requests/plugin.js';
import {
  defineAidePlugin,
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

function createPrimeTestServices(
  opts: { readonly ghAvailable?: () => boolean } = {}
): AideHostServices {
  const registry = createCommandRegistry();
  registry
    .registerPlugin(createJiraPlugin())
    .registerPlugin(createGitHubPlugin({ ghAvailable: opts.ghAvailable }))
    .registerPlugin(createAzureDevOpsPlugin())
    .registerPlugin(pullRequestsPlugin);
  return createAideHostServices(registry);
}

async function buildPrimeTestOutput(
  opts: { readonly ghAvailable?: () => boolean } = {}
): Promise<string> {
  return buildPrimeOutput({ services: createPrimeTestServices(opts) });
}

describe('buildPrimeOutput', () => {
  let snap: Map<string, string | undefined>;
  let store: Store;
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
    const output = await buildPrimeTestOutput({ ghAvailable: () => false });
    expect(output).toMatch(/Jira: Not configured/i);
  });

  test('buildPrimeOutputEffect matches the compatibility wrapper output', async () => {
    const services = createPrimeTestServices({ ghAvailable: () => true });
    const effectOutput = await Effect.runPromise(
      buildPrimeOutputEffect().pipe(
        Effect.provideService(AideHostServicesTag, services)
      )
    );
    const wrapperOutput = await buildPrimeOutput({ services });

    expect(effectOutput).toBe(wrapperOutput);
    expect(effectOutput).toContain('# aide - Jira & Git Hosting Integration');
    expect(effectOutput).toMatch(/Pull Requests: Configured/i);
  });

  test('primeCommandDescriptor returns the Effect-backed text result', async () => {
    const services = createPrimeTestServices({ ghAvailable: () => true });
    const descriptor = makePrimeCommandDescriptor();
    const result = await Effect.runPromise(
      descriptor
        .run({ $0: 'aide', _: [] })
        .pipe(Effect.provideService(AideHostServicesTag, services))
    );
    expect(result).toMatchObject({
      _tag: 'Text',
      text: expect.stringContaining('# aide - Jira & Git Hosting Integration'),
    });
  });

  test('reports Jira configured when env vars are set', async () => {
    Bun.env.JIRA_URL = 'https://x.atlassian.net';
    Bun.env.JIRA_EMAIL = 'a@b.c';
    Bun.env.JIRA_API_TOKEN = 't';
    const output = await buildPrimeTestOutput({ ghAvailable: () => false });
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
    const output = await buildPrimeTestOutput({ ghAvailable: () => false });
    expect(output).toMatch(/Jira: Configured/i);
  });

  test('omits the Configuration Status section when everything is configured', async () => {
    Bun.env.JIRA_URL = 'https://x.atlassian.net';
    Bun.env.JIRA_EMAIL = 'a@b.c';
    Bun.env.JIRA_API_TOKEN = 't';
    Bun.env.AZURE_DEVOPS_ORG_URL = 'https://dev.azure.com/x';
    Bun.env.AZURE_DEVOPS_PAT = 'p';
    const output = await buildPrimeTestOutput({ ghAvailable: () => false });
    expect(output).not.toContain('Configuration Status');
  });

  test('reports Jira misconfigured when stored blob fails schema', async () => {
    store.set('aide:jira', JSON.stringify({ url: 'not-a-url' }));
    const output = await buildPrimeTestOutput({ ghAvailable: () => false });
    expect(output).toMatch(/Jira: Misconfigured/i);
    expect(output).not.toMatch(/Jira: Configured$/m);
  });

  test('reports PR misconfigured when stored github token blob fails schema', async () => {
    store.set('aide:github', JSON.stringify({ wrongField: 'x' }));
    const output = await buildPrimeTestOutput({ ghAvailable: () => false });
    expect(output).toMatch(/Pull Requests: Misconfigured/i);
  });

  test('still omits status section when everything is configured via env', async () => {
    Bun.env.JIRA_URL = 'https://x.atlassian.net';
    Bun.env.JIRA_EMAIL = 'a@b.c';
    Bun.env.JIRA_API_TOKEN = 't';
    Bun.env.AZURE_DEVOPS_ORG_URL = 'https://dev.azure.com/x';
    Bun.env.AZURE_DEVOPS_PAT = 'p';
    const output = await buildPrimeTestOutput({ ghAvailable: () => false });
    expect(output).not.toContain('Configuration Status');
  });

  test('reports services as not configured when keyring is unreachable', async () => {
    restore();
    restore = installMockSecrets(store, 'get');
    const output = await buildPrimeTestOutput({ ghAvailable: () => false });
    expect(output).toMatch(/Jira: Not configured/i);
    expect(output).toMatch(/Pull Requests: Not configured/i);
  });

  test('reports Jira configured when JIRA_USERNAME is set instead of JIRA_EMAIL', async () => {
    Bun.env.JIRA_URL = 'https://x.atlassian.net';
    Bun.env.JIRA_USERNAME = 'user';
    Bun.env.JIRA_API_TOKEN = 't';
    const output = await buildPrimeTestOutput({ ghAvailable: () => false });
    expect(output).toMatch(/Jira: Configured/i);
  });

  test('reports Jira configured when JIRA_TOKEN is set instead of JIRA_API_TOKEN', async () => {
    Bun.env.JIRA_URL = 'https://x.atlassian.net';
    Bun.env.JIRA_EMAIL = 'a@b.c';
    Bun.env.JIRA_TOKEN = 't';
    const output = await buildPrimeTestOutput({ ghAvailable: () => false });
    expect(output).toMatch(/Jira: Configured/i);
  });

  test('emits partial status section when Jira is configured but PR is not', async () => {
    Bun.env.JIRA_URL = 'https://x.atlassian.net';
    Bun.env.JIRA_EMAIL = 'a@b.c';
    Bun.env.JIRA_API_TOKEN = 't';
    const output = await buildPrimeTestOutput({ ghAvailable: () => false });
    expect(output).toContain('Configuration Status');
    expect(output).toMatch(/Jira: Configured/i);
    expect(output).toMatch(/Pull Requests: Not configured/i);
  });

  test('emits partial status section when PR via gh is configured but Jira is not', async () => {
    const output = await buildPrimeTestOutput({ ghAvailable: () => true });
    expect(output).toContain('Configuration Status');
    expect(output).toMatch(/Jira: Not configured/i);
    expect(output).toMatch(/Pull Requests: Configured/i);
  });

  test('reports PR configured when GITHUB_TOKEN is set', async () => {
    Bun.env.GITHUB_TOKEN = 'ghp_xxx';
    const output = await buildPrimeTestOutput({ ghAvailable: () => false });
    expect(output).toMatch(/Pull Requests: Configured/i);
  });

  test('reports PR configured when GH_TOKEN is set', async () => {
    Bun.env.GH_TOKEN = 'ghp_xxx';
    const output = await buildPrimeTestOutput({ ghAvailable: () => false });
    expect(output).toMatch(/Pull Requests: Configured/i);
  });

  test('renders dynamically contributed status groups with plugin-owned guidance', async () => {
    const registry = createCommandRegistry();
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
      services: createAideHostServices(registry),
    });

    expect(output).toContain(
      '- External Tool: Not configured (run `aide login external-tool`)'
    );
    expect(output).toContain('## External Tool');
    expect(output).not.toContain('- Jira:');
    expect(output).not.toContain('- Pull Requests:');
  });

  test('isolates failing plugin status effects to that status group', async () => {
    const registry = createCommandRegistry();
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
      services: createAideHostServices(registry),
    });

    expect(output).toContain(
      "- Unstable Tool: Misconfigured (Plugin 'unstable-tool' Unstable Tool status is unavailable: status boom)"
    );
    expect(output).toContain('## Unstable Tool');
  });

  test('drops malformed contributed sections without failing prime', async () => {
    const registry = createCommandRegistry();
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
      services: createAideHostServices(registry),
    });

    expect(output).toContain('## Good Section');
    expect(output).not.toContain('## Hidden Bad Section');
  });
});
