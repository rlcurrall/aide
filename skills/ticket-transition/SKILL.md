---
name: ticket-transition
description: Change a Jira ticket's workflow status. Use when the user wants to move a ticket to a different status, start work, complete a task, or change workflow state.
allowed-tools: Bash(aide:*)
---

# Transition Ticket Status

Change the workflow status of a Jira ticket (e.g., move to "In Progress", "Done").

## When to Use

- User wants to start work on a ticket
- User has completed work and wants to close a ticket
- User wants to move a ticket to a different status
- User needs to see available status transitions

## How to Execute

List available transitions first:

```bash
aide jira transition TICKET-KEY --list
```

Then transition to desired status:

```bash
aide jira transition TICKET-KEY "Status Name" [options]
```

### Flags

| Flag           | Short | Description                                    |
| -------------- | ----- | ---------------------------------------------- |
| `--list`       | `-l`  | List available transitions for the ticket      |
| `--comment`    | `-c`  | Add comment with the transition                |
| `--resolution` | `-r`  | Set resolution (for Done/Resolved transitions) |
| `--format`     |       | Output format: text, json, markdown            |

## Output

**When transitioning:**

1. Confirmation of successful transition
2. New status name
3. URL to view the ticket

**When listing (`--list`):**

1. Available transition names
2. Target status for each transition

## Common Patterns

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

| Category    | Status Names                |
| ----------- | --------------------------- |
| Not Started | To Do, Open, Backlog        |
| In Progress | In Progress, In Development |
| Review      | Code Review, In Review, QA  |
| Completed   | Done, Closed, Resolved      |

## Best Practices

- Always list available transitions first with `--list`
- Add comments when transitioning to explain the change
- Set resolution when closing tickets
- Check workflow requirements - some transitions need fields set

## Workflow Example

```bash
# 1. Start work
aide jira transition PROJ-123 "In Progress" --comment "Starting implementation"

# 2. Move to review
aide jira transition PROJ-123 "Code Review" --comment "PR #456 ready for review"

# 3. Complete work
aide jira transition PROJ-123 "Done" --comment "Merged and deployed" --resolution "Fixed"
```

## Next Steps

After transitioning:

- Use **ticket** skill to verify the new status
- Use **ticket-comment** skill to add additional notes
