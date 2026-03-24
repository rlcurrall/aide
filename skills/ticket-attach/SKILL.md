---
name: ticket-attach
description: Manage Jira ticket attachments. Use when the user wants to list, upload, download, or delete attachments on a ticket.
allowed-tools: Bash(aide:*)
---

# Manage Ticket Attachments

List, upload, download, or delete attachments on a Jira ticket.

## When to Use

- User wants to see what files are attached to a ticket
- User wants to upload a screenshot, log, or document
- User needs to download an attachment for review
- User wants to remove outdated attachments

## How to Execute

Run:

```bash
aide jira attach TICKET-KEY --<operation> [options]
```

### Operations (one at a time)

| Flag         | Short | Description                                |
| ------------ | ----- | ------------------------------------------ |
| `--list`     | `-l`  | List all attachments on the ticket         |
| `--upload`   | `-u`  | Upload file(s) to ticket (can be repeated) |
| `--download` | `-d`  | Download attachment by ID or filename      |
| `--delete`   |       | Delete attachment by ID or filename        |

### Additional Flags

| Flag       | Short | Description                         |
| ---------- | ----- | ----------------------------------- |
| `--output` | `-o`  | Output directory for downloads      |
| `--format` |       | Output format: text, json, markdown |

## Output

**List mode:** Shows attachment details including:

- Filename
- Size
- MIME type
- Author
- Upload date

**Upload mode:** Confirmation with uploaded file details

**Download mode:** File saved to current directory or specified output path

**Delete mode:** Confirmation of deletion

## Common Patterns

```bash
# List all attachments
aide jira attach PROJ-123 --list

# Upload a single file
aide jira attach PROJ-123 --upload ./screenshot.png

# Upload multiple files
aide jira attach PROJ-123 --upload ./doc1.pdf --upload ./doc2.pdf

# Download by filename
aide jira attach PROJ-123 --download "requirements.docx"

# Download to specific directory
aide jira attach PROJ-123 --download "report.pdf" --output ./downloads

# Delete an attachment
aide jira attach PROJ-123 --delete "old-screenshot.png"

# Get attachment list as JSON
aide jira attach PROJ-123 --list --format json
```

## Workflow

1. **List first**: Always list attachments to see what's available
2. **Upload supporting files**: Add screenshots, logs, or documents
3. **Download for analysis**: Get files locally when needed
4. **Clean up**: Delete outdated or incorrect attachments

## Use Cases

| Goal               | Command                                            |
| ------------------ | -------------------------------------------------- |
| See attached files | `aide jira attach PROJ-123 --list`                 |
| Add bug screenshot | `aide jira attach PROJ-123 --upload ./bug.png`     |
| Get attached log   | `aide jira attach PROJ-123 --download "error.log"` |
| Remove old file    | `aide jira attach PROJ-123 --delete "draft.pdf"`   |

## Best Practices

- List attachments before uploading to avoid duplicates
- Use descriptive filenames when uploading
- Download attachments to review requirements or reproduce issues
- Clean up outdated attachments to keep tickets organized

## Next Steps

After managing attachments:

- Use **ticket** skill to view full ticket details
- Use **ticket-comment** skill to note attachment changes
