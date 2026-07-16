import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dir, '../../..');
const fixtureDirectory = join(
  import.meta.dir,
  'test-fixtures/command-descriptor-declaration'
);

function runTsc(arguments_: readonly string[]) {
  const result = spawnSync(
    join(repositoryRoot, 'node_modules/.bin/tsc'),
    arguments_,
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
    }
  );

  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
  };
}

function diagnosticMarkers(source: string): Map<number, string> {
  const markers = new Map<number, string>();
  const lines = source.split('\n');
  for (const [index, line] of lines.entries()) {
    const marker = line.match(/^\/\/ @diagnostic (\S+)$/)?.[1];
    if (marker !== undefined) markers.set(index + 2, marker);
  }
  return markers;
}

describe('emitted command descriptor declarations', () => {
  test('retain environment invariance for an external TypeScript consumer', () => {
    const temporaryDirectory = mkdtempSync(
      join(repositoryRoot, '.command-descriptor-declaration-')
    );

    try {
      const declarationDirectory = join(temporaryDirectory, 'declarations');
      const emit = runTsc([
        '--project',
        join(fixtureDirectory, 'tsconfig.emit.json'),
        '--outDir',
        declarationDirectory,
      ]);
      expect(emit.status, emit.output).toBe(0);

      const emittedDescriptor = readFileSync(
        join(declarationDirectory, 'src/cli/host/command-descriptor.d.ts'),
        'utf8'
      );
      const compilerOptions = {
        strict: true,
        skipLibCheck: true,
        target: 'ESNext',
        module: 'Preserve',
        moduleResolution: 'bundler',
        noEmit: true,
        baseUrl: temporaryDirectory,
        paths: {
          '@aide/internal-command-descriptor': [
            'declarations/src/cli/host/command-descriptor.d.ts',
          ],
          '@aide/plugin-api': ['declarations/src/cli/plugin-api.d.ts'],
          '@cli/*': ['declarations/src/cli/*'],
          '@lib/*': ['declarations/src/lib/*'],
          '@schemas/*': ['declarations/src/schemas/*'],
        },
      } as const;

      const validConsumer = join(temporaryDirectory, 'valid-consumer.ts');
      const validSource = readFileSync(
        join(fixtureDirectory, 'valid-consumer.ts.fixture'),
        'utf8'
      );
      expect(validSource.match(/^\/\/ @valid same:/gm)).toHaveLength(4);
      expect(validSource.match(/^\/\/ @valid public:/gm)).toHaveLength(5);
      writeFileSync(validConsumer, validSource);
      const validConfig = join(temporaryDirectory, 'tsconfig.valid.json');
      writeFileSync(
        validConfig,
        JSON.stringify({ compilerOptions, files: [validConsumer] })
      );
      const valid = runTsc(['--project', validConfig, '--pretty', 'false']);
      expect(valid.status, valid.output).toBe(0);

      const pullRequestOperationErrorsConsumer = join(
        temporaryDirectory,
        'pull-request-operation-errors.ts'
      );
      writeFileSync(
        pullRequestOperationErrorsConsumer,
        readFileSync(
          join(fixtureDirectory, 'pull-request-operation-errors.ts.fixture'),
          'utf8'
        )
      );
      const pullRequestOperationErrorsConfig = join(
        temporaryDirectory,
        'tsconfig.pull-request-operation-errors.json'
      );
      writeFileSync(
        pullRequestOperationErrorsConfig,
        JSON.stringify({
          compilerOptions,
          files: [pullRequestOperationErrorsConsumer],
        })
      );
      const pullRequestOperationErrors = runTsc([
        '--project',
        pullRequestOperationErrorsConfig,
        '--pretty',
        'false',
      ]);
      expect(
        pullRequestOperationErrors.status,
        pullRequestOperationErrors.output
      ).toBe(0);

      const invalidSource = readFileSync(
        join(fixtureDirectory, 'invalid-consumer.ts.fixture'),
        'utf8'
      );
      const invalidConsumer = join(temporaryDirectory, 'invalid-consumer.ts');
      writeFileSync(invalidConsumer, invalidSource);
      const invalidConfig = join(temporaryDirectory, 'tsconfig.invalid.json');
      writeFileSync(
        invalidConfig,
        JSON.stringify({ compilerOptions, files: [invalidConsumer] })
      );
      const invalid = runTsc(['--project', invalidConfig, '--pretty', 'false']);
      expect(invalid.status).not.toBe(0);

      const expectedMarkers = diagnosticMarkers(invalidSource);
      const expectedMarkerNames = [...expectedMarkers.values()];
      expect(
        expectedMarkerNames.filter((marker) => marker.startsWith('cross:'))
      ).toHaveLength(12);
      expect(
        expectedMarkerNames.filter((marker) => marker.startsWith('raw:'))
      ).toHaveLength(4);
      expect(
        expectedMarkerNames.filter((marker) => marker.startsWith('spread:'))
      ).toHaveLength(4);
      expect(
        expectedMarkerNames.filter((marker) =>
          marker.startsWith('public-runtime:')
        )
      ).toHaveLength(3);
      const diagnosticLines = [
        ...invalid.output.matchAll(
          /invalid-consumer\.ts\((\d+),\d+\): error TS\d+:/g
        ),
      ].map((match) => Number(match[1]));
      const actualMarkers = diagnosticLines
        .map((line) => expectedMarkers.get(line))
        .filter((marker): marker is string => marker !== undefined);

      expect(new Set(actualMarkers), invalid.output).toEqual(
        new Set(expectedMarkers.values())
      );
      expect(diagnosticLines, invalid.output).toHaveLength(
        expectedMarkers.size
      );
      expect(emittedDescriptor).toContain(
        'declare const descriptorEnvironmentNominality: unique symbol;'
      );
      expect(emittedDescriptor).toContain(
        '[descriptorEnvironmentNominality](environment: R): (environment: R) => R;'
      );
      expect(emittedDescriptor).not.toContain(
        'export { descriptorEnvironmentNominality'
      );
      const emittedPluginApi = readFileSync(
        join(declarationDirectory, 'src/cli/plugin-api.d.ts'),
        'utf8'
      );
      expect(emittedPluginApi).toContain(
        'export interface AidePluginCommandDescriptor<TArgs extends object = object, E = unknown>'
      );
      expect(emittedPluginApi).toContain(
        'export type AidePrimeContributionCapability = InternalAidePrimeContributionCapability<never>;'
      );
      expect(emittedPluginApi).toContain(
        'export type AidePullRequestProviderCapability = InternalAidePullRequestProviderCapability<never>;'
      );
    } finally {
      rmSync(temporaryDirectory, { force: true, recursive: true });
    }
  }, 30_000);
});
