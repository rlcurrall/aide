---
name: ticket-comments
description: Get comments from a Jira ticket to review discussion history. Use when the user wants to see ticket comments, check for updates, review feedback, or understand the discussion on an issue.
allowed-tools: Bash(aide:*)
---

# Get Ticket Comments

Retrieve and view comments from a Jira ticket with filtering options.

## When to Use

- User asks "what's been discussed on this ticket?"
- User wants to check for updates from stakeholders
- User needs to review feedback or decisions
- User wants to see recent activity on a ticket

## How to Execute

Run:

```bash
aide jira comments TICKET-KEY [options]
```

### Flags

| Flag            | Description                                           |
| --------------- | ----------------------------------------------------- |
| `--author`      | Filter comments by author name/email                  |
| `--since`       | Show comments since date (YYYY-MM-DD)                 |
| `--latest`      | Show only N most recent comments                      |
| `--max-results` | Maximum comments to fetch per API call (default: 100) |
| `--all`         | Fetch all comments (may require multiple API calls)   |
| `--format`      | Output format: text, json, markdown                   |

## Output Includes

1. Author name
2. Timestamp
3. Comment content
4. Total comment count

## Common Patterns

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

## Use Cases

| Goal                   | Command                                          |
| ---------------------- | ------------------------------------------------ |
| Review discussion      | `aide jira comments PROJ-123`                    |
| Check recent updates   | `aide jira comments PROJ-123 --latest 5`         |
| See specific reviewer  | `aide jira comments PROJ-123 --author "name"`    |
| Track since last check | `aide jira comments PROJ-123 --since 2024-01-15` |

## Best Practices

- Use `--latest N` to focus on recent discussion
- Filter by `--author` to see specific stakeholder's input
- Use `--since` to see updates since your last review
- Use `--format json` for structured processing

## Next Steps

After reviewing comments:

- Use **ticket-comment** skill to respond
- Use **ticket-update** skill if changes are needed
- Use **ticket-transition** skill to change status
