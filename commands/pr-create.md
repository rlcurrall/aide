---
description: Create Azure DevOps pull request
allowed-tools: Bash(aide:*)
---

Create a new pull request in Azure DevOps from the current branch.

## Usage

`/aide:pr-create --title "Title"` - Create PR with title (uses current branch as source, default target branch)
`/aide:pr-create --title "Title" --target main` - Create PR targeting specific branch
`/aide:pr-create --title "Title" --description "Details"` - Create PR with description
`/aide:pr-create --title "Title" --draft` - Create PR as draft
`/aide:pr-create --source feature/xyz --target develop --title "Title"` - Specify both source and target branches

## Execution

Run the following command with the provided arguments:

```bash
aide ado pr create $ARGUMENTS
```

## Flags

| Flag            | Description                                |
| --------------- | ------------------------------------------ |
| `--title`       | PR title (required)                        |
| `--description` | PR description body                        |
| `--source`      | Source branch (defaults to current branch) |
| `--target`      | Target branch (defaults to repo default)   |
| `--draft`       | Create as draft PR                         |

## Output

Displays the created PR details including:

1. PR ID and URL
2. Title and description
3. Source and target branches
4. Status (draft or active)

## Workflow

After creating a PR:

1. Share the PR URL with reviewers
2. Use `/aide:pr <pr-id>` to monitor feedback
3. Use `/aide:pr-update <pr-id> --publish` when ready to publish a draft
4. Address reviewer comments with code changes
