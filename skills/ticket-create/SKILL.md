---
name: ticket-create
description: Create a new Jira ticket. Use when the user wants to create a task, bug, story, or any other issue type in Jira.
allowed-tools: Bash(aide:*)
---

# Create Jira Ticket

Create a new Jira ticket with the specified details.

## When to Use

- User says "create a ticket" or "make a new issue"
- User wants to log a bug or create a task
- User needs to track new work in Jira

## How to Execute

Run:

```bash
aide jira create -p PROJECT -t TYPE -s "Summary" [options]
```

### Required Flags

| Flag        | Short | Description                                   |
| ----------- | ----- | --------------------------------------------- |
| `--project` | `-p`  | Project key (required, e.g., PROJ)            |
| `--type`    | `-t`  | Issue type (required, e.g., Task, Bug, Story) |
| `--summary` | `-s`  | Issue summary/title (required)                |

### Optional Flags

| Flag            | Short | Description                           |
| --------------- | ----- | ------------------------------------- |
| `--description` | `-d`  | Description text in markdown format   |
| `--file`        | `-f`  | Read description from markdown file   |
| `--assignee`    | `-a`  | Assignee (email, account ID, or "me") |
| `--priority`    |       | Priority name (e.g., High, Medium)    |
| `--labels`      | `-l`  | Labels (comma-separated)              |
| `--component`   |       | Component name (can be repeated)      |
| `--parent`      |       | Parent issue key (for subtasks)       |
| `--field`       |       | Custom field (Name=value format)      |
| `--format`      |       | Output format: text, json, markdown   |

## Custom Fields

The `--field` flag supports intelligent handling:

- **Name resolution**: Use `--field "Severity=High"` instead of `--field "customfield_10269=High"`
- **Auto-formatting**: Values are formatted based on field type
- **Validation**: Invalid values show helpful errors with allowed options

Use **ticket-fields** skill to discover available fields.

## Common Patterns

```bash
# Create a simple task
aide jira create -p PROJ -t Task -s "Implement login feature"

# Create a bug with description
aide jira create -p PROJ -t Bug -s "Login fails on Safari" -d "Users report 500 error when logging in"

# Create and assign to yourself with priority
aide jira create -p PROJ -t Task -s "Review PR comments" --assignee me --priority High

# Create with labels and components
aide jira create -p PROJ -t Story -s "User dashboard" --labels "frontend,ux" --component UI

# Create subtask under parent
aide jira create -p PROJ -t Sub-task -s "Write unit tests" --parent PROJ-100

# Create with custom fields
aide jira create -p PROJ -t Bug -s "Critical bug" --field "Severity=Critical"
```

## Output Includes

1. Ticket key (e.g., PROJ-123)
2. URL to view the ticket

## Best Practices

- Use descriptive summaries
- Include enough description for context
- Set appropriate priority
- Use labels for categorization
- Write descriptions in Markdown format

## Next Steps

After creating a ticket:

- Use **ticket** skill to verify details
- Use **ticket-update** skill to modify fields
- Use **ticket-transition** skill to change status
