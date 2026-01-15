---
description: Manage Jira ticket attachments
allowed-tools: Bash(aide:*)
---

List, upload, download, or delete attachments on a Jira ticket.

## Usage

`/aide:ticket-attach TICKET-KEY --list` - List all attachments
`/aide:ticket-attach TICKET-KEY --upload ./file.pdf` - Upload a file
`/aide:ticket-attach TICKET-KEY --download "filename"` - Download an attachment
`/aide:ticket-attach TICKET-KEY --delete "filename"` - Delete an attachment

## Execution

Run the following command with the provided arguments:

```bash
aide jira attach $ARGUMENTS
```

## Flags

| Flag         | Short | Description                                |
| ------------ | ----- | ------------------------------------------ |
| `--list`     | `-l`  | List all attachments on the ticket         |
| `--upload`   | `-u`  | Upload file(s) to ticket (can be repeated) |
| `--download` | `-d`  | Download attachment by ID or filename      |
| `--output`   | `-o`  | Output directory for downloads             |
| `--delete`   |       | Delete attachment by ID or filename        |
| `--format`   |       | Output format: text, json, markdown        |

**Note:** Only one operation (`--list`, `--upload`, `--download`, `--delete`) can be performed at a time.

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

## Examples

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
