---
name: ticket-fields
description: Discover available Jira fields for a project and issue type. Use when the user needs to find field names, see what fields are available, or discover custom field values before creating or updating tickets.
allowed-tools: Bash(aide:*)
---

# Discover Jira Fields

Discover what fields are available when creating or updating Jira tickets.

## When to Use

- User needs to find correct field names
- User encounters "field not found" errors
- User wants to see allowed values for select fields
- User is preparing to create/update tickets with custom fields

## How to Execute

Run:

```bash
aide jira fields PROJECT [options]
```

### Options

| Flag            | Short | Description                                         |
| --------------- | ----- | --------------------------------------------------- |
| `--type`        | `-t`  | Issue type (e.g., Task, Bug). If omitted, shows all |
| `--filter`      | `-f`  | Filter: all, required, optional, custom, system     |
| `--show-values` | `-v`  | Display allowed values for select fields            |
| `--max-values`  |       | Maximum values to display per field (default: 10)   |
| `--format`      |       | Output format: text, json, markdown                 |

## Common Patterns

```bash
# List all fields for a project
aide jira fields PROJ

# List fields for a specific issue type
aide jira fields PROJ -t Bug

# Show only required fields
aide jira fields PROJ -t Task --filter required

# Show custom fields with their allowed values
aide jira fields PROJ -t Bug --filter custom --show-values

# Get full field metadata as JSON
aide jira fields PROJ -t Task --format json --show-values
```

## Integration with Create/Update

Once you discover field names, use them directly with **ticket-create** or **ticket-update**:

```bash
# 1. Discover available fields
aide jira fields PROJ -t Bug --filter custom --show-values
# Output shows: Severity (customfield_10269) - select
#   Values: Critical, High, Medium, Low

# 2. Use the field name (auto-resolved to internal ID)
aide jira create -p PROJ -t Bug -s "My bug" --field "Severity=Critical"
aide jira update PROJ-123 --field "Severity=High"
```

The `--field` flag automatically:

- Resolves field names to internal IDs
- Formats values based on field type
- Validates values and shows allowed options on error

## Output Includes

1. Field name (human-readable)
2. Field ID (internal)
3. Field type (text, select, array, etc.)
4. Whether the field is required
5. Allowed values (with `--show-values`)

## Use Cases

| Goal                        | Command                                          |
| --------------------------- | ------------------------------------------------ |
| Find required fields        | `aide jira fields PROJ -t Bug --filter required` |
| See custom fields           | `aide jira fields PROJ --filter custom`          |
| Get allowed values          | `aide jira fields PROJ -t Bug --show-values`     |
| Get metadata for automation | `aide jira fields PROJ --format json`            |

## Best Practices

- Always check fields before creating tickets with custom fields
- Use `--show-values` to see valid options for select fields
- Use `--filter required` to see mandatory fields
- Use `--format json` for programmatic access

## Next Steps

After discovering fields:

- Use **ticket-create** skill to create tickets with correct fields
- Use **ticket-update** skill to update custom fields
