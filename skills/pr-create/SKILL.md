---
name: pr-create
description: Create a new pull request. Use when the user wants to open a PR, submit code for review, create a draft PR, or push changes for merge.
allowed-tools: Bash(aide:*)
---

# Create Pull Request

Create a new pull request from the current branch.

## When to Use

- User says "create a PR" or "open a pull request"
- User wants to submit code for review
- User has finished changes and needs to merge
- User wants to create a draft PR for early feedback

## How to Execute

Run:

```bash
aide pr create --title "Title" [options]
```

### Flags

Supports both GitHub CLI and Azure CLI style flags:

| Flag (gh-style) | Short | Aliases (az-style)                  | Description                                     |
| --------------- | ----- | ----------------------------------- | ----------------------------------------------- |
| `--title`       | `-t`  | -                                   | PR title (required)                             |
| `--body`        | `-b`  | `--description`                     | PR description/body                             |
| `--head`        | `-H`  | `--source`, `-s`, `--source-branch` | Source/head branch (defaults to current branch) |
| `--base`        | `-B`  | `--target`, `--target-branch`       | Target/base branch (defaults to main)           |
| `--draft`       | `-d`  | -                                   | Create as draft PR                              |
| `--tag`         | -     | -                                   | Add tag(s) to the PR (repeatable)               |

## Output Includes

1. PR ID and URL
2. Title and description
3. Source and target branches
4. Status (draft or active)

## Best Practices

- Use descriptive titles that summarize the change
- Include ticket references in title (e.g., "PROJ-123: Add feature")
- Start as draft if work is incomplete
- Always include a meaningful description

## Common Patterns

```bash
# Basic PR creation
aide pr create --title "Add user authentication"

# With description
aide pr create --title "PROJ-123: Add OAuth" --body "Implements OAuth 2.0 with PKCE flow"

# Draft PR for early feedback
aide pr create --title "WIP: Refactor auth module" --draft

# Targeting specific branch
aide pr create --title "Hotfix: Login bug" --base release/v2.0

# With tags
aide pr create --title "PROJ-123: Fix performance" --tag bug --tag performance
```

## PR Management Workflow

1. **Prepare branch**: Ensure all changes are committed and pushed
2. **Create PR**: Use appropriate flags for title, description, target
3. **Draft mode**: Use `--draft` for work-in-progress
4. **Monitor**: Use **pr-comments** skill to track feedback
5. **Publish**: Use **pr-update** skill with `--publish` when ready

## Next Steps

After creating a PR:

- Share the PR URL with reviewers
- Use **pr-comments** skill to monitor feedback
- Use **pr-update** skill to publish draft when ready
