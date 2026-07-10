import { describe, test, expect } from 'bun:test';
import {
  isGhCliAuthenticated,
  isGhCliAvailable,
  probeGhCliAuth,
} from './gh-utils.js';

const expectedGithubDotComArgs = [
  'gh',
  'auth',
  'status',
  '--active',
  '--hostname',
  'github.com',
];

describe('isGhCliAvailable', () => {
  test('returns true when gh auth status exits 0', () => {
    let capturedArgs: string[] | undefined;
    const result = isGhCliAvailable(((args: string[]) => {
      capturedArgs = args;
      return { exitCode: 0 };
    }) as unknown as typeof import('bun').spawnSync);
    expect(result).toBe(true);
    expect(capturedArgs).toEqual(expectedGithubDotComArgs);
  });

  test('returns false when gh auth status exits non-zero', () => {
    let capturedArgs: string[] | undefined;
    const result = isGhCliAvailable(((args: string[]) => {
      capturedArgs = args;
      return { exitCode: 1 };
    }) as unknown as typeof import('bun').spawnSync);
    expect(result).toBe(false);
    expect(capturedArgs).toEqual(expectedGithubDotComArgs);
  });

  test('returns false when spawn throws (gh not installed)', () => {
    let capturedArgs: string[] | undefined;
    const result = isGhCliAvailable(((args: string[]) => {
      capturedArgs = args;
      throw new Error('ENOENT');
    }) as unknown as typeof import('bun').spawnSync);
    expect(result).toBe(false);
    expect(capturedArgs).toEqual(expectedGithubDotComArgs);
  });

  test('checks the exact canonical host and strips auth env variables', () => {
    let capturedArgs: string[] | undefined;
    let capturedOptions:
      | { env?: Record<string, string | undefined> }
      | undefined;
    const result = isGhCliAuthenticated(
      'ssh.Acme.GHE.com',
      ((args: string[], options?: typeof capturedOptions) => {
        capturedArgs = args;
        capturedOptions = options;
        return { exitCode: 0 };
      }) as unknown as typeof import('bun').spawnSync,
      {
        PATH: '/bin',
        GH_HOST: 'wrong.ghe.com',
        GH_TOKEN: 'public-token',
        GH_ENTERPRISE_TOKEN: 'enterprise-token',
      }
    );

    expect(result).toBe(true);
    expect(capturedArgs).toEqual([
      'gh',
      'auth',
      'status',
      '--active',
      '--hostname',
      'acme.ghe.com',
    ]);
    expect(capturedOptions?.env).toEqual({ PATH: '/bin' });
  });

  test('proves an account-qualified request from structured active-account output', () => {
    let capturedArgs: string[] | undefined;
    let capturedOptions:
      | { env?: Record<string, string | undefined>; stdout?: string }
      | undefined;
    const result = probeGhCliAuth(
      { host: 'github.com', account: 'octocat' },
      ((args: string[], options?: typeof capturedOptions) => {
        capturedArgs = args;
        capturedOptions = options;
        return {
          exitCode: 0,
          stdout: Buffer.from(
            JSON.stringify({
              hosts: {
                'github.com': [
                  {
                    active: true,
                    host: 'github.com',
                    login: 'OctoCat',
                    state: 'success',
                    tokenSource: 'oauth_token',
                    scopes: 'gist, read:org, repo',
                  },
                ],
              },
            })
          ),
        };
      }) as unknown as typeof import('bun').spawnSync,
      { PATH: '/bin', GH_TOKEN: 'must-not-leak' }
    );

    expect(result).toEqual({
      kind: 'authenticated',
      host: 'github.com',
      account: 'octocat',
    });
    expect(capturedArgs).toEqual([
      'gh',
      'auth',
      'status',
      '--active',
      '--hostname',
      'github.com',
      '--json',
      'hosts',
    ]);
    expect(capturedOptions).toMatchObject({
      env: { PATH: '/bin' },
      stdout: 'pipe',
    });
  });

  test('requires the structured account host to exactly equal the requested hostname', () => {
    for (const [requestedHost, structuredHost] of [
      ['github.com', 'https://github.com/path'],
      ['github.com', 'ssh.github.com'],
      ['github.com', 'GITHUB.COM'],
      ['github.com', 'github.com:443'],
      ['github.example.com:8443', 'github.example.com'],
    ] as const) {
      const result = probeGhCliAuth(
        { host: requestedHost, account: 'octocat' },
        (() => ({
          exitCode: 0,
          stdout: Buffer.from(
            JSON.stringify({
              hosts: {
                [requestedHost]: [
                  {
                    active: true,
                    host: structuredHost,
                    login: 'octocat',
                    state: 'success',
                  },
                ],
              },
            })
          ),
        })) as unknown as typeof import('bun').spawnSync
      );

      expect(result.kind).toBe('unavailable');
    }
  });

  test('keeps the structured hosts map key exact', () => {
    const result = probeGhCliAuth(
      { host: 'github.com', account: 'octocat' },
      (() => ({
        exitCode: 0,
        stdout: Buffer.from(
          JSON.stringify({
            hosts: {
              'GITHUB.COM': [
                {
                  active: true,
                  host: 'github.com',
                  login: 'octocat',
                  state: 'success',
                },
              ],
            },
          })
        ),
      })) as unknown as typeof import('bun').spawnSync
    );

    expect(result.kind).toBe('unavailable');
  });

  test('returns a typed mismatch for a different structured active account', () => {
    const result = probeGhCliAuth(
      { host: 'github.com', account: 'octocat' },
      (() => ({
        exitCode: 0,
        stdout: Buffer.from(
          JSON.stringify({
            hosts: {
              'github.com': [
                {
                  active: true,
                  host: 'github.com',
                  login: 'Hubot',
                  state: 'success',
                },
              ],
            },
          })
        ),
      })) as unknown as typeof import('bun').spawnSync
    );

    expect(result).toMatchObject({
      kind: 'account-mismatch',
      code: 'account-mismatch',
      host: 'github.com',
      requestedAccount: 'octocat',
      activeAccount: 'hubot',
    });
  });

  test('fails closed when the gh JSON contract is malformed or unhealthy', () => {
    for (const payload of [
      '{not-json',
      JSON.stringify({ hosts: { 'github.com': [] } }),
      JSON.stringify({
        hosts: {
          'github.com': [
            {
              active: true,
              host: 'github.com',
              login: 'octocat',
              state: 'success',
              error: null,
            },
          ],
        },
      }),
      JSON.stringify({
        hosts: {
          'github.com': [
            {
              active: true,
              host: 'github.com',
              login: 'octocat',
              state: 'success',
              error: 'credential rejected',
            },
          ],
        },
      }),
      JSON.stringify({
        hosts: {
          'github.com': [
            {
              active: true,
              host: 'github.com',
              login: 'octocat',
              state: 'error',
            },
          ],
        },
      }),
      JSON.stringify({
        hosts: {
          'github.com': [
            {
              active: true,
              host: 'github.com',
              login: 'octocat',
              state: 'success',
            },
            {
              active: true,
              host: 'github.com',
              login: 'hubot',
              state: 'success',
            },
          ],
        },
      }),
    ]) {
      expect(
        probeGhCliAuth({ host: 'github.com', account: 'octocat' }, (() => ({
          exitCode: 0,
          stdout: Buffer.from(payload),
        })) as unknown as typeof import('bun').spawnSync).kind
      ).toBe('unavailable');
    }
  });
});
