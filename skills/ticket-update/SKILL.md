---
name: ticket-update
description: Update fields on an existing Jira ticket. Use when the user wants to modify a ticket's summary, description, assignee, priority, labels, or custom fields.
allowed-tools: Bash(aide:*),Read
---

# Update Jira Ticket

Update fields on an existing Jira ticket.

## When to Use

- User wants to change ticket title or description
- User wants to assign/reassign a ticket
- User wants to change priority or labels
- User wants to update custom fields

## How to Execute

First, view the current ticket to see existing values:

```bash
aide jira view TICKET-KEY
```

Then update desired fields:

```bash
aide jira update TICKET-KEY [options]
```

### Flags

| Flag              | Short | Description                                         |
| ----------------- | ----- | --------------------------------------------------- |
| `--summary`       | `-s`  | Update summary/title                                |
| `--description`   | `-d`  | Update description (markdown format)                |
| `--file`          | `-f`  | Read description from markdown file                 |
| `--assignee`      | `-a`  | Update assignee (email, "me", or "none")            |
| `--priority`      |       | Update priority (e.g., High, Medium, Low)           |
| `--labels`        |       | Set labels (comma-separated, replaces existing)     |
| `--add-labels`    |       | Add labels (keeps existing)                         |
| `--remove-labels` |       | Remove specific labels                              |
| `--component`     |       | Set components (can be repeated, replaces existing) |
| `--field`         |       | Custom field (Name=value format)                    |
| `--format`        |       | Output format: text, json, markdown                 |

## Custom Fields

The `--field` flag supports intelligent handling:

- **Name resolution**: Use `--field "Severity=High"` instead of internal IDs
- **Auto-formatting**: Values are formatted based on field type
- **Validation**: Invalid values show helpful errors

Use **ticket-fields** skill to discover available fields.

## Common Patterns

```bash
# Update title
aide jira update PROJ-123 --summary "Updated feature title"

# Update description
aide jira update PROJ-123 --description "New description with **markdown**"

# Update from file
aide jira update PROJ-123 --file ./new-description.md

# Assign to yourself
aide jira update PROJ-123 --assignee me

# Unassign
aide jira update PROJ-123 --assignee none

# Change priority
aide jira update PROJ-123 --priority High

# Add labels without removing existing
aide jira update PROJ-123 --add-labels "needs-review"

# Remove specific labels
aide jira update PROJ-123 --remove-labels "wip,draft"

# Multiple updates at once
aide jira update PROJ-123 --summary "New title" --assignee me --priority High

# Update custom field
aide jira update PROJ-123 --field "Severity=High"
```

## Important Notes

- **Description replacement**: `--description` replaces the entire description
- **Description format**: Use Markdown - automatically converted to Jira format
- **Labels**: Use `--labels` to replace all, `--add-labels` to add, `--remove-labels` to remove
- **Assignee options**: Use "me" for yourself, "none" to unassign, or provide email

## Best Practices

- Read the ticket first to preserve existing content when updating description
- Use `--add-labels` instead of `--labels` to avoid removing existing labels
- When updating descriptions, preserve important existing content

## Next Steps

After updating:

- Use **ticket** skill to verify changes
- Use **ticket-comment** skill to note the update
