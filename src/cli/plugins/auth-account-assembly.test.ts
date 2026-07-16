import { describe, expect, test } from 'bun:test';

import {
  authIndexScopeName,
  normalizeAuthStoreScope,
} from '@lib/auth-index-codec.js';

import {
  assembleBuiltinAuthAccounts,
  type BuiltinAuthAccountCandidate,
  type BuiltinAuthAccountStorageKind,
} from './auth-account-assembly.js';

const INVALID_CANDIDATE_MESSAGE = 'Invalid built-in auth account candidate.';
const MAX_PRESENTATION_IDENTITY_FIELD_LENGTH = 256;
const MAX_PRESENTATION_METADATA_STRING_LENGTH = 1_024;

function acceptsCandidate(_candidate: BuiltinAuthAccountCandidate): void {}

function compileTimeCandidateConstraints(): void {
  const jiraGhCli = {
    scope: {
      providerId: 'jira',
      host: 'example.atlassian.net',
      account: 'dev@example.com',
    },
    source: { kind: 'external', name: 'gh-cli', active: true },
  } as const;
  const azureDevOpsGhCli = {
    scope: {
      providerId: 'azure-devops',
      host: 'dev.azure.com',
      org: 'acme',
    },
    source: { kind: 'external', name: 'gh-cli', active: true },
  } as const;
  const githubEnvironmentAccount = {
    scope: { providerId: 'github', host: 'github.com', account: 'octocat' },
    source: { kind: 'env', name: 'environment' },
  } as const;
  const githubLegacyAccount = {
    scope: { providerId: 'github', host: 'github.com', account: 'octocat' },
    source: { kind: 'keyring', name: 'keyring', storageKind: 'legacy' },
  } as const;
  const githubLegacyEnterpriseHost = {
    scope: { providerId: 'github', host: 'github.example.com' },
    source: { kind: 'keyring', name: 'keyring', storageKind: 'legacy' },
  } as const;
  const githubExternalHostOnly = {
    scope: { providerId: 'github', host: 'github.com' },
    source: { kind: 'external', name: 'gh-cli', active: true },
  } as const;
  const githubExternalInactive = {
    scope: { providerId: 'github', host: 'github.com', account: 'octocat' },
    source: { kind: 'external', name: 'gh-cli', active: false },
  } as const;

  // @ts-expect-error Jira candidates cannot be sourced from the GitHub CLI.
  acceptsCandidate(jiraGhCli);
  // @ts-expect-error Azure DevOps candidates cannot be sourced from the GitHub CLI.
  acceptsCandidate(azureDevOpsGhCli);
  // @ts-expect-error GitHub environment credentials prove only a host.
  acceptsCandidate(githubEnvironmentAccount);
  // @ts-expect-error A legacy GitHub credential never proves an account.
  acceptsCandidate(githubLegacyAccount);
  // @ts-expect-error A legacy GitHub credential is limited to github.com.
  acceptsCandidate(githubLegacyEnterpriseHost);
  // @ts-expect-error GitHub CLI candidates require an account-qualified scope.
  acceptsCandidate(githubExternalHostOnly);
  // @ts-expect-error GitHub CLI candidates require literal healthy active proof.
  acceptsCandidate(githubExternalInactive);
}

void compileTimeCandidateConstraints;

function capturedCandidateError(candidate: unknown): TypeError {
  try {
    assembleBuiltinAuthAccounts([candidate as BuiltinAuthAccountCandidate]);
  } catch (error) {
    expect(error).toBeInstanceOf(TypeError);
    if (!(error instanceof TypeError)) throw error;
    expect(error.message).toBe(INVALID_CANDIDATE_MESSAGE);
    expect(Reflect.has(error, 'cause')).toBe(false);
    return error;
  }
  throw new Error('Expected an invalid built-in auth account candidate.');
}

function expectInvalidCandidate(
  candidate: unknown,
  rawValues: readonly string[] = []
): void {
  const first = capturedCandidateError(candidate);
  const second = capturedCandidateError(candidate);
  expect(first).not.toBe(second);
  const retained = `${first.message}\n${first.stack ?? ''}\n${JSON.stringify(first)}`;
  for (const rawValue of rawValues) expect(retained).not.toContain(rawValue);
}

