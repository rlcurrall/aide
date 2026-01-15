---
description: Change Jira ticket workflow status
allowed-tools: Bash(aide:*)
---

Change the workflow status of a Jira ticket (e.g., move to "In Progress", "Done").

## Usage

`/aide:ticket-transition TICKET-KEY "Status"` - Transition to specified status
`/aide:ticket-transition TICKET-KEY --list` - List available transitions

## Execution

Run the following command with the provided arguments:

```bash
aide jira transition $ARGUMENTS
```

## Flags

| Flag           | Short | Description                                    |
| -------------- | ----- | ---------------------------------------------- |
| `--list`       | `-l`  | List available transitions for the ticket      |
| `--comment`    | `-c`  | Add comment with the transition                |
| `--resolution` | `-r`  | Set resolution (for Done/Resolved transitions) |
| `--format`     |       | Output format: text, json, markdown            |

## Output

When transitioning:

1. Confirmation of successful transition
2. New status name
3. URL to view the ticket

When listing (`--list`):

1. Available transition names
2. Target status for each transition

## Workflow

1. **Check available transitions first**: Use `--list` to see what transitions are valid for the ticket's current state
2. **Transition with context**: Add a comment explaining why you're changing the status
3. **Set resolution when closing**: Use `--resolution` when moving to Done/Resolved

## Examples

```bash
# List available transitions
aide jira transition PROJ-123 --list

# Move ticket to In Progress
aide jira transition PROJ-123 "In Progress"

# Complete a ticket with comment
aide jira transition PROJ-123 "Done" --comment "Implementation complete, tests passing"

# Resolve with specific resolution
aide jira transition PROJ-123 "Done" --resolution "Fixed"

# Move to code review
aide jira transition PROJ-123 "Code Review"
```

## Common Status Names

Status names vary by project workflow. Common ones include:

- `To Do`, `Open`, `Backlog`
- `In Progress`, `In Development`
- `Code Review`, `In Review`
- `Done`, `Closed`, `Resolved`
