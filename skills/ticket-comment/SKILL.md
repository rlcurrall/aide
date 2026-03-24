---
name: ticket-comment
description: Add a comment to a Jira ticket. Use when the user wants to post an update, ask a question, document a decision, or communicate status on a ticket.
allowed-tools: Bash(aide:*)
---

# Add Ticket Comment

Add a comment to a Jira ticket. Comments support markdown formatting.

## When to Use

- User wants to add an update to a ticket
- User wants to ask a question on a ticket
- User wants to document a decision
- User wants to communicate progress or blockers

## How to Execute

Run:

```bash
aide jira comment TICKET-KEY "comment text" [--format text|json|markdown]
```

Or read from file:

```bash
aide jira comment TICKET-KEY --file ./comment.md
```

### Flags

| Flag       | Short | Description                         |
| ---------- | ----- | ----------------------------------- |
| `--file`   | `-f`  | Read comment from markdown file     |
| `--format` |       | Output format: text, json, markdown |

## Output Includes

1. Comment ID
2. Creation timestamp
3. Author name

## Common Patterns

```bash
# Add a simple comment
aide jira comment PROJ-123 "Started working on this task"

# Add a detailed comment with markdown
aide jira comment PROJ-123 "## Progress Update

- Completed initial implementation
- Tests passing locally
- Ready for code review

**Next steps:** Create PR and request review"

# Add comment from file (for longer content)
aide jira comment PROJ-123 --file ./status-update.md
```

## Use Cases

| Purpose                | Example                                           |
| ---------------------- | ------------------------------------------------- |
| Progress update        | "Completed initial implementation"                |
| Asking questions       | "Should this handle edge case X?"                 |
| Documenting decisions  | "Using OAuth 2.0 with PKCE for enhanced security" |
| Communicating blockers | "Blocked on API access - waiting for credentials" |
| Closing notes          | "Implementation complete, PR #123 merged"         |

## Best Practices

- Use markdown for formatted comments (headers, lists, code blocks)
- For long comments, write to a file first and use `--file`
- Reference other tickets with their keys (e.g., "Related to PROJ-456")
- Include relevant details for future reference

## Next Steps

After adding a comment:

- Use **ticket-comments** skill to see all comments
- Use **ticket-transition** skill to change status if appropriate
