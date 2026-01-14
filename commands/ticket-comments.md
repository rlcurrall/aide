---
description: Get comments from a Jira ticket
allowed-tools: Bash(aide:*)
---

Retrieve and view comments from a Jira ticket with filtering options.

## Usage

`/aide:ticket-comments TICKET-KEY` - Get all comments
`/aide:ticket-comments TICKET-KEY --latest 5` - Get latest 5 comments
`/aide:ticket-comments TICKET-KEY --author "name"` - Filter by author

## Execution

Run the following command with the provided arguments:

```bash
aide jira comments $ARGUMENTS
```

## Flags

| Flag | Description |
|------|-------------|
| `--author` | Filter comments by author name/email |
| `--since` | Show comments since date (YYYY-MM-DD) |
| `--latest` | Show only N most recent comments |
| `--max-results` | Maximum comments to fetch per API call (default: 100) |
| `--all` | Fetch all comments (may require multiple API calls) |
| `--format` | Output format: text, json, markdown |

## Output

Displays comments with:

1. Author name
2. Timestamp
3. Comment content
4. Total comment count

## Workflow

Use this command to:

1. **Review discussion history**: See what's been discussed on a ticket
2. **Check for updates**: Look for recent comments from stakeholders
3. **Find specific feedback**: Filter by author to see a reviewer's comments
4. **Track progress**: Review comments since a specific date

## Examples

```bash
# Get all comments on a ticket
aide jira comments PROJ-123

# Get latest 5 comments
aide jira comments PROJ-123 --latest 5

# Filter by author
aide jira comments PROJ-123 --author "john.doe@company.com"

# Get comments since a date
aide jira comments PROJ-123 --since 2024-01-01

# Combine filters
aide jira comments PROJ-123 --latest 10 --author "reviewer"

# Get all comments with pagination
aide jira comments PROJ-123 --all

# Output as JSON for processing
aide jira comments PROJ-123 --format json
```
