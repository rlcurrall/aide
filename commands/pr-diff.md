---
description: View pull request diff
allowed-tools: Bash(aide:*)
---

View changes in a pull request including file diffs and change statistics.

## Usage

`/aide:pr-diff` - Auto-detect PR from current branch
`/aide:pr-diff --pr <id>` - View specific PR diff by ID
`/aide:pr-diff --stat` - Show summary statistics
`/aide:pr-diff --files` - Show only changed file paths
`/aide:pr-diff --file <path>` - Show diff for specific file
`/aide:pr-diff --no-fetch` - Skip auto-fetching missing branches (fetch enabled by default)

## Execution

Run the following command with the provided arguments:

```bash
aide pr diff $ARGUMENTS
```

## Output

By default, aide automatically fetches missing source/target branches from the remote to ensure accurate diff output.

Display PR diff including:

1. Source and target branches
2. Changed files with +/- line counts (with --stat)
3. Full unified diff output (default)
4. File list only (with --files)

## Workflow

After viewing PR diff:

1. Understand what code has changed
2. Review specific files of interest with --file
3. Use `/aide:pr-comments` to see related feedback
