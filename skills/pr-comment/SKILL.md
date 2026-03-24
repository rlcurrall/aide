---
name: pr-comment
description: Post a comment on a pull request. Use when the user wants to add a comment to a PR, respond to feedback, request review, or document decisions.
allowed-tools: Bash(aide:*)
---

# Post PR Comment

Post a comment on a pull request thread.

## When to Use

- User wants to add a general comment to a PR
- User wants to comment on a specific file or line
- User wants to request re-review after changes
- User wants to document a decision or explanation

## How to Execute

Run:

```bash
aide pr comment "comment text" [--pr <id>] [options]
```

### Flags

| Flag         | Description                                         |
| ------------ | --------------------------------------------------- |
| `--pr`       | PR ID or URL (auto-detected from branch if omitted) |
| `--file`     | File path to attach comment to                      |
| `--line`     | Line number in file (requires `--file`)             |
| `--end-line` | End line for multi-line comment range               |

## Output Includes

1. Thread ID
2. Comment content
3. File and line location (if specified)
4. Timestamp

## Common Patterns

```bash
# General PR comment (auto-detect PR from branch)
aide pr comment "Ready for re-review after addressing all feedback"

# Comment on specific PR
aide pr comment "LGTM!" --pr 24094

# Comment on specific file
aide pr comment "Consider refactoring this section" --pr 24094 --file src/auth.ts

# Comment on specific line
aide pr comment "Added null check as suggested" --pr 24094 --file src/utils/helpers.ts --line 127
```

## Use Cases

| Purpose              | Example                                             |
| -------------------- | --------------------------------------------------- |
| Request review       | "Ready for re-review after addressing all feedback" |
| Acknowledge feedback | "Good point, I've updated the implementation"       |
| Ask questions        | "Should this use async/await or promises?"          |
| Document decisions   | "Using OAuth 2.0 with PKCE for enhanced security"   |
| Mark completion      | "All comments addressed, tests passing"             |

## Best Practices

- Be specific when commenting on code locations
- Use line comments for inline feedback
- Use general comments for overall PR updates
- Keep comments constructive and actionable

## Next Steps

After posting a comment:

- Use **pr-comments** skill to verify your comment was posted
- Use **pr-reply** skill to respond to specific threads
