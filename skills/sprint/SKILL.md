---
name: sprint
description: Get sprint information for a Jira board. Use when the user wants to find the current/active sprint, check sprint dates, or see sprint goals.
allowed-tools: Bash(aide:*)
---

# Get Sprint Information

Get sprint details for a Jira board, filtered by state.

## When to Use

- User asks "what's the current sprint?" or "what sprint are we in?"
- User needs the active sprint ID to search for issues
- User wants to see sprint dates or goals

## How to Execute

Run:

```bash
aide jira sprint <boardId> [--state active|future|closed] [--format text|json|markdown]
```

### Arguments

| Argument  | Description                    |
| --------- | ------------------------------ |
| `boardId` | Board ID (from boards command) |

### Flags

| Flag       | Description                           |
| ---------- | ------------------------------------- |
| `--state`  | Sprint state filter (default: active) |
| `--format` | Output format: text, json, markdown   |

## Examples

```bash
# Get active sprint for a board
aide jira sprint 123

# Get future sprints
aide jira sprint 123 --state future

# Get closed sprints
aide jira sprint 123 --state closed
```

## Output Includes

1. Sprint ID
2. Sprint name
3. State (future, active, closed)
4. Start and end dates
5. Sprint goal (if set)

## Common Workflow

To find "what's on the board right now":

1. Find the board: `aide jira boards PROJ`
2. Get the active sprint: `aide jira sprint <boardId>`
3. Search for issues in that sprint: `aide jira search "assignee = currentUser()" --sprint-board <boardId>`

The `--sprint-board` flag on the search command combines steps 2 and 3 automatically.

## Next Steps

After finding the active sprint:

- Use **ticket-search** skill with `--sprint-board` to search issues in the sprint
- Use **ticket** skill to view details on specific issues
