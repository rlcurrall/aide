import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import type {
  AideAuthProviderCapability,
  AideDiscoveredCapability,
} from '@cli/host/plugin-descriptor.js';
import { AuthProviderOperationError } from '@cli/host/auth-provider-operations.js';
import { createJiraPlugin } from '@cli/plugins/jira/plugin.js';
import { installMockSecrets, type Store } from '@lib/test-helpers.js';
import { runAuthProviderLogout } from './auth-provider-command-utils.js';

function authProvider(plugin: {
  readonly id: string;
  readonly capabilities?: {
    readonly authProvider?: AideAuthProviderCapability;
  };
}): AideDiscoveredCapability<AideAuthProviderCapability> {
  const provider = plugin.capabilities?.authProvider;
  if (provider === undefined) throw new Error('Plugin has no auth provider');
  return Object.freeze({ pluginId: plugin.id, capability: provider });
}

describe('provider-backed logout', () => {
  let store: Store;
  let restore: () => void;

  beforeEach(() => {
    store = new Map();
    Bun.env.AIDE_SECRET_SERVICE_OVERRIDE = 'aide';
    restore = installMockSecrets(store);
  });

  afterEach(() => restore());

  test('removes an existing entry', async () => {
    store.set('aide:jira', '{"url":"x","email":"y","apiToken":"z"}');
    const result = await runAuthProviderLogout(
      authProvider(createJiraPlugin())
    );

    expect(result.status).toBe('removed');
    expect(store.has('aide:jira')).toBe(false);
  });

  test('reports not-found when nothing was stored', async () => {
    const result = await runAuthProviderLogout(
      authProvider(createJiraPlugin())
    );

    expect(result.status).toBe('not-found');
  });

  test('wraps KeyringUnavailableError when deleteSecret fails', async () => {
    restore();
    const localRestore = installMockSecrets(store, 'delete');
    try {
      const error = await runAuthProviderLogout(
        authProvider(createJiraPlugin())
      ).catch((error) => error);

      expect(error).toBeInstanceOf(AuthProviderOperationError);
      expect((error as AuthProviderOperationError).cause).toMatchObject({
        name: 'KeyringUnavailableError',
      });
    } finally {
      localRestore();
    }
  });
});
