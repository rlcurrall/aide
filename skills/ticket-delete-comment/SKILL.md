---
name: ticket-delete-comment
description: Delete a comment from a Jira ticket. Use when the user wants to remove a comment they previously added or clean up outdated comments.
allowed-tools: Bash(aide:*)
---

# Delete Ticket Comment

Delete a comment from a Jira ticket by its comment ID.

## When to Use

- User wants to remove a comment they previously added
- User wants to clean up test or draft comments
- User wants to remove outdated or incorrect information

## How to Execute

Run:

```bash
aide jira delete-comment TICKET-KEY COMMENT-ID [--format text|json|markdown]
```

### Arguments

| Argument     | Required | Description                      |
| ------------ | -------- | -------------------------------- |
| `TICKET-KEY` | Yes      | Jira ticket key (e.g., PROJ-123) |
| `COMMENT-ID` | Yes      | ID of the comment to delete      |

### Flags

| Flag       | Description                         |
| ---------- | ----------------------------------- |
| `--format` | Output format: text, json, markdown |

## Finding Comment IDs

To find the comment ID you want to delete, first list comments:

```bash
aide jira comments PROJ-123 --format json
```

Each comment in the output will have an `id` field.

## Output Includes

1. Confirmation of deletion
2. Ticket key
3. Deleted comment ID

## Common Patterns

```bash
# Delete a specific comment
aide jira delete-comment PROJ-123 10001

# Delete with JSON output (useful for scripting)
aide jira delete-comment PROJ-123 10001 --format json
```

## Use Cases

| Purpose              | Example                                |
| -------------------- | -------------------------------------- |
| Remove test comment  | Clean up after testing                 |
| Remove duplicate     | Accidentally posted same comment twice |
| Remove outdated info | Information is no longer accurate      |
| Clean up draft       | Remove incomplete or draft comment     |

## Important Notes

- Deletion is permanent and cannot be undone
- You can only delete comments you have permission to delete
- The comment ID is required (use `aide jira comments` to find it)

## Next Steps

After deleting a comment:

- Use **ticket-comments** skill to verify deletion
- Use **ticket-comment** skill to add a new comment if needed
