---
name: release
description: Create a new software release by bumping version numbers, committing changes, creating git tags, and pushing to remote. Use when creating a release, bumping versions, or publishing a new version.
allowed-tools: Bash(bun:*)
---

# Release

Create a new release for the aide CLI.

## What it does

The release script (`src/scripts/release.ts`):

1. Bumps version in `package.json`, `.claude-plugin/plugin.json`, and `.claude-plugin/marketplace.json`
2. Commits the version changes
3. Creates a git tag (e.g., `v0.0.3`)
4. Pushes to remote (both commit and tag)

## Usage

| Command | Description |
|---------|-------------|
| `bun release` | Patch bump (0.0.1 -> 0.0.2) |
| `bun release --minor` | Minor bump (0.0.1 -> 0.1.0) |
| `bun release --major` | Major bump (0.0.1 -> 1.0.0) |

## Instructions

1. Ask the user which version bump type they want (patch, minor, or major) if not specified
2. Run the appropriate command:
   - Patch (default): `bun release`
   - Minor: `bun release --minor`
   - Major: `bun release --major`
3. Report the new version and the GitHub release URL

## Example output

```
🚀 Releasing new patch version: 0.0.1 → 0.0.2

✓ Updated package.json to 0.0.2
✓ Updated .claude-plugin/plugin.json to 0.0.2
✓ Updated .claude-plugin/marketplace.json to 0.0.2

📝 Committing changes...
🏷️  Creating tag v0.0.2...
📤 Pushing to remote...

✅ Release v0.0.2 complete!

🔗 GitHub Actions will build and publish the release at:
   https://github.com/rlcurrall/aide/releases/tag/v0.0.2
```
