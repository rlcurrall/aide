import { Effect } from 'effect';

import { createKeyringCommandRegistry } from '@cli/host/command-registry.js';
import { defineImmutableBuiltinPlugin } from '@cli/host/immutable-builtin-plugin.js';
import { createAideHostServices } from '@cli/host/runtime-context.js';
import {
  azureDevOpsPlugin,
  createAzureDevOpsPlugin,
} from '@cli/plugins/azure-devops/plugin.js';
import {
  createGitHubPlugin,
  githubPlugin,
} from '@cli/plugins/github/plugin.js';
import { runPullRequestCommandEffect } from '@cli/plugins/pull-requests/commands/error.js';
import { renderTopLevelError } from '@cli/index.js';
import { GitHubAuthError } from '@lib/github-client.js';
import { validateUrl } from '@cli/plugins/auth-operation-utils.js';

const mode = process.argv[2] as 'before-first' | 'between-registries';
const secret = 'SECRET-MUTATED-EXACT-BUILTIN-DIAGNOSTIC';
let attackerOperationCalls = 0;
let attackerDiagnosticCalls = 0;

function graphContainerPaths(
  root: unknown,
  predicate: (value: object) => boolean
): readonly string[] {
  const seen = new WeakSet<object>();
  const matches: string[] = [];

  const visit = (value: unknown, path: string): void => {
    if (typeof value !== 'object' || value === null) return;
    if (seen.has(value)) return;
    seen.add(value);
    if (predicate(value)) matches.push(path);

    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !('value' in descriptor)) continue;
      visit(
        descriptor.value,
        `${path}.${typeof key === 'symbol' ? key.toString() : key}`
      );
    }
  };

  visit(root, '$');
  return matches;
}

function definitionContainers(root: unknown): readonly object[] {
  const containers: object[] = [];
  const seen = new WeakSet<object>();
  const visit = (value: unknown): void => {
    if (typeof value !== 'object' || value === null || seen.has(value)) return;
    seen.add(value);
    containers.push(value);
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (descriptor !== undefined && 'value' in descriptor) {
        visit(descriptor.value);
      }
    }
  };
  visit(root);
  return containers;
}

// The static exports are deliberately imported before any fresh factory call.
const githubFactoryA = createGitHubPlugin();
const githubFactoryB = createGitHubPlugin();
const azureFactoryA = createAzureDevOpsPlugin();
const azureFactoryB = createAzureDevOpsPlugin();

const githubCapabilities = githubPlugin.capabilities;
const githubPullRequests = githubCapabilities?.pullRequestProvider;
const githubOperations = githubPullRequests?.operations;
const githubAuthProvider = githubCapabilities?.authProvider;
const githubAuthOperations = githubAuthProvider?.operations;
const githubAuthVariables = githubAuthProvider?.login?.envMigration?.variables;
const azureCapabilities = azureDevOpsPlugin.capabilities;
const azurePullRequests = azureCapabilities?.pullRequestProvider;
const azureOperations = azurePullRequests?.operations;
const azureAuthProvider = azureCapabilities?.authProvider;
const azureAuthOperations = azureAuthProvider?.operations;
const azureAuthVariables = azureAuthProvider?.login?.envMigration?.variables;
const githubFactoryAAuth = githubFactoryA.capabilities?.authProvider;
const githubFactoryBAuth = githubFactoryB.capabilities?.authProvider;
const githubFactoryAFields = githubFactoryAAuth?.login?.fields;
const githubFactoryBFields = githubFactoryBAuth?.login?.fields;
const githubFactoryAVariables =
  githubFactoryAAuth?.login?.envMigration?.variables;
const githubFactoryBVariables =
  githubFactoryBAuth?.login?.envMigration?.variables;
const githubFactoryAFeatures =
  githubFactoryA.capabilities?.pullRequestProvider?.features;
const githubFactoryBFeatures =
  githubFactoryB.capabilities?.pullRequestProvider?.features;
const azureFactoryAAuth = azureFactoryA.capabilities?.authProvider;
const azureFactoryBAuth = azureFactoryB.capabilities?.authProvider;
const azureFactoryAFields = azureFactoryAAuth?.login?.fields;
const azureFactoryBFields = azureFactoryBAuth?.login?.fields;
const azureFactoryAFeatures =
  azureFactoryA.capabilities?.pullRequestProvider?.features;
