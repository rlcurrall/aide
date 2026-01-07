---
description: Reply to Azure DevOps PR thread
allowed-tools: Bash(aide:*)
---

Reply to an existing comment thread on an Azure DevOps pull request.

## Usage

`/aide:pr-reply <pr-id> --thread <thread-id> "reply text"` - Reply to a thread
`/aide:pr-reply <pr-id> --thread <thread-id> --parent <comment-id> "reply"` - Reply to specific comment in thread
`/aide:pr-reply --thread <thread-id> "reply text"` - Auto-detect PR from current branch

## Execution

Run the following command with the provided arguments:

```bash
aide ado pr reply $ARGUMENTS
```

## Flags

| Flag       | Description                          |
| ---------- | ------------------------------------ |
| `--thread` | Thread ID to reply to (required)     |
| `--parent` | Parent comment ID for nested replies |

## Output

Displays the posted reply details including:

1. Thread ID
2. Reply content
3. Parent comment reference (if specified)
4. Timestamp

## Workflow

Use replies to:

1. **Address feedback**: Respond directly to reviewer comments
2. **Provide context**: Explain why changes were made a certain way
3. **Acknowledge comments**: Confirm you've seen and will address feedback
4. **Continue discussion**: Ask follow-up questions in the same thread

## Examples

```bash
# Reply to a thread
aide ado pr reply 24094 --thread 156 "Fixed as suggested in the latest commit"

# Reply to specific comment in a thread
aide ado pr reply 24094 --thread 156 --parent 789 "Good point, I've updated the implementation"

# Auto-detect PR from current branch
aide ado pr reply --thread 156 "Done, please re-review"
```

## Finding Thread IDs

Use `/aide:pr <pr-id>` to load PR comments, which displays thread IDs for each comment thread. Look for the thread ID in the output to use with this command.
