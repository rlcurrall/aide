---
name: ticket
description: View Jira ticket details to understand requirements and context. Use when the user mentions a ticket key, wants to understand a task, needs to load ticket context, or starts work on an issue.
allowed-tools: Bash(aide:*)
---

# View Jira Ticket

Fetch detailed information about a Jira ticket to understand requirements and context.

## When to Use

- User mentions a ticket key (e.g., "PROJ-123")
- User wants to understand a task's requirements
- User asks "what's this ticket about?"
- User is starting work on an issue

## How to Execute

Run:

```bash
aide jira view <TICKET-KEY> [--format text|json|markdown]
```

## Output Includes

1. Summary and description
2. Status, priority, type
3. Assignee and reporter
4. Labels and components
5. Created and updated dates
6. Any linked issues

## Ticket-Driven Development Workflow

### Starting Work on a Ticket

1. **Load ticket context**: Use this skill to fetch full details
2. **Understand requirements**: Review description and acceptance criteria
3. **Check for blockers**: Look for linked issues or dependencies
4. **Review comments**: Use **ticket-comments** skill for discussion history

### During Development

- Reference ticket requirements while coding
- Track progress with comments using **ticket-comment** skill
- Update description if scope changes using **ticket-update** skill
- Stay aligned by checking for new comments

### Completing Work

1. Add summary comment documenting what was implemented
2. Reference in commits (e.g., "PROJ-123: Add feature")
3. Link PR in closing comment
4. Transition status using **ticket-transition** skill

## Best Practices

- Always load ticket context before starting implementation
- Keep the ticket updated as you progress
- Use ticket key in commit messages for traceability
- Check comments for clarifications from stakeholders

## Next Steps

After loading ticket:

- Use **ticket-comments** skill to see discussion history
- Use **ticket-update** skill to modify fields
- Use **ticket-transition** skill to change status
