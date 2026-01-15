---
description: Add a comment to a Jira ticket
allowed-tools: Bash(aide:*)
---

Add a comment to a Jira ticket. Comments support markdown formatting.

## Usage

`/aide:ticket-comment TICKET-KEY "comment text"` - Add inline comment
`/aide:ticket-comment TICKET-KEY --file ./comment.md` - Add from file

## Execution

Run the following command with the provided arguments:

```bash
aide jira comment $ARGUMENTS
```

## Flags

| Flag       | Short | Description                         |
| ---------- | ----- | ----------------------------------- |
| `--file`   | `-f`  | Read comment from markdown file     |
| `--format` |       | Output format: text, json, markdown |

## Output

Displays confirmation with:

1. Comment ID
2. Creation timestamp
3. Author name

## Workflow

Use comments to:

1. **Track progress**: Add updates as you work
2. **Ask questions**: Request clarification from stakeholders
3. **Document decisions**: Record technical decisions
4. **Communicate status**: Notify team of blockers or completion

## Examples

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

# Get JSON output
aide jira comment PROJ-123 "Done" --format json
```

## Tips

- Use markdown for formatted comments (headers, lists, code blocks)
- For long comments, write to a file first and use `--file`
- Reference other tickets with their keys (e.g., "Related to PROJ-456")
