---
description: Load Azure DevOps PR comments for code review
allowed-tools: Bash(aide:*)
---

Fetch PR comments from Azure DevOps to review feedback.

## Usage

`/aide:pr` - Auto-detect PR from current branch
`/aide:pr <pr-id>` - Load specific PR by ID
`/aide:pr <pr-url>` - Load PR from full URL
`/aide:pr --latest 10` - Load latest 10 comments
`/aide:pr --thread-status active` - Load only active/unresolved threads

## Execution

Run the following command with the provided arguments:

```bash
aide ado comments $ARGUMENTS
```

## Output

Display PR comments organized by:

1. File path and line number
2. Thread status (active, fixed, etc.)
3. Author and timestamp
4. Comment content

For active threads, help the user understand what changes are being requested and suggest how to address them.

## Workflow

After loading PR comments:

1. Summarize the key feedback points
2. Identify any blocking issues
3. Suggest an order to address comments (critical first)
4. Offer to help implement fixes for specific comments
