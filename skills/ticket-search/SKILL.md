---
name: ticket-search
description: Search Jira tickets using JQL queries. Use when the user wants to find tickets, search for issues, list their assigned work, or query the backlog.
allowed-tools: Bash(aide:*)
---

# Search Jira Tickets

Search for Jira tickets using JQL (Jira Query Language).

## When to Use

- User asks "what are my tickets?" or "find tickets about X"
- User wants to search for issues by keyword, status, or assignee
- User needs to query the backlog or sprint
- User wants to find related issues

## How to Execute

Run:

```bash
aide jira search "JQL query" [maxResults] [--format text|json|markdown]
```

### Flags

| Flag         | Description                                         |
| ------------ | --------------------------------------------------- |
| `maxResults` | Maximum results to return (positional, default: 50) |
| `--limit`    | Alias for maxResults                                |
| `--format`   | Output format: text, json, markdown                 |

## Common JQL Patterns

### Personal Queries

```bash
# My open tickets
aide jira search "assignee = currentUser() AND status != Closed"

# My in-progress work
aide jira search "assignee = currentUser() AND status = 'In Progress'"

# Tickets I'm watching
aide jira search "watcher = currentUser()"

# Tickets I reported
aide jira search "reporter = currentUser()"
```

### Project Queries

```bash
# All open bugs in project
aide jira search "project = PROJ AND issuetype = Bug AND status != Closed"

# High priority unassigned
aide jira search "project = PROJ AND priority = High AND assignee IS EMPTY"

# Sprint tickets
aide jira search "project = PROJ AND sprint in openSprints()"

# Specific component
aide jira search "project = PROJ AND component = 'API'"
```

### Time-Based Queries

```bash
# Recent bugs (last 7 days)
aide jira search "issuetype = Bug AND created >= -7d"

# Updated this week
aide jira search "updated >= startOfWeek()"

# Resolved this month
aide jira search "resolved >= startOfMonth()"
```

### Text Search

```bash
# Search by keyword in all text fields
aide jira search "text ~ 'authentication'"

# Search in summary only
aide jira search "summary ~ 'login bug'"

# Combine with filters
aide jira search "project = PROJ AND text ~ 'performance' AND priority = High"
```

## Output Includes

1. Ticket key (e.g., PROJ-123)
2. Summary/title
3. Status
4. Assignee
5. Priority

## Next Steps

After finding tickets:

- Use **ticket** skill to view full details
- Use **ticket-comments** skill to see discussion
- Use **ticket-update** skill to modify tickets
