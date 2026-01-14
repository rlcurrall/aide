---
description: Create a new Jira ticket
allowed-tools: Bash(aide:*)
---

Create a new Jira ticket with the specified details.

## Usage

`/aide:ticket-create -p PROJECT -t TYPE -s "Summary"` - Create with required fields
`/aide:ticket-create -p PROJ -t Task -s "Title" -d "Description"` - With description
`/aide:ticket-create -p PROJ -t Bug -s "Bug title" --assignee me` - Assign to self

## Execution

Run the following command with the provided arguments:

```bash
aide jira create $ARGUMENTS
```

## Flags

| Flag | Short | Description |
|------|-------|-------------|
| `--project` | `-p` | Project key (required, e.g., PROJ) |
| `--type` | `-t` | Issue type (required, e.g., Task, Bug, Story) |
| `--summary` | `-s` | Issue summary/title (required) |
| `--description` | `-d` | Description text in markdown format |
| `--file` | `-f` | Read description from markdown file |
| `--assignee` | `-a` | Assignee (email, account ID, or "me") |
| `--priority` | | Priority name (e.g., High, Medium, Low) |
| `--labels` | `-l` | Labels (comma-separated) |
| `--component` | | Component name (can be repeated) |
| `--parent` | | Parent issue key (for subtasks) |
| `--field` | | Custom field (format: fieldName=value) |
| `--format` | | Output format: text, json, markdown |

## Output

Displays the created ticket details including:

1. Ticket key (e.g., PROJ-123)
2. URL to view the ticket

## Examples

```bash
# Create a simple task
aide jira create -p PROJ -t Task -s "Implement login feature"

# Create a bug with description
aide jira create -p PROJ -t Bug -s "Login fails on Safari" -d "Users report 500 error when logging in using Safari browser"

# Create and assign to yourself with priority
aide jira create -p PROJ -t Task -s "Review PR comments" --assignee me --priority High

# Create with labels and components
aide jira create -p PROJ -t Story -s "User dashboard" --labels "frontend,ux" --component UI --component Dashboard

# Create subtask under parent
aide jira create -p PROJ -t Sub-task -s "Write unit tests" --parent PROJ-100

# Create with description from file
aide jira create -p PROJ -t Task -s "New feature" --file ./description.md
```
