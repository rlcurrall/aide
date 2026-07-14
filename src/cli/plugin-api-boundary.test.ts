import { describe, expect, test } from 'bun:test';
import { Effect } from 'effect';

import type {
  AideHostServices,
  AidePublicPluginDescriptor,
} from '@aide/plugin-api';
import {
  getAuthProviderStatus,
  listAuthProviderAccounts,
  loginWithAuthProvider,
  logoutWithAuthProvider,
} from '@cli/host/auth-provider-operations.js';
import { createCommandRegistry } from '@cli/host/command-registry.js';
import {
  defineAidePlugin,
  type AideAuthProviderCapability,
  type AidePrimeContributionCapability,
  type AidePullRequestProviderCapability,
} from '@cli/host/plugin-descriptor.js';
import { resolvePullRequestProviderForRemote } from '@cli/host/pull-request-provider-resolver.js';
import { KeyringService } from '@lib/auth-keyring.js';

// @ts-expect-error Internal host services are not exported by @aide/plugin-api.
export type { AideInternalHostServices as _NoInternalHostExport } from '@aide/plugin-api';
// @ts-expect-error Raw keyring services are not exported by @aide/plugin-api.
export type { KeyringService as _NoKeyringExport } from '@aide/plugin-api';

type PublicCapabilities = NonNullable<
  AidePublicPluginDescriptor['capabilities']
>;
type PublicAuth = NonNullable<PublicCapabilities['auth']>;
type PublicAuthProvider = NonNullable<PublicCapabilities['authProvider']>;
type PublicAuthOperations = NonNullable<PublicAuthProvider['operations']>;
type PublicPrime = NonNullable<PublicCapabilities['primeContribution']>;
type PublicPrimeStatus = NonNullable<PublicPrime['status']>[number];
type PublicPullRequestProvider = NonNullable<
  PublicCapabilities['pullRequestProvider']
>;
type PublicPullRequestOperations = NonNullable<
  PublicPullRequestProvider['operations']
>;

type IsNever<T> = [T] extends [never] ? true : false;
type Environment<T extends Effect.Effect<unknown, unknown, unknown>> =
  Effect.Effect.Context<T>;

const publicAuthIsServiceFree: IsNever<
  Environment<ReturnType<PublicAuth['status']>>
> = true;
const publicAuthStatusIsServiceFree: IsNever<
  Environment<ReturnType<PublicAuthProvider['status']>>
> = true;
const publicAuthAccountsIsServiceFree: IsNever<
  Environment<ReturnType<NonNullable<PublicAuthProvider['accounts']>>>
> = true;
const publicAuthLoginIsServiceFree: IsNever<
  Environment<ReturnType<NonNullable<PublicAuthOperations['login']>>>
> = true;
const publicAuthLogoutIsServiceFree: IsNever<
  Environment<ReturnType<NonNullable<PublicAuthOperations['logout']>>>
> = true;
const publicPrimeStatusIsServiceFree: IsNever<
  Environment<ReturnType<PublicPrimeStatus['status']>>
> = true;
const publicPrimeSectionsAreServiceFree: IsNever<
  Environment<ReturnType<NonNullable<PublicPrime['sections']>>>
> = true;
const publicPullRequestAuthIsServiceFree: IsNever<
  Environment<ReturnType<PublicPullRequestProvider['authStatus']>>
> = true;
const publicPullRequestMatchIsServiceFree: IsNever<
  Environment<
    ReturnType<NonNullable<PublicPullRequestProvider['matchRepository']>>
  >
> = true;
const publicPrListIsServiceFree: IsNever<
  Environment<
    ReturnType<NonNullable<PublicPullRequestOperations['listPullRequests']>>
  >
> = true;
const publicPrViewIsServiceFree: IsNever<
  Environment<
    ReturnType<NonNullable<PublicPullRequestOperations['getPullRequest']>>
  >
> = true;
const publicPrCreateIsServiceFree: IsNever<
  Environment<
    ReturnType<NonNullable<PublicPullRequestOperations['createPullRequest']>>
  >
> = true;
const publicPrUpdateIsServiceFree: IsNever<
  Environment<
    ReturnType<NonNullable<PublicPullRequestOperations['updatePullRequest']>>
  >
> = true;
const publicPrDiffIsServiceFree: IsNever<
  Environment<
    ReturnType<NonNullable<PublicPullRequestOperations['getPullRequestDiff']>>
  >
> = true;
const publicPrCommentsAreServiceFree: IsNever<
  Environment<
    ReturnType<
      NonNullable<PublicPullRequestOperations['listPullRequestComments']>
    >
  >
> = true;
const publicPrCommentIsServiceFree: IsNever<
  Environment<
    ReturnType<
      NonNullable<PublicPullRequestOperations['addPullRequestComment']>
    >
  >
