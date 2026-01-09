---
description: Create pull request
allowed-tools: Bash(aide:*)
---

Create a new pull request from the current branch.

## Usage

`/aide:pr-create --title "Title"` - Create PR with title (uses current branch as head, default base branch)
`/aide:pr-create -t "Title" -b "Description"` - Create PR with title and body (gh-style short flags)
`/aide:pr-create --title "Title" --base main` - Create PR targeting specific base branch
`/aide:pr-create --title "Title" --body "Details"` - Create PR with body/description
`/aide:pr-create --title "Title" --draft` - Create PR as draft
`/aide:pr-create --head feature/xyz --base develop --title "Title"` - Specify both head and base branches (gh-style)
`/aide:pr-create --source feature/xyz --target develop --title "Title"` - Specify both branches (az-style, aliases)

## Execution

Run the following command with the provided arguments:

```bash
aide pr create $ARGUMENTS
```

## Flags

Flags follow GitHub CLI (`gh`) conventions with Azure CLI (`az`) compatibility aliases.

| Flag (gh-style)                  | Short | Aliases (az-style)                        | Description                                      |
| -------------------------------- | ----- | ----------------------------------------- | ------------------------------------------------ |
| `--title`                        | `-t`  | -                                         | PR title (required)                              |
| `--body`                         | `-b`  | `--description`                           | PR description/body                              |
| `--head`                         | `-H`  | `--source`, `-s`, `--source-branch`       | Source/head branch (defaults to current branch)  |
| `--base`                         | `-B`  | `--target`, `--target-branch`             | Target/base branch (defaults to main)            |
| `--draft`                        | `-d`  | -                                         | Create as draft PR                               |

## Output

Displays the created PR details including:

1. PR ID and URL
2. Title and description
3. Source and target branches
4. Status (draft or active)

## Workflow

After creating a PR:

1. Share the PR URL with reviewers
2. Use `/aide:pr-comments --pr <pr-id>` to monitor feedback
3. Use `/aide:pr-update --pr <pr-id> --publish` when ready to publish a draft
4. Address reviewer comments with code changes
