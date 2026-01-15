---
description: Search Jira tickets using JQL
allowed-tools: Bash(aide:*)
---

Search for Jira tickets using JQL (Jira Query Language).

## Usage

`/aide:ticket-search "JQL query"` - Search with JQL
`/aide:ticket-search "assignee = currentUser()"` - Find your tickets
`/aide:ticket-search "project = PROJ" 10` - Limit results

## Execution

Run the following command with the provided arguments:

```bash
aide jira search $ARGUMENTS
```

## Flags

| Flag         | Description                                         |
| ------------ | --------------------------------------------------- |
| `maxResults` | Maximum results to return (positional, default: 50) |
| `--limit`    | Alias for maxResults                                |
| `--format`   | Output format: text, json, markdown                 |

## Output

Displays search results showing:

1. Ticket key (e.g., PROJ-123)
2. Summary/title
3. Status
4. Assignee
5. Priority

## Common JQL Patterns

### Personal Queries

```bash
# My open tickets
aide jira search "assignee = currentUser() AND status != Closed"

# My in-progress work
aide jira search "assignee = currentUser() AND status = 'In Progress'"

# Tickets I'm watching
aide jira search "watcher = currentUser()"
```

### Project Queries

```bash
# All open bugs in project
aide jira search "project = PROJ AND issuetype = Bug AND status != Closed"

# High priority unassigned
aide jira search "project = PROJ AND priority = High AND assignee IS EMPTY"

# Sprint tickets
aide jira search "project = PROJ AND sprint in openSprints()"
```

### Time-Based Queries

```bash
# Recent bugs (last 7 days)
aide jira search "issuetype = Bug AND created >= -7d"

# Updated this week
aide jira search "updated >= startOfWeek()"
```

### Text Search

```bash
# Search by keyword
aide jira search "text ~ 'authentication'"

# Search in summary only
aide jira search "summary ~ 'login bug'"
```

## Examples

```bash
# Search for your tickets
aide jira search "assignee = currentUser()"

# Limit to 10 results
aide jira search "project = PROJ" 10

# Get JSON output
aide jira search "status = 'In Progress'" --format json
```