> = true;
const publicPrReplyIsServiceFree: IsNever<
  Environment<
    ReturnType<
      NonNullable<PublicPullRequestOperations['replyToPullRequestComment']>
    >
  >
> = true;
const publicPrBranchLookupIsServiceFree: IsNever<
  Environment<
    ReturnType<
      NonNullable<PublicPullRequestOperations['findPullRequestForBranch']>
    >
  >
> = true;

const publicCapabilityChecks = [
  publicAuthIsServiceFree,
  publicAuthStatusIsServiceFree,
  publicAuthAccountsIsServiceFree,
  publicAuthLoginIsServiceFree,
  publicAuthLogoutIsServiceFree,
  publicPrimeStatusIsServiceFree,
  publicPrimeSectionsAreServiceFree,
  publicPullRequestAuthIsServiceFree,
  publicPullRequestMatchIsServiceFree,
  publicPrListIsServiceFree,
  publicPrViewIsServiceFree,
  publicPrCreateIsServiceFree,
  publicPrUpdateIsServiceFree,
  publicPrDiffIsServiceFree,
  publicPrCommentsAreServiceFree,
  publicPrCommentIsServiceFree,
  publicPrReplyIsServiceFree,
  publicPrBranchLookupIsServiceFree,
] satisfies readonly true[];

describe('@aide/plugin-api Effect boundary', () => {
  test('keeps every public capability operation service-free', () => {
    expect(publicCapabilityChecks).toEqual(
      Array(publicCapabilityChecks.length).fill(true)
    );
  });

  test('keeps public host methods mediated and raw-keyring-free', () => {
    type ResolveEnvironment = Environment<
      ReturnType<AideHostServices['resolvePullRequestProviderForRemote']>
    >;
    const resolutionIsServiceFree: IsNever<ResolveEnvironment> = true;
    const exposesRawKeyring: 'keyring' extends keyof AideHostServices
      ? true
      : false = false;

    expect(resolutionIsServiceFree).toBe(true);
    expect(exposesRawKeyring).toBe(false);
  });

  test('does not couple section-only Prime or PR resolution to keyring auth', () => {
    type SectionEnvironment = Environment<
      ReturnType<
        NonNullable<AidePrimeContributionCapability<KeyringService>['sections']>
      >
    >;
    type MatchEnvironment = Environment<
      ReturnType<
        NonNullable<
          AidePullRequestProviderCapability<KeyringService>['matchRepository']
        >
      >
    >;
    type ResolutionEnvironment = Environment<
      ReturnType<typeof resolvePullRequestProviderForRemote>
    >;

    const sectionIsServiceFree: IsNever<SectionEnvironment> = true;
    const matchingIsServiceFree: IsNever<MatchEnvironment> = true;
    const resolutionIsServiceFree: IsNever<ResolutionEnvironment> = true;
    expect([
      sectionIsServiceFree,
      matchingIsServiceFree,
      resolutionIsServiceFree,
    ]).toEqual([true, true, true]);
  });

  test('preserves mixed auth-provider environments through registry discovery and invocation', () => {
    type MixedProvider = AideAuthProviderCapability<
      KeyringService,
      never,
      KeyringService,
      never
    >;
    const capability: MixedProvider = {
      providerId: 'mixed-auth',
      label: 'Mixed Auth',
      status: () =>
        Effect.flatMap(KeyringService, () =>
          Effect.succeed({ state: 'configured' })
        ),
      accounts: () => Effect.succeed([]),
      operations: {
        login: () =>
          Effect.flatMap(KeyringService, () =>
            Effect.succeed({ status: 'stored' as const })
          ),
        logout: () => Effect.succeed({ status: 'not-found' as const }),
      },
    };
    const registry = createCommandRegistry<
      never,
      KeyringService,
      never,
      KeyringService,
      never,
      never,
      never
    >().registerPlugin(
      defineAidePlugin({
        id: 'mixed-auth-plugin',
        summary: 'Mixed auth environments',
        commands: [],
        capabilities: { authProvider: capability },
      })
    );
    const discovered = registry.capabilities.authProviders()[0]!;
    const status = getAuthProviderStatus(discovered);
    const accounts = listAuthProviderAccounts(discovered);
    const login = loginWithAuthProvider(discovered, {});
    const logout = logoutWithAuthProvider(discovered);

    const statusNeedsKeyring: Environment<typeof status> extends KeyringService
      ? true
      : false = true;
    const accountsAreServiceFree: IsNever<Environment<typeof accounts>> = true;
    const loginNeedsKeyring: Environment<typeof login> extends KeyringService
      ? true
      : false = true;
    const logoutIsServiceFree: IsNever<Environment<typeof logout>> = true;

    expect([
      statusNeedsKeyring,
      accountsAreServiceFree,
      loginNeedsKeyring,
      logoutIsServiceFree,
    ]).toEqual([true, true, true, true]);
  });
});