function* permutations<T>(values: readonly T[]): Generator<readonly T[]> {
  if (values.length <= 1) {
    yield [...values];
    return;
  }
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === undefined) continue;
    const rest = [...values.slice(0, index), ...values.slice(index + 1)];
    for (const permutation of permutations(rest)) {
      yield [value, ...permutation];
    }
  }
}

function assertDeeplyFrozenAccounts(
  accounts: ReturnType<typeof assembleBuiltinAuthAccounts>
): void {
  if (!Object.isFrozen(accounts)) throw new Error('account list is mutable');
  for (const account of accounts) {
    if (!Object.isFrozen(account)) throw new Error('account is mutable');
    if (account.scope === undefined || !Object.isFrozen(account.scope)) {
      throw new Error('account scope is missing or mutable');
    }
    if (
      account.metadata === undefined ||
      !Object.isFrozen(account.metadata) ||
      account.scope.metadata === undefined ||
      !Object.isFrozen(account.scope.metadata)
    ) {
      throw new Error('account metadata is missing or mutable');
    }
    if (
      account.id !== account.scope.id ||
      account.providerId !== account.scope.providerId ||
      account.label !== account.scope.label ||
      account.sourceKind !== account.scope.sourceKind ||
      account.metadata !== account.scope.metadata
    ) {
      throw new Error('account and scope identity diverged');
    }
    const normalized = normalizeAuthStoreScope(
      account.providerId ?? '',
      account.scope
    );
    if (normalized === null || authIndexScopeName(normalized) !== account.id) {
      throw new Error('account id diverged from canonical auth identity');
    }
  }
}

