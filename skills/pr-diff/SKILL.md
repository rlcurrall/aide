---
name: pr-diff
description: View pull request diff and code changes. Use when the user wants to see what changed in a PR, review code changes, understand the scope of modifications, or examine specific file changes.
allowed-tools: Bash(aide:*)
---

# View Pull Request Diff

View changes in a pull request including file diffs and change statistics.

## When to Use

- User asks "what changed?" or "show me the changes"
- User wants to review code before approving
- User needs to understand the scope of modifications
- User wants to see a specific file's changes

## How to Execute

Run:

```bash
aide pr diff [--pr <id|url>] [options]
```

### Options

| Flag         | Description                                            |
| ------------ | ------------------------------------------------------ |
| `--pr`       | PR ID or URL (auto-detected from branch if omitted)    |
| `--stat`     | Show summary statistics with line counts               |
| `--files`    | Show only changed file paths                           |
| `--file`     | Show diff for a specific file path                     |
| `--no-fetch` | Skip auto-fetching missing branches (fetch by default) |

## Output Includes

1. Source and target branches
2. Changed files with +/- line counts (with `--stat`)
3. Full unified diff output (default)
4. File list only (with `--files`)

## Best Practices

- Start with `--stat` to get an overview of changes
- Use `--files` to see which files were modified
- Focus on specific files with `--file <path>` for detailed review
- Auto-fetch is enabled by default - use `--no-fetch` if branches are already local

## Progressive Review Pattern

```bash
# 1. Get overview of changes
aide pr diff --stat

# 2. See which files changed
aide pr diff --files

# 3. Review specific file
aide pr diff --file src/auth/login.ts
```

## Next Steps

After viewing PR diff:

- Use **pr-comments** skill to see related feedback
- Use **pr-view** skill for PR metadata
