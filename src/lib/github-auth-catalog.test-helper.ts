import { Effect, Layer } from 'effect';

import {
  GitHubAuthCatalogService,
  type GitHubAuthCatalogServiceShape,
} from './github-auth-catalog.js';

const emptyCatalog = Object.freeze({
  identities: Object.freeze([]),
  hasUnhealthyActiveIdentity: false,
});

export const emptyTestGitHubAuthCatalogService: GitHubAuthCatalogServiceShape =
  Object.freeze({ discover: Effect.succeed(emptyCatalog) });

export const testGitHubAuthCatalogLayer: Layer.Layer<GitHubAuthCatalogService> =
  Layer.succeed(GitHubAuthCatalogService, emptyTestGitHubAuthCatalogService);
