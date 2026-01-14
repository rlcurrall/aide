---
description: Update Jira ticket fields
allowed-tools: Bash(aide:*),Read
---

Update fields on an existing Jira ticket including summary, description, assignee, priority, labels, and more.

## Usage

`/aide:ticket-update TICKET-KEY --summary "New title"` - Update title
`/aide:ticket-update TICKET-KEY --description "New desc"` - Update description
`/aide:ticket-update TICKET-KEY --assignee me` - Assign to yourself

## Execution

First, fetch the current ticket to see existing values:

```bash
aide jira view $ARGUMENTS
```

Then update the desired fields:

```bash
aide jira update $ARGUMENTS
```

## Flags

| Flag | Short | Description |
|------|-------|-------------|
| `--summary` | `-s` | Update summary/title |
| `--description` | `-d` | Update description (markdown format) |
| `--file` | `-f` | Read description from markdown file |
| `--assignee` | `-a` | Update assignee (email, account ID, "me", or "none") |
| `--priority` | | Update priority (e.g., High, Medium, Low) |
| `--labels` | | Set labels (comma-separated, replaces existing) |
| `--add-labels` | | Add labels (comma-separated, keeps existing) |
| `--remove-labels` | | Remove labels (comma-separated) |
| `--component` | | Set components (can be repeated, replaces existing) |
| `--field` | | Custom field (format: fieldName=value, can repeat) |
| `--format` | | Output format: text, json, markdown |

**Note:** At least one field to update must be specified.

## Output

Displays confirmation with:

1. Ticket key
2. URL to view the updated ticket

## Examples

```bash
# Update title
aide jira update PROJ-123 --summary "Updated feature title"

# Update description
aide jira update PROJ-123 --description "New detailed description with **markdown** support"

# Update description from file
aide jira update PROJ-123 --file ./new-description.md

# Assign to yourself
aide jira update PROJ-123 --assignee me

# Assign to someone else
aide jira update PROJ-123 --assignee "john.doe@company.com"

# Unassign
aide jira update PROJ-123 --assignee none

# Change priority
aide jira update PROJ-123 --priority High

# Replace all labels
aide jira update PROJ-123 --labels "frontend,urgent,v2"

# Add labels without removing existing
aide jira update PROJ-123 --add-labels "needs-review"

# Remove specific labels
aide jira update PROJ-123 --remove-labels "wip,draft"

# Set components
aide jira update PROJ-123 --component API --component Backend

# Set custom field
aide jira update PROJ-123 --field "customfield_10001=value"

# Multiple updates at once
aide jira update PROJ-123 --summary "New title" --assignee me --priority High --add-labels "in-progress"
```

## Important Notes

- **Description replacement**: `--description` replaces the entire description. Read the ticket first to preserve existing content if needed.
- **Labels**: Use `--labels` to replace all labels, `--add-labels` to add without removing, `--remove-labels` to remove specific ones.
- **Assignee options**: Use "me" for yourself, "none" to unassign, or provide an email/account ID.
