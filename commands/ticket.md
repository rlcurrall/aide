---
description: Load Jira ticket context for the current task
allowed-tools: Bash(aide:*)
---

Fetch detailed information about a Jira ticket to understand requirements and context.

## Usage

`/aide:ticket TICKET-KEY` - Get ticket details
`/aide:ticket TICKET-KEY --format json` - Get raw JSON data

## Execution

Run the following command with the provided arguments:

```bash
aide jira view $ARGUMENTS
```

## Flags

| Flag | Description |
|------|-------------|
| `--format` | Output format: text, json, markdown |

## Output

Displays ticket information including:

1. Summary and description
2. Status, priority, type
3. Assignee and reporter
4. Labels and components
5. Created and updated dates
6. Any linked issues

## Workflow

Use this command to:

1. **Understand requirements**: Read the description and acceptance criteria
2. **Check status**: See current workflow state
3. **Identify stakeholders**: Note assignee and reporter
4. **Find context**: Review linked issues and labels

## Examples

```bash
# Get ticket details
aide jira view PROJ-123

# Get raw JSON for processing
aide jira view PROJ-123 --format json

# Get markdown format
aide jira view PROJ-123 --format markdown
```

After loading ticket context, consider using `/aide:ticket-comments` to see discussion history.