const azureFactoryBFeatures =
  azureFactoryB.capabilities?.pullRequestProvider?.features;

if (
  githubPullRequests === undefined ||
  githubOperations === undefined ||
  githubAuthProvider === undefined ||
  githubAuthOperations === undefined ||
  githubAuthVariables === undefined ||
  azurePullRequests === undefined ||
  azureOperations === undefined ||
  azureAuthProvider === undefined ||
  azureAuthOperations === undefined ||
  azureAuthVariables === undefined ||
  githubFactoryAAuth === undefined ||
  githubFactoryBAuth === undefined ||
  githubFactoryAFields === undefined ||
  githubFactoryBFields === undefined ||
  githubFactoryAVariables === undefined ||
  githubFactoryBVariables === undefined ||
  githubFactoryAFeatures === undefined ||
  githubFactoryBFeatures === undefined ||
  azureFactoryAAuth === undefined ||
  azureFactoryBAuth === undefined ||
  azureFactoryAFields === undefined ||
  azureFactoryBFields === undefined ||
  azureFactoryAFeatures === undefined ||
  azureFactoryBFeatures === undefined
) {
  throw new Error('Missing required static built-in graph layer');
}

const staticContainers = new Set([
  ...definitionContainers(githubPlugin),
  ...definitionContainers(azureDevOpsPlugin),
]);
const githubAContainers = definitionContainers(githubFactoryA);
const githubBContainers = definitionContainers(githubFactoryB);
const azureAContainers = definitionContainers(azureFactoryA);
const azureBContainers = definitionContainers(azureFactoryB);
const factoryContainers = [
  ...githubAContainers,
  ...githubBContainers,
  ...azureAContainers,
  ...azureBContainers,
];
const factoryContainersDisjoint = factoryContainers.every(
  (container, index) =>
    !staticContainers.has(container) &&
    factoryContainers.indexOf(container) === index
);

function callbackAndPrototypeUnfrozen(callback: unknown): boolean {
  if (typeof callback !== 'function' || Object.isFrozen(callback)) return false;
  const prototype = Reflect.getOwnPropertyDescriptor(callback, 'prototype');
  return (
    prototype === undefined ||
    !('value' in prototype) ||
    typeof prototype.value !== 'object' ||
    prototype.value === null ||
    !Object.isFrozen(prototype.value)
  );
}

function authFieldValidate(field: unknown): unknown {
  if (
    typeof field !== 'object' ||
    field === null ||
    !Object.hasOwn(field, 'kind') ||
    (field as { readonly kind?: unknown }).kind !== 'text'
  ) {
    return undefined;
  }
  return (field as { readonly validate?: unknown }).validate;
}

const githubStaticLogout = githubAuthOperations.logout;
const githubALogout = githubFactoryAAuth.operations?.logout;
const githubBLogout = githubFactoryBAuth.operations?.logout;
const azureStaticLogin = azureAuthOperations.login;
const azureALogin = azureFactoryAAuth.operations?.login;
const azureBLogin = azureFactoryBAuth.operations?.login;
const azureStaticValidate = authFieldValidate(
  azureAuthProvider.login?.fields?.[0]
);
const azureAValidate = authFieldValidate(azureFactoryAFields[0]);
const azureBValidate = authFieldValidate(azureFactoryBFields[0]);

const sharedCallbacks = {
  githubLogoutShared:
    githubStaticLogout === githubALogout && githubALogout === githubBLogout,
  githubLogoutUnfrozen: callbackAndPrototypeUnfrozen(githubStaticLogout),
  azureLoginShared:
    azureStaticLogin === azureALogin && azureALogin === azureBLogin,
  azureLoginUnfrozen: callbackAndPrototypeUnfrozen(azureStaticLogin),
  azureValidateShared:
    azureStaticValidate === validateUrl &&
    azureAValidate === validateUrl &&
    azureBValidate === validateUrl,
  azureValidateUnfrozen: callbackAndPrototypeUnfrozen(validateUrl),
};

