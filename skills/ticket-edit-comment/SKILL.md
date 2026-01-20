---
name: ticket-edit-comment
description: Edit an existing comment on a Jira ticket. Use when the user wants to update, correct, or improve a comment they previously added.
allowed-tools: Bash(aide:*)
---

# Edit Ticket Comment

Edit an existing comment on a Jira ticket. Comments support markdown formatting.

## When to Use

- User wants to fix a typo or error in a comment
- User wants to add more information to an existing comment
- User wants to update status information in a comment
- User wants to correct inaccurate information

## How to Execute

Run:
```bash
aide jira edit-comment TICKET-KEY COMMENT-ID "new content" [--format text|json|markdown]
```

Or read from file:
```bash
aide jira edit-comment TICKET-KEY COMMENT-ID --file ./updated-comment.md
```

### Arguments

| Argument     | Required | Description                        |
|--------------|----------|------------------------------------|
| `TICKET-KEY` | Yes      | Jira ticket key (e.g., PROJ-123)   |
| `COMMENT-ID` | Yes      | ID of the comment to edit          |
| `comment`    | No*      | New comment text in markdown format |

*Either inline comment or `--file` must be provided.

### Flags

| Flag       | Short | Description                         |
|------------|-------|-------------------------------------|
| `--file`   | `-f`  | Read new comment from markdown file |
| `--format` |       | Output format: text, json, markdown |

## Finding Comment IDs

To find the comment ID you want to edit, first list comments:
```bash
aide jira comments PROJ-123 --format json
```

Each comment in the output will have an `id` field.

## Output Includes

1. Comment ID
2. Updated timestamp
3. Author name

## Common Patterns

```bash
# Edit with inline text
aide jira edit-comment PROJ-123 10001 "Updated comment text"

# Edit with markdown formatting
aide jira edit-comment PROJ-123 10001 "## Updated Status

- Fixed the bug
- Added unit tests
- Ready for review"

# Edit from file (for longer content)
aide jira edit-comment PROJ-123 10001 --file ./updated-comment.md

# Get JSON output
aide jira edit-comment PROJ-123 10001 "Updated" --format json
```

## Use Cases

| Purpose              | Example                                        |
|----------------------|------------------------------------------------|
| Fix typo             | Correct spelling or grammar mistake            |
| Add information      | Include details that were initially missed     |
| Update status        | Change "in progress" to "completed"            |
| Correct inaccuracy   | Fix incorrect technical information            |
| Improve formatting   | Add markdown headers, lists, or code blocks    |

## Best Practices

- Use markdown for formatted comments (headers, lists, code blocks)
- For significant changes, write to a file first and use `--file`
- The entire comment is replaced - include all content you want to keep
- Consider adding an "Updated:" note to indicate the comment was edited

## Important Notes

- The edit replaces the entire comment content
- You can only edit comments you have permission to edit
- The comment ID is required (use `aide jira comments` to find it)

## Next Steps

After editing a comment:
- Use **ticket-comments** skill to verify the edit
- Use **ticket-delete-comment** skill if you need to remove it instead
