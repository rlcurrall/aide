import { Effect } from 'effect';

import {
  defineAidePlugin,
  type AidePluginAuthStatus,
} from '@cli/host/plugin-descriptor.js';
import {
  probeGithubConfig,
  type ConfigStatus,
  type GithubConfigValue,
} from '@lib/config.js';
import { parseGitHubPRUrl, parseGitHubRemote } from '@lib/github-utils.js';

type ProbeGithubConfig = () => Promise<ConfigStatus<GithubConfigValue>>;

interface GitHubPluginOptions {
  readonly probeConfig?: ProbeGithubConfig;
}

function mapGithubAuthStatus(
  status: ConfigStatus<GithubConfigValue>
): AidePluginAuthStatus {
  switch (status.kind) {
    case 'env':
      return {
        state: 'configured',
        detail:
          status.value.source === 'gh-cli'
            ? 'authenticated via gh CLI'
            : 'configured via environment token',
      };
    case 'keyring':
      return {
        state: 'configured',
        detail: 'configured via keyring token',
      };
    case 'missing':
      return {
        state: 'not-configured',
        detail: "run 'aide login github' or authenticate with gh CLI",
      };
    case 'malformed':
      return { state: 'misconfigured', detail: status.reason };
    case 'unreachable':
      return {
        state: 'unavailable',
        detail: 'system keyring is unreachable and no GitHub env token is set',
      };
  }
}

export function createGitHubPlugin(opts: GitHubPluginOptions = {}) {
  const probeConfig = opts.probeConfig ?? (() => probeGithubConfig());
  const authStatus = () =>
    Effect.tryPromise({
      try: () => probeConfig(),
      catch: (error) => error,
    }).pipe(Effect.map(mapGithubAuthStatus));

  return defineAidePlugin({
    id: 'github',
    summary: 'GitHub pull request provider',
    commands: [],
    capabilities: {
      auth: { status: authStatus },
      pullRequestProvider: {
        providerId: 'github',
        priority: 100,
        features: {
          draftPullRequests: true,
          enterpriseHosts: true,
          reviewComments: true,
        },
        authStatus,
        matchRemote: (remoteUrl) => {
          const parsed = parseGitHubRemote(remoteUrl);
          if (parsed === null) return null;
          return {
            source: 'git-remote',
            priority: 100,
            detail: `${parsed.host}/${parsed.owner}/${parsed.repo}`,
            context: {
              host: parsed.host,
              owner: parsed.owner,
              repo: parsed.repo,
            },
          };
        },
        matchPullRequestUrl: (url) => {
          const parsed = parseGitHubPRUrl(url);
          if (parsed === null) return null;
          return {
            source: 'pull-request-url',
            priority: 100,
            detail: `${parsed.host}/${parsed.owner}/${parsed.repo}#${parsed.number}`,
            context: {
              host: parsed.host,
              owner: parsed.owner,
              repo: parsed.repo,
              number: parsed.number,
            },
          };
        },
      },
    },
  });
}

export const githubPlugin = createGitHubPlugin();
