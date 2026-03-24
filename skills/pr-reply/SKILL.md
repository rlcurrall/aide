---
name: pr-reply
description: Reply to an existing comment thread on a pull request. Use when the user wants to respond to reviewer feedback, continue a discussion, or acknowledge comments in an existing thread.
allowed-tools: Bash(aide:*)
---

# Reply to PR Thread

Reply to an existing comment thread on a pull request.

## When to Use

- User wants to respond to specific reviewer feedback
- User wants to continue a discussion in an existing thread
- User wants to acknowledge they've addressed a comment
- User wants to ask follow-up questions in context

## How to Execute

Run:

```bash
aide pr reply <thread-id> "reply text" [--pr <id>] [options]
```

### Flags

| Flag       | Description                                         |
| ---------- | --------------------------------------------------- |
| `--pr`     | PR ID or URL (auto-detected from branch if omitted) |
| `--parent` | Parent comment ID for nested replies                |

## Output Includes

1. Thread ID
2. Reply content
3. Parent comment reference (if specified)
4. Timestamp

## Common Patterns

```bash
# Reply to a thread (auto-detect PR from branch)
aide pr reply 156 "Fixed as suggested in the latest commit"

# Reply to specific PR's thread
aide pr reply 156 "Done, please re-review" --pr 24094

# Reply to specific comment in a thread
aide pr reply 156 "Good point, I've updated the implementation" --parent 789 --pr 24094
```

## Finding Thread IDs

Use the **pr-comments** skill to load PR comments, which displays thread IDs for each comment thread. Look for the thread ID in the output to use with this command.

## Response Patterns

| Scenario                 | Example Reply                                 |
| ------------------------ | --------------------------------------------- |
| Fixed as requested       | "Fixed in commit abc123"                      |
| Explaining approach      | "I chose this approach because..."            |
| Requesting clarification | "Could you clarify what you mean by...?"      |
| Acknowledging feedback   | "Good catch! I've updated the implementation" |
| Disagreeing respectfully | "I see your point, but I think X because..."  |

## Best Practices

- Reply in the relevant thread to keep context together
- Reference commits when changes are made
- Be specific about what was changed
- Ask clarifying questions if feedback is unclear

## Next Steps

After replying:

- Use **pr-comments** skill to see the updated thread
- Use **pr-comment** skill for new general comments