describe('built-in auth account assembly', () => {
  test('canonicalizes every built-in scope and derives stable ordered identities', () => {
    const accounts = assembleBuiltinAuthAccounts([
      {
        scope: {
          providerId: 'jira',
          host: ' HTTPS://EXAMPLE.atlassian.net/path ',
          account: ' Dev@Example.COM ',
        },
        source: { kind: 'keyring', name: 'keyring', storageKind: 'scoped' },
        defaultProject: ' CORE ',
      },
      {
        scope: {
          providerId: 'github',
          host: ' GITHUB.COM ',
          account: ' OctoCat ',
        },
        source: { kind: 'external', name: 'gh-cli', active: true },
      },
      {
        scope: {
          providerId: 'azure-devops',
          host: 'https://Acme.visualstudio.com',
        },
        source: { kind: 'env', name: 'environment' },
        authMethod: 'bearer',
        defaultProject: ' Boards ',
      },
      {
        scope: { providerId: 'github', host: 'GITHUB.COM' },
        source: { kind: 'env', name: 'environment' },
      },
    ]);

    expect(accounts).toEqual([
      {
        id: 'auth:azure-devops:host:dev.azure.com:org:acme',
        providerId: 'azure-devops',
        label: 'acme',
        detail: 'dev.azure.com',
        sourceKind: 'env',
        metadata: {
          sources: 'environment',
          authMethod: 'bearer',
          defaultProject: 'Boards',
        },
        scope: {
          id: 'auth:azure-devops:host:dev.azure.com:org:acme',
          providerId: 'azure-devops',
          host: 'dev.azure.com',
          org: 'acme',
          label: 'acme',
          sourceKind: 'env',
          metadata: {
            sources: 'environment',
            authMethod: 'bearer',
            defaultProject: 'Boards',
          },
        },
      },
      {
        id: 'auth:github:host:github.com',
        providerId: 'github',
        label: 'github.com',
        detail: 'github.com',
        sourceKind: 'env',
        metadata: { sources: 'environment' },
        scope: {
          id: 'auth:github:host:github.com',
          providerId: 'github',
          host: 'github.com',
          label: 'github.com',
          sourceKind: 'env',
          metadata: { sources: 'environment' },
        },
      },
      {
        id: 'auth:github:host:github.com:account:octocat',
        providerId: 'github',
        label: 'octocat',
        detail: 'github.com',
        sourceKind: 'external',
        metadata: { sources: 'gh-cli', active: true },
        scope: {
          id: 'auth:github:host:github.com:account:octocat',
          providerId: 'github',
          host: 'github.com',
          account: 'octocat',
          label: 'octocat',
          sourceKind: 'external',
          metadata: { sources: 'gh-cli', active: true },
        },
      },
      {
        id: 'auth:jira:host:example.atlassian.net:account:dev%40example.com',
        providerId: 'jira',
        label: 'dev@example.com',
        detail: 'example.atlassian.net',
        sourceKind: 'keyring',
        metadata: {
          sources: 'keyring',
          storageKinds: 'scoped',
          defaultProject: 'CORE',
        },
        scope: {
          id: 'auth:jira:host:example.atlassian.net:account:dev%40example.com',
          providerId: 'jira',
          host: 'example.atlassian.net',
          account: 'dev@example.com',
          label: 'dev@example.com',
          sourceKind: 'keyring',
          metadata: {
            sources: 'keyring',
            storageKinds: 'scoped',
            defaultProject: 'CORE',
          },
        },
      },
    ]);

    assertDeeplyFrozenAccounts(accounts);
  });

  test('rejects every forbidden provider, source, and scope combination with fixed fresh errors', () => {
    const cases = [
      {
        name: 'Jira gh-cli',
        candidate: {
          scope: {
            providerId: 'jira',
            host: 'example.atlassian.net',
            account: 'JIRA-RAW-ACCOUNT',
          },
          source: { kind: 'external', name: 'gh-cli', active: true },
        },
        raw: ['JIRA-RAW-ACCOUNT'],
      },
      {
        name: 'Azure DevOps gh-cli',
        candidate: {
          scope: {
            providerId: 'azure-devops',
            host: 'dev.azure.com',
            org: 'ADO-RAW-ORG',
          },
          source: { kind: 'external', name: 'gh-cli', active: true },
        },
        raw: ['ADO-RAW-ORG'],
      },
      {
        name: 'GitHub env account',
        candidate: {
          scope: {
            providerId: 'github',
            host: 'github.com',
            account: 'GH-ENV-RAW-ACCOUNT',
          },
          source: { kind: 'env', name: 'environment' },
        },
        raw: ['GH-ENV-RAW-ACCOUNT'],
      },
      {
        name: 'GitHub legacy account',
        candidate: {
          scope: {
            providerId: 'github',
            host: 'github.com',
            account: 'GH-LEGACY-RAW-ACCOUNT',
          },
          source: {
            kind: 'keyring',
            name: 'keyring',
            storageKind: 'legacy',
          },
        },
        raw: ['GH-LEGACY-RAW-ACCOUNT'],
      },
      {
        name: 'GitHub legacy enterprise host',
        candidate: {
          scope: { providerId: 'github', host: 'legacy-raw.example.com' },
          source: {
            kind: 'keyring',
            name: 'keyring',
            storageKind: 'legacy',
          },
        },
        raw: ['legacy-raw.example.com'],
      },
      {
        name: 'GitHub external host-only',
        candidate: {
          scope: { providerId: 'github', host: 'external-raw.example.com' },
          source: { kind: 'external', name: 'gh-cli', active: true },
        },
        raw: ['external-raw.example.com'],
      },
      {
        name: 'GitHub external inactive',
        candidate: {
          scope: {
            providerId: 'github',
            host: 'github.com',
            account: 'GH-INACTIVE-RAW-ACCOUNT',
          },
          source: { kind: 'external', name: 'gh-cli', active: false },
        },
        raw: ['GH-INACTIVE-RAW-ACCOUNT'],
      },
    ];

    for (const { name, candidate, raw } of cases) {
      expectInvalidCandidate(candidate, raw);
      expect(name.length).toBeGreaterThan(0);
    }
  });

  test('selects ADO metadata by source rank across every conflict permutation', () => {
    const scope = {
      providerId: 'azure-devops' as const,
      host: 'dev.azure.com',
      org: 'acme',
    };
    const env: BuiltinAuthAccountCandidate = {
      scope,
      source: { kind: 'env', name: 'environment' },
      authMethod: 'pat',
      defaultProject: 'Z-CURRENT',
    };
    const scoped: BuiltinAuthAccountCandidate = {
      scope,
      source: { kind: 'keyring', name: 'keyring', storageKind: 'scoped' },
      authMethod: 'bearer',
      defaultProject: 'A-STALE',
    };

    for (const candidates of permutations([env, scoped])) {
      expect(assembleBuiltinAuthAccounts(candidates)[0]).toMatchObject({
        sourceKind: 'env',
        metadata: {
          sources: 'environment,keyring',
          storageKinds: 'scoped',
          authMethod: 'pat',
          defaultProject: 'Z-CURRENT',
        },
        scope: {
          sourceKind: 'env',
          metadata: {
            authMethod: 'pat',
            defaultProject: 'Z-CURRENT',
          },
        },
      });
    }
  });

  test('selects scoped keyring metadata over legacy across every conflict permutation', () => {
    const scope = {
      providerId: 'azure-devops' as const,
      host: 'dev.azure.com',
      org: 'acme',
    };
    const legacy: BuiltinAuthAccountCandidate = {
      scope,
      source: { kind: 'keyring', name: 'keyring', storageKind: 'legacy' },
      authMethod: 'bearer',
      defaultProject: 'A-LEGACY',
    };
    const scoped: BuiltinAuthAccountCandidate = {
      scope,
      source: { kind: 'keyring', name: 'keyring', storageKind: 'scoped' },
      authMethod: 'pat',
      defaultProject: 'Z-SCOPED',
    };

    for (const candidates of permutations([legacy, scoped])) {
      expect(assembleBuiltinAuthAccounts(candidates)[0]).toMatchObject({
        sourceKind: 'keyring',
        metadata: {
          sources: 'keyring',
          storageKinds: 'legacy,scoped',
          authMethod: 'pat',
          defaultProject: 'Z-SCOPED',
        },
        scope: {
          sourceKind: 'keyring',
          metadata: {
            authMethod: 'pat',
            defaultProject: 'Z-SCOPED',
          },
        },
      });
    }
  });

  test('omits Jira metadata absent at the winning env rank across every lower-rank permutation', () => {
    const scope = {
      providerId: 'jira' as const,
      host: 'example.atlassian.net',
      account: 'dev@example.com',
    };
    const env: BuiltinAuthAccountCandidate = {
      scope,
      source: { kind: 'env', name: 'environment' },
    };
    const scoped: BuiltinAuthAccountCandidate = {
      scope,
      source: { kind: 'keyring', name: 'keyring', storageKind: 'scoped' },
      defaultProject: 'STALE-SCOPED',
    };
    const legacy: BuiltinAuthAccountCandidate = {
      scope,
      source: { kind: 'keyring', name: 'keyring', storageKind: 'legacy' },
      defaultProject: 'STALE-LEGACY',
    };
    const expectedMetadata = {
      sources: 'environment,keyring',
      storageKinds: 'legacy,scoped',
    };

    for (const candidates of permutations([env, scoped, legacy])) {
      const account = assembleBuiltinAuthAccounts(candidates)[0];
      expect(account?.sourceKind).toBe('env');
      expect(account?.metadata).toEqual(expectedMetadata);
      expect(account?.scope?.sourceKind).toBe('env');
      expect(account?.scope?.metadata).toEqual(expectedMetadata);
    }
  });

  test('omits ADO metadata absent at the winning env rank in both candidate orders', () => {
    const scope = {
      providerId: 'azure-devops' as const,
      host: 'dev.azure.com',
      org: 'acme',
    };
    const env: BuiltinAuthAccountCandidate = {
      scope,
      source: { kind: 'env', name: 'environment' },
    };
    const scoped: BuiltinAuthAccountCandidate = {
      scope,
      source: { kind: 'keyring', name: 'keyring', storageKind: 'scoped' },
      authMethod: 'bearer',
      defaultProject: 'STALE-SCOPED',
    };
    const expectedMetadata = {
      sources: 'environment,keyring',
      storageKinds: 'scoped',
    };

    for (const candidates of permutations([env, scoped])) {
      const account = assembleBuiltinAuthAccounts(candidates)[0];
      expect(account?.sourceKind).toBe('env');
      expect(account?.metadata).toEqual(expectedMetadata);
      expect(account?.scope?.sourceKind).toBe('env');
      expect(account?.scope?.metadata).toEqual(expectedMetadata);
    }
  });

  test('omits Jira and ADO metadata absent at the winning scoped-keyring rank', () => {
    const cases: readonly {
      readonly scoped: BuiltinAuthAccountCandidate;
      readonly legacy: BuiltinAuthAccountCandidate;
    }[] = [
      {
        scoped: {
          scope: {
            providerId: 'jira',
            host: 'example.atlassian.net',
            account: 'dev@example.com',
          },
          source: {
            kind: 'keyring',
            name: 'keyring',
            storageKind: 'scoped',
          },
        },
        legacy: {
          scope: {
            providerId: 'jira',
            host: 'example.atlassian.net',
            account: 'dev@example.com',
          },
          source: {
            kind: 'keyring',
            name: 'keyring',
            storageKind: 'legacy',
          },
          defaultProject: 'STALE-LEGACY',
        },
      },
      {
        scoped: {
          scope: {
            providerId: 'azure-devops',
            host: 'dev.azure.com',
            org: 'acme',
          },
          source: {
            kind: 'keyring',
            name: 'keyring',
            storageKind: 'scoped',
          },
        },
        legacy: {
          scope: {
            providerId: 'azure-devops',
            host: 'dev.azure.com',
            org: 'acme',
          },
          source: {
            kind: 'keyring',
            name: 'keyring',
            storageKind: 'legacy',
          },
          authMethod: 'bearer',
          defaultProject: 'STALE-LEGACY',
        },
      },
    ];
    const expectedMetadata = {
      sources: 'keyring',
      storageKinds: 'legacy,scoped',
    };

    for (const { scoped, legacy } of cases) {
      for (const candidates of permutations([scoped, legacy])) {
        const account = assembleBuiltinAuthAccounts(candidates)[0];
        expect(account?.sourceKind).toBe('keyring');
        expect(account?.metadata).toEqual(expectedMetadata);
        expect(account?.scope?.sourceKind).toBe('keyring');
        expect(account?.scope?.metadata).toEqual(expectedMetadata);
      }
    }
  });

  test('uses a deterministic tie-break only within equal semantic rank', () => {
    const scope = {
      providerId: 'azure-devops' as const,
      host: 'dev.azure.com',
      org: 'acme',
    };
    const first: BuiltinAuthAccountCandidate = {
      scope,
      source: { kind: 'env', name: 'environment' },
      authMethod: 'pat',
      defaultProject: 'Z-PROJECT',
    };
    const second: BuiltinAuthAccountCandidate = {
      scope,
      source: { kind: 'env', name: 'environment' },
      authMethod: 'bearer',
      defaultProject: 'A-PROJECT',
    };
    const emptyAtWinningRank: BuiltinAuthAccountCandidate = {
      scope,
      source: { kind: 'env', name: 'environment' },
    };
    const lowerRank: BuiltinAuthAccountCandidate = {
      scope,
      source: { kind: 'keyring', name: 'keyring', storageKind: 'scoped' },
      authMethod: 'pat',
      defaultProject: 'LOWER-RANK',
    };

    for (const candidates of permutations([
      emptyAtWinningRank,
      first,
      second,
      lowerRank,
    ])) {
      expect(assembleBuiltinAuthAccounts(candidates)[0]?.metadata).toEqual({
        sources: 'environment,keyring',
        storageKinds: 'scoped',
        authMethod: 'bearer',
        defaultProject: 'A-PROJECT',
      });
    }
  });

  test('rejects inactive external data instead of OR-merging it with healthy proof', () => {
    const scope = {
      providerId: 'github' as const,
      host: 'github.com',
      account: 'octocat',
    };
    const healthy: BuiltinAuthAccountCandidate = {
      scope,
      source: { kind: 'external', name: 'gh-cli', active: true },
    };
    const inactive = {
      scope,
      source: { kind: 'external', name: 'gh-cli', active: false },
    } as unknown as BuiltinAuthAccountCandidate;

    for (const candidates of permutations([healthy, inactive])) {
      const first = capturedCandidateErrorFromList(candidates);
      const second = capturedCandidateErrorFromList(candidates);
      expect(first).not.toBe(second);
    }
  });

  test('accepts exact presentation boundaries and rejects every overflow', () => {
    const jiraAccount = 'j'.repeat(MAX_PRESENTATION_IDENTITY_FIELD_LENGTH);
    const adoOrg = 'a'.repeat(MAX_PRESENTATION_IDENTITY_FIELD_LENGTH);
    const githubAccount = 'g'.repeat(MAX_PRESENTATION_IDENTITY_FIELD_LENGTH);
    const defaultProject = 'p'.repeat(MAX_PRESENTATION_METADATA_STRING_LENGTH);

    const accounts = assembleBuiltinAuthAccounts([
      {
        scope: {
          providerId: 'jira',
          host: 'example.atlassian.net',
          account: jiraAccount,
        },
        source: { kind: 'env', name: 'environment' },
        defaultProject,
      },
      {
        scope: {
          providerId: 'azure-devops',
          host: 'dev.azure.com',
          org: adoOrg,
        },
        source: { kind: 'env', name: 'environment' },
      },
      {
        scope: {
          providerId: 'github',
          host: 'github.com',
          account: githubAccount,
        },
        source: { kind: 'external', name: 'gh-cli', active: true },
      },
    ]);

    expect(
      accounts.find(({ providerId }) => providerId === 'jira')?.label
    ).toBe(jiraAccount);
    expect(
      accounts.find(({ providerId }) => providerId === 'jira')?.metadata
        ?.defaultProject
    ).toBe(defaultProject);
    expect(
      accounts.find(({ providerId }) => providerId === 'azure-devops')?.label
    ).toBe(adoOrg);
    expect(
      accounts.find(({ providerId }) => providerId === 'github')?.label
    ).toBe(githubAccount);

    expectInvalidCandidate({
      scope: {
        providerId: 'jira',
        host: 'example.atlassian.net',
        account: `${jiraAccount}x`,
      },
      source: { kind: 'env', name: 'environment' },
    });
    expectInvalidCandidate({
      scope: {
        providerId: 'azure-devops',
        host: 'dev.azure.com',
        org: `${adoOrg}x`,
      },
      source: { kind: 'env', name: 'environment' },
    });
    expectInvalidCandidate({
      scope: {
        providerId: 'github',
        host: 'github.com',
        account: `${githubAccount}x`,
      },
      source: { kind: 'external', name: 'gh-cli', active: true },
    });
    expectInvalidCandidate({
      scope: {
        providerId: 'jira',
        host: 'example.atlassian.net',
        account: 'dev@example.com',
      },
      source: { kind: 'env', name: 'environment' },
      defaultProject: `${defaultProject}x`,
    });
  });

  test('rejects unsafe canonical identity and metadata text with fixed errors', () => {
    const cases = [
      {
        scope: {
          providerId: 'jira',
          host: 'example.atlassian.net',
          account: 'dev\noperator@example.com',
        },
        source: { kind: 'env', name: 'environment' },
      },
      {
        scope: {
          providerId: 'azure-devops',
          host: 'dev.azure.com',
          org: 'acme\0admin',
        },
        source: { kind: 'env', name: 'environment' },
      },
      {
        scope: {
          providerId: 'github',
          host: 'github.com',
          account: 'octo\u202ecat',
        },
        source: { kind: 'external', name: 'gh-cli', active: true },
      },
      {
        scope: {
          providerId: 'jira',
          host: 'example.atlassian.net',
          account: 'dev@example.com',
        },
        source: { kind: 'env', name: 'environment' },
        defaultProject: 'CORE\u2028INJECTED',
      },
      {
        scope: {
          providerId: 'jira',
          host: 'example.atlassian.net',
          account: 'dev\ud800@example.com',
        },
        source: { kind: 'env', name: 'environment' },
      },
      {
        scope: {
          providerId: 'azure-devops',
          host: 'dev.azure.com',
          org: 'acme\udfff',
        },
        source: { kind: 'env', name: 'environment' },
      },
      {
        scope: {
          providerId: 'github',
          host: 'github.com',
          account: 'octo\ud800cat',
        },
        source: { kind: 'external', name: 'gh-cli', active: true },
      },
      {
        scope: {
          providerId: 'jira',
          host: 'example.atlassian.net',
          account: 'dev@example.com',
        },
        source: { kind: 'env', name: 'environment' },
        defaultProject: 'CORE\ud800',
      },
    ];

    for (const candidate of cases) expectInvalidCandidate(candidate);
  });

  test('rejects credential-shaped optional presentation metadata', () => {
    const credentialShapes = [
      'token=TODO146_RAW_TOKEN_73fb',
      'Bearer TODO146_RAW_BEARER_90ac',
      'ghp_TODO146RawGitHubToken1234567890',
      'https://TODO146-USER:TODO146-PASSWORD@example.com/project',
      'https://example.com/project?access_token=TODO146-QUERY-TOKEN',
      '-----BEGIN PRIVATE KEY-----',
    ];

    for (const defaultProject of credentialShapes) {
      expectInvalidCandidate(
        {
          scope: {
            providerId: 'jira',
            host: 'example.atlassian.net',
            account: 'dev@example.com',
          },
          source: { kind: 'env', name: 'environment' },
          defaultProject,
        },
        [defaultProject]
      );
    }
  });

  test('normalizes optional metadata once and validates the final canonical id', () => {
    const normalized = assembleBuiltinAuthAccounts([
      {
        scope: {
          providerId: 'jira',
          host: 'example.atlassian.net',
          account: 'dev@example.com',
        },
        source: { kind: 'env', name: 'environment' },
        defaultProject: '  Cafe\u0301  ',
      },
    ]);
    expect(normalized[0]?.metadata?.defaultProject).toBe('Caf\u00e9');

    expectInvalidCandidate({
      scope: {
        providerId: 'github',
        host: 'github.com',
        account: '\u00e9'.repeat(MAX_PRESENTATION_IDENTITY_FIELD_LENGTH),
      },
      source: { kind: 'external', name: 'gh-cli', active: true },
    });
  });

  test('is deterministic across all multi-provider permutations', () => {
    const jiraEnv = {
      scope: {
        providerId: 'jira' as const,
        host: 'example.atlassian.net',
        account: 'dev@example.com',
      },
      source: { kind: 'env' as const, name: 'environment' as const },
      defaultProject: 'CURRENT',
      token: 'TODO146_PERMUTATION_RAW_TOKEN',
    };
    const jiraScoped = {
      scope: jiraEnv.scope,
      source: {
        kind: 'keyring' as const,
        name: 'keyring' as const,
        storageKind: 'scoped' as const,
        backend: 'TODO146_PERMUTATION_RAW_BACKEND',
      },
      defaultProject: 'STALE',
    };
    const candidates: readonly BuiltinAuthAccountCandidate[] = [
      jiraEnv,
      jiraScoped,
      {
        scope: {
          providerId: 'azure-devops',
          host: 'dev.azure.com',
          org: 'acme',
        },
        source: { kind: 'env', name: 'environment' },
        authMethod: 'pat',
        defaultProject: 'CURRENT',
      },
      {
        scope: {
          providerId: 'azure-devops',
          host: 'dev.azure.com',
          org: 'acme',
        },
        source: { kind: 'keyring', name: 'keyring', storageKind: 'legacy' },
        authMethod: 'bearer',
        defaultProject: 'STALE',
      },
      {
        scope: { providerId: 'github', host: 'github.com' },
        source: { kind: 'env', name: 'environment' },
      },
      {
        scope: {
          providerId: 'github',
          host: 'github.com',
          account: 'octocat',
        },
        source: { kind: 'external', name: 'gh-cli', active: true },
      },
      {
        scope: { providerId: 'github', host: 'github.example.com' },
        source: { kind: 'keyring', name: 'keyring', storageKind: 'scoped' },
      },
      {
        scope: {
          providerId: 'github',
          host: 'github.example.com',
          account: 'enterprise-bot',
        },
        source: { kind: 'keyring', name: 'keyring', storageKind: 'scoped' },
      },
    ];

    const expected = assembleBuiltinAuthAccounts(candidates);
    const expectedJson = JSON.stringify(expected);
    expect(expected).toHaveLength(6);
    expect(expectedJson).not.toContain('TODO146_PERMUTATION_RAW_TOKEN');
    expect(expectedJson).not.toContain('TODO146_PERMUTATION_RAW_BACKEND');
    expect(
      expected.find(({ providerId }) => providerId === 'jira')?.metadata
        ?.defaultProject
    ).toBe('CURRENT');
    expect(
      expected.find(({ providerId }) => providerId === 'azure-devops')?.metadata
    ).toMatchObject({ authMethod: 'pat', defaultProject: 'CURRENT' });

    let count = 0;
    for (const permutation of permutations(candidates)) {
      const accounts = assembleBuiltinAuthAccounts(permutation);
      assertDeeplyFrozenAccounts(accounts);
      if (JSON.stringify(accounts) !== expectedJson) {
        throw new Error(`assembly changed for permutation ${count}`);
      }
      count += 1;
    }
    expect(count).toBe(40_320);
  });

  test('snapshots allowlisted inputs without retaining raw or arbitrary data', () => {
    const mutableSource: {
      kind: 'keyring';
      name: 'keyring';
      storageKind: BuiltinAuthAccountStorageKind;
      backend: string;
    } = {
      kind: 'keyring',
      name: 'keyring',
      storageKind: 'legacy',
      backend: 'RAW-BACKEND-DIAGNOSTIC',
    };
    const mutable = {
      scope: {
        providerId: 'jira' as const,
        host: 'EXAMPLE.atlassian.net',
        account: 'Dev@Example.com',
        label: 'ARBITRARY-SCOPE-LABEL',
      },
      source: mutableSource,
      defaultProject: 'CORE',
      token: 'RAW-CREDENTIAL-TOKEN',
      metadata: { arbitrary: 'ARBITRARY-METADATA' },
    };
    const candidates: BuiltinAuthAccountCandidate[] = [mutable];
    const accounts = assembleBuiltinAuthAccounts(candidates);
    const snapshot = JSON.stringify(accounts);

    mutable.scope.host = 'mutated.example.com';
    mutable.scope.account = 'mutated@example.com';
    mutable.defaultProject = 'MUTATED';
    mutable.source.storageKind = 'scoped';
    candidates.push({
      scope: { providerId: 'github', host: 'later.example.com' },
      source: { kind: 'keyring', name: 'keyring', storageKind: 'scoped' },
    });

    expect(JSON.stringify(accounts)).toBe(snapshot);
    expect(snapshot).not.toContain('RAW-CREDENTIAL-TOKEN');
    expect(snapshot).not.toContain('RAW-BACKEND-DIAGNOSTIC');
    expect(snapshot).not.toContain('ARBITRARY-METADATA');
    expect(snapshot).not.toContain('ARBITRARY-SCOPE-LABEL');
    assertDeeplyFrozenAccounts(accounts);
  });
});

function capturedCandidateErrorFromList(
  candidates: readonly BuiltinAuthAccountCandidate[]
): TypeError {
  try {
    assembleBuiltinAuthAccounts(candidates);
  } catch (error) {
    expect(error).toBeInstanceOf(TypeError);
    if (!(error instanceof TypeError)) throw error;
    expect(error.message).toBe(INVALID_CANDIDATE_MESSAGE);
    expect(Reflect.has(error, 'cause')).toBe(false);
    return error;
  }
  throw new Error('Expected an invalid built-in auth account candidate.');
}
