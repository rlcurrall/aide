---
name: boards
description: List Jira boards for a project. Use when the user wants to find board IDs, see available boards, or needs to identify which board to query for sprint information.
allowed-tools: Bash(aide:*)
---

# List Jira Boards

List boards in Jira, optionally filtered by project key.

## When to Use

- User asks "what boards are there?" or "find the board for project X"
- User needs a board ID to query sprints
- User wants to see "what's on the board" (first step: find the board)

## How to Execute

Run:

```bash
aide jira boards [project] [--format text|json|markdown]
```

### Arguments

| Argument  | Description                               |
| --------- | ----------------------------------------- |
| `project` | Project key to filter boards (e.g., PROJ) |

### Flags

| Flag       | Description                         |
| ---------- | ----------------------------------- |
| `--format` | Output format: text, json, markdown |

## Examples

```bash
# List all boards
aide jira boards

# List boards for a specific project
aide jira boards PROJ
```

## Output Includes

1. Board ID (needed for sprint queries)
2. Board name
3. Board type (scrum, kanban, simple)
4. Associated project

## Next Steps

After finding a board:

- Use **sprint** skill to get the active sprint for the board
- Use **ticket-search** skill with `--sprint-board` flag to search within the active sprint
