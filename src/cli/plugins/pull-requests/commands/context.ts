import { Effect } from 'effect';
import type { ArgumentsCamelCase } from 'yargs';

import type {
  AidePullRequestAddCommentRequest,
  AidePullRequestCommentMutationResult,
  AidePullRequestReplyCommentRequest,
  AidePullRequestUpdateRequest,
  AidePullRequestUpdateResult,
  AidePullRequestViewResult,
} from '@cli/host/plugin-descriptor.js';
import { getAideHostContext } from '@cli/host/runtime-context.js';
import { validatePRId } from '@lib/ado-utils.js';
import { logProgress } from '@lib/cli-utils.js';
import { getCurrentBranch, getGitRemoteUrl } from '@lib/git-utils.js';
import type { OutputFormat } from '@schemas/common.js';
import { resolveExplicitPullRequestRepositoryRef } from './repository-ref.js';

export interface ProviderPullRequestContext {
  readonly provider: {
    readonly providerId: string;
  };
  readonly result: AidePullRequestViewResult;
  readonly addPullRequestComment: (
    request: Omit<AidePullRequestAddCommentRequest, 'match'>
  ) => Effect.Effect<AidePullRequestCommentMutationResult, unknown, never>;
  readonly replyToPullRequestComment: (
    request: Omit<AidePullRequestReplyCommentRequest, 'match'>
  ) => Effect.Effect<AidePullRequestCommentMutationResult, unknown, never>;
  readonly updatePullRequest: (
    request: Omit<AidePullRequestUpdateRequest, 'match'>
  ) => Effect.Effect<AidePullRequestUpdateResult, unknown, never>;
}

export interface ResolvedPullRequestContext {
  readonly context: ProviderPullRequestContext;
  readonly autoDiscovered: boolean;
}

export interface PullRequestContextArgs {
  readonly pr?: string;
  readonly project?: string;
  readonly repo?: string;
}

export async function resolvePullRequestOperationContext(
  argv: ArgumentsCamelCase<PullRequestContextArgs>,
  args: PullRequestContextArgs,
  format: OutputFormat
): Promise<ResolvedPullRequestContext> {
  const hostContext = getAideHostContext(argv);
  if (hostContext === null) {
    throw new Error('Pull request provider services are unavailable.');
  }

  const hasExplicitRepoContext =
    args.project !== undefined || args.repo !== undefined;

  if (args.pr === undefined) {
    const branch = getCurrentBranch();
    if (!branch) {
      throw new Error(
        'Could not detect current git branch. Are you in a git repository? (Detached HEAD state is not supported)'
      );
    }

    logProgress(`Searching for PR from branch '${branch}'...`, format);
    const found = hasExplicitRepoContext
      ? await (async () => {
          const { repository, autoDiscovered } =
            await resolveExplicitPullRequestRepositoryRef(
              args.project,
              args.repo
            );
          const context = await Effect.runPromise(
            hostContext.services.findPullRequestForBranchContextForRepository(
              repository,
              { branch }
            )
          );
          return { context, autoDiscovered };
        })()
      : await (async () => {
          const remoteUrl = gitRemoteOrThrow(
            'Could not determine repository context. Provide a PR ID, full PR URL, or run from a git repository with a supported remote.'
          );
          const context = await Effect.runPromise(
            hostContext.services.findPullRequestForBranchContextForRemote(
              remoteUrl,
              { branch }
            )
          );
          return { context, autoDiscovered: true };
        })();

    logProgress(
      `Found PR #${found.context.result.pullRequest.id}: ${found.context.result.pullRequest.title}`,
      format
    );
    logProgress('', format);
    return {
      context: found.context,
      autoDiscovered: found.autoDiscovered,
    };
  }

  if (args.pr.startsWith('http')) {
    const context = await Effect.runPromise(
      hostContext.services.getPullRequestContextForUrl(args.pr)
    );
    return { context, autoDiscovered: false };
  }

  const validation = validatePRId(args.pr);
  if (!validation.valid || validation.value === undefined) {
    throw new Error(
      `Could not parse '${args.pr}' as a PR ID. Expected a positive number or full PR URL.`
    );
  }
  const prNumber = validation.value;

  if (hasExplicitRepoContext) {
    const { repository, autoDiscovered } =
      await resolveExplicitPullRequestRepositoryRef(args.project, args.repo);
    const context = await Effect.runPromise(
      hostContext.services.getPullRequestContextForRepository(repository, {
        pullRequest: { number: prNumber },
      })
    );
    return { context, autoDiscovered };
  }

  const remoteUrl = gitRemoteOrThrow(
    'Could not determine repository context. Provide a full PR URL or run from a git repository with a supported remote.'
  );
  const context = await Effect.runPromise(
    hostContext.services.getPullRequestContextForRemote(remoteUrl, {
      pullRequest: { number: prNumber },
    })
  );
  return { context, autoDiscovered: true };
}

function gitRemoteOrThrow(message: string): string {
  const remoteUrl = getGitRemoteUrl();
  if (!remoteUrl) {
    throw new Error(message);
  }
  return remoteUrl;
}