const githubStaticFieldLabel = githubAuthProvider.login?.fields?.[0]?.label;
const githubBFieldLabel = githubFactoryBFields[0]?.label;
const githubStaticVariable = githubAuthVariables[0];
const githubBVariable = githubFactoryBVariables[0];
const githubStaticDraft = githubPullRequests.features.draftPullRequests;
const githubBDraft = githubFactoryBFeatures.draftPullRequests;
const azureStaticFieldLabel = azureAuthProvider.login?.fields?.[0]?.label;
const azureBFieldLabel = azureFactoryBFields[0]?.label;
const azureStaticDraft = azurePullRequests.features.draftPullRequests;
const azureBDraft = azureFactoryBFeatures.draftPullRequests;
const factoryMutationSucceeded = [
  Reflect.set(githubFactoryAFields[0] as object, 'label', secret),
  Reflect.set(githubFactoryAFields as object, githubFactoryAFields.length, {
    kind: 'secret',
    key: 'factory-a-only',
    label: secret,
    description: secret,
    required: false,
  }),
  Reflect.set(githubFactoryAVariables as object, '0', secret),
  Reflect.set(githubFactoryAFeatures, 'draftPullRequests', false),
  Reflect.set(azureFactoryAFields[0] as object, 'label', secret),
  Reflect.set(azureFactoryAFeatures, 'draftPullRequests', false),
];
const factoryMutationIsolated =
  githubFactoryBFields[0]?.label === githubBFieldLabel &&
  githubAuthProvider.login?.fields?.[0]?.label === githubStaticFieldLabel &&
  githubFactoryBVariables[0] === githubBVariable &&
  githubAuthVariables[0] === githubStaticVariable &&
  githubFactoryBFeatures.draftPullRequests === githubBDraft &&
  githubPullRequests.features.draftPullRequests === githubStaticDraft &&
  azureFactoryBFields[0]?.label === azureBFieldLabel &&
  azureAuthProvider.login?.fields?.[0]?.label === azureStaticFieldLabel &&
  azureFactoryBFeatures.draftPullRequests === azureBDraft &&
  azurePullRequests.features.draftPullRequests === azureStaticDraft;

const ownedSymbol = Symbol('owned-definition');
let ownedAccessorReads = 0;
function ownedCallback() {}
const ownedSource: Record<PropertyKey, unknown> = {
  nested: { value: 1 },
  callback: ownedCallback,
};
ownedSource.self = ownedSource;
ownedSource[ownedSymbol] = { value: 2 };
Object.defineProperty(ownedSource, 'accessor', {
  get() {
    ownedAccessorReads += 1;
    return secret;
  },
});
const owned = defineImmutableBuiltinPlugin(ownedSource);
const ownedCloneProbe = {
  sourceMutable: !Object.isFrozen(ownedSource),
  cloneDifferent: owned !== ownedSource,
  cloneFrozen: Object.isFrozen(owned),
  nestedDifferent: owned.nested !== ownedSource.nested,
  nestedFrozen: Object.isFrozen(owned.nested),
  cycleRetained: owned.self === owned,
  symbolDifferent: owned[ownedSymbol] !== ownedSource[ownedSymbol],
  symbolFrozen: Object.isFrozen(owned[ownedSymbol]),
  accessorReads: ownedAccessorReads,
  accessorRetained:
    Reflect.getOwnPropertyDescriptor(owned, 'accessor')?.get ===
    Reflect.getOwnPropertyDescriptor(ownedSource, 'accessor')?.get,
  callbackShared: owned.callback === ownedCallback,
  callbackUnfrozen: !Object.isFrozen(ownedCallback),
  callbackPrototypeUnfrozen: !Object.isFrozen(ownedCallback.prototype),
};

const originalListPullRequests = githubOperations.listPullRequests;
const registries = [];
if (mode === 'between-registries') {
  registries.push(createKeyringCommandRegistry().registerPlugin(githubPlugin));
}

