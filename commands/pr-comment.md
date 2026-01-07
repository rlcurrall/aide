---
description: Post comment on Azure DevOps PR
allowed-tools: Bash(aide:*)
---

Post a comment on an Azure DevOps pull request thread.

## Usage

`/aide:pr-comment <pr-id> "comment text"` - Add general PR comment
`/aide:pr-comment <pr-id> "comment" --file src/app.ts --line 42` - Comment on a specific file/line
`/aide:pr-comment "comment text"` - Auto-detect PR from current branch

## Execution

Run the following command with the provided arguments:

```bash
aide ado pr comment $ARGUMENTS
```

## Flags

| Flag     | Description                             |
| -------- | --------------------------------------- |
| `--file` | File path to attach comment to          |
| `--line` | Line number in file (requires `--file`) |

## Output

Displays the posted comment details including:

1. Thread ID
2. Comment content
3. File and line location (if specified)
4. Timestamp

## Workflow

Use comments to:

1. **Respond to feedback**: Reply to reviewer comments with explanations
2. **Request review**: Add a comment when changes are ready for re-review
3. **Ask questions**: Clarify requirements or implementation approaches
4. **Document decisions**: Record architectural or design decisions

## Examples

```bash
# General PR comment
aide ado pr comment 24094 "Ready for re-review after addressing all feedback"

# Comment on specific line
aide ado pr comment 24094 "Added null check as suggested" --file src/utils/helpers.ts --line 127
```
