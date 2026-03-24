---
name: pr-update
description: Update an existing pull request. Use when the user wants to modify PR title, description, publish a draft, convert to draft, abandon, or reactivate a PR.
allowed-tools: Bash(aide:*)
---

# Update Pull Request

Update an existing pull request's title, description, or status.

## When to Use

- User wants to update PR title or description
- User wants to publish a draft PR
- User wants to convert PR back to draft
- User wants to abandon or reactivate a PR

## How to Execute

Run:

```bash
aide pr update [--pr <id>] [options]
```

### Flags

| Flag            | Description                            |
| --------------- | -------------------------------------- |
| `--pr`          | PR ID (auto-detected if omitted)       |
| `--title`       | Update PR title                        |
| `--description` | Update PR description                  |
| `--target`      | Change target/base branch              |
| `--draft`       | Convert to draft PR                    |
| `--publish`     | Publish draft PR (make active)         |
| `--abandon`     | Abandon the PR                         |
| `--activate`    | Reactivate an abandoned PR             |
| `--tag`         | Add tag(s) to the PR (repeatable)      |
| `--remove-tag`  | Remove tag(s) from the PR (repeatable) |

## Output Includes

1. PR ID and URL
2. Updated title and description
3. Current status
4. Confirmation of changes made

## Common Patterns

```bash
# Update title (auto-detect PR from branch)
aide pr update --title "PROJ-123: Improved auth flow"

# Update specific PR's description
aide pr update --pr 24094 --description "Updated implementation notes"

# Publish draft when ready for review
aide pr update --pr 24094 --publish

# Convert back to draft if more work needed
aide pr update --pr 24094 --draft

# Abandon PR
aide pr update --pr 24094 --abandon

# Reactivate abandoned PR
aide pr update --pr 24094 --activate

# Add tags
aide pr update --tag bug --tag performance

# Remove tags
aide pr update --remove-tag "old-tag"

# Tag-only update (no other fields needed)
aide pr update --tag "new-tag"
```

## PR Lifecycle Management

| Status    | Action       | Use Case                       |
| --------- | ------------ | ------------------------------ |
| Draft     | `--publish`  | Ready for review               |
| Active    | `--draft`    | Need more work before review   |
| Active    | `--abandon`  | Close without merging          |
| Abandoned | `--activate` | Reopen previously abandoned PR |

## Best Practices

- Update description as implementation evolves
- Publish drafts only when truly ready for review
- Use abandon instead of deleting to preserve history
- Keep title synchronized with actual changes

## Next Steps

After updating a PR:

- Use **pr-comments** skill to check for new feedback
- Use **pr-view** skill to verify changes
