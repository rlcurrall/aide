---
name: pr-comments
description: Load PR comments and feedback for code review. Use when the user wants to see reviewer feedback, check for unresolved comments, understand what changes are requested, or review discussion on a PR.
allowed-tools: Bash(aide:*)
---

# Load PR Comments

Fetch PR comments to review feedback from reviewers.

## When to Use

- User asks "what feedback is there?" or "show me the comments"
- User wants to check for unresolved review comments
- User needs to understand what changes reviewers are requesting
- User wants to see discussion history on a PR

## How to Execute

Run:

```bash
aide pr comments [--pr <id|url>] [options]
```

### Flags

| Flag               | Description                                         |
| ------------------ | --------------------------------------------------- |
| `--pr`             | PR ID or URL (auto-detected from branch if omitted) |
| `--latest`         | Limit to N most recent comments                     |
| `--thread-status`  | Filter by thread status: active, fixed, closed      |
| `--author`         | Filter by reviewer email or name                    |
| `--include-system` | Include system-generated comments (default: false)  |
| `--format`         | Output format: text, json, markdown                 |

## Output Includes

Comments organized by:

1. File path and line number
2. Thread status (active, fixed, etc.)
3. Author and timestamp
4. Comment content

## Best Practices

- Use `--thread-status active` to focus on unresolved feedback
- Use `--latest N` to see most recent discussion
- Filter by `--author` to see specific reviewer's feedback
- Use `--format json` for structured processing

## PR Review Workflow

```bash
# View all active (unresolved) threads
aide pr comments --thread-status active

# Get latest 10 comments
aide pr comments --latest 10

# See specific reviewer's feedback
aide pr comments --author "senior.dev@company.com"

# Get structured data for analysis
aide pr comments --format json
```

## Addressing Feedback

After loading comments:

1. **Prioritize**: Address blocking/critical feedback first
2. **Understand context**: Read the full thread, not just latest comment
3. **Implement fixes**: Make changes based on feedback
4. **Respond**: Use **pr-reply** skill to acknowledge and explain changes

## Next Steps

After reviewing comments:

- Use **pr-reply** skill to respond to specific threads
- Use **pr-comment** skill to post general updates
- Use **pr-diff** skill to see the code being discussed
