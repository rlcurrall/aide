---
description: Update pull request
allowed-tools: Bash(aide:*)
---

Update an existing pull request.

## Usage

`/aide:pr-update --pr <id> --title "New title"` - Update PR title
`/aide:pr-update --pr <id> --description "New description"` - Update PR description
`/aide:pr-update --pr <id> --publish` - Publish a draft PR (make it active)
`/aide:pr-update --pr <id> --draft` - Convert PR back to draft
`/aide:pr-update --pr <id> --abandon` - Abandon the PR
`/aide:pr-update --pr <id> --activate` - Reactivate an abandoned PR
`/aide:pr-update --title "New title"` - Auto-detect PR from current branch

## Execution

Run the following command with the provided arguments:

```bash
aide pr update $ARGUMENTS
```

## Flags

| Flag            | Description                    |
| --------------- | ------------------------------ |
| `--title`       | Update PR title                |
| `--description` | Update PR description          |
| `--draft`       | Convert to draft PR            |
| `--publish`     | Publish draft PR (make active) |
| `--abandon`     | Abandon the PR                 |
| `--activate`    | Reactivate an abandoned PR     |

## Output

Displays the updated PR details including:

1. PR ID and URL
2. Updated title and description
3. Current status
4. Confirmation of changes made

## Workflow

Common update scenarios:

1. **Publishing draft**: After addressing all feedback, use `--publish` to mark ready for merge
2. **Reverting to draft**: Use `--draft` if more work is needed
3. **Abandoning**: Use `--abandon` to close without merging
4. **Updating description**: Keep PR description in sync with implementation changes
