---
description: List pull requests
allowed-tools: Bash(aide:*)
---

List pull requests from the repository with filtering options.

## Usage

`/aide:pr-list` - List active PRs (auto-discovers project/repo from git remote)
`/aide:pr-list --status all` - List all PRs regardless of status
`/aide:pr-list --created-by "email"` - Filter by creator

## Execution

Run the following command with the provided arguments:

```bash
aide pr list $ARGUMENTS
```

## Flags

| Flag | Description |
|------|-------------|
| `--status` | Filter by status: active, completed, abandoned, all (default: active) |
| `--limit` | Maximum number of PRs to return (default: 20) |
| `--created-by` | Filter by creator email or display name |
| `--author` | Alias for --created-by |
| `--project` | Project name (auto-discovered from git remote) |
| `--repo` | Repository name (auto-discovered from git remote) |
| `--format` | Output format: text, json, markdown |

## Output

Displays PR list with:

1. PR number and title
2. Status (active, completed, abandoned)
3. Creation date
4. Author name
5. Description preview

## Examples

```bash
# List active PRs (default)
aide pr list

# List all PRs
aide pr list --status all

# List completed (merged) PRs
aide pr list --status completed

# List your PRs
aide pr list --created-by "your.email@company.com"

# List PRs with limit
aide pr list --limit 50

# Combine filters
aide pr list --status active --created-by "john.doe" --limit 10

# Output as JSON
aide pr list --format json

# Output as markdown
aide pr list --format markdown
```

## Workflow

Use this command to:

1. **Find PRs to review**: List active PRs to see what needs attention
2. **Track your work**: Filter by your email to see your open PRs
3. **Audit history**: List completed PRs to review merged changes
4. **Monitor team activity**: See all active PRs across the repository
