---
name: pr-list
description: List pull requests from the repository. Use when the user wants to see open PRs, find PRs to review, check their own PRs, or browse PR history.
allowed-tools: Bash(aide:*)
---

# List Pull Requests

List pull requests from the repository with filtering options.

## When to Use

- User asks "what PRs are open?" or "show me the PRs"
- User wants to find PRs to review
- User wants to check their own open PRs
- User wants to browse completed/merged PRs

## How to Execute

Run:

```bash
aide pr list [options]
```

### Flags

| Flag           | Description                                                           |
| -------------- | --------------------------------------------------------------------- |
| `--status`     | Filter by status: active, completed, abandoned, all (default: active) |
| `--limit`      | Maximum number of PRs to return (default: 20)                         |
| `--created-by` | Filter by creator email or display name                               |
| `--author`     | Alias for --created-by                                                |
| `--project`    | Project name (auto-discovered from git remote)                        |
| `--repo`       | Repository name (auto-discovered from git remote)                     |
| `--format`     | Output format: text, json, markdown                                   |

## Output Includes

1. PR number and title
2. Status (active, completed, abandoned)
3. Creation date
4. Author name
5. Description preview

## Common Patterns

```bash
# List active PRs (default)
aide pr list

# List all PRs regardless of status
aide pr list --status all

# List completed (merged) PRs
aide pr list --status completed

# List your own PRs
aide pr list --created-by "your.email@company.com"

# Combine filters
aide pr list --status active --created-by "john.doe" --limit 10

# Output as JSON for processing
aide pr list --format json
```

## Use Cases

| Goal                  | Command                                      |
| --------------------- | -------------------------------------------- |
| Find PRs to review    | `aide pr list --status active`               |
| Track your work       | `aide pr list --created-by "me@company.com"` |
| Audit merged changes  | `aide pr list --status completed --limit 50` |
| Monitor team activity | `aide pr list --status all`                  |

## Best Practices

- Use `--status active` (default) for day-to-day review work
- Use `--created-by` to quickly find your own PRs
- Use `--format json` when processing results programmatically
- Set `--limit` higher when searching for specific PRs

## Next Steps

After listing PRs:

- Use **pr-view** skill to see details of a specific PR
- Use **pr-comments** skill to check feedback on a PR
- Use **pr-diff** skill to review code changes