const attackerOperation = () => {
  attackerOperationCalls += 1;
  return Effect.fail(
    new GitHubAuthError('github.com', 'malformed-credential', secret)
  );
};
const operationMutationSucceeded = Reflect.set(
  githubOperations,
  'listPullRequests',
  attackerOperation
);
const diagnosticMutationSucceeded = Reflect.defineProperty(
  githubPullRequests,
  'failureDiagnostic',
  {
    configurable: true,
    value: () => {
      attackerDiagnosticCalls += 1;
      return secret;
    },
  }
);
const nestedMutationResults = [
  Reflect.set(githubPlugin, 'summary', secret),
  Reflect.set(githubPlugin.commands, '0', Object.freeze({ secret })),
  Reflect.set(githubCapabilities as object, 'pullRequestProvider', { secret }),
  Reflect.set(githubPullRequests.features, 'draftPullRequests', false),
  Reflect.set(githubAuthOperations, 'login', attackerOperation),
  Reflect.set(githubAuthVariables, '0', secret),
  Reflect.set(azureDevOpsPlugin, 'summary', secret),
  Reflect.set(azureDevOpsPlugin.commands, '0', Object.freeze({ secret })),
  Reflect.set(azureCapabilities as object, 'pullRequestProvider', { secret }),
  Reflect.set(azurePullRequests.features, 'draftPullRequests', false),
  Reflect.set(azureOperations, 'listPullRequests', attackerOperation),
  Reflect.set(azureAuthOperations, 'login', attackerOperation),
  Reflect.set(azureAuthVariables, '0', secret),
];

registries.push(createKeyringCommandRegistry().registerPlugin(githubPlugin));
if (mode === 'before-first') {
  registries.push(createKeyringCommandRegistry().registerPlugin(githubPlugin));
}

const repository = Object.freeze({
  kind: 'github' as const,
  host: 'github.com',
  owner: 'openai',
  repo: 'aide',
});
const rendered: string[] = [];
const registeredOperationIsOriginal: boolean[] = [];
for (const registry of registries) {
  const entry = registry.capabilities.pullRequestProviders()[0];
  registeredOperationIsOriginal.push(
    entry?.capability.operations?.listPullRequests === originalListPullRequests
  );
  try {
    await runPullRequestCommandEffect(
      createAideHostServices(registry).listPullRequestsForRepository(repository)
    );
    rendered.push('unexpected success');
  } catch (error) {
    rendered.push(renderTopLevelError(error));
  }
}

process.stdout.write(
  `${JSON.stringify({
    mode,
    frozenLayers: {
      github: {
        descriptor: Object.isFrozen(githubPlugin),
        commands: Object.isFrozen(githubPlugin.commands),
        capabilities: Object.isFrozen(githubCapabilities),
        pullRequest: Object.isFrozen(githubPullRequests),
        features: Object.isFrozen(githubPullRequests.features),
        operations: Object.isFrozen(githubOperations),
        authProvider: Object.isFrozen(githubAuthProvider),
        authOperations: Object.isFrozen(githubAuthOperations),
        authVariables: Object.isFrozen(githubAuthVariables),
      },
      azure: {
        descriptor: Object.isFrozen(azureDevOpsPlugin),
        commands: Object.isFrozen(azureDevOpsPlugin.commands),
        capabilities: Object.isFrozen(azureCapabilities),
        pullRequest: Object.isFrozen(azurePullRequests),
        features: Object.isFrozen(azurePullRequests.features),
        operations: Object.isFrozen(azureOperations),
        authProvider: Object.isFrozen(azureAuthProvider),
        authOperations: Object.isFrozen(azureAuthOperations),
        authVariables: Object.isFrozen(azureAuthVariables),
      },
    },
    staticUnfrozenContainerPaths: [
      ...graphContainerPaths(githubPlugin, (value) => !Object.isFrozen(value)),
      ...graphContainerPaths(
        azureDevOpsPlugin,
        (value) => !Object.isFrozen(value)
      ),
    ],
    factoryFrozenContainerPaths: [
      ...graphContainerPaths(githubFactoryA, Object.isFrozen),
      ...graphContainerPaths(githubFactoryB, Object.isFrozen),
      ...graphContainerPaths(azureFactoryA, Object.isFrozen),
      ...graphContainerPaths(azureFactoryB, Object.isFrozen),
    ],
    factoryContainersDisjoint,
    factoryMutationSucceeded,
    factoryMutationIsolated,
    sharedCallbacks,
    ownedCloneProbe,
    operationMutationSucceeded,
    diagnosticMutationSucceeded,
    nestedMutationResults,
    registeredOperationIsOriginal,
    attackerOperationCalls,
    attackerDiagnosticCalls,
    rendered,
    leaked: rendered.some((message) => message.includes(secret)),
  })}\n`
);
