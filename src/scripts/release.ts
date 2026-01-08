#!/usr/bin/env bun

/**
 * Release script that:
 * 1. Bumps version in package.json, .claude-plugin/plugin.json, and .claude-plugin/marketplace.json
 * 2. Commits the changes
 * 3. Creates a git tag
 * 4. Pushes to remote
 *
 * Usage:
 *   bun release          # patch bump (0.0.0 -> 0.0.1)
 *   bun release --minor  # minor bump (0.0.0 -> 0.1.0)
 *   bun release --major  # major bump (0.0.0 -> 1.0.0)
 */

import { spawnSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

type BumpType = 'major' | 'minor' | 'patch';

function parseArgs(): BumpType {
  const args = process.argv.slice(2);

  if (args.includes('--major')) return 'major';
  if (args.includes('--minor')) return 'minor';
  return 'patch';
}

function bumpVersion(currentVersion: string, bumpType: BumpType): string {
  const [major = 0, minor = 0, patch = 0] = currentVersion
    .split('.')
    .map(Number);

  switch (bumpType) {
    case 'major':
      return `${major + 1}.0.0`;
    case 'minor':
      return `${major}.${minor + 1}.0`;
    case 'patch':
      return `${major}.${minor}.${patch + 1}`;
  }
}

function updateJsonFile(filePath: string, newVersion: string): void {
  const content = JSON.parse(readFileSync(filePath, 'utf-8'));
  content.version = newVersion;
  writeFileSync(filePath, JSON.stringify(content, null, 2) + '\n');
  console.log(`✓ Updated ${filePath} to ${newVersion}`);
}

function updateMarketplaceFile(filePath: string, newVersion: string): void {
  const content = JSON.parse(readFileSync(filePath, 'utf-8'));
  if (content.plugins && content.plugins[0]) {
    content.plugins[0].version = newVersion;
  }
  writeFileSync(filePath, JSON.stringify(content, null, 2) + '\n');
  console.log(`✓ Updated ${filePath} to ${newVersion}`);
}

function execCommand(command: string, args: string[]): void {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`✗ Failed to execute: ${command} ${args.join(' ')}`);
    process.exit(1);
  }
}

function main() {
  const bumpType = parseArgs();
  const projectRoot = join(import.meta.dir, '../..');

  // Read current version from package.json
  const packageJsonPath = join(projectRoot, 'package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
  const currentVersion = packageJson.version;
  const newVersion = bumpVersion(currentVersion, bumpType);

  console.log(
    `\n🚀 Releasing new ${bumpType} version: ${currentVersion} → ${newVersion}\n`
  );

  // Update all version files
  updateJsonFile(packageJsonPath, newVersion);
  updateJsonFile(join(projectRoot, '.claude-plugin/plugin.json'), newVersion);
  updateMarketplaceFile(
    join(projectRoot, '.claude-plugin/marketplace.json'),
    newVersion
  );

  console.log('\n📝 Committing changes...');
  execCommand('git', [
    'add',
    'package.json',
    '.claude-plugin/plugin.json',
    '.claude-plugin/marketplace.json',
  ]);
  execCommand('git', ['commit', '-m', `chore: bump version to v${newVersion}`]);

  console.log(`\n🏷️  Creating tag v${newVersion}...`);
  execCommand('git', ['tag', `v${newVersion}`]);

  console.log('\n📤 Pushing to remote...');
  execCommand('git', ['push', 'origin', 'main']);
  execCommand('git', ['push', 'origin', `v${newVersion}`]);

  console.log(`\n✅ Release v${newVersion} complete!`);
  console.log(`\n🔗 GitHub Actions will build and publish the release at:`);
  console.log(
    `   https://github.com/your-org/aide/releases/tag/v${newVersion}\n`
  );
}

main();
